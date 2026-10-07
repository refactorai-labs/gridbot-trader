import { describe, expect, it } from 'vitest';
import type { OHLC } from '../lib/types';
import { aggregateAligned, makeBucketLookup } from '../lib/data/alignedAggregator';

const T0 = Date.UTC(2026, 0, 1) / 1000; // aligned to every bucket size used here
const S = 300;

function c(ts: number, price: number, volume = 1): OHLC {
  return { timestamp: ts, open: price, high: price + 1, low: price - 1, close: price, volume };
}

describe('aggregateAligned', () => {
  it('5m passthrough keeps every candle, all complete', () => {
    const src = [c(T0, 10), c(T0 + S, 11), c(T0 + 2 * S, 12)];
    const out = aggregateAligned(src, 5);
    expect(out).toHaveLength(3);
    expect(out.every(b => b.complete)).toBe(true);
    expect(out.map(b => b.close)).toEqual([10, 11, 12]);
    expect(out[1].startTs).toBe(T0 + S);
  });

  it('unaligned start gives a partial first bucket keyed to the clock', () => {
    // 15m buckets; start at T0+10m → first bucket [T0, T0+15m) holds one candle.
    const src = [c(T0 + 2 * S, 1), c(T0 + 3 * S, 2), c(T0 + 4 * S, 3), c(T0 + 5 * S, 4)];
    const out = aggregateAligned(src, 15);
    expect(out.map(b => b.startTs)).toEqual([T0, T0 + 3 * S]);
    expect(out[0].complete).toBe(false);
    expect(out[1].complete).toBe(true);
    expect(out[1]).toMatchObject({ open: 2, close: 4, high: 5, low: 1, volume: 3 });
  });

  it('internal gap never shifts later buckets', () => {
    // 15m buckets; the middle bucket is missing one candle.
    const src = [0, 1, 2, 3, 5, 6, 7, 8].map(i => c(T0 + i * S, i));
    const out = aggregateAligned(src, 15);
    expect(out.map(b => b.startTs)).toEqual([T0, T0 + 3 * S, T0 + 6 * S]);
    expect(out.map(b => b.complete)).toEqual([true, false, true]);
    expect(out[2].open).toBe(6);
  });

  it('partial last bucket is kept and flagged', () => {
    const src = [0, 1, 2, 3].map(i => c(T0 + i * S, i));
    const out = aggregateAligned(src, 15);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ startTs: T0 + 3 * S, complete: false, close: 3 });
  });

  it('bucket lookup maps any timestamp to its bucket index', () => {
    const src = [0, 1, 2, 3, 4].map(i => c(T0 + i * S, i));
    const out = aggregateAligned(src, 15);
    const bucketOf = makeBucketLookup(out, 15);
    expect(bucketOf(T0 + 4 * S)).toBe(1);
    expect(bucketOf(T0 + 2 * S + 299)).toBe(0);
    expect(bucketOf(T0 + 100 * S)).toBe(-1);
  });
});
