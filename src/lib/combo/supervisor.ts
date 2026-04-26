import {
  OHLC,
  ComboBotConfig,
  ComboBotSideConfig,
  GridSide,
  GridLevel,
  PendingOrder,
  Fill,
  SnapshotData,
  OrderType,
} from '../types';
import { AdaptiveEngine, AdaptiveSignals, DEFAULT_ADAPTIVE_CONFIG } from './adaptiveEngine';
import { ComboBotStateMachine, ComboEvent, PositionSnapshot } from './stateMachine';
import { allocateCapital, atrScaledGridStep, slPrice } from './sizing';
import {
  PnLState,
  createInitialPnLState,
  calculateUnrealizedPnl,
  createSnapshot,
  processFill,
} from '../simulation/pnlTracker';
import { generateGridLevels } from '../simulation/gridGenerator';
import {
  initializeOrders,
  matchOrders,
  createCounterOrder,
  resetOrderIdCounter,
  getIntraCandlePath,
} from '../simulation/orderMatcher';
import {
  applyFundingBetween,
  FundingRateEntry,
  NotionalPosition,
} from '../simulation/funding';
import {
  applySlippage,
  atrFractionOfPrice,
  SlippageConfig,
  DEFAULT_SLIPPAGE,
} from '../simulation/slippage';

/** Per-side grid state: levels + live pending orders + current tier multiplier. */
interface SideGridState {
  levels: GridLevel[];
  pending: PendingOrder[];
  /** Per-order USD size at sizeMultiplier=1.0 (already leverage-scaled). */
  baseOrderSize: number;
  /** Applied to new pending orders (tier ramp 0.25/0.5/1.0 during REOPENING). */
  sizeMultiplier: number;
  /**
   * Deferred multiplier from a tier2/tier3 scale event: applied at the TOP of the
   * next candle (before matchOrders) so same-candle fills are not retroactively
   * inflated by the new tier size.
   */
  nextSizeMultiplier: number | null;
  active: boolean;
  /** Set true on the candle the grid was seeded; matchOrders skips fresh grids on that
   *  candle to avoid same-candle lookahead (signal fires at close, but OHLC path
   *  may have already crossed grid levels earlier in the candle). Reset each iteration. */
  freshlySeeded: boolean;
}

const MARKET_ENTRY_LEVEL_INDEX = -1;

function emptySideGridState(): SideGridState {
  return { levels: [], pending: [], baseOrderSize: 0, sizeMultiplier: 0, nextSizeMultiplier: null, active: false, freshlySeeded: false };
}

export interface ComboSimulationInputs {
  candles5m: OHLC[];
  candles1h: OHLC[];
  candles4h: OHLC[];
  cfg: ComboBotConfig;
  totalCapital: number;
  fundingRates: FundingRateEntry[];
  feeRate: number;
  slippageCfg?: SlippageConfig;
  snapshotInterval?: number;
  // Optional pre-persisted AVWAP anchor to resume from (spec §10.4).
  resumeAnchor?: { candleIdx: number; timestamp: number; typicalPrice: number; volume: number } | null;
}

export interface ComboSupervisorEvent {
  candleIdx: number;
  timestamp: number;
  type: string; // same strings as ComboEvent.type
  detailsJson: string;
  longMultiplier: number;
  shortMultiplier: number;
}

export interface ComboSimulationResult {
  events: ComboSupervisorEvent[];
  snapshots: SnapshotData[];
  fills: Fill[];
  pnlState: PnLState;
  finalAnchor: { candleIdx: number; timestamp: number; typicalPrice: number; volume: number } | null;
  totalFundingCost: number;
  longFundingCost: number;
  shortFundingCost: number;
}

const DEFAULT_LONG_CFG: ComboBotSideConfig = {
  averagingDepth: 5,
  slBasePercent: 0.015,
  slAtrMultiplier: 1.5,
  slFloor: 0.01,
  slCap: 0.04,
  tier1Size: 0.25,
  tier2Size: 0.5,
  tier3Size: 1.0,
  cooldownCandles: 12,
  retryCap: 2,
  hibernationCandles: 288,
};

const DEFAULT_SHORT_CFG: ComboBotSideConfig = {
  ...DEFAULT_LONG_CFG,
  averagingDepth: 2, // spec §1: short runs shallower
};

function sideCfgOrDefault(cfg: ComboBotSideConfig | undefined, side: GridSide): ComboBotSideConfig {
  if (cfg) return cfg;
  return side === 'long' ? DEFAULT_LONG_CFG : DEFAULT_SHORT_CFG;
}

/**
 * Derive entry and reopen booleans from adaptive signals + config.
 *
 * These are the minimum-viable heuristics for Phase 3c. Richer user-configurable
 * conditions come in Phase 6 via the ConditionEvaluator wiring.
 */
function evaluateConditions(
  side: GridSide,
  signals: AdaptiveSignals,
  price: number,
  cfg: ComboBotConfig
): { entry: boolean; reopen: boolean } {
  const regimeTrending = signals.regime === 'trending';

  const avwapOk = (() => {
    if (!cfg.avwapEnabled) return true;
    if (signals.avwap === null) return true;
    // 0.5% tolerance band: long allowed unless price is deeply below AVWAP;
    // short allowed unless price is deeply above. Keeps trend bias without
    // permanently locking out the counter-trend side once anchor offsets in a
    // sustained one-direction move.
    const tolerance = 0.005;
    if (side === 'long') return price > signals.avwap * (1 - tolerance);
    return price < signals.avwap * (1 + tolerance);
  })();

  const entry = regimeTrending
    && avwapOk
    && !isNaN(signals.rsi)
    && (side === 'long' ? signals.rsi < cfg.rsiLongThreshold : signals.rsi > cfg.rsiShortThreshold);

  // Reopen: same trend regime + RSI coiled zone (neutral area) + AVWAP alignment.
  const rsiCoiled = !isNaN(signals.rsi) && signals.rsi > 40 && signals.rsi < 60;
  const reopen = regimeTrending && avwapOk && rsiCoiled;

  return { entry, reopen };
}

function positionSnapshotForSide(
  pnlState: PnLState,
  side: GridSide,
  currentPrice: number,
  allocatedCapital: number
): PositionSnapshot {
  const sidePositions = pnlState.openPositions.filter(p => p.side === side);
  if (sidePositions.length === 0) {
    return { hasPosition: false, avgEntry: 0, currentPrice, unrealizedPnlPct: 0 };
  }
  let totalValue = 0;
  let totalQty = 0;
  for (const pos of sidePositions) {
    const qty = pos.size / pos.entryPrice;
    totalValue += pos.entryPrice * qty;
    totalQty += qty;
  }
  const avgEntry = totalQty > 0 ? totalValue / totalQty : 0;
  const unrealized = calculateUnrealizedPnl(pnlState, currentPrice);
  const sideUnreal = side === 'long' ? unrealized.long : unrealized.short;
  const sideCapital = Math.max(1, allocatedCapital);
  return {
    hasPosition: true,
    avgEntry,
    currentPrice,
    unrealizedPnlPct: sideUnreal / sideCapital,
  };
}

function updateDrawdown(pnlState: PnLState, totalCapital: number, currentPrice: number): void {
  const unrealized = calculateUnrealizedPnl(pnlState, currentPrice);
  const equity = totalCapital + pnlState.realizedPnl + unrealized.total;
  if (equity > pnlState.maxEquity) pnlState.maxEquity = equity;
  const drawdown = pnlState.maxEquity - equity;
  if (drawdown > pnlState.maxDrawdown) {
    pnlState.maxDrawdown = drawdown;
    pnlState.maxDrawdownPct = pnlState.maxEquity > 0 ? (drawdown / pnlState.maxEquity) * 100 : 0;
  }
}

function segmentTouchesSL(side: GridSide, from: number, to: number, sl: number): boolean {
  return side === 'long'
    ? Math.min(from, to) <= sl
    : Math.max(from, to) >= sl;
}

function remainingPathTouchesSL(candle: OHLC, fill: Fill, side: GridSide, sl: number): boolean {
  const path = getIntraCandlePath(candle);
  const seg = Math.max(0, Math.min(fill.pathSegment ?? 0, path.length - 2));

  // The fill occurs inside this segment, so only the path after the fill price
  // can trigger a same-candle SL for the newly opened exposure.
  if (segmentTouchesSL(side, fill.fillPrice, path[seg + 1], sl)) return true;
  for (let i = seg + 1; i < path.length - 1; i++) {
    if (segmentTouchesSL(side, path[i], path[i + 1], sl)) return true;
  }
  return false;
}

function applyForcedCloseSL(
  pnlState: PnLState,
  side: GridSide,
  slPrice: number,
  candleIdx: number,
  timestamp: number,
  atr: number,
  feeRate: number,
  slippageCfg: SlippageConfig,
  leverage: number,
  totalCapital: number,
  currentPrice: number,
  outFills: Fill[]
): void {
  const positions = pnlState.openPositions.filter(p => p.side === side);
  if (positions.length === 0) return;

  for (const pos of positions) {
    const exitType = pos.entryType === 'buy' ? 'sell' : 'buy';
    const atrFrac = atrFractionOfPrice(atr, slPrice);
    const adjustedPrice = applySlippage(slPrice, exitType, side, atrFrac, true, slippageCfg);
    const qty = pos.size / pos.entryPrice;
    const fees = pos.size * feeRate;

    let pnl: number;
    if (exitType === 'sell') {
      pnl = (adjustedPrice - pos.entryPrice) * qty - pos.entryFees - fees;
    } else {
      pnl = (pos.entryPrice - adjustedPrice) * qty - pos.entryFees - fees;
    }

    pnlState.realizedPnl += pnl;
    if (side === 'long') pnlState.longRealizedPnl += pnl;
    else pnlState.shortRealizedPnl += pnl;
    if (pnl > 0) pnlState.winCount++;
    else if (pnl < 0) pnlState.lossCount++;
    pnlState.totalFees += fees;

    updateDrawdown(pnlState, totalCapital, currentPrice);

    outFills.push({
      orderId: `sl_${side}_${candleIdx}_${pos.levelIndex}`,
      side,
      type: exitType,
      levelIndex: pos.levelIndex,
      fillPrice: adjustedPrice,
      candleIdx,
      timestamp,
      size: pos.size,
      fees,
      pnl,
      pnlPct: totalCapital > 0 ? (pnl / totalCapital) * 100 : 0,
    });
  }

  pnlState.openPositions = pnlState.openPositions.filter(p => p.side !== side);
  if (side === 'long') pnlState.longFillCount += positions.length;
  else pnlState.shortFillCount += positions.length;
}

/**
 * Run the Combo Bot simulation loop over prepared candle arrays.
 *
 * Pure function: no DB writes. Caller is responsible for persistence.
 */
export function runComboSimulationCore(inputs: ComboSimulationInputs): ComboSimulationResult {
  const {
    candles5m,
    candles1h,
    candles4h,
    cfg,
    totalCapital,
    fundingRates,
    feeRate,
    slippageCfg = DEFAULT_SLIPPAGE,
    snapshotInterval,
    resumeAnchor,
  } = inputs;

  const leverage = Math.max(1, cfg.leverage);
  const allocation = allocateCapital(totalCapital, cfg.mode, cfg.allocationLong);

  const adaptive = new AdaptiveEngine({
    ...DEFAULT_ADAPTIVE_CONFIG,
    atrPeriod: cfg.atrPeriod,
    erLookback: cfg.erLookback,
    erSmoothingLength: cfg.erSmoothingLength,
    erRegimeThreshold: cfg.erRegimeThreshold,
    rsiLength: DEFAULT_ADAPTIVE_CONFIG.rsiLength,
    blendedFactor: DEFAULT_ADAPTIVE_CONFIG.blendedFactor,
  });
  if (resumeAnchor) {
    adaptive.setAnchor({
      candleIdx: resumeAnchor.candleIdx,
      timestamp: resumeAnchor.timestamp,
      typicalPrice: resumeAnchor.typicalPrice,
      volume: resumeAnchor.volume,
    });
  }

  const longSideCfg = sideCfgOrDefault(cfg.longSide, 'long');
  const shortSideCfg = sideCfgOrDefault(cfg.shortSide, 'short');

  const longSM = cfg.mode !== 'short'
    ? new ComboBotStateMachine('long', longSideCfg)
    : null;
  const shortSM = cfg.mode !== 'long'
    ? new ComboBotStateMachine('short', shortSideCfg)
    : null;

  resetOrderIdCounter();
  const pnlState = createInitialPnLState();
  pnlState.maxEquity = totalCapital;

  const fills: Fill[] = [];
  const snapshots: SnapshotData[] = [];
  const events: ComboSupervisorEvent[] = [];
  let totalFundingCost = 0;
  let longFundingCost = 0;
  let shortFundingCost = 0;

  let prevTimeSec = candles5m.length > 0 ? candles5m[0].timestamp - 1 : 0;

  const snapEvery = snapshotInterval ?? Math.max(1, Math.floor(candles5m.length / 2000));

  let agg1hIdx = 0;
  let agg4hIdx = 0;

  // Per-side grid state, managed across the cycle (seed on breakout; teardown on SL/cycle).
  const longGrid: SideGridState = emptySideGridState();
  const shortGrid: SideGridState = emptySideGridState();
  const gridLevels = Math.max(4, cfg.gridLevels ?? 10);

  for (let i = 0; i < candles5m.length; i++) {
    const candle = candles5m[i];

    // Reset freshly-seeded flag at the top of each candle so previous-candle seeds
    // become eligible for matching this candle.
    longGrid.freshlySeeded = false;
    shortGrid.freshlySeeded = false;

    // Apply any deferred tier-rescale multiplier (set last candle to avoid retroactive
    // same-candle fill inflation).
    if (longGrid.nextSizeMultiplier !== null) {
      longGrid.sizeMultiplier = longGrid.nextSizeMultiplier;
      for (const o of longGrid.pending) o.sizeMultiplier = longGrid.nextSizeMultiplier;
      longGrid.nextSizeMultiplier = null;
    }
    if (shortGrid.nextSizeMultiplier !== null) {
      shortGrid.sizeMultiplier = shortGrid.nextSizeMultiplier;
      for (const o of shortGrid.pending) o.sizeMultiplier = shortGrid.nextSizeMultiplier;
      shortGrid.nextSizeMultiplier = null;
    }

    // Advance aggregated pointers so engine always sees the "current-or-prior" completed bar
    while (agg1hIdx < candles1h.length && candles1h[agg1hIdx].timestamp <= candle.timestamp) agg1hIdx++;
    while (agg4hIdx < candles4h.length && candles4h[agg4hIdx].timestamp <= candle.timestamp) agg4hIdx++;

    // Pass full arrays + index bounds — no slicing — to keep the loop O(n).
    const signals = adaptive.update(
      candles5m, i,
      candles1h, agg1hIdx,
      candles4h, agg4hIdx,
    );

    // Funding drag settle
    if (fundingRates.length > 0 && pnlState.openPositions.length > 0) {
      // pos.size is already leveraged notional (see seedGrid: baseOrderSize = allocatedCap * leverage / levels).
      const notionalPositions: NotionalPosition[] = pnlState.openPositions.map(p => ({
        side: p.side,
        notional: p.size,
      }));
      const fund = applyFundingBetween(prevTimeSec, candle.timestamp, notionalPositions, fundingRates);
      if (fund.appliedCount > 0) {
        pnlState.realizedPnl -= fund.totalCost;
        pnlState.longRealizedPnl -= fund.longCost;
        pnlState.shortRealizedPnl -= fund.shortCost;
        totalFundingCost += fund.totalCost;
        longFundingCost += fund.longCost;
        shortFundingCost += fund.shortCost;
        updateDrawdown(pnlState, totalCapital, candle.close);
      }
    }

    // Per-side state-machine tick; emits events that drive grid seeding / teardown.
    const runSide = (
      side: GridSide,
      sm: ComboBotStateMachine | null,
      allocatedCap: number,
      gridState: SideGridState,
    ): void => {
      if (!sm) return;
      const cond = evaluateConditions(side, signals, candle.close, cfg);
      const posSnap = positionSnapshotForSide(pnlState, side, candle.close, allocatedCap);

      const { instruction, events: smEvents } = sm.tick({
        candleIdx: i,
        timestamp: candle.timestamp,
        price: candle.close,
        candleHigh: candle.high,
        candleLow: candle.low,
        signals,
        position: posSnap,
        entryConditionMet: cond.entry,
        reopenConditionsMet: cond.reopen,
      });

      // SL hit — close all open positions + tear down the grid.
      if (instruction.slHit && instruction.slPrice !== null && posSnap.hasPosition) {
        applyForcedCloseSL(
          pnlState,
          side,
          instruction.slPrice,
          i,
          candle.timestamp,
          signals.atr,
          feeRate,
          slippageCfg,
          leverage,
          totalCapital,
          candle.close,
          fills,
        );
        teardownGrid(gridState);
      }

      // Event-driven grid management: breakout/tier events seed or rescale;
      // cycle_complete closes at market and tears down.
      for (const e of smEvents) {
        if (e.type === 'breakout_entered' || e.type === 'tier1_reopen') {
          const marketEntrySize = allocatedCap / Math.max(1, gridLevels) * instruction.sizeMultiplier;
          const gridCapital = Math.max(0, allocatedCap - marketEntrySize);
          seedGrid(
            gridState,
            side,
            candle.close,
            signals.atr,
            gridCapital,
            leverage,
            gridLevels,
            instruction.sizeMultiplier,
          );
          if (!posHasSide(pnlState, side)) {
            const positionId = `combo_entry_${side}_${i}`;
            const entryFill = openMarketPosition(
              pnlState,
              side,
              candle,
              i,
              marketEntrySize,
              leverage,
              feeRate,
              slippageCfg,
              signals.atr,
              positionId,
              fills,
            );
            if (entryFill) {
              const tpOrder = createMarketEntryTakeProfitOrder(entryFill, gridState.levels);
              if (tpOrder) gridState.pending.push(tpOrder);
            }
          }
        } else if (e.type === 'tier2_scale' || e.type === 'tier3_scale') {
          // Defer the multiplier to the next candle so same-candle fills are not
          // retroactively inflated (matchOrders still runs after runSide this candle).
          gridState.nextSizeMultiplier = instruction.sizeMultiplier;
        } else if (e.type === 'cycle_complete' && posHasSide(pnlState, side)) {
          closeMarketPosition(
            pnlState,
            side,
            candle,
            i,
            leverage,
            feeRate,
            slippageCfg,
            signals.atr,
            totalCapital,
            fills,
          );
          teardownGrid(gridState);
        }
      }

      const longMult = side === 'long' ? instruction.sizeMultiplier : 0;
      const shortMult = side === 'short' ? instruction.sizeMultiplier : 0;
      for (const e of smEvents) {
        events.push(supervisorEvent(e, longMult, shortMult));
      }
    };

    runSide('long', longSM, allocation.longCapital, longGrid);
    runSide('short', shortSM, allocation.shortCapital, shortGrid);

    // Match pending orders across both sides' grids against this candle.
    // Skip orders from grids freshly seeded this candle: signal fired at close, but the
    // OHLC path may have already crossed grid levels earlier in the candle (lookahead).
    const combinedPending = [
      ...(longGrid.freshlySeeded ? [] : longGrid.pending),
      ...(shortGrid.freshlySeeded ? [] : shortGrid.pending),
    ];
    if (combinedPending.length > 0) {
      const orderFills = matchOrders(candle, i, combinedPending, feeRate, longGrid.levels, shortGrid.levels);
      const stoppedSides = new Set<GridSide>();
      for (const fill of orderFills) {
        if (stoppedSides.has(fill.side)) continue;
        const gs = fill.side === 'long' ? longGrid : shortGrid;
        const sm = fill.side === 'long' ? longSM : shortSM;
        const sideCfg = fill.side === 'long' ? longSideCfg : shortSideCfg;
        const allocatedCap = fill.side === 'long' ? allocation.longCapital : allocation.shortCapital;
        // Remove the filled pending order
        gs.pending = gs.pending.filter(o => o.id !== fill.orderId);
        if (slippageCfg.basisBp !== 0) {
          fill.fillPrice = applySlippage(
            fill.fillPrice,
            fill.type,
            fill.side,
            0,
            false,
            slippageCfg,
          );
        }
        fill.fees = fill.size * feeRate;
        // fill.size is already leveraged notional (baseOrderSize = allocatedCap * leverage / levels).
        // Do NOT multiply by leverage again — that double-counts and was the source of 25× P&L / 125× funding.
        const { pnl, pnlPct } = processFill(pnlState, fill, totalCapital);
        fill.pnl = pnl;
        fill.pnlPct = pnlPct;

        const postFillPos = positionSnapshotForSide(pnlState, fill.side, candle.close, allocatedCap);
        if (postFillPos.hasPosition && postFillPos.avgEntry > 0 && sm) {
          // The state-machine tick happened before this fill, so any instruction SL
          // cannot cover exposure opened later in the candle. Recompute from the same
          // shared sizing formula for this post-fill position snapshot.
          const sameCandleSL = slPrice(sideCfg, fill.side, postFillPos.avgEntry, signals.atr);
          if (remainingPathTouchesSL(candle, fill, fill.side, sameCandleSL)) {
            fills.push(fill);
            applyForcedCloseSL(
              pnlState,
              fill.side,
              sameCandleSL,
              i,
              candle.timestamp,
              signals.atr,
              feeRate,
              slippageCfg,
              leverage,
              totalCapital,
              candle.close,
              fills,
            );
            teardownGrid(gs);
            stoppedSides.add(fill.side);
            const slEvents = sm.forceStopLoss({
              candleIdx: i,
              timestamp: candle.timestamp,
              price: candle.close,
              candleHigh: candle.high,
              candleLow: candle.low,
              signals,
              position: postFillPos,
              entryConditionMet: false,
              reopenConditionsMet: false,
            }, sameCandleSL);
            for (const e of slEvents) events.push(supervisorEvent(e, 0, 0));
            continue;
          }
        }

        // Market-entry TP fills close by positionId and should not spawn a new grid counter.
        if (!fill.positionId) {
          // Create counter-order at the adjacent level (buy filled → sell above; sell filled → buy below).
          const counter = createCounterOrder(fill, longGrid.levels, shortGrid.levels, gs.baseOrderSize, gs.sizeMultiplier);
          if (counter) gs.pending.push(counter);
        }

        fills.push(fill);
      }
    }

    updateDrawdown(pnlState, totalCapital, candle.close);

    prevTimeSec = candle.timestamp;

    // Snapshot
    if (i % snapEvery === 0 || i === candles5m.length - 1) {
      const snap = createSnapshot(
        pnlState,
        i,
        candle.timestamp,
        candle.close,
        totalCapital,
        allocation.longCapital,
        allocation.shortCapital,
        0,
        0,
      );
      snapshots.push(snap);
    }
  }

  const finalAnchor = adaptive.getAnchor();
  return {
    events,
    snapshots,
    fills,
    pnlState,
    finalAnchor,
    totalFundingCost,
    longFundingCost,
    shortFundingCost,
  };
}

function posHasSide(pnlState: PnLState, side: GridSide): boolean {
  return pnlState.openPositions.some(p => p.side === side);
}

/**
 * Seed an ATR-scaled grid around `centerPrice` for a side, using `allocatedCap × leverage`
 * total notional split across `levelCount` orders.
 *
 * Falls back to a 0.5%-per-level grid when ATR is NaN/0 (degenerate early candles).
 */
function seedGrid(
  gridState: SideGridState,
  side: GridSide,
  centerPrice: number,
  atr: number,
  allocatedCap: number,
  leverage: number,
  levelCount: number,
  sizeMultiplier: number,
): void {
  if (centerPrice <= 0) return;
  // Half-ATR step, with a percentage fallback when ATR is missing.
  const step = isFinite(atr) && atr > 0
    ? atrScaledGridStep(atr, 2.0)            // half-ATR per level
    : centerPrice * 0.005;                    // 0.5% per level
  const half = step * Math.floor(levelCount / 2);
  const lower = Math.max(0.00000001, centerPrice - half);
  const upper = centerPrice + half;

  gridState.levels = generateGridLevels(lower, upper, levelCount, side, 'arithmetic');
  // Per-order notional size — leverage baked in via `size` so processFill round-trips carry leverage.
  const totalNotional = Math.max(0, allocatedCap) * leverage;
  gridState.baseOrderSize = totalNotional / Math.max(1, levelCount);
  gridState.sizeMultiplier = sizeMultiplier;
  gridState.pending = initializeOrders(centerPrice, gridState.levels, side, gridState.baseOrderSize, sizeMultiplier)
    .filter(o => side === 'long' ? o.type === 'buy' : o.type === 'sell');
  gridState.active = true;
  gridState.freshlySeeded = true;
}

/** Cancel all pending orders and mark the grid inactive. Open positions are closed separately. */
function teardownGrid(gridState: SideGridState): void {
  gridState.pending = [];
  gridState.levels = [];
  gridState.baseOrderSize = 0;
  gridState.sizeMultiplier = 0;
  gridState.active = false;
}

function createMarketEntryTakeProfitOrder(entryFill: Fill, levels: GridLevel[]): PendingOrder | null {
  const tpLevel = entryFill.side === 'long'
    ? levels.find(l => l.price > entryFill.fillPrice)
    : [...levels].reverse().find(l => l.price < entryFill.fillPrice);
  if (!tpLevel) return null;

  const type: OrderType = entryFill.side === 'long' ? 'sell' : 'buy';
  return {
    id: `${entryFill.orderId}_tp`,
    side: entryFill.side,
    type,
    levelIndex: tpLevel.index,
    price: tpLevel.price,
    size: entryFill.size,
    sizeMultiplier: 1,
    positionId: entryFill.positionId,
  };
}

function openMarketPosition(
  pnlState: PnLState,
  side: GridSide,
  candle: OHLC,
  candleIdx: number,
  sizeUSDT: number,
  leverage: number,
  feeRate: number,
  slippageCfg: SlippageConfig,
  atr: number,
  positionId: string,
  outFills: Fill[]
): Fill | null {
  if (sizeUSDT <= 0) return null;
  const effectiveSize = sizeUSDT * leverage;
  const orderType = side === 'long' ? 'buy' : 'sell';
  const atrFrac = atrFractionOfPrice(atr, candle.close);
  const entryPrice = applySlippage(candle.close, orderType, side, atrFrac, false, slippageCfg);
  const qty = effectiveSize / entryPrice;
  const fees = qty * entryPrice * feeRate;

  pnlState.openPositions.push({
    side,
    entryType: orderType,
    entryPrice,
    size: effectiveSize,
    levelIndex: MARKET_ENTRY_LEVEL_INDEX,
    entryFees: fees,
    positionId,
  });
  pnlState.totalFees += fees;
  if (side === 'long') pnlState.longFillCount++;
  else pnlState.shortFillCount++;

  const fill: Fill = {
    orderId: `entry_${side}_${candleIdx}`,
    side,
    type: orderType,
    levelIndex: MARKET_ENTRY_LEVEL_INDEX,
    fillPrice: entryPrice,
    candleIdx,
    timestamp: candle.timestamp,
    size: effectiveSize,
    fees,
    positionId,
    pnl: 0,
    pnlPct: 0,
  };
  outFills.push(fill);
  return fill;
}

function closeMarketPosition(
  pnlState: PnLState,
  side: GridSide,
  candle: OHLC,
  candleIdx: number,
  leverage: number,
  feeRate: number,
  slippageCfg: SlippageConfig,
  atr: number,
  totalCapital: number,
  outFills: Fill[]
): void {
  const positions = pnlState.openPositions.filter(p => p.side === side);
  if (positions.length === 0) return;

  for (const pos of positions) {
    const exitType = pos.entryType === 'buy' ? 'sell' : 'buy';
    const atrFrac = atrFractionOfPrice(atr, candle.close);
    const exitPrice = applySlippage(candle.close, exitType, side, atrFrac, false, slippageCfg);
    const qty = pos.size / pos.entryPrice;
    const fees = pos.size * feeRate;

    let pnl: number;
    if (exitType === 'sell') {
      pnl = (exitPrice - pos.entryPrice) * qty - pos.entryFees - fees;
    } else {
      pnl = (pos.entryPrice - exitPrice) * qty - pos.entryFees - fees;
    }

    pnlState.realizedPnl += pnl;
    if (side === 'long') pnlState.longRealizedPnl += pnl;
    else pnlState.shortRealizedPnl += pnl;
    if (pnl > 0) pnlState.winCount++;
    else if (pnl < 0) pnlState.lossCount++;
    pnlState.totalFees += fees;

    updateDrawdown(pnlState, totalCapital, candle.close);

    outFills.push({
      orderId: `exit_${side}_${candleIdx}_${pos.levelIndex}`,
      side,
      type: exitType,
      levelIndex: pos.levelIndex,
      fillPrice: exitPrice,
      candleIdx,
      timestamp: candle.timestamp,
      size: pos.size,
      fees,
      pnl,
      pnlPct: totalCapital > 0 ? (pnl / totalCapital) * 100 : 0,
    });
  }
  pnlState.openPositions = pnlState.openPositions.filter(p => p.side !== side);
  if (side === 'long') pnlState.longFillCount += positions.length;
  else pnlState.shortFillCount += positions.length;
}

function supervisorEvent(e: ComboEvent, longMult: number, shortMult: number): ComboSupervisorEvent {
  return {
    candleIdx: e.candleIdx,
    timestamp: e.timestamp,
    type: e.type,
    detailsJson: JSON.stringify({
      side: e.side,
      phase: e.phase,
      snapshot: e.snapshot,
    }),
    longMultiplier: longMult,
    shortMultiplier: shortMult,
  };
}
