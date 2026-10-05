import { describe, it, expect } from 'vitest';
import { OHLC } from '../lib/types';
import { minuteSeriesQuality, buildGapReport } from '../lib/pionex/dataQuality';
import { topDrawdowns } from '../lib/pionex/drawdowns';

const bar = (sec: number, o: number, h: number, l: number, c: number): OHLC => ({ timestamp: sec, open: o, high: h, low: l, close: c, volume: 0 });
const flat1m = (startSec: number, count: number, skip: number[] = []): OHLC[] =>
  Array.from({ length: count }, (_, i) => i).filter(i => !skip.includes(i)).map(i => bar(startSec + i * 60, 1, 1, 1, 1));

describe('pionex data quality (plan §3.10)', () => {
  const startMs = Date.UTC(2022, 4, 10);
  const endMs = startMs + 10 * 60_000;

  it('counts expected vs found minutes and lists holes', () => {
    const q = minuteSeriesQuality(flat1m(startMs / 1000, 10, [3, 4, 8]), startMs, endMs);
    expect(q.expected).toBe(10);
    expect(q.found).toBe(7);
    expect(q.gaps).toEqual([
      { startMs: startMs + 3 * 60_000, endMs: startMs + 5 * 60_000, minutes: 2 },
      { startMs: startMs + 8 * 60_000, endMs: startMs + 9 * 60_000, minutes: 1 },
    ]);
  });

  it('a minute missing from only one series still makes the report incomplete', () => {
    const last = flat1m(startMs / 1000, 10);
    const mark = flat1m(startMs / 1000, 10, [5]);
    const r = buildGapReport('ETHUSDT', startMs, endMs, last, mark, { records: 1, gaps: [] });
    expect(r.last.gaps).toEqual([]);
    expect(r.mark.gaps.length).toBe(1);
    expect(r.complete).toBe(false);
    expect(buildGapReport('ETHUSDT', startMs, endMs, last, last, { records: 1, gaps: [] }).complete).toBe(true);
    expect(buildGapReport('ETHUSDT', startMs, endMs, last, last, { records: 0, gaps: [{ startMs, endMs }] }).complete).toBe(false);
    const withError = buildGapReport('ETHUSDT', startMs, endMs, last, last, { records: 1, gaps: [] }, ['funding: timeout']);
    expect(withError.errors).toEqual(['funding: timeout']);
    expect(withError.complete).toBe(false);
  });
});

describe('pionex top drawdowns (plan §2/8)', () => {
  it('finds separate legs under a trailing lookback and orders by depth', () => {
    // 1h bars; prices: 100 → 60 (day 2), recover to 100 (day 4), → 80 (day 6), recover 100 (day 8).
    const bars: OHLC[] = [];
    const path = [100, 60, 100, 100, 80, 100, 100];
    for (let d = 0; d < path.length; d++) {
      for (let h = 0; h < 24; h++) {
        const p = path[d];
        bars.push(bar(d * 86_400 + h * 3600, p, p, p, p));
      }
    }
    const eps = topDrawdowns(bars, 5, 1);
    expect(eps.length).toBe(2);
    expect(eps[0].depthPct).toBeCloseTo(0.4, 6);
    expect(eps[0].peakPrice).toBe(100);
    expect(eps[0].troughPrice).toBe(60);
    expect(eps[0].recoveredMs).toBe(2 * 86_400_000);
    expect(eps[1].depthPct).toBeCloseTo(0.2, 6);
  });

  it('returns nothing for an empty or monotonic series', () => {
    expect(topDrawdowns([], 5)).toEqual([]);
    const up = Array.from({ length: 48 }, (_, i) => bar(i * 3600, 1 + i, 1 + i, 1 + i, 1 + i));
    expect(topDrawdowns(up, 5)).toEqual([]);
  });
});
