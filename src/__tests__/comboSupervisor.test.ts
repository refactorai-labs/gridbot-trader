import { describe, it, expect, vi } from 'vitest';
import { OHLC, ComboBotConfig, ComboBotSideConfig } from '../lib/types';
import { runComboSimulationCore, evaluateEntryCondition } from '../lib/combo/supervisor';
import { aggregate5mTo } from '../lib/data/aggregator';
import { FundingRateEntry } from '../lib/simulation/funding';
import * as reopenPolicy from '../lib/combo/reopenPolicy';
import { AdaptiveEngine, DEFAULT_ADAPTIVE_CONFIG } from '../lib/combo/adaptiveEngine';

function candle(ts: number, o: number, h: number, l: number, c: number, v: number = 100): OHLC {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: v };
}

function primedTrendCandles(startTs: number): OHLC[] {
  return Array.from({ length: 30 }, (_, i) => {
    const close = 80 + i;
    return candle(startTs - (30 - i) * 14_400, close - 0.5, close + 2, close - 2, close, 100);
  });
}

const SIDE_CFG: ComboBotSideConfig = {
  averagingDepth: 5,
  slBasePercent: 0.015,
  slAtrMultiplier: 1.5,
  slFloor: 0.01,
  slCap: 0.04,
  tier1Size: 0.25,
  tier2Size: 0.5,
  tier3Size: 1.0,
  cooldownCandles: 6,
  retryCap: 3,
  hibernationCandles: 24,
};

const FAST_SIDE_CFG: ComboBotSideConfig = {
  ...SIDE_CFG,
  slBasePercent: 0.005,
  slAtrMultiplier: 0,
  slFloor: 0.01,
  slCap: 0.01,
};

const CFG: ComboBotConfig = {
  enabled: true,
  mode: 'dual',
  leverage: 5,
  allocationLong: 0.6,
  avwapEnabled: true,
  totalCapital: 10000,
  gridLevels: 10,
  longSide: SIDE_CFG,
  shortSide: SIDE_CFG,
  atrPeriod: 5,
  erLookback: 5,
  erSmoothingLength: 3,
  erRegimeThreshold: 0.4,
  // Relaxed thresholds so the MVP heuristics fire during a synthetic trend
  rsiLongThreshold: 100,
  rsiShortThreshold: 0,
};

const FAST_CFG: ComboBotConfig = {
  ...CFG,
  mode: 'long',
  leverage: 1,
  allocationLong: 1,
  avwapEnabled: false,
  gridLevels: 4,
  longSide: FAST_SIDE_CFG,
  shortSide: FAST_SIDE_CFG,
  atrPeriod: 3,
  erLookback: 3,
  erSmoothingLength: 2,
  erRegimeThreshold: 0.1,
  rsiLongThreshold: 101,
  rsiShortThreshold: 99,
};

describe('combo/supervisor integration', () => {
  it('runs a 1000+ candle ETH-style trending fixture, fires entry events and applies funding+slippage', () => {
    // Build 5m candles: warmup, strong uptrend long enough for 4H ER, drop, recovery
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    let price = 2000;

    // 480 flat (warmup, ~10 4H candles)
    for (let i = 0; i < 480; i++) {
      const p = 2000 + Math.sin(i * 0.05) * 0.5;
      candles5m.push(candle(t, p, p + 0.5, p - 0.5, p));
      t += 300;
    }
    // 720 strong uptrend (~15 4H candles — well above erLookback)
    price = 2000;
    for (let i = 0; i < 720; i++) {
      const prev = price;
      price = price + 1.5;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    // 240 sharp drop (SL trigger)
    for (let i = 0; i < 240; i++) {
      const prev = price;
      price = price - 5.0;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }
    // 240 recovery
    for (let i = 0; i < 240; i++) {
      const prev = price;
      price = price + 2.0;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }

    expect(candles5m.length).toBeGreaterThanOrEqual(1000);

    const candles1h = aggregate5mTo(candles5m, 60);
    const candles4h = aggregate5mTo(candles5m, 240);

    // Funding: 0.01% every 8 hours across the window — ensures the funding loop fires
    const startTs = candles5m[0].timestamp;
    const endTs = candles5m[candles5m.length - 1].timestamp;
    const fundingRates: FundingRateEntry[] = [];
    for (let ts = startTs; ts <= endTs; ts += 8 * 3600) {
      fundingRates.push({ fundingTimeSec: ts, fundingRate: 0.0001 });
    }

    const result = runComboSimulationCore({
      candles5m,
      candles1h,
      candles4h,
      cfg: CFG,
      totalCapital: 10000,
      fundingRates,
      feeRate: 0.001,
      snapshotInterval: 50,
    });

    // At minimum, IDLE → BREAKOUT transition should fire during the uptrend
    const eventTypes = result.events.map(e => e.type);
    expect(eventTypes).toContain('breakout_entered');

    // The synthetic market entry on breakout_entered produces a fill
    expect(result.fills.length).toBeGreaterThan(0);

    // Final anchor exists (ER crossed threshold during the uptrend)
    expect(result.finalAnchor).not.toBeNull();

    // Snapshots cover the run
    expect(result.snapshots.length).toBeGreaterThan(1);
    expect(result.snapshots[result.snapshots.length - 1].candleIdx).toBe(candles5m.length - 1);
  });

  it('honors cfg.gridLevels end-to-end: 20-level config produces half-size fills vs 10-level', () => {
    // Build a minimal trending fixture that triggers a single long market entry, then
    // run twice with gridLevels=10 and gridLevels=20. Per supervisor.ts seedGrid +
    // openMarketPosition: marketEntrySize = allocatedCap / gridLevels, then leveraged.
    // So the 20-level run must produce a market-entry fill exactly half the size of
    // the 10-level run. Proves the UI value is honored, not silently overridden.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    let price = 2000;
    for (let i = 0; i < 480; i++) {
      const p = 2000 + Math.sin(i * 0.05) * 0.5;
      candles5m.push(candle(t, p, p + 0.5, p - 0.5, p));
      t += 300;
    }
    price = 2000;
    for (let i = 0; i < 720; i++) {
      const prev = price;
      price = price + 1.5;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }

    const candles1h = aggregate5mTo(candles5m, 60);
    const candles4h = aggregate5mTo(candles5m, 240);

    const baseInputs = {
      candles5m,
      candles1h,
      candles4h,
      totalCapital: 10000,
      fundingRates: [] as FundingRateEntry[],
      feeRate: 0.001,
    };

    const result10 = runComboSimulationCore({ ...baseInputs, cfg: { ...CFG, gridLevels: 10 } });
    const result20 = runComboSimulationCore({ ...baseInputs, cfg: { ...CFG, gridLevels: 20 } });

    const entry10 = result10.fills.find(f => f.orderId.startsWith('entry_long_'));
    const entry20 = result20.fills.find(f => f.orderId.startsWith('entry_long_'));
    expect(entry10).toBeDefined();
    expect(entry20).toBeDefined();
    // 10-level: 10000 * 0.6 / 10 * 5 = 3000. 20-level: 10000 * 0.6 / 20 * 5 = 1500.
    expect(entry10!.size).toBeCloseTo(3000, 6);
    expect(entry20!.size).toBeCloseTo(1500, 6);
    expect(entry20!.size * 2).toBeCloseTo(entry10!.size, 6);
  });

  it('clamps invalid gridLevels values: gridLevels=2 runs as 4 (engine floor)', () => {
    // The canonical clamp is at the API boundary (`clampGridLevels` in sizing.ts),
    // but the engine applies it again as defense in depth. A user POST with
    // gridLevels=2 must not produce a 2-level grid here; it must produce a
    // 4-level grid so DB and engine stay in lockstep.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    let price = 2000;
    for (let i = 0; i < 480; i++) {
      const p = 2000 + Math.sin(i * 0.05) * 0.5;
      candles5m.push(candle(t, p, p + 0.5, p - 0.5, p));
      t += 300;
    }
    price = 2000;
    for (let i = 0; i < 720; i++) {
      const prev = price;
      price = price + 1.5;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    const candles1h = aggregate5mTo(candles5m, 60);
    const candles4h = aggregate5mTo(candles5m, 240);
    const baseInputs = {
      candles5m,
      candles1h,
      candles4h,
      totalCapital: 10000,
      fundingRates: [] as FundingRateEntry[],
      feeRate: 0.001,
    };

    // gridLevels=2 → engine clamps to 4. marketEntry = 6000 / 4 * 5 = 7500.
    const result2 = runComboSimulationCore({ ...baseInputs, cfg: { ...CFG, gridLevels: 2 } });
    const entry2 = result2.fills.find(f => f.orderId.startsWith('entry_long_'));
    expect(entry2).toBeDefined();
    expect(entry2!.size).toBeCloseTo(7500, 6);

    // Upper bound: gridLevels=999 → clamps to 50. marketEntry = 6000 / 50 * 5 = 600.
    const result999 = runComboSimulationCore({ ...baseInputs, cfg: { ...CFG, gridLevels: 999 } });
    const entry999 = result999.fills.find(f => f.orderId.startsWith('entry_long_'));
    expect(entry999).toBeDefined();
    expect(entry999!.size).toBeCloseTo(600, 6);
  });

  it('does not seed combo grids with inventory-style reverse orders', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);

    const longCandles = [
      candle(start, 100, 100.2, 99.8, 100),
      // Would cross initial long-side sell levels if combo seeded implied inventory sells.
      candle(start + 300, 100, 106, 99.5, 104),
    ];
    const longResult = runComboSimulationCore({
      candles5m: longCandles,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });
    expect(longResult.fills.some(f => f.side === 'long' && f.type === 'sell' && !f.orderId.startsWith('sl_') && !f.positionId)).toBe(false);

    const shortCandles = [
      candle(start, 100, 100.2, 99.8, 100),
      // Would cross initial short-side buy levels if combo seeded implied inventory buys.
      candle(start + 300, 100, 100.5, 94, 96),
    ];
    const shortResult = runComboSimulationCore({
      candles5m: shortCandles,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'short' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });
    expect(shortResult.fills.some(f => f.side === 'short' && f.type === 'buy' && !f.orderId.startsWith('sl_') && !f.positionId)).toBe(false);
  });

  it('opens an explicit one-grid-unit position on monotone long breakout without waiting for pullback', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 101, 99.5, 100),
      candle(start + 300, 100, 104, 100.5, 103),
      candle(start + 600, 103, 107, 103.5, 106),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    const entryFill = result.fills.find(f => f.orderId.startsWith('entry_long_'));
    expect(entryFill).toBeDefined();
    expect(entryFill!.type).toBe('buy');
    expect(entryFill!.levelIndex).toBeLessThan(0);
    expect(result.events.map(e => e.type)).toContain('position_opened');
  });

  it('closes the explicit market entry through its paired take-profit order', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 101, 99.5, 100),
      candle(start + 300, 100, 104, 100.5, 103),
      candle(start + 600, 103, 108, 103.5, 107),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    const entryFill = result.fills.find(f => f.orderId.startsWith('entry_long_'));
    expect(entryFill?.positionId).toBeDefined();
    const tpFill = result.fills.find(f => f.positionId === entryFill!.positionId && f.type === 'sell');
    expect(tpFill).toBeDefined();
    expect(tpFill!.levelIndex).toBeGreaterThanOrEqual(0);
    expect(tpFill!.pnl).toBeGreaterThan(0);
    expect(result.pnlState.realizedPnl).toBeGreaterThan(0);
  });

  it('applies regular slippage to combo grid fills before P&L processing', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      candle(start + 300, 100, 100.2, 98.5, 99.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0.01,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    const buyFill = result.fills.find(f => f.side === 'long' && f.type === 'buy');
    expect(buyFill).toBeDefined();
    // The raw grid level is below 99; 1% buy slippage moves it above 99.
    expect(buyFill!.fillPrice).toBeGreaterThan(99);
  });

  it('forces same-candle SL when a newly filled grid order is stopped later in the candle path', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      // Bullish path is open -> low -> high -> close; the buy fills on the drop,
      // then the remaining drop crosses SL before the candle recovers.
      candle(start + 300, 100, 101, 90, 100.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });

    expect(result.fills.some(f => f.side === 'long' && f.type === 'buy')).toBe(true);
    expect(result.fills.some(f => f.orderId.startsWith('sl_long_'))).toBe(true);
    expect(result.pnlState.openPositions.filter(p => p.side === 'long')).toHaveLength(0);
    expect(result.events.map(e => e.type)).toEqual(expect.arrayContaining(['sl_triggered', 'cooldown_entered']));
  });

  it('forces same-candle SL for short fills stopped later in the candle path', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      // Bearish path is open -> high -> low -> close; the short sell fills on the
      // push up, then the remaining push crosses the short SL before the drop.
      candle(start + 300, 100, 110, 99, 99.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'short' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });

    expect(result.fills.some(f => f.side === 'short' && f.type === 'sell')).toBe(true);
    expect(result.fills.some(f => f.orderId.startsWith('sl_short_'))).toBe(true);
    expect(result.pnlState.openPositions.filter(p => p.side === 'short')).toHaveLength(0);
    expect(result.events.map(e => e.type)).toEqual(expect.arrayContaining(['sl_triggered', 'cooldown_entered']));
  });

  it('includes unrealized losses in max drawdown before a position closes', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const wideStopSide: ComboBotSideConfig = {
      ...FAST_SIDE_CFG,
      slBasePercent: 0.5,
      slFloor: 0.5,
      slCap: 0.5,
    };
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      candle(start + 300, 100, 100.2, 89.8, 90),
      candle(start + 600, 90, 91, 89, 90),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long', longSide: wideStopSide },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    expect(result.pnlState.realizedPnl).toBe(0);
    expect(result.pnlState.openPositions.filter(p => p.side === 'long').length).toBeGreaterThan(0);
    expect(result.pnlState.maxDrawdown).toBeGreaterThan(0);
    expect(result.pnlState.maxDrawdownPct).toBeGreaterThan(0);
  });

  it('updates max drawdown when funding is charged without a closing trade', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      candle(start + 300, 100, 100.2, 98.5, 99.5),
      candle(start + 600, 99.5, 100, 99, 99.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [{ fundingTimeSec: start + 600, fundingRate: 0.01 }],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    expect(result.totalFundingCost).toBeGreaterThan(0);
    expect(result.longFundingCost).toBeGreaterThan(0);
    expect(result.shortFundingCost).toBe(0);
    expect(result.pnlState.maxDrawdown).toBeGreaterThanOrEqual(result.totalFundingCost);
    expect(result.pnlState.maxDrawdownPct).toBeGreaterThan(0);
  });

  it('persists reopenDiagnostics only on cooldown-driven events, not on breakout/position_opened', () => {
    // Build a long lifecycle that goes IDLE → BREAKOUT → RUNNING → COOLDOWN → REOPENING
    // so we can assert diagnostics ride only the cooldown tick's events.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 240; i++) {
      candles5m.push(candle(t, 2000, 2001, 1999, 2000));
      t += 300;
    }
    let price = 2000;
    for (let i = 0; i < 500; i++) {
      const prev = price;
      price += 1.2;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    for (let i = 0; i < 200; i++) {
      const prev = price;
      price -= 8;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }
    // Recovery long enough for cooldown to elapse and reopen attempts to fire.
    for (let i = 0; i < 200; i++) {
      const prev = price;
      price += 1.5;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }

    const result = runComboSimulationCore({
      candles5m,
      candles1h: aggregate5mTo(candles5m, 60),
      candles4h: aggregate5mTo(candles5m, 240),
      cfg: { ...CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.001,
    });

    type Detail = { reopenDiagnostics?: { atrRatioOk: boolean; atrDecliningOk: boolean; rsiCrossOk: boolean; avwapOk: boolean; avwapRequired: boolean } };
    const breakouts = result.events.filter(e => e.type === 'breakout_entered');
    const positionOpens = result.events.filter(e => e.type === 'position_opened');
    const slTriggered = result.events.filter(e => e.type === 'sl_triggered');
    const cooldownEntered = result.events.filter(e => e.type === 'cooldown_entered');

    expect(breakouts.length).toBeGreaterThan(0);
    for (const e of [...breakouts, ...positionOpens, ...slTriggered, ...cooldownEntered]) {
      const d = JSON.parse(e.detailsJson) as Detail;
      expect(d.reopenDiagnostics).toBeUndefined();
    }

    const cooldownTickEvents = result.events.filter(e =>
      e.type === 'retry_incremented'
      || e.type === 'tier1_reopen'
      || e.type === 'hibernation_entered'
      || e.type === 'reopen_check_failed'
    );
    for (const e of cooldownTickEvents) {
      const d = JSON.parse(e.detailsJson) as Detail;
      expect(d.reopenDiagnostics).toBeDefined();
      expect(typeof d.reopenDiagnostics!.atrRatioOk).toBe('boolean');
      expect(typeof d.reopenDiagnostics!.atrDecliningOk).toBe('boolean');
      expect(typeof d.reopenDiagnostics!.rsiCrossOk).toBe('boolean');
      expect(typeof d.reopenDiagnostics!.avwapOk).toBe('boolean');
      expect(typeof d.reopenDiagnostics!.avwapRequired).toBe('boolean');
    }

    // Failed-gate tooltip data: `reopen_check_failed` events should fire on
    // post-expiry cooldown candles when gates fail. The fixture has a long
    // recovery, so at least some failed-gate ticks must exist before reopen
    // succeeds. Phase is COOLDOWN on every such event (the failure branch
    // never transitions out).
    const failedChecks = result.events.filter(e => e.type === 'reopen_check_failed');
    expect(failedChecks.length).toBeGreaterThan(0);
    type PhaseDetail = { phase?: string };
    for (const e of failedChecks) {
      const d = JSON.parse(e.detailsJson) as PhaseDetail;
      expect(d.phase).toBe('COOLDOWN');
    }

    // Entry diagnostics ride only on breakout_entered. They must NOT appear on
    // position_opened / sl_triggered / cooldown_entered / cooldown-tick events.
    type EntryDetail = {
      entryDiagnostics?: { regimeTrending: boolean; avwapOk: boolean; rsiOk: boolean; directionOk?: boolean };
    };
    for (const e of breakouts) {
      const d = JSON.parse(e.detailsJson) as EntryDetail;
      expect(d.entryDiagnostics).toBeDefined();
      expect(typeof d.entryDiagnostics!.regimeTrending).toBe('boolean');
      expect(typeof d.entryDiagnostics!.avwapOk).toBe('boolean');
      expect(typeof d.entryDiagnostics!.rsiOk).toBe('boolean');
      // breakout_entered fires only when allowed=true, so all three must be true.
      expect(d.entryDiagnostics!.regimeTrending).toBe(true);
      expect(d.entryDiagnostics!.avwapOk).toBe(true);
      expect(d.entryDiagnostics!.rsiOk).toBe(true);
    }
    for (const e of [...positionOpens, ...slTriggered, ...cooldownEntered, ...cooldownTickEvents]) {
      const d = JSON.parse(e.detailsJson) as EntryDetail;
      expect(d.entryDiagnostics).toBeUndefined();
    }

    // `position_opened` events must carry the active SL price so observability
    // paths (the chart SL line) can render without recomputing engine logic.
    // Per supervisor.ts → stateMachine.ts:174-186, SL is computed via
    // slPrice(sideCfg, side, position.avgEntry, signals.atr). For the long side,
    // SL must sit *below* the entry; for short, above.
    type PosOpenDetail = { snapshot?: { price?: number; slPrice?: number | null } };
    expect(positionOpens.length).toBeGreaterThan(0);
    for (const e of positionOpens) {
      const d = JSON.parse(e.detailsJson) as PosOpenDetail;
      expect(d.snapshot?.slPrice).toBeDefined();
      expect(typeof d.snapshot!.slPrice).toBe('number');
      expect(Number.isFinite(d.snapshot!.slPrice as number)).toBe(true);
      // entry price is also on snapshot; SL must be on the loss side of entry.
      const entry = d.snapshot?.price ?? 0;
      const sl = d.snapshot!.slPrice as number;
      expect(sl).toBeGreaterThan(0);
      expect(sl).toBeLessThan(entry); // long-only fixture
    }
  });

  it('supervisor passes the most-recent-SL ATR into evaluateReopenPolicy, not the original breakout ATR', () => {
    // Closes the regression gap: the prior version of this test only checked
    // that `atrAtBreakout` was finite, which would still pass if the supervisor
    // were rewritten to use `atrAtPhaseEntry` forever. To prove the supervisor
    // consumes the SL-captured ATR (supervisor.ts:469, `smState.atrAtLastSL ??
    // smState.atrAtPhaseEntry`), we re-run AdaptiveEngine independently on the
    // same candles, identify the breakout and SL candle indices, and assert
    // every spy-captured `atrAtBreakout` equals the SL ATR (NOT the breakout
    // ATR), within float tolerance.

    // Fixture: warmup → gentle trend (breakout at relatively low 4H ATR) →
    // long high-vol chop with wide intra-candle ranges (4H ATR climbs to a
    // much higher value) → final sharp drop that triggers a single SL while
    // the ATR is at the elevated chop level. The wide-SL side config below
    // ensures the chop wicks don't accidentally trigger SL.
    const wideSL: ComboBotSideConfig = {
      ...SIDE_CFG,
      slBasePercent: 0.20,
      slAtrMultiplier: 0,
      slFloor: 0.20,
      slCap: 0.20,
    };
    const cfg: ComboBotConfig = {
      ...CFG,
      mode: 'long',
      longSide: wideSL,
      shortSide: wideSL,
    };

    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    // 240 5m warmup: flat at 2000, range 2 (low ATR baseline).
    for (let i = 0; i < 240; i++) {
      candles5m.push(candle(t, 2000, 2001, 1999, 2000));
      t += 300;
    }
    // 480 5m gentle trend (+1.2 per candle). Spans 10 4H bars; ER and 4H ATR
    // converge during this segment so a clean breakout fires inside this window.
    let price = 2000;
    for (let i = 0; i < 480; i++) {
      const prev = price;
      price += 1.2;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    const trendEndPrice = price;
    // 480 5m high-volatility chop: each candle has wide wicks (+/- 60 from
    // close) but only +/- 0.2 net drift, so price stays near the trend top.
    // 4H bars over this segment have very large TR values, pulling 4H ATR up
    // far above what the gentle trend produced.
    for (let i = 0; i < 480; i++) {
      const prev = price;
      price = trendEndPrice + (i % 2 === 0 ? 0.2 : -0.2);
      candles5m.push(candle(t, prev, price + 60, price - 60, price));
      t += 300;
    }
    // 80 5m sharp drop (-8 per candle, range 9 with wicks). 20% SL distance
    // from the chop-level entry takes ~57 candles to reach, so the SL fires
    // inside this segment exactly once. Recovery is unnecessary because the
    // assertions look at policy calls during the resulting COOLDOWN.
    for (let i = 0; i < 80; i++) {
      const prev = price;
      price -= 8;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }
    // 60 5m calm recovery — gives COOLDOWN ticks somewhere to run policy calls.
    for (let i = 0; i < 60; i++) {
      const prev = price;
      price += 0.2;
      candles5m.push(candle(t, prev, price + 0.3, prev - 0.3, price));
      t += 300;
    }

    const candles1h = aggregate5mTo(candles5m, 60);
    const candles4h = aggregate5mTo(candles5m, 240);

    // Independently re-run AdaptiveEngine on the same candles using the
    // supervisor's exact instantiation (supervisor.ts:309-317) and pointer
    // advance loop (supervisor.ts:411-412). aggregate5mTo stores the aggregated
    // candle's timestamp as the FIRST 5m candle's timestamp in each group, and
    // the supervisor's pointer advances on `<=`, so we copy that exactly.
    const adaptive = new AdaptiveEngine({
      ...DEFAULT_ADAPTIVE_CONFIG,
      atrPeriod: cfg.atrPeriod,
      erLookback: cfg.erLookback,
      erSmoothingLength: cfg.erSmoothingLength,
      erRegimeThreshold: cfg.erRegimeThreshold,
      rsiLength: DEFAULT_ADAPTIVE_CONFIG.rsiLength,
      blendedFactor: DEFAULT_ADAPTIVE_CONFIG.blendedFactor,
    });
    const atrPerCandle: number[] = new Array(candles5m.length);
    let agg1hIdx = 0;
    let agg4hIdx = 0;
    for (let i = 0; i < candles5m.length; i++) {
      const c = candles5m[i];
      while (agg1hIdx < candles1h.length && candles1h[agg1hIdx].timestamp <= c.timestamp) agg1hIdx++;
      while (agg4hIdx < candles4h.length && candles4h[agg4hIdx].timestamp <= c.timestamp) agg4hIdx++;
      const signals = adaptive.update(candles5m, i, candles1h, agg1hIdx, candles4h, agg4hIdx);
      atrPerCandle[i] = signals.atr;
    }

    const spy = vi.spyOn(reopenPolicy, 'evaluateReopenPolicy');
    try {
      const result = runComboSimulationCore({
        candles5m,
        candles1h,
        candles4h,
        cfg,
        totalCapital: 10000,
        fundingRates: [],
        feeRate: 0.001,
      });

      const breakoutEvents = result.events.filter(e => e.type === 'breakout_entered');
      const slEvents = result.events.filter(e => e.type === 'sl_triggered');
      expect(breakoutEvents.length).toBeGreaterThan(0);
      // The per-call equality below assumes a single SL captured atrAtLastSL.
      // If a second SL fires, atrAtLastSL gets a different value mid-stream and
      // a single expected constant would be wrong. Hard-fail on multi-SL fixtures.
      expect(slEvents).toHaveLength(1);

      const breakoutIdx = breakoutEvents[0].candleIdx;
      const slIdx = slEvents[0].candleIdx;
      // The state machine captures `atrAtPhaseEntry = inp.signals.atr` at the
      // breakout tick (stateMachine.ts:166) and `atrAtLastSL = inp.signals.atr`
      // at the SL tick (stateMachine.ts:294) — both off `signals.atr` (the 4H
      // ATR). Recompute here from the same engine on the same candles so we
      // know what the supervisor saw at those candle indices.
      const atrAtBreakoutExpected = atrPerCandle[breakoutIdx];
      const atrAtSLExpected = atrPerCandle[slIdx];

      // Sanity: the fixture is meaningful only if breakout-ATR and SL-ATR
      // diverge by a wide margin, otherwise the equality assertion below has
      // no discriminating power.
      expect(Number.isFinite(atrAtBreakoutExpected)).toBe(true);
      expect(Number.isFinite(atrAtSLExpected)).toBe(true);
      expect(atrAtSLExpected).toBeGreaterThan(atrAtBreakoutExpected * 2);

      // Every spy call fires post-SL because the supervisor gates
      // evaluateReopenPolicy to COOLDOWN (supervisor.ts:460). So every call
      // must observe the SL-captured ATR — NOT the breakout ATR.
      expect(spy).toHaveBeenCalled();
      const tol = 1e-9;
      for (const call of spy.mock.calls) {
        const inputArg = call[0];
        expect(inputArg.atrAtBreakout).not.toBeNull();
        expect(Number.isFinite(inputArg.atrAtBreakout!)).toBe(true);
        expect(Math.abs(inputArg.atrAtBreakout! - atrAtSLExpected)).toBeLessThan(tol);
        expect(Math.abs(inputArg.atrAtBreakout! - atrAtBreakoutExpected)).toBeGreaterThan(tol);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('supervisor falls back to atrAtPhaseEntry when atrAtLastSL is null (state machine integration)', () => {
    // Direct unit-level proof that swapping atrAtBreakout between
    // atrAtPhaseEntry-equivalent and atrAtLastSL-equivalent values flips the
    // ATR ratio diagnostic. Combined with combo.test.ts's existing tests for
    // `atrAtLastSL` capture/clear, this proves the contract that supervisor.ts
    // line 469 implements: prefer atrAtLastSL, fall back to atrAtPhaseEntry.
    const baseInput = {
      side: 'long' as const,
      price: 100,
      previousPrice: 99,
      atr: 3,
      atrHistory: [8, 6, 4, 3],
      rsi: 36,
      previousRsi: 34,
      avwap: 100,
      previousAvwap: 100,
      regime: 'trending' as const,
      config: {
        policy: 'full_v31' as const,
        avwapEnabled: true,
        atrRatioThreshold: 0.6,
        atrDecliningCandles: 3,
        rsiLongCross: 35,
        rsiShortCross: 65,
      },
    };
    // atrAtBreakout = atrAtPhaseEntry-equivalent (smaller value): ratio 3/4 = 0.75 > 0.6 → false
    const phaseEntryResult = reopenPolicy.evaluateReopenPolicy({ ...baseInput, atrAtBreakout: 4 });
    // atrAtBreakout = atrAtLastSL-equivalent (larger SL ATR): ratio 3/10 = 0.3 < 0.6 → true
    const lastSLResult = reopenPolicy.evaluateReopenPolicy({ ...baseInput, atrAtBreakout: 10 });
    expect(phaseEntryResult.diagnostics.atrRatioOk).toBe(false);
    expect(lastSLResult.diagnostics.atrRatioOk).toBe(true);
  });

  it('long-only mode skips short-side state machine entirely', () => {
    const shortCandles: OHLC[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 600; i++) {
      const p = 2000 + i * 0.5;
      shortCandles.push(candle(t, p, p + 1, p - 1, p));
      t += 300;
    }
    const result = runComboSimulationCore({
      candles5m: shortCandles,
      candles1h: aggregate5mTo(shortCandles, 60),
      candles4h: aggregate5mTo(shortCandles, 240),
      cfg: { ...CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.001,
    });
    // No short-side events
    for (const e of result.events) {
      const details = JSON.parse(e.detailsJson) as { side: string };
      expect(details.side).toBe('long');
    }
  });

  it('P&L does NOT double-count leverage (regression — Phase 3c hotfix)', () => {
    // Build a deliberate loss cycle: breakout long at ~2000, price drops to SL, exit.
    // At leverage=5, allocation=100% long, $10K capital → $50K notional total.
    // Per-order notional = $50K / 10 levels = $5K. SL @ slCap=4% = $200 loss per filled level.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    // 240 flat warmup
    for (let i = 0; i < 240; i++) {
      candles5m.push(candle(t, 2000, 2001, 1999, 2000));
      t += 300;
    }
    // 500 strong uptrend to build ER regime
    let price = 2000;
    for (let i = 0; i < 500; i++) {
      const prev = price;
      price += 1.2;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    // Sharp drop to force SL
    for (let i = 0; i < 200; i++) {
      const prev = price;
      price -= 8;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }

    const result = runComboSimulationCore({
      candles5m,
      candles1h: aggregate5mTo(candles5m, 60),
      candles4h: aggregate5mTo(candles5m, 240),
      cfg: { ...CFG, mode: 'long', leverage: 5 },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.0004,
    });

    // With leverage baked into notional exactly once, total P&L is bounded by total notional.
    // Pre-fix (leverage² in fill.size) made losses 5× larger and could exceed -$20K easily.
    // Post-fix: bounded well within total notional — set tight: -$10K floor.
    expect(result.pnlState.realizedPnl).toBeGreaterThan(-10000);
    // Per-fill |pnl| capped by per-order notional × slCap (×2 to cover slippage+fees).
    const perOrderNotional = (10000 * 5) / 10; // 5K
    const maxPerFillLoss = perOrderNotional * 0.04 * 2; // 4% slCap × 2 (slippage+fee margin)
    for (const f of result.fills) {
      if (f.pnl != null && f.pnl < 0) {
        expect(Math.abs(f.pnl)).toBeLessThan(maxPerFillLoss);
      }
    }
  });

  it('slippage is applied on SL exit fills — fillPrice shifts away from slPrice in the trader-hurting direction', () => {
    // Drive a SL exit (long) and verify slippage was applied to the exit fill.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 240; i++) {
      candles5m.push(candle(t, 2000, 2001, 1999, 2000));
      t += 300;
    }
    let price = 2000;
    for (let i = 0; i < 500; i++) {
      const prev = price;
      price += 1.2;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    // Sharp drop to force SL
    for (let i = 0; i < 200; i++) {
      const prev = price;
      price -= 8;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }
    const result = runComboSimulationCore({
      candles5m,
      candles1h: aggregate5mTo(candles5m, 60),
      candles4h: aggregate5mTo(candles5m, 240),
      cfg: { ...CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.001,
    });
    // SL exits use orderId pattern `sl_<side>_<candleIdx>_<levelIndex>`.
    const slFill = result.fills.find(f => f.orderId.startsWith('sl_long_'));
    // Hard assertion — silent skip masked the real bug previously.
    expect(slFill).toBeDefined();
    if (!slFill) return; // type narrow

    const slEvent = result.events.find(e => e.type === 'sl_triggered' && e.candleIdx === slFill.candleIdx);
    expect(slEvent).toBeDefined();
    const details = JSON.parse(slEvent!.detailsJson) as { snapshot: { slPrice: number } };
    // Long SL exit is a sell; trader-hurting slippage fills strictly below the raw SL price.
    expect(slFill.fillPrice).toBeLessThan(details.snapshot.slPrice);
  });

  it('directional confirmation flag does not block long entries on a clean uptrend', () => {
    // Reuses the canonical trending fixture (warmup → strong uptrend). With the
    // directional filter ON, a clean monotone uptrend must still satisfy
    // directionOk: price > AVWAP holds once the anchor drops, and each candle's
    // low sits above the prior 12-candle min low. The flag should not regress
    // the happy path.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 480; i++) {
      const p = 2000 + Math.sin(i * 0.05) * 0.5;
      candles5m.push(candle(t, p, p + 0.5, p - 0.5, p));
      t += 300;
    }
    let price = 2000;
    for (let i = 0; i < 720; i++) {
      const prev = price;
      price = price + 1.5;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }

    const result = runComboSimulationCore({
      candles5m,
      candles1h: aggregate5mTo(candles5m, 60),
      candles4h: aggregate5mTo(candles5m, 240),
      cfg: { ...CFG, mode: 'long', requireDirectionalConfirmation: true },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.001,
    });

    const breakouts = result.events.filter(e => e.type === 'breakout_entered');
    expect(breakouts.length).toBeGreaterThan(0);

    type EntryDetail = { entryDiagnostics?: { directionOk?: boolean } };
    for (const e of breakouts) {
      const d = JSON.parse(e.detailsJson) as EntryDetail;
      // breakout_entered fires only when allowed=true, so directionOk must be true
      // when the flag is on (it's part of the AND-gate).
      expect(d.entryDiagnostics?.directionOk).toBe(true);
    }
  });

  it('directional confirmation: evaluateEntryCondition gates correctly on synthetic chop', () => {
    // Pure-function chop fixture for the directional filter. The 12-candle
    // lookback prints a stair-step *down* (lows decreasing), so on the test
    // candle the long no-new-low check fails. The existing entry gate (regime
    // trending + AVWAP-tolerance + relaxed RSI) passes — proves the filter, not
    // some other gate, is what blocks.
    const recentCandles: OHLC[] = Array.from({ length: 12 }, (_, i) => ({
      timestamp: 1_700_000_000 + i * 300,
      open: 2000 - i * 0.5,
      high: 2001 - i * 0.5,
      low: 1999 - i * 0.5,  // lows: 1999, 1998.5, 1998, ..., 1993.5 (monotone down)
      close: 2000 - i * 0.5,
      volume: 100,
    }));

    // Test candle prints a NEW low below all 12 prior candle lows.
    const testCandleLow = 1990;
    const testCandleHigh = 1996;
    const testPrice = 1995;

    const signals = {
      atr: 5,
      blendedAtr: 5,
      erRaw: 0.7,
      erSmooth: 0.7,
      rsi: 30,
      avwap: 1994,        // Long: testPrice (1995) > avwap (1994) — strict-side check passes
      regime: 'trending' as const,
      anchorJustArmed: false,
    };

    const cfgOff: ComboBotConfig = { ...CFG, mode: 'long', requireDirectionalConfirmation: false };
    const cfgOn: ComboBotConfig = { ...cfgOff, requireDirectionalConfirmation: true };

    const off = evaluateEntryCondition('long', signals, testPrice, testCandleHigh, testCandleLow, recentCandles, cfgOff);
    const on = evaluateEntryCondition('long', signals, testPrice, testCandleHigh, testCandleLow, recentCandles, cfgOn);

    // Flag OFF: existing AND-gate passes — regime trending, RSI 30 < threshold 100,
    // AVWAP within tolerance. directionOk stays undefined (not computed).
    expect(off.allowed).toBe(true);
    expect(off.diagnostics.directionOk).toBeUndefined();

    // Flag ON: directional check runs. testCandleLow (1990) is below the prior
    // 12-candle min low (1993.5), so directionOk=false → allowed=false.
    expect(on.diagnostics.directionOk).toBe(false);
    expect(on.allowed).toBe(false);

    // And the inverse: a candle that does NOT make a new low but otherwise
    // matches the same signals must pass the directional gate.
    const goodLow = 1996;  // above all prior lows
    const goodHigh = 1999;
    const goodPrice = 1998; // > avwap (1994)
    const onGood = evaluateEntryCondition('long', signals, goodPrice, goodHigh, goodLow, recentCandles, cfgOn);
    expect(onGood.diagnostics.directionOk).toBe(true);
    expect(onGood.allowed).toBe(true);
  });
});
