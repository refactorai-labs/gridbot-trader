import { describe, it, expect, beforeEach } from 'vitest';
import { OHLC } from '../lib/types';
import { PerpAccount, resetResearchIds } from '../lib/research/account';
import { runFillSim } from '../lib/research/fillSim';
import { DEFAULT_PERP_FEES } from '../lib/research/types';

const FEES = DEFAULT_PERP_FEES; // maker 0.0002, taker 0.0005

function bar(timestamp: number, o: number, h: number, l: number, c: number): OHLC {
  return { timestamp, open: o, high: h, low: l, close: c, volume: 1 };
}

// Flat 1m bars at `price` from startSec, `count` bars.
function flatBars(startSec: number, count: number, price: number): OHLC[] {
  return Array.from({ length: count }, (_, i) => bar(startSec + i * 60, price, price, price, price));
}

function agg30(c1m: OHLC[]): OHLC[] {
  const buckets = new Map<number, OHLC[]>();
  for (const c of c1m) {
    const key = Math.floor(c.timestamp / 1800) * 1800;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }
  const out: OHLC[] = [];
  for (const [key, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length < 30) continue; // only fully-formed 30m bars
    out.push({
      timestamp: key,
      open: group[0].open,
      high: Math.max(...group.map(g => g.high)),
      low: Math.min(...group.map(g => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
    });
  }
  return out;
}

beforeEach(() => resetResearchIds());

// ---------------------------------------------------------------------------
// PerpAccount ledger
// ---------------------------------------------------------------------------

describe('PerpAccount ledger', () => {
  it('long round-trip: realized = gross - entry fee - exit fee, cash consistent', () => {
    const acc = new PerpAccount(1000, FEES);
    acc.openLot('long', 2, 100, FEES.makerFee, 0, 0);
    const entryFee = 2 * 100 * FEES.makerFee;
    expect(acc.cash).toBeCloseTo(1000 - entryFee, 10);

    const res = acc.closeQty('long', 2, 110, FEES.makerFee);
    const exitFee = 2 * 110 * FEES.makerFee;
    expect(res.realizedPnl).toBeCloseTo(20 - entryFee - exitFee, 10);
    expect(acc.cash).toBeCloseTo(1000 + res.realizedPnl, 10);
    expect(acc.legs.long.lots).toHaveLength(0);
  });

  it('short leg profits when price falls', () => {
    const acc = new PerpAccount(1000, FEES);
    acc.openLot('short', 1, 100, FEES.makerFee, 0, 0);
    const res = acc.closeQty('short', 1, 90, FEES.takerFee);
    const gross = 10;
    const fees = 100 * FEES.makerFee + 90 * FEES.takerFee;
    expect(res.realizedPnl).toBeCloseTo(gross - fees, 10);
    expect(acc.unrealized(123)).toBe(0);
  });

  it('closeFraction closes proportionally across lots and preserves the rest', () => {
    const acc = new PerpAccount(1000, FEES);
    acc.openLot('long', 1, 100, FEES.makerFee, 0, 0);
    acc.openLot('long', 1, 102, FEES.makerFee, 0, 1);
    const res = acc.closeFraction('long', 0.6, 110, FEES.takerFee);
    expect(res.qty).toBeCloseTo(1.2, 10);
    expect(acc.legQty('long')).toBeCloseTo(0.8, 10);
    for (const lot of acc.legs.long.lots) expect(lot.qty).toBeCloseTo(0.4, 10);

    const gross = 0.6 * (110 - 100) + 0.6 * (110 - 102);
    const exitFee = 1.2 * 110 * FEES.takerFee;
    const entryFeeShare = 0.6 * (100 * FEES.makerFee) + 0.6 * (102 * FEES.makerFee);
    expect(res.realizedPnl).toBeCloseTo(gross - exitFee - entryFeeShare, 10);
  });

  it('funding: long pays positive rate, short receives it', () => {
    const acc = new PerpAccount(1000, FEES);
    acc.openLot('long', 1, 100, 0, 0, 0);
    acc.openLot('short', 0.5, 100, 0, 0, 0);
    acc.applyFunding(0.0001, 100, 0);
    expect(acc.legs.long.fundingPaid).toBeCloseTo(100 * 0.0001, 10);
    expect(acc.legs.short.fundingPaid).toBeCloseTo(-50 * 0.0001, 10);
    expect(acc.cash).toBeCloseTo(1000 - 0.005, 10);
  });
});

// ---------------------------------------------------------------------------
// runFillSim — grid arming + churn on 1m bars
// ---------------------------------------------------------------------------

describe('runFillSim grid mechanics', () => {
  it('arms at the next 1m open: entries on the entry side, taker initial position with TPs on the TP side', () => {
    const c1m = [...flatBars(0, 30, 101), ...flatBars(1800, 30, 101)];
    const c30 = agg30(c1m);

    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          if (ctx.nowSec === 1800) {
            ctx.api.setGrid('long', { levels: [100, 102, 104], qtyPerLevel: 0.5 });
          }
        },
      },
    });

    const init = result.events.filter(e => e.type === 'initialOpen');
    expect(init).toHaveLength(1);
    const fillPrice = 101 * 1.0001; // taker open at next bar open + 1bp base slippage
    expect(init[0]).toMatchObject({ leg: 'long', orderType: 'buy' });
    expect(init[0].qty).toBeCloseTo(1.0, 10); // two TP-side levels × 0.5
    expect(init[0].price).toBeCloseTo(fillPrice, 10);
    expect(init[0].fee).toBeCloseTo(1.0 * fillPrice * FEES.takerFee, 10);

    const orders = result.account.legs.long.orders;
    expect(orders.filter(o => !o.reduceOnly).map(o => o.price)).toEqual([100]);
    const tps = orders.filter(o => o.reduceOnly);
    expect(tps.map(o => o.price).sort((a, b) => a - b)).toEqual([102, 104]);
    for (const tp of tps) {
      expect(tp.qty).toBeCloseTo(0.5, 10);
      expect(tp.lotId).toBeDefined();
    }
  });

  it('fills a grid entry on a 1m dip and its TP counter on the way back (maker fees both ways)', () => {
    // Grid arms at bar(1800) open 103 → entries 100/101/102, no TP side.
    const c1m = [
      ...flatBars(0, 30, 103),
      bar(1800, 103, 103, 100.9, 101), // fills buy@102 (no TP above), buy@101 (TP sell@102)
      bar(1860, 101, 102.5, 101, 102.4), // TP sell@102 closes the 101-lot
      ...flatBars(1920, 28, 102.4),
    ];
    const c30 = agg30(c1m);

    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          if (ctx.nowSec === 1800) {
            ctx.api.setGrid('long', { levels: [100, 101, 102], qtyPerLevel: 1 });
          }
        },
      },
    });

    const fills = result.events.filter(e => e.type === 'gridFill');
    expect(fills).toHaveLength(3);
    expect(fills[0]).toMatchObject({ orderType: 'buy', price: 102, reduceOnly: false });
    expect(fills[1]).toMatchObject({ orderType: 'buy', price: 101, reduceOnly: false });
    expect(fills[2]).toMatchObject({ orderType: 'sell', price: 102, reduceOnly: true });

    const expected = (102 - 101) * 1 - 101 * FEES.makerFee - 102 * FEES.makerFee;
    expect(fills[2].realizedPnl).toBeCloseTo(expected, 10);
    expect(result.account.legs.long.realizedPnl).toBeCloseTo(expected, 10);
    expect(result.account.legQty('long')).toBeCloseTo(1, 10); // 102-lot still open
    // TP fill re-armed the entry one level down.
    expect(result.account.legs.long.orders.some(o => !o.reduceOnly && o.price === 101)).toBe(true);
  });

  it('one dip through several levels fills each level once, deepest included', () => {
    const c1m = [
      ...flatBars(0, 30, 103),
      bar(1800, 103, 103, 99.5, 99.9), // sweeps buy@102, buy@101, buy@100
      ...flatBars(1860, 29, 99.9),
    ];
    const c30 = agg30(c1m);

    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          if (ctx.nowSec === 1800) {
            ctx.api.setGrid('long', { levels: [100, 101, 102], qtyPerLevel: 0.5 });
          }
        },
      },
    });

    const entries = result.events.filter(e => e.type === 'gridFill' && !e.reduceOnly);
    expect(entries.map(e => e.price)).toEqual([102, 101, 100]); // path order: descending
    expect(result.account.legQty('long')).toBeCloseTo(1.5, 10);
    // TP counters one level above each filled entry (102 has no level above).
    const tpPrices = result.account.legs.long.orders.filter(o => o.reduceOnly).map(o => o.price).sort((a, b) => a - b);
    expect(tpPrices).toEqual([101, 102]);
  });
});

// ---------------------------------------------------------------------------
// runFillSim — stops
// ---------------------------------------------------------------------------

describe('runFillSim stops', () => {
  function withOpenLongAndStop(stopBar: OHLC) {
    const c1m = [
      ...flatBars(0, 30, 103),
      bar(1800, 103, 103, 100.9, 101.0), // fill buy@101 (single-level grid, no TP side)
      ...flatBars(1860, 29, 101),        // completes 30m bar 1 → strategy sets stop
      stopBar,
      ...flatBars(stopBar.timestamp + 60, 29, stopBar.close),
    ];
    const c30 = agg30(c1m);
    return runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          if (ctx.nowSec === 1800) ctx.api.setGrid('long', { levels: [101], qtyPerLevel: 1 });
          if (ctx.nowSec === 3600) ctx.api.setStop('long', 95);
        },
      },
    });
  }

  it('intrabar cross flattens the leg at stop price minus slippage, taker fee, leg disarmed', () => {
    const result = withOpenLongAndStop(bar(3600, 101, 101, 94, 94.5));
    const stops = result.events.filter(e => e.type === 'stop');
    expect(stops).toHaveLength(1);
    // ATR is NaN with so few 30m bars → slippage floor 0.1% below the stop.
    expect(stops[0].price).toBeCloseTo(95 * 0.999, 10);
    expect(stops[0].fee).toBeCloseTo(1 * 95 * 0.999 * FEES.takerFee, 10);
    expect(result.account.legQty('long')).toBe(0);
    expect(result.account.legs.long.active).toBe(false);
    expect(result.account.legs.long.orders).toHaveLength(0);
    expect(result.account.legs.long.stopCount).toBe(1);
  });

  it('a gap open beyond the stop fills at the (worse) open, not the stop price', () => {
    const result = withOpenLongAndStop(bar(3600, 93, 93.5, 92.8, 93.2));
    const stops = result.events.filter(e => e.type === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].price).toBeCloseTo(93 * 0.999, 10);
  });

  it('a flat leg that buys on the way down still stops out when the same candle crosses its stop', () => {
    // Arms flat at 100 (no initial inventory); one bullish candle wicks 100 → 80 → 101.
    const c1m = [
      ...flatBars(0, 30, 100),
      bar(1800, 100, 101, 80, 100.5),
      ...flatBars(1860, 29, 100.5),
    ];
    const c30 = agg30(c1m);
    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          if (ctx.nowSec === 1800) {
            ctx.api.setGrid('long', { levels: [90, 92, 94, 96, 98, 102], qtyPerLevel: 1, initialFraction: 0 });
            ctx.api.setStop('long', 85);
          }
        },
      },
    });
    const stops = result.events.filter(e => e.type === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].qty).toBeCloseTo(5, 10); // all five entries filled above the stop
    expect(result.account.legQty('long')).toBe(0);
    expect(result.events.some(e => e.type === 'gridFill' && e.reduceOnly)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runFillSim — partial close + no-lookahead timing
// ---------------------------------------------------------------------------

describe('runFillSim partial close and signal timing', () => {
  it('queued partial close executes at the NEXT 1m open with taker fee; resting TPs scale down', () => {
    const c1m = [
      ...flatBars(0, 30, 101),         // grid arms at bar(1800) open 101
      ...flatBars(1800, 30, 101),      // initial long 1 @ ~101 (level 104), TP sell@104 resting
      bar(3600, 100, 100, 100, 100),   // close action executes at THIS open (100)
      ...flatBars(3660, 29, 100),
    ];
    const c30 = agg30(c1m);

    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          if (ctx.nowSec === 1800) ctx.api.setGrid('long', { levels: [98, 104], qtyPerLevel: 1 });
          if (ctx.nowSec === 3600) {
            ctx.api.queueAction({ kind: 'closeFraction', leg: 'long', fraction: 0.6, reason: 'bankProfit' });
          }
        },
      },
    });

    const pc = result.events.filter(e => e.type === 'partialClose');
    expect(pc).toHaveLength(1);
    expect(pc[0].timeSec).toBe(3600); // next bar open, not the signal's 30m close bar
    expect(pc[0].price).toBeCloseTo(100 * (1 - 0.0001), 10); // taker sell at open with 1bp base slippage
    expect(pc[0].qty).toBeCloseTo(0.6, 10);
    expect(pc[0].reason).toBe('bankProfit');
    expect(result.account.legQty('long')).toBeCloseTo(0.4, 10);

    const tp = result.account.legs.long.orders.find(o => o.reduceOnly);
    expect(tp).toBeDefined();
    expect(tp!.qty).toBeCloseTo(0.4, 10); // scaled by (1 - 0.6)
  });

  it('no lookahead: signals fire only on closed 30m bars and see nothing beyond them', () => {
    const c1m = flatBars(0, 95, 100); // 95 bars → exactly 3 closed 30m bars + 5 dangling 1m bars
    const c30 = agg30(c1m);
    expect(c30).toHaveLength(3);

    const signals: Array<{ nowSec: number; lastClosedOpen: number; count: number }> = [];
    runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          const last = ctx.closed30m[ctx.closed30m.length - 1];
          signals.push({ nowSec: ctx.nowSec, lastClosedOpen: last.timestamp, count: ctx.closed30m.length });
          // every visible bar must already be closed at nowSec
          for (const c of ctx.closed30m) expect(c.timestamp + 1800).toBeLessThanOrEqual(ctx.nowSec);
        },
      },
    });

    expect(signals).toHaveLength(3);
    expect(signals.map(s => s.nowSec)).toEqual([1800, 3600, 5400]);
    expect(signals.map(s => s.count)).toEqual([1, 2, 3]);
    // each signal's newest bar closes exactly at the signal time — never later
    for (const s of signals) expect(s.lastClosedOpen + 1800).toBe(s.nowSec);
  });

  it('funding settlements debit open notional at the settlement bar open', () => {
    const c1m = [
      ...flatBars(0, 30, 103),
      bar(1800, 103, 103, 100.9, 101), // fill buy@101 → long 1 ETH
      ...flatBars(1860, 59, 101),
    ];
    const c30 = agg30(c1m);

    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [
        { fundingTimeSec: 900, fundingRate: 0.0005 },  // before any position — no event
        { fundingTimeSec: 3600, fundingRate: 0.0001 }, // long 1 ETH @ mark 101
      ],
      config: { initialCapital: 10_000, fees: FEES },
      hooks: {
        onSignal(ctx) {
          if (ctx.nowSec === 1800) ctx.api.setGrid('long', { levels: [101], qtyPerLevel: 1 });
        },
      },
    });

    const funding = result.events.filter(e => e.type === 'funding');
    expect(funding).toHaveLength(1);
    expect(funding[0].timeSec).toBe(3600);
    expect(funding[0].fee).toBeCloseTo(1 * 101 * 0.0001, 10);
    expect(result.account.legs.long.fundingPaid).toBeCloseTo(0.0101, 10);
  });
});
