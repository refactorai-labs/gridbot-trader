import { describe, it, expect } from 'vitest';
import { OHLC } from '../lib/types';
import { runPionex } from '../lib/pionex/engine';
import { markLastOffset } from '../lib/pionex/segments';
import { liqPrice } from '../lib/pionex/liquidation';
import { decideVerdict, computeMetrics, thinSamples } from '../lib/pionex/metrics';
import { PionexRunConfig, RunResult } from '../lib/pionex/types';

const T0 = Date.UTC(2022, 4, 10);
const M = 60_000;
const bar = (i: number, o: number, h: number, l: number, c: number): OHLC => ({
  timestamp: (T0 + i * M) / 1000, open: o, high: h, low: l, close: c, volume: 0,
});
const flat = (i: number, p: number) => bar(i, p, p, p, p);
const shift = (bars: OHLC[], d: number) => bars.map(b => ({ ...b, open: b.open + d, high: b.high + d, low: b.low + d, close: b.close + d }));

// Band 90–110, 10 grids (step 2), Q = I·lev/n = 100. Start at 100 → slots 5..9
// (levels 100..108) bought at market: qty 5, wallet 100 with zero costs.
const cfg = (over: Partial<PionexRunConfig> = {}, bot: Partial<PionexRunConfig['bot']> = {}): PionexRunConfig => ({
  bot: { lower: 90, upper: 110, gridCount: 10, mode: 'arithmetic', investment: 100, extraMargin: 0, leverage: 10, ...bot },
  costs: { makerFee: 0, takerFee: 0, mmr: 0 },
  marginCheck: false,
  ...over,
});

const types = (r: RunResult) => r.events.map(e => e.type);

describe('pionex engine — start (plan §3.3)', () => {
  it('buys the levels at/above the start price at market, the rest wait', () => {
    const r = runPionex([flat(0, 100)], [flat(0, 100)], [], cfg(), 'A');
    expect(r.startPrice).toBe(100);
    expect(r.initialQty).toBe(5);
    expect(r.events[0]).toMatchObject({ type: 'start', price: 100, qty: 5 });
    expect(r.status).toBe('active');
  });

  it('start_rejected when the common capital is below I + E', () => {
    const r = runPionex([flat(0, 100)], [flat(0, 100)], [], cfg({ capitalTotal: 50 }), 'A');
    expect(types(r)).toEqual(['start_rejected']);
    expect(r.freeCash).toBe(50);
  });
});

describe('pionex engine — liquidation as an event (plan §3.4, §3.4.1)', () => {
  it('a bounce does not save: below the threshold, then closes above the open → liquidated', () => {
    const last = [flat(0, 100), bar(1, 100, 101, 85, 100.5)];
    for (const path of ['A', 'B'] as const) {
      const r = runPionex(last, last, [], cfg(), path);
      expect(r.status).toBe('liquidated');
      expect(r.liquidatedAtMs).toBe(T0 + M);
      const buys = r.events.filter(e => e.type === 'buy');
      expect(buys.map(b => b.price)).toEqual([98, 96, 94, 92, 90]);
      // Liquidation at the P_liq of the full position (d = 0 → T = P_liq).
      const qty = 5 + [98, 96, 94, 92, 90].reduce((s, p) => s + 100 / p, 0);
      const liq = r.events.find(e => e.type === 'liquidation')!;
      expect(liq.price).toBeCloseTo(liqPrice(qty, 1000 / qty, 100, 0)!, 9);
      expect(types(r).at(-1)).toBe('liquidation');
      // The liquidation point enters the metrics with distance 0.
      expect(computeMetrics(r.samples).minLiqDistPct).toBeCloseTo(0, 9);
    }
  });

  it('a buy level below the liquidation threshold never fills, margin check off too', () => {
    // Band 70–110, 20 grids, lev 20 → Q = 100; deep candle to 60.
    const c = cfg({}, { lower: 70, upper: 110, gridCount: 20, leverage: 20 });
    const last = [flat(0, 100), bar(1, 100, 100, 60, 60)];
    const r = runPionex(last, last, [], c, 'A');
    const liq = r.events.find(e => e.type === 'liquidation')!;
    const buys = r.events.filter(e => e.type === 'buy');
    expect(r.status).toBe('liquidated');
    expect(liq.price!).toBeGreaterThan(70); // levels below it existed in the band
    expect(buys.length).toBeGreaterThan(0);
    expect(buys.every(b => b.price! > liq.price!)).toBe(true);
    expect(buys.length).toBeLessThan(15);
    expect(r.events.indexOf(liq)).toBe(r.events.length - 1);
  });

  it('opening-gap segment: crossed buy levels fill in the gap at the next minute', () => {
    const last = [flat(0, 100), flat(1, 95)];
    const r = runPionex(last, last, [], cfg(), 'A');
    const buys = r.events.filter(e => e.type === 'buy');
    expect(buys.map(b => [b.price, b.timeMs])).toEqual([[98, T0 + M], [96, T0 + M]]);
    expect(r.status).toBe('active');
  });

  it('opening-gap segment: crossing the threshold interrupts the gap; nothing below fills', () => {
    const last = [flat(0, 100), flat(1, 80)];
    const r = runPionex(last, last, [], cfg(), 'A');
    expect(r.status).toBe('liquidated');
    expect(r.liquidatedAtMs).toBe(T0 + M);
    const liq = r.events.find(e => e.type === 'liquidation')!;
    expect(liq.price!).toBeGreaterThan(80);
    expect(r.events.filter(e => e.type === 'buy').every(b => b.price! > liq.price!)).toBe(true);
  });

  it('liquidation at the open + pending top-up: top-up cancelled, freeCash unchanged', () => {
    // Last opens at 95 (above the last-price threshold), but the mark open is far lower.
    const last = [flat(0, 100), flat(1, 95)];
    const mark = [flat(0, 100), bar(1, 60, 95, 60, 95)];
    const r = runPionex(last, mark, [], cfg({ capitalTotal: 300, scheduledTopUps: [{ atMs: T0 + M, amount: 150 }] }), 'A');
    expect(r.status).toBe('liquidated');
    expect(r.liquidatedAtMs).toBe(T0 + M);
    expect(types(r)).toContain('topup_cancelled');
    expect(types(r)).not.toContain('topup');
    expect(r.freeCash).toBe(200);
    expect(r.totals.topUps).toBe(0);
  });

  it('a top-up executed at the open adds margin and lowers P_liq', () => {
    const last = [flat(0, 100), flat(1, 100), bar(2, 100, 100, 85, 90)];
    const plain = runPionex(last, last, [], cfg({ capitalTotal: 300 }), 'A');
    const topped = runPionex(last, last, [], cfg({ capitalTotal: 300, scheduledTopUps: [{ atMs: T0 + M, amount: 150 }] }), 'A');
    expect(plain.status).toBe('liquidated');
    expect(topped.status).toBe('active');
    expect(topped.freeCash).toBe(50);
    expect(topped.maxInvariantError).toBeLessThan(1e-9);
  });
});

describe('pionex engine — mark–last offset (plan §3.4.1)', () => {
  it('d is the minimum of the four mark − last differences', () => {
    expect(markLastOffset(bar(0, 100, 102, 98, 101), bar(0, 99, 100, 93, 101))).toBe(-5);
    expect(markLastOffset(bar(0, 100, 102, 98, 101), bar(0, 101, 103, 99, 102))).toBe(1);
  });

  it('liquidation fires at last price T = P_liq − d (mark = P_liq)', () => {
    const last = [flat(0, 100), bar(1, 100, 100, 80, 80)];
    const mark = [flat(0, 100), shift([bar(1, 100, 100, 80, 80)], -1)[0]];
    const r = runPionex(last, mark, [], cfg(), 'A');
    const liq = r.events.find(e => e.type === 'liquidation')!;
    const qty = 5 + [98, 96, 94, 92, 90].reduce((s, p) => s + 100 / p, 0);
    const pLiq = liqPrice(qty, 1000 / qty, 100, 0)!;
    // With mark 1 below last, buys still fill at their last-price levels…
    expect(r.events.filter(e => e.type === 'buy').length).toBe(5);
    // …and the threshold in last-price terms is 1 above P_liq.
    expect(liq.price).toBeCloseTo(pLiq + 1, 9);
    expect(liq.mark).toBeCloseTo(pLiq, 9);
  });
});

describe('pionex engine — paths A and B (plan §3.4.2)', () => {
  // Band 95–105, 10 grids (step 1), lev 15, I = 10 → Q = 15. Start 100: slots 5..9.
  // Path A drops to the low first with the start position; path B first sells
  // everything above, banks the profit and only then re-buys down to the low.
  const c = cfg({}, { lower: 95, upper: 105, gridCount: 10, leverage: 15, investment: 10 });
  const last = [flat(0, 100), bar(1, 100, 106, 91.65, 100)];
  const a = runPionex(last, last, [], c, 'A');
  const b = runPionex(last, last, [], c, 'B');

  it('the same candle liquidates on one path and not on the other', () => {
    expect(a.status).toBe('liquidated');
    expect(b.status).toBe('active');
    expect(types(b).filter(t => t === 'sell').length).toBeGreaterThanOrEqual(5);
  });

  it('different paths → "path-dependent" verdict; identical → path verdict', () => {
    expect(decideVerdict(a, b, true)).toBe('path_dependent');
    expect(decideVerdict(a, a, true)).toBe('liquidated');
    expect(decideVerdict(a, b, false)).toBe('data_incomplete');
  });

  it('liquidation times more than 1h apart are path-dependent too', () => {
    const later = { ...a, liquidatedAtMs: a.liquidatedAtMs! + 61 * M };
    expect(decideVerdict(a, later, true)).toBe('path_dependent');
    expect(decideVerdict(a, { ...a, liquidatedAtMs: a.liquidatedAtMs! + 59 * M }, true)).toBe('liquidated');
  });

  it('survives on both paths with a small minimum distance → borderline', () => {
    const calm = [flat(0, 100), flat(1, 99)];
    const s = runPionex(calm, calm, [], cfg(), 'A');
    expect(decideVerdict(s, s, true)).toBe('survived');
    expect(decideVerdict(s, s, true, 0.5)).toBe('borderline');
  });
});

describe('pionex engine — margin check (plan §3.5)', () => {
  // Descend 100 → 88 one level per minute, then back up to 110.
  const down = Array.from({ length: 13 }, (_, i) => flat(i, 100 - i));
  const up = Array.from({ length: 23 }, (_, i) => flat(13 + i, 88 + i));
  const path = [...down, ...up];

  it('with margin check on, buys are skipped when the open position leaves too little margin', () => {
    const on = runPionex(path, path, [], cfg({ marginCheck: true }, { leverage: 5, investment: 50 }), 'A');
    const off = runPionex(path, path, [], cfg({}, { leverage: 5, investment: 50 }), 'A');
    const skipped = on.events.filter(e => e.type === 'buy_skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every(e => e.price! >= 90 && e.amount! > 0 && e.reason === 'insufficient margin')).toBe(true);
    expect(off.events.some(e => e.type === 'buy_skipped')).toBe(false);
  });

  it('only the open position reserves margin: closed rounds free it again', () => {
    // Many round trips (buy 100, sell 102); with E sized for the open position
    // only, none of the re-buys is skipped.
    const osc = Array.from({ length: 40 }, (_, i) => flat(i, i % 2 ? 99.5 : 102.5));
    const r = runPionex(osc, osc, [], cfg({ marginCheck: true }, { extraMargin: 10 }), 'A');
    expect(r.rounds).toBeGreaterThan(15);
    expect(r.events.some(e => e.type === 'buy_skipped')).toBe(false);
  });
});

describe('pionex engine — ledger invariant and fees (plan §3.7, §4.3)', () => {
  // Deterministic pseudo-random walk with fees, funding and margin check on.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const last: OHLC[] = [];
  const mark: OHLC[] = [];
  let p = 100;
  for (let i = 0; i < 3000; i++) {
    const o = p;
    const c = Math.max(80, Math.min(120, o + (rnd() - 0.5) * 1.2));
    const h = Math.max(o, c) + rnd() * 0.6;
    const l = Math.min(o, c) - rnd() * 0.6;
    last.push(bar(i, o, h, l, c));
    const dm = (rnd() - 0.5) * 0.2;
    mark.push(bar(i, o + dm, h + dm, l + dm, c + dm));
    p = c + (rnd() - 0.5) * 0.3; // small opening gaps
  }
  const funding = Array.from({ length: 6 }, (_, k) => ({ fundingTimeMs: T0 + (k * 480 + 7) * M + 2, rate: 0.0001 * (k % 3 - 1) }));
  const c = cfg({ marginCheck: true }, { extraMargin: 60, leverage: 5 });
  c.costs = { makerFee: 0.0002, takerFee: 0.0005, mmr: 0.005 };

  it('holds after every event on both paths', () => {
    for (const path of ['A', 'B'] as const) {
      const r = runPionex(last, mark, funding, c, path);
      expect(r.status).toBe('active');
      expect(new Set(types(r))).toEqual(new Set(['start', 'buy', 'sell', 'funding']));
      expect(r.maxInvariantError).toBeLessThan(1e-9);
    }
  });

  it('fees are booked once: Σ event fees = ledger fees', () => {
    const r = runPionex(last, mark, funding, c, 'A');
    const startFee = r.events.find(e => e.type === 'start')!.amount!;
    const buyFees = r.events.filter(e => e.type === 'buy').reduce((s, e) => s + e.amount!, 0);
    const sells = r.events.filter(e => e.type === 'sell').reduce((s, e) => s + e.qty! * e.price! * 0.0002, 0);
    expect(r.totals.fees).toBeCloseTo(startFee + buyFees + sells, 9);
  });

  it('metrics come from the full stream; thinning keeps each bucket minimum', () => {
    const r = runPionex(last, mark, funding, c, 'A');
    const m = computeMetrics(r.samples);
    const thin = thinSamples(r.samples);
    expect(thin.length).toBeLessThan(r.samples.length);
    expect(Math.min(...thin.map(s => s.wealth))).toBe(Math.min(...r.samples.map(s => s.wealth)));
    expect(m.maxDrawdownPct).toBeGreaterThan(0);
    expect(m.minLiqDistPct).not.toBeNull();
  });

  it('a missing minute in either series is skipped, not filled in', () => {
    const r = runPionex(last.slice(0, 50), mark.slice(0, 50).filter((_, i) => i !== 10), [], c, 'A');
    expect(r.skippedMinutes).toBe(1);
  });
});

describe('pionex engine — Phase 1 review regressions', () => {
  // Band 90–110, 10 grids, I = 100, E = 0, 15x (Q = 150), no fees, margin check off.
  const c15 = cfg({}, { leverage: 15 });

  it('P1: a liquidation already standing at a segment start fires before any sell', () => {
    // Last 100 → 91 (P_liq ≈ 90.45). Next candle all 94; mark L = 92 → d = −2, so the
    // gap segment starts at model mark 91 − 2 = 89, below P_liq.
    const last = [flat(0, 100), flat(1, 91), flat(2, 94)];
    const mark = [flat(0, 100), flat(1, 91), bar(2, 94, 94, 92, 94)];
    for (const path of ['A', 'B'] as const) {
      const r = runPionex(last, mark, [], c15, path);
      expect(r.status).toBe('liquidated');
      expect(r.liquidatedAtMs).toBe(T0 + 2 * M);
      expect(r.events.filter(e => e.type === 'sell')).toEqual([]);
      const liq = r.events.find(e => e.type === 'liquidation')!;
      expect(liq.price).toBe(91);
      expect(liq.mark).toBe(89);
    }
  });

  it('P1: the model segment end (last + d) enters distance, MTM and the verdict', () => {
    // Last low 92.4 with d = −1 → model mark 91.4 there; P_liq ≈ 90.246.
    const last = [flat(0, 100), bar(1, 100, 100, 92.4, 100)];
    const mark = [flat(0, 100), bar(1, 100, 100, 92.4, 99)];
    const a = runPionex(last, mark, [], c15, 'A');
    const b = runPionex(last, mark, [], c15, 'B');
    expect(a.status).toBe('active');
    const m = computeMetrics(a.samples);
    expect(m.minLiqDistPct!).toBeCloseTo(0.0126, 4);
    expect(m.maxDrawdownPct).toBeCloseTo(0.8594, 4);
    expect(decideVerdict(a, b, true)).toBe('borderline');
  });

  it('P2: a bot that never started gets no survival verdict', () => {
    const r = runPionex([flat(0, 100)], [flat(0, 100)], [], cfg({ capitalTotal: 50 }), 'A');
    expect(r.status).toBe('stopped');
    expect(decideVerdict(r, r, true)).toBe('not_started');
    const empty = runPionex([], [], [], cfg(), 'A');
    expect(decideVerdict(empty, empty, true)).toBe('not_started');
    // Missing data stays the primary label (plan §6.1).
    expect(decideVerdict(empty, empty, false)).toBe('data_incomplete');
  });

  it('P2: after funding, check and sample use the same (model) mark open', () => {
    // 100 → 91 (P_liq ≈ 90.45). Minute 2: last all 91.5, mark low 91 → d = −0.5,
    // model open 91.0, actual mark open 91.5. Funding 0.8 % lifts P_liq by ≈ 0.73
    // to ≈ 91.19: between the model and the actual open.
    const last = [flat(0, 100), flat(1, 91), flat(2, 91.5)];
    const mark = [flat(0, 100), flat(1, 91), bar(2, 91.5, 91.5, 91, 91.5)];
    const c = cfg({ capitalTotal: 300, scheduledTopUps: [{ atMs: T0 + 2 * M, amount: 50 }] }, { leverage: 15 });
    for (const path of ['A', 'B'] as const) {
      const r = runPionex(last, mark, [{ fundingTimeMs: T0 + 2 * M + 2, rate: 0.008 }], c, path);
      expect(types(r).slice(-3)).toEqual(['funding', 'liquidation', 'topup_cancelled']);
      expect(r.liquidatedAtMs).toBe(T0 + 2 * M);
      expect(r.events.find(e => e.type === 'liquidation')!.mark).toBe(91);
      expect(r.freeCash).toBe(200);
      // The only sample at/past the threshold is the liquidation point itself.
      const past = r.samples.filter(x => x.liqDistPct !== null && x.liqDistPct <= 0);
      expect(past.length).toBe(1);
      expect(past[0]).toBe(r.samples[r.samples.length - 3]); // then: post-liquidation, closing sample
    }
  });

  it('P2: thinning keeps the bucket minimum of the liquidation distance too', () => {
    const s = (t: number, wealth: number, liqDistPct: number) => ({ timeMs: T0 + t, wealth, liqDistPct, qty: 1, liqPrices: [] });
    const samples = [s(0, 100, 0.05), s(1000, 99, 0.01), s(2000, 90, 0.05), s(3000, 95, 0.06)];
    const thin = thinSamples(samples);
    expect(thin.map(x => x.timeMs - T0)).toEqual([1000, 2000, 3000]);
    expect(Math.min(...thin.map(x => x.liqDistPct!))).toBe(0.01);
    expect(Math.min(...thin.map(x => x.wealth))).toBe(90);
  });

  it('P2: the start fee is part of the drawdown (baseline sample before the start)', () => {
    const c = cfg();
    c.costs = { makerFee: 0, takerFee: 0.001, mmr: 0 };
    const last = [flat(0, 100), flat(1, 100)];
    const r = runPionex(last, last, [], c, 'A');
    expect(r.samples[0].wealth).toBe(100);
    expect(r.finalWealth).toBeCloseTo(99.5, 12);
    expect(computeMetrics(r.samples).maxDrawdownPct).toBeCloseTo(0.005, 12);
  });
});
