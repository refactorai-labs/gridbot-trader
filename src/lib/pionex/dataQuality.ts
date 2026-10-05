// Pionex backtester — data quality check before a run (plan §3.10).
// Expected vs found minutes for 1m last and 1m mark, the list of holes, and the
// strict funding coverage. Any gap → the run may proceed but the verdict is
// "data-incomplete" with no survival claim. A minute missing from only one
// series is a gap: the engine never fills in from the other series.

import { OHLC } from '../types';
import { computeMissingGaps } from '../data/candleCache';
import { FundingGap } from './funding';

export interface MinuteGap {
  startMs: number;
  endMs: number;
  minutes: number;
}

export interface SeriesQuality {
  expected: number;
  found: number;
  gaps: MinuteGap[];
}

export interface DataGapReport {
  symbol: string;
  startMs: number;
  endMs: number;
  last: SeriesQuality;
  mark: SeriesQuality;
  funding: { records: number; gaps: FundingGap[] };
  errors: string[]; // why a series could not be (fully) fetched — any error → incomplete
  complete: boolean;
}

const MINUTE_MS = 60_000;

export function minuteSeriesQuality(candles: OHLC[], startMs: number, endMs: number): SeriesQuality {
  const first = Math.ceil(startMs / MINUTE_MS) * MINUTE_MS;
  const last = Math.floor((endMs - 1) / MINUTE_MS) * MINUTE_MS;
  const expected = last >= first ? (last - first) / MINUTE_MS + 1 : 0;
  const gaps = computeMissingGaps(candles, startMs, endMs, MINUTE_MS).map(g => ({
    ...g,
    minutes: (g.endMs - g.startMs) / MINUTE_MS,
  }));
  const missing = gaps.reduce((s, g) => s + g.minutes, 0);
  return { expected, found: expected - missing, gaps };
}

export function buildGapReport(
  symbol: string,
  startMs: number,
  endMs: number,
  last1m: OHLC[],
  mark1m: OHLC[],
  funding: { records: number; gaps: FundingGap[] },
  errors: string[] = []
): DataGapReport {
  const last = minuteSeriesQuality(last1m, startMs, endMs);
  const mark = minuteSeriesQuality(mark1m, startMs, endMs);
  return {
    symbol,
    startMs,
    endMs,
    last,
    mark,
    funding,
    errors,
    complete: last.gaps.length === 0 && mark.gaps.length === 0 && funding.gaps.length === 0 && errors.length === 0,
  };
}
