// Strategy B research engine — honest fill simulation.
//
// All executions (grid fills, partial closes, stops) happen against 1m bars,
// walking a deterministic intra-candle path (open → extremes → close, same
// convention as simulation/orderMatcher.getIntraCandlePath). Strategy-level
// decisions run ONLY on closed 30m bars; taker actions they queue execute at
// the next 1m open, so no decision can act on prices it could not have seen.
//
// Grid counter-orders are exchange mechanics, not signals: when an opening
// fill happens, its take-profit counter is placed immediately (as a real grid
// bot does), eligible from the next path segment.

import { OHLC } from '../types';
import { getIntraCandlePath } from '../simulation/orderMatcher';
import { applySlippage, SlippageConfig, DEFAULT_SLIPPAGE } from '../simulation/slippage';
import { FundingRateEntry } from '../simulation/funding';
import { computeATR } from '../indicators/atr';
import { PerpAccount } from './account';
import {
  EquityPoint,
  FeeConfig,
  GridDef,
  GridOrder,
  LegSide,
  MarketAction,
  ResearchEvent,
} from './types';

const THIRTY_MIN = 1800;

export interface StrategyApi {
  account: PerpAccount;
  // Replace a leg's grid. Arming is deferred to the NEXT 1m bar open (the
  // first price the decision could actually trade at): entry limits rest on
  // the entry side of that open (long: buys below, short: sells above), and
  // an initial taker position is opened for the TP-side levels with a
  // reduceOnly TP resting at each — Pionex-style "grid with initial
  // position". Existing lots are untouched; existing orders are replaced.
  setGrid(leg: LegSide, def: GridDef): void;
  // Cancel a leg's resting orders without touching lots or stop.
  clearGrid(leg: LegSide): void;
  // Cancel only the leg's OPENING orders and stop re-arming entries on TP
  // fills; resting reduceOnly TPs keep working. Used when a leg becomes a
  // static hedge after banking.
  cancelEntries(leg: LegSide): void;
  setStop(leg: LegSide, price: number | null): void;
  // Queue a taker action executed at the next 1m bar open.
  queueAction(action: MarketAction): void;
}

export interface SignalContext {
  closed30m: OHLC[]; // grows in place; only fully closed 30m bars
  nowSec: number;    // close time of the latest closed 30m bar
  api: StrategyApi;
}

export interface StrategyHooks {
  onSignal(ctx: SignalContext): void;
}

export interface FillSimConfig {
  initialCapital: number;
  fees: FeeConfig;
  slippage?: SlippageConfig;
  atrPeriod?: number; // 30m ATR period used for stop slippage scaling (default 14)
}

export interface FillSimResult {
  account: PerpAccount;
  events: ResearchEvent[];
  equity: EquityPoint[];
}

interface LegRuntime {
  gridDef: GridDef | null;
}

export function runFillSim(opts: {
  candles1m: OHLC[];
  candles30m: OHLC[];
  fundingRates: FundingRateEntry[];
  config: FillSimConfig;
  hooks: StrategyHooks;
}): FillSimResult {
  const { candles1m, candles30m, fundingRates, config, hooks } = opts;
  const slippageCfg = config.slippage ?? DEFAULT_SLIPPAGE;
  const account = new PerpAccount(config.initialCapital, config.fees);
  const events: ResearchEvent[] = [];
  const equity: EquityPoint[] = [];
  const atr30 = computeATR(candles30m, config.atrPeriod ?? 14).values;

  const runtime: Record<LegSide, LegRuntime> = {
    long: { gridDef: null },
    short: { gridDef: null },
  };
  const pendingActions: MarketAction[] = [];
  const pendingArms: Array<{ leg: LegSide; def: GridDef }> = [];
  const closedView: OHLC[] = [];
  let idx30 = 0; // number of closed 30m bars
  let fundingIdx = 0;

  // ---- strategy API ---------------------------------------------------------

  const api: StrategyApi = {
    account,
    setGrid(leg, def) {
      // Replace any not-yet-armed grid for this leg, then defer to next open.
      for (let i = pendingArms.length - 1; i >= 0; i--) {
        if (pendingArms[i].leg === leg) pendingArms.splice(i, 1);
      }
      pendingArms.push({ leg, def });
    },
    clearGrid(leg) {
      account.cancelAllOrders(leg);
      runtime[leg].gridDef = null;
      for (let i = pendingArms.length - 1; i >= 0; i--) {
        if (pendingArms[i].leg === leg) pendingArms.splice(i, 1);
      }
    },
    cancelEntries(leg) {
      account.legs[leg].orders = account.legs[leg].orders.filter(o => o.reduceOnly);
      runtime[leg].gridDef = null; // no re-arm of entries when remaining TPs fill
    },
    setStop(leg, price) {
      account.legs[leg].stopPrice = price;
    },
    queueAction(action) {
      pendingActions.push(action);
    },
  };

  // ---- helpers --------------------------------------------------------------

  function lastClosedAtrFraction(price: number): number {
    const i = idx30 - 1;
    const atr = i >= 0 && i < atr30.length ? atr30[i] : NaN;
    return isFinite(atr) && price > 0 ? atr / price : 0;
  }

  // Arm a leg's grid at a 1m bar open: entry limits on the entry side, an
  // initial taker position covering the TP-side levels, one reduceOnly TP per
  // TP-side level against that initial lot.
  function armGrid(leg: LegSide, def: GridDef, openPrice: number, timeSec: number): void {
    account.cancelAllOrders(leg);
    runtime[leg].gridDef = def;
    account.legs[leg].active = true;

    const tpLevels: number[] = [];
    for (let i = 0; i < def.levels.length; i++) {
      const price = def.levels[i];
      const isEntrySide = leg === 'long' ? price < openPrice : price > openPrice;
      const isTpSide = leg === 'long' ? price > openPrice : price < openPrice;
      if (isEntrySide) {
        account.placeOrder({
          leg, type: leg === 'long' ? 'buy' : 'sell', price,
          qty: def.qtyPerLevel, levelIndex: i, reduceOnly: false,
        });
      } else if (isTpSide) {
        tpLevels.push(i);
      }
    }

    const initialFraction = def.initialFraction ?? 1;
    if (tpLevels.length > 0 && initialFraction > 0) {
      const qty = def.qtyPerLevel * tpLevels.length * initialFraction;
      const entryType = leg === 'long' ? 'buy' : 'sell';
      const fillPrice = applySlippage(openPrice, entryType, leg, 0, false, slippageCfg);
      const lot = account.openLot(leg, qty, fillPrice, account.fees.takerFee, timeSec, -1);
      events.push({
        type: 'initialOpen', timeSec, leg, orderType: entryType, price: fillPrice,
        qty, fee: qty * fillPrice * account.fees.takerFee,
      });
      for (const i of tpLevels) {
        account.placeOrder({
          leg, type: leg === 'long' ? 'sell' : 'buy', price: def.levels[i],
          qty: def.qtyPerLevel * initialFraction, levelIndex: i, reduceOnly: true, lotId: lot.id,
        });
      }
    }
  }

  // Execute a maker grid fill and place its counter order (grid churn mechanics).
  function executeGridFill(order: GridOrder, timeSec: number, placedSeg: Map<string, number>, seg: number): void {
    const leg = account.legs[order.leg];
    account.removeOrder(order.leg, order.id);
    const def = runtime[order.leg].gridDef;

    if (!order.reduceOnly) {
      const lot = account.openLot(order.leg, order.qty, order.price, account.fees.makerFee, timeSec, order.levelIndex);
      events.push({
        type: 'gridFill', timeSec, leg: order.leg, orderType: order.type, price: order.price,
        qty: order.qty, fee: order.qty * order.price * account.fees.makerFee,
        levelIndex: order.levelIndex, reduceOnly: false,
      });
      if (def) {
        // TP counter one level toward profit: long sells above, short buys below.
        const tpIdx = order.leg === 'long' ? order.levelIndex + 1 : order.levelIndex - 1;
        if (tpIdx >= 0 && tpIdx < def.levels.length) {
          const placed = account.placeOrder({
            leg: order.leg, type: order.leg === 'long' ? 'sell' : 'buy',
            price: def.levels[tpIdx], qty: order.qty, levelIndex: tpIdx,
            reduceOnly: true, lotId: lot.id,
          });
          placedSeg.set(placed.id, seg);
        }
      }
    } else {
      const res = account.closeQty(order.leg, order.qty, order.price, account.fees.makerFee, order.lotId);
      events.push({
        type: 'gridFill', timeSec, leg: order.leg, orderType: order.type, price: order.price,
        qty: res.qty, fee: res.fee, realizedPnl: res.realizedPnl,
        levelIndex: order.levelIndex, reduceOnly: true,
      });
      if (def && leg.active) {
        // Re-arm the entry one level back toward the range center — unless an
        // entry already rests there (two TPs at one level share the re-arm slot).
        const entryIdx = order.leg === 'long' ? order.levelIndex - 1 : order.levelIndex + 1;
        const occupied = leg.orders.some(o => !o.reduceOnly && o.levelIndex === entryIdx);
        if (!occupied && entryIdx >= 0 && entryIdx < def.levels.length) {
          const placed = account.placeOrder({
            leg: order.leg, type: order.leg === 'long' ? 'buy' : 'sell',
            price: def.levels[entryIdx], qty: def.qtyPerLevel, levelIndex: entryIdx,
            reduceOnly: false,
          });
          placedSeg.set(placed.id, seg);
        }
      }
    }
  }

  // Flatten a leg at its stop. `touchPrice` is where the trigger was observed
  // (the stop itself, or a worse open on a gap); slippage shifts it further.
  function executeStop(side: LegSide, touchPrice: number, timeSec: number): void {
    const leg = account.legs[side];
    const exitType = side === 'long' ? 'sell' : 'buy';
    const fillPrice = applySlippage(touchPrice, exitType, side, lastClosedAtrFraction(touchPrice), true, slippageCfg);
    const res = account.closeFraction(side, 1, fillPrice, account.fees.takerFee);
    account.cancelAllOrders(side);
    leg.stopPrice = null;
    leg.active = false;
    leg.stopCount += 1;
    events.push({
      type: 'stop', timeSec, leg: side, orderType: exitType, price: fillPrice,
      qty: res.qty, fee: res.fee, realizedPnl: res.realizedPnl, reason: 'hardStop',
    });
  }

  function executeMarketAction(action: MarketAction, openPrice: number, timeSec: number): void {
    const side = action.leg;
    if (account.legQty(side) <= 0) return;
    const exitType = side === 'long' ? 'sell' : 'buy';
    const fillPrice = applySlippage(openPrice, exitType, side, 0, false, slippageCfg);
    const fraction = action.kind === 'closeAll' ? 1 : Math.min(1, Math.max(0, action.fraction ?? 0));
    if (fraction <= 0) return;
    const res = account.closeFraction(side, fraction, fillPrice, account.fees.takerFee);
    // Resting TP (reduceOnly) orders must shrink with the position they close,
    // otherwise later fills would over-close the remaining hedge.
    for (const order of account.legs[side].orders) {
      if (order.reduceOnly) order.qty *= 1 - fraction;
    }
    if (fraction >= 1) {
      account.legs[side].orders = account.legs[side].orders.filter(o => !o.reduceOnly);
    }
    events.push({
      type: fraction >= 1 ? 'fullClose' : 'partialClose', timeSec, leg: side, orderType: exitType,
      price: fillPrice, qty: res.qty, fee: res.fee, realizedPnl: res.realizedPnl,
      fraction, reason: action.reason,
    });
  }

  // ---- main loop -------------------------------------------------------------

  for (let b = 0; b < candles1m.length; b++) {
    const bar = candles1m[b];
    const barOpenSec = bar.timestamp;
    const barCloseSec = barOpenSec + 60;

    // 1) Funding settlements due by this bar's open, applied at the open price.
    while (fundingIdx < fundingRates.length && fundingRates[fundingIdx].fundingTimeSec <= barOpenSec) {
      const r = fundingRates[fundingIdx++];
      if (account.legQty('long') > 0 || account.legQty('short') > 0) {
        events.push(account.applyFunding(r.fundingRate, bar.open, barOpenSec));
      }
    }

    // 2) Queued strategy actions execute at the open, then deferred grid arms
    //    (closes settle before fresh inventory opens).
    while (pendingActions.length > 0) {
      executeMarketAction(pendingActions.shift()!, bar.open, barOpenSec);
    }
    while (pendingArms.length > 0) {
      const arm = pendingArms.shift()!;
      armGrid(arm.leg, arm.def, bar.open, barOpenSec);
    }

    // 3) Gap handling at the open: stops first, then limit orders the open
    //    jumped past (limits fill at the open — the marketable price).
    for (const side of ['long', 'short'] as LegSide[]) {
      const leg = account.legs[side];
      if (leg.stopPrice === null || leg.lots.length === 0) continue;
      if ((side === 'long' && bar.open <= leg.stopPrice) || (side === 'short' && bar.open >= leg.stopPrice)) {
        executeStop(side, bar.open, barOpenSec);
      }
    }
    const placedSeg = new Map<string, number>(); // orderId -> segment it was placed in
    for (const side of ['long', 'short'] as LegSide[]) {
      for (const order of [...account.legs[side].orders]) {
        const gapped = order.type === 'buy' ? bar.open <= order.price : bar.open >= order.price;
        if (gapped) {
          executeGridFill({ ...order, price: bar.open }, barOpenSec, placedSeg, -1);
        }
      }
    }

    // 4) Walk the intra-candle path. Each monotonic segment triggers stops and
    //    limits in the order price encounters them.
    const path = getIntraCandlePath(bar);
    for (let seg = 0; seg < path.length - 1; seg++) {
      const from = path[seg];
      const to = path[seg + 1];
      if (from === to) continue;
      const down = to < from;

      // Collect triggers in this segment's price range (exclusive of `from`:
      // open-gap cases were handled above; later segments start where the
      // previous ended, so equality there was already processed).
      type Trigger = { price: number; kind: 'stop' | 'order'; side: LegSide; order?: GridOrder };
      const triggers: Trigger[] = [];

      for (const side of ['long', 'short'] as LegSide[]) {
        const leg = account.legs[side];
        // Collected even when flat: entries filled earlier in this segment may
        // open lots before price reaches the stop (execution re-checks lots).
        if (leg.stopPrice !== null) {
          const sp = leg.stopPrice;
          const hits = down ? side === 'long' && sp >= to && sp < from
                            : side === 'short' && sp <= to && sp > from;
          if (hits) triggers.push({ price: sp, kind: 'stop', side });
        }
        for (const order of leg.orders) {
          const eligibleFrom = placedSeg.get(order.id);
          if (eligibleFrom !== undefined && eligibleFrom >= seg) continue;
          const hits = down
            ? order.type === 'buy' && order.price >= to && order.price < from
            : order.type === 'sell' && order.price <= to && order.price > from;
          if (hits) triggers.push({ price: order.price, kind: 'order', side, order });
        }
      }

      triggers.sort((a, b2) => (down ? b2.price - a.price : a.price - b2.price));

      for (const t of triggers) {
        if (t.kind === 'stop') {
          const leg = account.legs[t.side];
          if (leg.stopPrice === null || leg.lots.length === 0) continue; // already handled
          executeStop(t.side, t.price, barOpenSec);
        } else if (t.order) {
          // Stop execution may have cancelled this order — verify it still rests.
          if (!account.legs[t.side].orders.some(o => o.id === t.order!.id)) continue;
          executeGridFill(t.order, barOpenSec, placedSeg, seg);
        }
      }
    }

    // 5) 30m closes: sample equity, then let the strategy act on closed bars.
    while (idx30 < candles30m.length && candles30m[idx30].timestamp + THIRTY_MIN <= barCloseSec) {
      const closed = candles30m[idx30];
      closedView.push(closed);
      idx30++;
      const closeSec = closed.timestamp + THIRTY_MIN;
      equity.push({
        timeSec: closeSec,
        price: closed.close,
        equity: account.equity(closed.close),
        cash: account.cash,
        unrealized: account.unrealized(closed.close),
        longQty: account.legQty('long'),
        shortQty: account.legQty('short'),
      });
      hooks.onSignal({ closed30m: closedView, nowSec: closeSec, api });
    }
  }

  return { account, events, equity };
}
