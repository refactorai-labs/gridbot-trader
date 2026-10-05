import { describe, it, expect } from 'vitest';
import {
  bucketFunding,
  fundingBucket,
  fundingCoverageGaps,
  MAX_FUNDING_SPACING_MS,
  FundingRecord,
} from '../lib/pionex/funding';
import { OHLC } from '../lib/types';
import { runPionex } from '../lib/pionex/engine';
import { decideVerdict } from '../lib/pionex/metrics';
import { buildGapReport } from '../lib/pionex/dataQuality';
import { PionexRunConfig } from '../lib/pionex/types';

const H = 3_600_000;
const T0 = Date.UTC(2022, 4, 10); // 2022-05-10 00:00 UTC (a settlement minute)

const rec = (ms: number, rate = 0.0001): FundingRecord => ({ fundingTimeMs: ms, rate });

describe('pionex funding — minute bucket (plan §3.4.3)', () => {
  it('a settlement 1–4 ms after the minute open lands in that minute, exactly once', () => {
    const buckets = bucketFunding([rec(T0 + 3), rec(T0 + 8 * H + 1)]);
    expect(buckets.size).toBe(2);
    expect(buckets.get(fundingBucket(T0))?.fundingTimeMs).toBe(T0 + 3);
    expect(buckets.get(fundingBucket(T0 + 8 * H))?.fundingTimeMs).toBe(T0 + 8 * H + 1);
    expect(fundingBucket(T0 + 3)).toBe(T0 / 60_000);
  });

  it('two records in one minute bucket is a data error', () => {
    expect(() => bucketFunding([rec(T0 + 1), rec(T0 + 40_000)])).toThrow(/two settlements/);
  });
});

describe('pionex funding — strict coverage (plan §3.4.3)', () => {
  const start = T0 - 2 * H;
  const end = T0 + 24 * H;
  const full = [rec(T0), rec(T0 + 8 * H), rec(T0 + 16 * H)];

  it('8h spacing with a sub-8h lead-in and tail-out is fully covered', () => {
    expect(fundingCoverageGaps(full, start, end)).toEqual([]);
  });

  it('a skipped settlement is reported as a gap → data-incomplete verdict', () => {
    const gaps = fundingCoverageGaps([rec(T0), rec(T0 + 16 * H)], start, end);
    expect(gaps).toEqual([{ startMs: T0, endMs: T0 + 16 * H }]);
  });

  it('a missing first or last settlement is a gap against the window edges', () => {
    expect(fundingCoverageGaps([rec(T0 + 8 * H), rec(T0 + 16 * H)], start, end)).toEqual([
      { startMs: start, endMs: T0 + 8 * H },
    ]);
    expect(fundingCoverageGaps([rec(T0), rec(T0 + 8 * H)], start, end)).toEqual([
      { startMs: T0 + 8 * H, endMs: end },
    ]);
  });

  it('tolerance is exactly 8h + 1min; records outside the window are ignored', () => {
    expect(MAX_FUNDING_SPACING_MS).toBe(8 * H + 60_000);
    const ok = [rec(T0), rec(T0 + 8 * H + 60_000), rec(T0 + 16 * H + 60_000)];
    expect(fundingCoverageGaps(ok, start, end)).toEqual([]);
    const outside = [rec(start - 1), ...full, rec(end)];
    expect(fundingCoverageGaps(outside, start, end)).toEqual([]);
  });
});

// Engine side (plan §3.4 step 2): band 90–110, 10 grids, Q = 100; start at 100
// buys 5 qty at market, zero fees, wallet 100.
const M = 60_000;
const flatBar = (i: number, p: number): OHLC => ({ timestamp: (T0 + i * M) / 1000, open: p, high: p, low: p, close: p, volume: 0 });
const runCfg: PionexRunConfig = {
  bot: { lower: 90, upper: 110, gridCount: 10, mode: 'arithmetic', investment: 100, extraMargin: 0, leverage: 10 },
  costs: { makerFee: 0, takerFee: 0, mmr: 0 },
  marginCheck: false,
};
const fundingEvents = (r: ReturnType<typeof runPionex>) => r.events.filter(e => e.type === 'funding');

describe('pionex engine — funding settlement (plan §3.4.3)', () => {
  // Minute 2 drops to 95 inside the candle (buys at 98 and 96 in step 4).
  const last = [flatBar(0, 100), flatBar(1, 100), { ...flatBar(2, 100), low: 95, close: 95 }, flatBar(3, 95)];

  it('a settlement 1–4 ms after the minute open is applied in that minute, exactly once, at the mark open', () => {
    const mark = last.map(b => ({ ...b, open: b.open + 1, high: b.high + 1, low: b.low + 1, close: b.close + 1 }));
    const r = runPionex(last, mark, [rec(T0 + 2 * M + 3, 0.001)], runCfg, 'A');
    const f = fundingEvents(r);
    expect(f.length).toBe(1);
    expect(f[0].timeMs).toBe(T0 + 2 * M);
    // Only the 5 qty held before the settlement pays — the buys of minute 2 come later.
    expect(f[0].amount).toBeCloseTo(5 * 101 * 0.001, 12);
    expect(r.totals.funding).toBeCloseTo(0.505, 12);
    const idx = r.events.indexOf(f[0]);
    expect(r.events.slice(idx + 1).some(e => e.type === 'buy')).toBe(true);
  });

  it('sign: a long pays a positive rate and receives a negative one', () => {
    const pay = runPionex(last, last, [rec(T0 + M + 1, 0.001)], runCfg, 'A');
    const recv = runPionex(last, last, [rec(T0 + M + 1, -0.001)], runCfg, 'A');
    expect(pay.totals.funding).toBeCloseTo(0.5, 12);
    expect(recv.totals.funding).toBeCloseTo(-0.5, 12);
    expect(recv.finalWealth - pay.finalWealth).toBeCloseTo(1, 12);
  });

  it('a position opened after the settlement does not pay it', () => {
    // Settlement in the start minute: the bot opens in step 3, after funding (step 2).
    const r = runPionex(last, last, [rec(T0 + 4, 0.01)], runCfg, 'A');
    expect(fundingEvents(r)).toEqual([]);
    expect(r.totals.funding).toBe(0);
  });

  it('liquidation is checked right after funding, before the candle moves', () => {
    // 5 qty · 100 · 0.2 = 100 = the whole wallet → P_liq = 100 = mark open.
    const r = runPionex(last, last, [rec(T0 + M + 2, 0.2)], runCfg, 'A');
    expect(r.status).toBe('liquidated');
    expect(r.liquidatedAtMs).toBe(T0 + M);
    expect(r.events.map(e => e.type)).toEqual(['start', 'funding', 'liquidation']);
  });

  it('a skipped settlement record → data-incomplete verdict', () => {
    const start = T0 - 2 * H;
    const end = T0 + 24 * H;
    const records = [rec(T0), rec(T0 + 16 * H)]; // T0 + 8h is missing
    const gaps = fundingCoverageGaps(records, start, end);
    const bars = Array.from({ length: (end - start) / M }, (_, i) => flatBar((start - T0) / M + i, 100));
    const report = buildGapReport('ETHUSDT', start, end, bars, bars, { records: records.length, gaps });
    const r = runPionex(bars, bars, records, runCfg, 'A');
    expect(report.last.gaps).toEqual([]);
    expect(report.mark.gaps).toEqual([]);
    expect(report.complete).toBe(false);
    expect(r.status).toBe('active');
    expect(decideVerdict(r, r, report.complete)).toBe('data_incomplete');
  });
});
