// Database cache for OHLCV candle data (Binance)

import prisma from '../prisma';
import { OHLC } from '../types';
import { fetchBinanceKlines } from './binanceApi';

// Get cached Binance candles from database
export async function getCachedCandles(
  pair: string,
  interval: string,
  startTime: Date,
  endTime: Date
): Promise<OHLC[]> {
  const startMs = BigInt(startTime.getTime());
  const endMs = BigInt(endTime.getTime());

  const candles = await prisma.binanceCandle.findMany({
    where: {
      pair,
      interval,
      openTime: {
        gte: startMs,
        lt: endMs,
      },
    },
    orderBy: { openTime: 'asc' },
  });

  return candles.map(c => ({
    timestamp: Number(c.openTime) / 1000, // BigInt ms -> seconds
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

// Store candles in BinanceCandle table using batch INSERT OR IGNORE (SQLite)
export async function storeCandlesInCache(
  pair: string,
  interval: string,
  candles: OHLC[]
): Promise<number> {
  if (candles.length === 0) return 0;

  // Validate pair/interval are alphanumeric to prevent injection
  if (!/^[A-Za-z0-9]+$/.test(pair) || !/^[0-9]+[a-z]$/.test(interval)) {
    throw new Error(`Invalid pair "${pair}" or interval "${interval}"`);
  }

  // Only persist fully-closed candles. The still-forming candle (openTime + tfMs > now)
  // is excluded so the cache holds only finalized, immutable rows and never serves a
  // stale partial bar. It is naturally re-fetched on the next run once it has closed.
  const tfMs = getTimeframeMinutes(interval) * 60_000;
  const now = Date.now();

  // Batch in chunks of 500 to avoid SQLite variable limits
  const BATCH_SIZE = 500;
  let totalStored = 0;

  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE);
    const values = batch
      .filter(c => isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close) && isFinite(c.volume))
      .filter(c => c.timestamp * 1000 + tfMs <= now)
      .map(c => {
        const openTimeMs = BigInt(c.timestamp * 1000);
        return `('${pair}', ${openTimeMs}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume}, '${interval}')`;
      }).join(',\n');

    if (!values) continue;
    const result = await prisma.$executeRawUnsafe(`
      INSERT OR IGNORE INTO BinanceCandle (pair, openTime, open, high, low, close, volume, interval)
      VALUES ${values}
    `);
    totalStored += result;
  }

  return totalStored;
}

// Compute missing contiguous bucket ranges in [startMs, endMs) given an ascending cached list.
// Returns half-open [gapStartMs, gapEndMs) windows aligned to bucket boundaries.
// Returns [] for malformed/sub-bucket ranges so the caller can short-circuit.
export function computeMissingGaps(
  cached: OHLC[],
  startMs: number,
  endMs: number,
  tfMs: number
): Array<{ startMs: number; endMs: number }> {
  if (endMs <= startMs || tfMs <= 0) return [];

  // Smallest bucket boundary >= startMs (matches cache query openTime >= startMs).
  const firstExpectedMs = Math.ceil(startMs / tfMs) * tfMs;
  // Largest bucket boundary < endMs (matches cache query openTime < endMs).
  const lastExpectedMs = Math.floor((endMs - 1) / tfMs) * tfMs;

  if (firstExpectedMs > lastExpectedMs) return [];

  const gaps: Array<{ startMs: number; endMs: number }> = [];
  let cursorMs = firstExpectedMs;

  for (const c of cached) {
    const cMs = c.timestamp * 1000;
    if (cMs < cursorMs) continue; // outside expected window or duplicate
    if (cMs > cursorMs) {
      gaps.push({ startMs: cursorMs, endMs: cMs });
    }
    cursorMs = cMs + tfMs;
  }

  if (cursorMs <= lastExpectedMs) {
    gaps.push({ startMs: cursorMs, endMs: lastExpectedMs + tfMs });
  }

  return gaps;
}

// Fetch candles, caching in database. Fills only missing gaps; never re-pulls fully cached data.
export async function getOrFetchCandles(
  pair: string,
  timeframe: string,
  startTime: Date,
  endTime: Date,
  onProgress?: (fetched: number) => void
): Promise<OHLC[]> {
  const now = Date.now();
  const startMs = startTime.getTime();
  // Clamp the end to now so a "today/future" end reaches the latest available candle.
  const endMs = Math.min(endTime.getTime(), now);
  const clampedEnd = new Date(endMs);
  const tfMs = getTimeframeMinutes(timeframe) * 60_000;

  const cached = await getCachedCandles(pair, timeframe, startTime, clampedEnd);
  const gaps = computeMissingGaps(cached, startMs, endMs, tfMs);

  if (gaps.length === 0) return cached;

  for (const gap of gaps) {
    const fetched = await fetchBinanceKlines(pair, timeframe, gap.startMs, gap.endMs, onProgress);
    if (fetched.length > 0) {
      await storeCandlesInCache(pair, timeframe, fetched);
    }
  }

  // Re-query so the returned array reflects exactly what's now persisted.
  const finalCandles = await getCachedCandles(pair, timeframe, startTime, clampedEnd);

  // Coverage is only required up to the last fully-closed bucket; the still-forming
  // bucket is intentionally never persisted, so don't flag it as a missing gap.
  const coverageEndMs = Math.min(endMs, Math.floor(now / tfMs) * tfMs);
  const remaining = computeMissingGaps(finalCandles, startMs, coverageEndMs, tfMs);
  if (remaining.length > 0) {
    const ranges = remaining
      .map(g => `[${new Date(g.startMs).toISOString()}, ${new Date(g.endMs).toISOString()})`)
      .join(', ');
    throw new Error(
      `Unable to fetch ${pair} ${timeframe} candles for ${ranges}; Binance returned no data for this range`
    );
  }

  return finalCandles;
}

export function getTimeframeMinutes(timeframe: string): number {
  switch (timeframe) {
    case '5m': return 5;
    case '15m': return 15;
    case '1h': return 60;
    case '4h': return 240;
    case '1d': return 1440;
    default: return 60;
  }
}
