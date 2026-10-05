// Pionex backtester — 1m → 5m aggregation for display only (plan §2/11).
// Buckets by timestamp (floor(ts / 300 s)), so holes in the 1m data never shift
// a candle into the wrong bucket. Decisions use the 1m data directly (plan §3.4).

import { OHLC } from '../types';

const FIVE_MIN_S = 300;

export function aggregateTo5m(candles1m: OHLC[]): OHLC[] {
  const out: OHLC[] = [];
  for (const c of candles1m) {
    const t = Math.floor(c.timestamp / FIVE_MIN_S) * FIVE_MIN_S;
    const cur = out[out.length - 1];
    if (cur && cur.timestamp === t) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    } else {
      out.push({ timestamp: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

// A 1m event time (ms) → the open time (s) of its 5m candle on the chart (plan §6.4).
export const fiveMinuteBucketSec = (timeMs: number): number =>
  Math.floor(timeMs / 1000 / FIVE_MIN_S) * FIVE_MIN_S;
