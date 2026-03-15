// GeckoTerminal API client for OHLCV candle data
// Adapted from memecoin-trader with multi-timeframe support

import { OHLC, GeckoTerminalOHLCResponse } from '../types';
import { fetchWithTimeout } from './fetch';
import { GECKO_API } from '../constants';

// Retry fetch on 429 with exponential backoff
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries: number = GECKO_API.maxRetries
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetchWithTimeout(url, options);
    if (response.status === 429 && attempt < retries) {
      const delay = GECKO_API.initialRetryDelay * Math.pow(2, attempt);
      console.warn(`GeckoTerminal 429 rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return response;
  }
  return fetchWithTimeout(url, options);
}

// Parse timeframe string to API parameters
function parseTimeframe(timeframe: string): { apiTimeframe: 'minute' | 'hour' | 'day'; aggregate: number } {
  switch (timeframe) {
    case '5m': return { apiTimeframe: 'minute', aggregate: 5 };
    case '15m': return { apiTimeframe: 'minute', aggregate: 15 };
    case '1h': return { apiTimeframe: 'hour', aggregate: 1 };
    case '4h': return { apiTimeframe: 'hour', aggregate: 4 };
    case '1d': return { apiTimeframe: 'day', aggregate: 1 };
    default: return { apiTimeframe: 'hour', aggregate: 1 };
  }
}

// Fetch a single batch of OHLCV candles
export async function getOHLC(
  chain: string,
  poolAddress: string,
  timeframe: string = '1h',
  limit: number = 1000,
  beforeTimestamp?: number
): Promise<OHLC[]> {
  const { apiTimeframe, aggregate } = parseTimeframe(timeframe);

  let url = `${GECKO_API.baseUrl}/networks/${chain}/pools/${poolAddress}/ohlcv/${apiTimeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`;
  if (beforeTimestamp) {
    url += `&before_timestamp=${beforeTimestamp}`;
  }

  const response = await fetchWithRetry(url, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`GeckoTerminal API error: ${response.status}`);
  }

  const data: GeckoTerminalOHLCResponse = await response.json();
  const ohlcvList = data.data?.attributes?.ohlcv_list || [];

  return ohlcvList.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp,
    open,
    high,
    low,
    close,
    volume,
  })).reverse(); // Oldest first
}

// Fetch all candles for a date range, paginating backwards
export async function fetchCandlesForRange(
  chain: string,
  poolAddress: string,
  timeframe: string,
  startTime: Date,
  endTime: Date,
  onProgress?: (fetched: number) => void
): Promise<OHLC[]> {
  const allCandles: OHLC[] = [];
  const startTimestamp = Math.floor(startTime.getTime() / 1000);
  const endTimestamp = Math.floor(endTime.getTime() / 1000);

  let beforeTimestamp = endTimestamp + 1;
  let iteration = 0;

  while (true) {
    const batch = await getOHLC(chain, poolAddress, timeframe, GECKO_API.candlesPerRequest, beforeTimestamp);

    if (batch.length === 0) break;

    // Filter to only include candles within our range
    const inRange = batch.filter(c => c.timestamp >= startTimestamp && c.timestamp <= endTimestamp);
    allCandles.push(...inRange);

    // Check if we've gone past our start time
    const oldestInBatch = batch[0].timestamp;
    if (oldestInBatch <= startTimestamp) break;

    // Set up next pagination
    beforeTimestamp = oldestInBatch;
    iteration++;

    if (onProgress) {
      onProgress(allCandles.length);
    }

    // Rate limit delay
    await new Promise(r => setTimeout(r, GECKO_API.requestDelay));
  }

  // Sort oldest first and deduplicate
  const seen = new Set<number>();
  const deduplicated = allCandles
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter(c => {
      if (seen.has(c.timestamp)) return false;
      seen.add(c.timestamp);
      return true;
    });

  return deduplicated;
}
