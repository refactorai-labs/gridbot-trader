import { describe, it, expect } from 'vitest';
import { OHLC } from '../lib/types';
import { runPionex } from '../lib/pionex/engine';
import { settleCycle } from '../lib/pionex/interventions';
import { computeMetrics, decideVerdict } from '../lib/pionex/metrics';
import { Capital } from '../lib/pionex/capital';
import { PionexLedger } from '../lib/pionex/ledger';
import { newBotState } from '../lib/pionex/gridLevels';
import { runSegment, StepContext } from '../lib/pionex/segments';
import { LedgerEvent, PionexRunConfig, RunResult, Sample } from '../lib/pionex/types';

const T0 = Date.UTC(2022, 4, 10); // 5m aligned: minutes 4, 9, … close a 5m candle
const M = 60_000;
const bar = (i: number, o: number, h: number, l: number, c: number): OHLC => ({
  timestamp: (T0 + i * M) / 1000, open: o, high: h, low: l, close: c, volume: 0,
});
const flat = (i: number, p: number) => bar(i, p, p, p, p);
const flats = (from: number, to: number, p: number) => Array.from({ length: to - from + 1 }, (_, k) => flat(from + k, p));

// Band 90–110, 10 grids (step 2), I = 100, 10x → Q = 100. Start at 100 → slots 5..9
// bought at market: qty 5, avgEntry 100, wallet 100 with zero costs.
const cfg = (over: Partial<PionexRunConfig> = {}, bot: Partial<PionexRunConfig['bot']> = {}): PionexRunConfig => ({
  bot: { lower: 90, upper: 110, gridCount: 10, mode: 'arithmetic', investment: 100, extraMargin: 0, leverage: 10, ...bot },
  costs: { makerFee: 0, takerFee: 0, mmr: 0 },
  marginCheck: false,
  ...over,
});

const types = (r: RunResult) => r.events.map(e => e.type);
// Plan §3.7: freeCash + Σ wallet + withdrawn − (capitalTotal + PnL − fees − funding − liquidation loss).
const invariant = (r: RunResult, capitalTotal: number) =>
  r.freeCash + r.finalWallet + r.withdrawn -
  (capitalTotal + r.totals.realizedTradePnl - r.totals.fees - r.totals.funding - r.totals.liquidationLoss);

describe('pionex cycle settlement (plan §3.6)', () => {
  it('plan example: E_start 1750, top-ups 200, net profit 100, reinvest 20 % → E_next 1970, withdrawn 80', () => {
    const s = settleCycle(1000, 1750, 200, 1000 + 1750 + 200 + 100, 0.2);
    expect(s.profit).toBeCloseTo(100, 9);
    expect(s.eNext).toBeCloseTo(1970, 9);
    expect(s.withdraw).toBeCloseTo(80, 9);
    expect(s.canRestart).toBe(true);
  });

  it('non-positive profit: the loss comes out of E, nothing withdrawn', () => {
    const s = settleCycle(1000, 1750, 200, 1000 + 1750 + 200 - 50, 0.2);
    expect(s.profit).toBeCloseTo(-50, 9);
    expect(s.eNext).toBeCloseTo(1900, 9);
    expect(s.withdraw).toBe(0);
    expect(settleCycle(100, 10, 0, 90, 0.2).canRestart).toBe(false); // returned 90 < I
  });
});

describe('pionex engine — TP cycle (plan §3.6)', () => {
  it('TP on a 5m close → close at the next 1m open, withdraw, restart from own money on the same open', () => {
    // Minute 1: 100 → 102 sells slot 5 (+2). Minute 4 closes the 5m: equity 110, net 10 ≥ 5 % · I.
    const last = [flat(0, 100), bar(1, 100, 102, 100, 102), ...flats(2, 5, 102)];
    const r = runPionex(last, last, [], cfg({ cycle: { takeProfitPct: 0.05, reinvestPct: 0.5 } }), 'A');
    const t5 = T0 + 5 * M;
    expect(r.events.filter(e => e.timeMs === t5).map(e => e.type)).toEqual(['close', 'cycle', 'restart']);
    expect(r.events.find(e => e.type === 'close')).toMatchObject({ price: 102, reason: 'take profit' });
    expect(r.events.find(e => e.type === 'cycle')!.amount).toBeCloseTo(10, 9);
    expect(r.cycles).toBe(1);
    expect(r.withdrawn).toBeCloseTo(5, 9);
    expect(r.freeCash).toBe(0); // the restart never draws on freeCash
    expect(r.bots[0].wallet).toBeCloseTo(105, 9); // I + E_next = 100 + 5
    // Decision 1: the new cycle re-centres the band with the initial % offsets.
    expect(r.bots[0].lower).toBeCloseTo(91.8, 9);
    expect(r.bots[0].upper).toBeCloseTo(112.2, 9);
    expect(r.status).toBe('active');
    expect(r.maxInvariantError).toBeLessThan(1e-9);
    // Withdrawn profit stays in the wealth.
    expect(r.finalWealth).toBeCloseTo(110, 9);
  });

  it('execution price worse than at the TP decision: loss from E, no withdrawal, restart_rejected below I', () => {
    // TP decided at minute 4 (net 10), minute 5 gaps down to 95: buys 100, 98, 96 in the gap, close at 95.
    const last = [flat(0, 100), bar(1, 100, 102, 100, 102), ...flats(2, 4, 102), ...flats(5, 6, 95)];
    const r = runPionex(last, last, [], cfg({ cycle: { takeProfitPct: 0.05, reinvestPct: 0.5 } }), 'A');
    const cycle = r.events.find(e => e.type === 'cycle')!;
    expect(cycle.amount!).toBeLessThan(0);
    expect(r.withdrawn).toBe(0);
    expect(r.cycles).toBe(1);
    const rejected = r.events.find(e => e.type === 'restart_rejected')!;
    expect(rejected).toMatchObject({ bot: 0, reason: 'returned money below I' });
    expect(r.bots[0].status).toBe('stopped');
    expect(r.freeCash).toBeCloseTo(rejected.amount!, 9); // the returned money goes to freeCash
    expect(r.freeCash).toBeCloseTo(100 + cycle.amount!, 9);
    expect(r.maxInvariantError).toBeLessThan(1e-9);
  });
});

describe('pionex engine — fixed close price (plan §3.8)', () => {
  it('bot1ClosePrice stops bot 1 for good: no restart, cycle counter unchanged, nothing withdrawn', () => {
    const last = [flat(0, 100), bar(1, 100, 100, 95, 95), ...flats(2, 9, 95)];
    const r = runPionex(last, last, [], cfg({ bot1ClosePrice: 95, cycle: { takeProfitPct: 0.05, reinvestPct: 0.5 } }), 'A');
    const close = r.events.find(e => e.type === 'close')!;
    expect(close).toMatchObject({ timeMs: T0 + 5 * M, price: 95, reason: 'fixed close price' });
    expect(types(r)).not.toContain('restart');
    expect(types(r)).not.toContain('cycle');
    expect(r.cycles).toBe(0);
    expect(r.withdrawn).toBe(0);
    expect(r.status).toBe('stopped');
    expect(r.finalWallet).toBe(0);
    expect(r.freeCash).toBeCloseTo(100 + r.totals.realizedTradePnl, 9);
    expect(r.events.filter(e => e.type === 'close')).toHaveLength(1);
  });
});

describe('pionex engine — simultaneous interventions (plan §3.8)', () => {
  it('fixed close wins over a TP due at the same open; the closing bot\'s top-up is cancelled', () => {
    const last = flats(0, 5, 100);
    const r = runPionex(last, last, [], cfg({
      capitalTotal: 200,
      bot1ClosePrice: 200,
      cycle: { takeProfitPct: 0, reinvestPct: 0.5 },
      topUp: { triggerPct: 1, amount: 50 },
    }), 'A');
    expect(r.events.filter(e => e.timeMs === T0 + 5 * M).map(e => [e.type, e.reason])).toEqual([
      ['close', 'fixed close price'],
      ['topup_cancelled', 'bot closing'],
    ]);
    expect(r.cycles).toBe(0);
    expect(r.freeCash).toBe(200);
  });

  it('order on one open: close → (cancelled top-up) → restart → bot 2', () => {
    // Band 101–121 above the start: every level bought at market (qty 10), P_liq 90, distance 10 %.
    // L1 = 101 → the 5m close 100 < 101 · (1 − 0.001) triggers bot 2; TP 0 % → net 0 qualifies.
    const last = flats(0, 5, 100);
    const r = runPionex(last, last, [], cfg({
      capitalTotal: 400,
      cycle: { takeProfitPct: 0, reinvestPct: 0.5 },
      topUp: { triggerPct: 0.2, amount: 50 },
      bot2: { triggerOffsetPct: 0.001, capitalMultiplier: 1 },
    }, { lower: 101, upper: 121 }), 'A');
    expect(r.events.filter(e => e.timeMs === T0 + 5 * M).map(e => [e.type, e.bot])).toEqual([
      ['close', 0],
      ['cycle', 0],
      ['topup_cancelled', 0],
      ['restart', 0],
      ['start', 1],
    ]);
    expect(r.bots).toHaveLength(2);
    expect(r.bots[1]).toMatchObject({ lower: 81, upper: 101, status: 'active', startPrice: 100 });
    expect(r.freeCash).toBe(200); // 400 − bot 1 (100) − bot 2 (100); the restart used bot 1's own money
    expect(r.maxInvariantError).toBeLessThan(1e-9);
  });
});

describe('pionex engine — rejections with a reason (plan §3.7, §3.8)', () => {
  it('top-up rejected without free cash; bot 2 rejected once, never retried', () => {
    const last = flats(0, 14, 100);
    const r = runPionex(last, last, [], cfg({
      topUp: { triggerPct: 1, amount: 50 },
      bot2: { triggerOffsetPct: 0.001, capitalMultiplier: 1 },
    }, { lower: 101, upper: 121 }), 'A');
    const rejected = r.events.filter(e => e.type === 'topup_rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]).toMatchObject({ bot: 0, reason: 'no free cash' });
    const bot2 = r.events.filter(e => e.type === 'bot2_rejected');
    expect(bot2).toHaveLength(1);
    expect(bot2[0]).toMatchObject({ timeMs: T0 + 5 * M, amount: 100, reason: 'free cash below I2 + E2' });
    expect(r.bots).toHaveLength(1);
  });

  it('a liquidated bot\'s due top-up is cancelled, the money stays free', () => {
    // 5m close at 100 with distance 10 % → top-up due; minute 5 gaps to 80 → liquidated before it.
    const last = [...flats(0, 4, 100), flat(5, 80)];
    const r = runPionex(last, last, [], cfg({ capitalTotal: 300, topUp: { triggerPct: 0.2, amount: 50 } }, { lower: 101, upper: 121 }), 'A');
    expect(r.events.filter(e => e.timeMs === T0 + 5 * M).map(e => [e.type, e.reason])).toEqual([
      ['liquidation', undefined],
      ['topup_cancelled', 'already liquidated'],
    ]);
    expect(r.freeCash).toBe(200);
  });
});

describe('pionex engine — two bots, one ledger (plan §3.7, §3.8)', () => {
  it('invariant holds at every event with fees, funding, top-ups, a cycle and bot 2', () => {
    const last = [
      ...flats(0, 4, 100),
      bar(5, 100, 106, 99, 105), bar(6, 105, 105, 86, 88), ...flats(7, 9, 88),
      bar(10, 88, 97, 84, 96), bar(11, 96, 104, 95, 103), ...flats(12, 20, 103),
    ];
    const mark = last.map(b => ({ ...b, open: b.open - 0.1, high: b.high - 0.05, low: b.low - 0.2, close: b.close - 0.1 }));
    const funding = [{ fundingTimeMs: T0 + 8 * M + 2, rate: 0.001 }];
    const config = cfg({
      capitalTotal: 1000,
      costs: { makerFee: 0.0002, takerFee: 0.0005, mmr: 0.005 },
      marginCheck: true,
      cycle: { takeProfitPct: 0.02, reinvestPct: 0.3 },
      topUp: { triggerPct: 0.15, amount: 40 },
      bot2: { triggerOffsetPct: 0.01, capitalMultiplier: 1 },
    }, { extraMargin: 60 });
    for (const path of ['A', 'B'] as const) {
      const r = runPionex(last, mark, funding, config, path);
      expect(r.bots).toHaveLength(2);
      expect(r.events.some(e => e.bot === 1 && e.type === 'buy')).toBe(true);
      expect(r.events.some(e => e.type === 'funding')).toBe(true);
      expect(r.events.some(e => e.type === 'topup')).toBe(true);
      expect(r.cycles).toBeGreaterThanOrEqual(1);
      expect(r.maxInvariantError).toBeLessThan(1e-9);
      expect(Math.abs(invariant(r, 1000))).toBeLessThan(1e-9);
    }
  });

  it('inside one segment the bots\' fills run merged in price order, samples see both', () => {
    const capital = new Capital(1000);
    const grid = { lower: 90, upper: 110, mode: 'arithmetic' as const, investment: 100, extraMargin: 0, leverage: 10 };
    const a = new PionexLedger(capital, newBotState({ ...grid, gridCount: 10 })); // levels step 2
    const b = new PionexLedger(capital, newBotState({ ...grid, gridCount: 5 }));  // levels step 4
    a.fund(100);
    b.fund(100);
    const events: LedgerEvent[] = [];
    const samples: Sample[] = [];
    const ctx: StepContext = {
      ledgers: [a, b], costs: { makerFee: 0, takerFee: 0, mmr: 0 }, leverage: 10, marginCheck: false, timeMs: 0,
      emit: e => events.push(e),
      sample: mark => samples.push({ timeMs: 0, wealth: capital.freeCash + a.equity(mark) + b.equity(mark), liqDistPct: null, qty: a.bot.qty + b.bot.qty, liqPrices: [] }),
    };
    runSegment(ctx, 100, 90, 0);
    expect(events.map(e => [e.price, e.bot])).toEqual([
      [98, 0], [98, 1], [96, 0], [94, 0], [94, 1], [92, 0], [90, 0], [90, 1],
    ]);
    for (let k = 1; k < samples.length; k++) expect(samples[k].qty).toBeGreaterThanOrEqual(samples[k - 1].qty);
  });
});

describe('pionex engine — review regressions (Phase 2)', () => {
  it('the last bot\'s permanent close is sampled at once: underwater ends at the close', () => {
    // Last 100, mark 99, qty 5 → wealth 95; the fixed close at minute 5 (100) returns 100.
    const last = flats(0, 60, 100);
    const mark = flats(0, 60, 99);
    const r = runPionex(last, mark, [], cfg({ bot1ClosePrice: 100 }), 'A');
    expect(r.events.find(e => e.type === 'close')!.timeMs).toBe(T0 + 5 * M);
    const m = computeMetrics(r.samples);
    expect(m.underwaterMs).toBe(5 * M);
    expect(m.recovered).toBe(true);
    const atClose = r.samples.filter(x => x.timeMs === T0 + 5 * M);
    expect(atClose.at(-1)).toMatchObject({ wealth: 100, liqDistPct: null, qty: 0 });
  });

  it('restart_rejected (final stop) is sampled at once too', () => {
    const last = [flat(0, 100), bar(1, 100, 102, 100, 102), ...flats(2, 4, 102), ...flats(5, 30, 95)];
    const r = runPionex(last, last, [], cfg({ cycle: { takeProfitPct: 0.05, reinvestPct: 0.5 } }), 'A');
    const atStop = r.samples.filter(x => x.timeMs === T0 + 5 * M).at(-1)!;
    expect(atStop.wealth).toBeCloseTo(r.freeCash, 9);
    expect(atStop.qty).toBe(0);
  });

  it('an intervention whose execution minute is missing is dropped with an event, never run later', () => {
    // Fixed close due at minute 5's open; minute 5 is missing from the mark series.
    const last = flats(0, 14, 95);
    const mark = last.filter((_, i) => i !== 5);
    const r = runPionex(last, mark, [], cfg({ bot1ClosePrice: 96 }), 'A');
    const missed = r.events.find(e => e.type === 'intervention_missed')!;
    expect(missed).toMatchObject({ timeMs: T0 + 6 * M, bot: 0 });
    expect(missed.reason).toContain('fixed close');
    // No close at minute 6; the rule fires again on the next 5m close (minute 9) → minute 10.
    expect(r.events.filter(e => e.type === 'close').map(e => e.timeMs)).toEqual([T0 + 10 * M]);
  });

  it('a missing minute after a 5m close with nothing due emits no intervention_missed', () => {
    const last = flats(0, 14, 100);
    const mark = last.filter((_, i) => i !== 5);
    const r = runPionex(last, mark, [], cfg({ bot1ClosePrice: 50, topUp: { triggerPct: 0.01, amount: 10 } }), 'A');
    expect(types(r)).not.toContain('intervention_missed');
  });

  it('a losing TP execution still restarts from the extra margin when I + E_next ≥ I', () => {
    // Same gap-down TP as above, but E = 50: returned ≈ 122.9 ≥ I → restart with E_next < E_start.
    const last = [flat(0, 100), bar(1, 100, 102, 100, 102), ...flats(2, 4, 102), ...flats(5, 6, 95)];
    const r = runPionex(last, last, [], cfg({ cycle: { takeProfitPct: 0.05, reinvestPct: 0.5 } }, { extraMargin: 50 }), 'A');
    const cycle = r.events.find(e => e.type === 'cycle')!;
    expect(cycle.amount!).toBeLessThan(0);
    expect(r.withdrawn).toBe(0);
    expect(types(r)).toContain('restart');
    expect(types(r)).not.toContain('restart_rejected');
    expect(r.bots[0].status).toBe('active');
    expect(r.bots[0].wallet).toBeCloseTo(150 + cycle.amount!, 9); // I + E_start + profit
    expect(r.freeCash).toBe(0);
    expect(r.maxInvariantError).toBeLessThan(1e-9);
  });

  it('one bot liquidated, the other keeps trading', () => {
    // Bot 1 (90–110, E 0) fills down to 90 at minute 5 (P_liq ≈ 87.18). The 5m close 88 < 90·0.99
    // starts bot 2 (70–90) at minute 10's open; in the same candle the drop to 78 liquidates
    // bot 1 at 87.18 while bot 2 keeps buying, and bot 2 sells on the bounce at minute 11.
    const last = [...flats(0, 4, 100), flat(5, 88), ...flats(6, 9, 88), bar(10, 88, 88, 78, 78), bar(11, 78, 84, 78, 84)];
    const r = runPionex(last, last, [], cfg({
      capitalTotal: 400, bot2: { triggerOffsetPct: 0.01, capitalMultiplier: 1 },
    }, { extraMargin: 0 }), 'A');
    expect(r.bots).toHaveLength(2);
    expect(r.bots[0].status).toBe('liquidated');
    expect(r.status).toBe('liquidated');
    expect(r.bots[1].status).toBe('active');
    expect(r.events.some(e => e.bot === 1 && e.type === 'sell' && e.timeMs === T0 + 11 * M)).toBe(true);
    expect(r.maxInvariantError).toBeLessThan(1e-9);
  });

  it('a bot that survives on one path only makes the run path-dependent', () => {
    const last = [...flats(0, 4, 100), flat(5, 88), ...flats(6, 9, 88), bar(10, 88, 88, 78, 78), bar(11, 78, 84, 78, 84)];
    const a = runPionex(last, last, [], cfg({ capitalTotal: 400, bot2: { triggerOffsetPct: 0.01, capitalMultiplier: 1 } }), 'A');
    const liqBot2 = { ...a, bots: [a.bots[0], { ...a.bots[1], status: 'liquidated' as const, liquidatedAtMs: a.liquidatedAtMs! + M }] };
    // Same first liquidation and cycle count, but bot 2 survives on one path only.
    expect(decideVerdict(a, a, true)).toBe('liquidated');
    expect(decideVerdict(a, liqBot2, true)).toBe('path_dependent');
  });
});
