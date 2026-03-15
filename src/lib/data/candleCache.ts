// Database cache for OHLCV candle data
// Avoids re-fetching from GeckoTerminal

import prisma from '../prisma';
import { OHLC } from '../types';
import { fetchCandlesForRange } from './geckoterminal';

// Get cached candles from database
export async function getCachedCandles(
  poolAddress: string,
  timeframe: string,
  startTime: Date,
  endTime: Date
): Promise<OHLC[]> {
  const candles = await prisma.candleCache.findMany({
    where: {
      poolAddress,
      timeframe,
      timestamp: {
        gte: startTime,
        lte: endTime,
      },
    },
    orderBy: { timestamp: 'asc' },
  });

  return candles.map(c => ({
    timestamp: Math.floor(c.timestamp.getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

// Store candles in database cache
export async function storeCandlesInCache(
  pair: string,
  poolAddress: string,
  chain: string,
  timeframe: string,
  candles: OHLC[]
): Promise<number> {
  if (candles.length === 0) return 0;

  // Use upsert-like behavior with createMany + skipDuplicates
  const data = candles.map(c => ({
    pair,
    poolAddress,
    chain,
    timeframe,
    timestamp: new Date(c.timestamp * 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  // Insert candles one by one, skipping duplicates via upsert
  let stored = 0;

  for (const candle of data) {
    try {
      await prisma.candleCache.upsert({
        where: {
          poolAddress_timeframe_timestamp: {
            poolAddress: candle.poolAddress,
            timeframe: candle.timeframe,
            timestamp: candle.timestamp,
          },
        },
        update: {}, // No update needed — data is immutable
        create: candle,
      });
      stored++;
    } catch {
      // Skip duplicates silently
    }
  }

  return stored;
}

// Fetch candles, caching in database. Returns cached data if available.
export async function getOrFetchCandles(
  pair: string,
  poolAddress: string,
  chain: string,
  timeframe: string,
  startTime: Date,
  endTime: Date,
  onProgress?: (fetched: number) => void
): Promise<OHLC[]> {
  // Check cache first
  const cached = await getCachedCandles(poolAddress, timeframe, startTime, endTime);

  // Calculate expected candle count for the range
  const timeframeMins = getTimeframeMinutes(timeframe);
  const rangeMinutes = (endTime.getTime() - startTime.getTime()) / 60000;
  const expectedCandles = Math.floor(rangeMinutes / timeframeMins);

  // If we have >= 90% of expected candles, use cache
  if (cached.length >= expectedCandles * 0.9) {
    return cached;
  }

  // Fetch from API and cache
  const fetched = await fetchCandlesForRange(
    chain, poolAddress, timeframe, startTime, endTime, onProgress
  );

  // Store in cache
  await storeCandlesInCache(pair, poolAddress, chain, timeframe, fetched);

  return fetched;
}

function getTimeframeMinutes(timeframe: string): number {
  switch (timeframe) {
    case '5m': return 5;
    case '15m': return 15;
    case '1h': return 60;
    case '4h': return 240;
    case '1d': return 1440;
    default: return 60;
  }
}
