// Pionex backtester — Top N drawdowns from 1h futures history (plan §2/8, §6.2).
// Depth is measured against the highest high of a trailing lookback (default
// 30 days, by timestamp), so a multi-month bear market yields its sharp legs as separate
// episodes instead of one giant peak-to-trough span. Episodes are mutually
// excluded within ±lookback of the trough. Picking a window from this list
// uses hindsight (the peak is known); the UI labels it as such.

import { OHLC } from '../types';
import { getOrFetchCandles, getCachedCandles, computeMissingGaps } from '../data/candleCache';
import { pionexLastPair } from '../constants';

export interface DrawdownEpisode {
  peakMs: number;
  peakPrice: number;
  troughMs: number;
  troughPrice: number;
  depthPct: number;           // (peak − trough) / peak, positive
  recoveredMs: number | null; // first 1h bar after the trough whose high ≥ peak, or null
}

export function topDrawdowns(candles1h: OHLC[], n: number, lookbackDays = 30): DrawdownEpisode[] {
  const len = candles1h.length;
  if (len === 0 || n <= 0) return [];
  // Lookback and exclusion are measured in time, not bars, so a hole in the
  // history can never stretch the window.
  const lookbackSec = lookbackDays * 86_400;
  const ts = (i: number) => candles1h[i].timestamp;

  // Trailing-window peak index per bar (monotonic deque on highs).
  const peakIdx = new Int32Array(len);
  const dd = new Float64Array(len);
  const deque: number[] = [];
  for (let i = 0; i < len; i++) {
    while (deque.length && ts(deque[0]) < ts(i) - lookbackSec) deque.shift();
    while (deque.length && candles1h[deque[deque.length - 1]].high <= candles1h[i].high) deque.pop();
    deque.push(i);
    peakIdx[i] = deque[0];
    const peak = candles1h[deque[0]].high;
    dd[i] = peak > 0 ? (peak - candles1h[i].low) / peak : 0;
  }

  const excluded = new Uint8Array(len);
  const episodes: DrawdownEpisode[] = [];
  for (let k = 0; k < n; k++) {
    let best = -1;
    for (let i = 0; i < len; i++) {
      if (!excluded[i] && dd[i] > 0 && (best < 0 || dd[i] > dd[best])) best = i;
    }
    if (best < 0) break;
    const p = peakIdx[best];
    const peakPrice = candles1h[p].high;
    let recoveredMs: number | null = null;
    for (let j = best + 1; j < len; j++) {
      if (candles1h[j].high >= peakPrice) { recoveredMs = candles1h[j].timestamp * 1000; break; }
    }
    episodes.push({
      peakMs: candles1h[p].timestamp * 1000,
      peakPrice,
      troughMs: candles1h[best].timestamp * 1000,
      troughPrice: candles1h[best].low,
      depthPct: dd[best],
      recoveredMs,
    });
    for (let i = 0; i < len; i++) {
      if (Math.abs(ts(i) - ts(best)) <= lookbackSec) excluded[i] = 1;
    }
  }
  return episodes;
}

// First 1h bar on Binance USDT-M futures per symbol (verified against the
// cache); the cache never asks for earlier data, so no pre-listing gap is fetched.
const FUTURES_LISTING_MS: Record<string, number> = {
  BTCUSDT: Date.UTC(2019, 8, 8, 17),
  ETHUSDT: Date.UTC(2019, 10, 27, 7),
  SOLUSDT: Date.UTC(2020, 8, 14, 7),
};

export interface History1h {
  candles: OHLC[];
  gaps: Array<{ startMs: number; endMs: number }>; // missing closed 1h bars since listing
  error: string | null;                             // why the fetch did not complete
}

// Full 1h history (cached; only missing stretches are fetched). A failed fetch
// or a residual hole is reported, never silently treated as full history.
export async function getFullHistory1h(symbol: string): Promise<History1h> {
  const pair = pionexLastPair(symbol);
  const listingMs = FUTURES_LISTING_MS[symbol];
  if (listingMs === undefined) throw new Error(`No futures listing time for ${symbol}`);
  const start = new Date(listingMs);
  const end = new Date();
  let candles: OHLC[];
  let error: string | null = null;
  try {
    candles = await getOrFetchCandles(pair, '1h', start, end, undefined, { market: 'futures', symbol });
  } catch (e) {
    if (e instanceof Error && e.name.startsWith('PrismaClient')) throw e;
    error = e instanceof Error ? e.message : String(e);
    candles = await getCachedCandles(pair, '1h', start, end);
  }
  // Only closed bars are required (the forming bar is never cached).
  const closedEndMs = Math.floor(end.getTime() / 3_600_000) * 3_600_000;
  const gaps = computeMissingGaps(candles, listingMs, closedEndMs, 3_600_000);
  return { candles, gaps, error };
}
