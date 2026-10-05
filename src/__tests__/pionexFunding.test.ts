import { describe, it, expect } from 'vitest';
import {
  bucketFunding,
  fundingBucket,
  fundingCoverageGaps,
  MAX_FUNDING_SPACING_MS,
  FundingRecord,
} from '../lib/pionex/funding';

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
