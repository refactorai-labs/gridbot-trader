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
        lte: endMs,
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

  // Batch in chunks of 500 to avoid SQLite variable limits
  const BATCH_SIZE = 500;
  let totalStored = 0;

  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE);
    const values = batch.map(c => {
      const openTimeMs = BigInt(c.timestamp * 1000);
      return `('${pair}', ${openTimeMs}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume}, '${interval}')`;
    }).join(',\n');

    const result = await prisma.$executeRawUnsafe(`
      INSERT OR IGNORE INTO BinanceCandle (pair, openTime, open, high, low, close, volume, interval)
      VALUES ${values}
    `);
    totalStored += result;
  }

  return totalStored;
}

// Fetch candles, caching in database. Returns cached data if available.
export async function getOrFetchCandles(
  pair: string,
  timeframe: string,
  startTime: Date,
  endTime: Date,
  onProgress?: (fetched: number) => void
): Promise<OHLC[]> {
  // Check cache first
  const cached = await getCachedCandles(pair, timeframe, startTime, endTime);

  // Calculate expected candle count for the range
  const timeframeMins = getTimeframeMinutes(timeframe);
  const rangeMinutes = (endTime.getTime() - startTime.getTime()) / 60000;
  const expectedCandles = Math.floor(rangeMinutes / timeframeMins);

  // If we have >= 90% of expected candles, use cache
  if (cached.length >= expectedCandles * 0.9) {
    return cached;
  }

  // Fetch from Binance API
  const fetched = await fetchBinanceKlines(
    pair, timeframe,
    startTime.getTime(), endTime.getTime(),
    onProgress
  );

  // Store in cache
  await storeCandlesInCache(pair, timeframe, fetched);

  return fetched;
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
