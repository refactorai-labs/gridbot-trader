// Clock-aligned aggregation of 5m candles (classic grid engine v1 + replay).
// Unlike aggregate5mTo (index-based, drops the tail), buckets are keyed by
// floor(timestamp / bucket), so internal gaps never shift later buckets, and
// partial first/last buckets are kept and flagged `complete: false`.

import { OHLC } from '../types';

export interface AlignedCandle extends OHLC {
  startTs: number;    // bucket start, seconds (equals `timestamp`)
  complete: boolean;  // true when every 5m candle of the bucket is present
}

const FIVE_MIN_S = 300;

export function aggregateAligned(candles5m: OHLC[], minutes: number): AlignedCandle[] {
  const bucketSec = Math.max(5, minutes) * 60;
  const expected = bucketSec / FIVE_MIN_S;
  const result: AlignedCandle[] = [];
  let count = 0;

  for (const c of candles5m) {
    const startTs = Math.floor(c.timestamp / bucketSec) * bucketSec;
    const last = result[result.length - 1];
    if (last && last.startTs === startTs) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
      count++;
      last.complete = count === expected;
    } else {
      count = 1;
      result.push({
        timestamp: startTs,
        startTs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        complete: count === expected,
      });
    }
  }

  return result;
}

// Index of the bucket that holds `ts` (seconds), or -1. Buckets must come from
// aggregateAligned with the same `minutes`.
export function makeBucketLookup(buckets: AlignedCandle[], minutes: number): (ts: number) => number {
  const bucketSec = Math.max(5, minutes) * 60;
  const byStart = new Map<number, number>();
  buckets.forEach((b, i) => byStart.set(b.startTs, i));
  return (ts: number) => byStart.get(Math.floor(ts / bucketSec) * bucketSec) ?? -1;
}
