// Binance public API client for OHLCV candle data
// Uses /api/v3/klines — no API key required

import { OHLC } from '../types';
import { fetchWithTimeout } from './fetch';
import { BINANCE_API } from '../constants';

// Fetch paginated klines from Binance, forward from startTime
export async function fetchBinanceKlines(
  pair: string,
  interval: string,
  startTime: number,
  endTime: number,
  onProgress?: (fetched: number) => void
): Promise<OHLC[]> {
  const allCandles: OHLC[] = [];
  let currentStart = startTime;

  while (currentStart < endTime) {
    const url = `${BINANCE_API.baseUrl}/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=${BINANCE_API.candlesPerRequest}`;

    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }

    const data: (string | number)[][] = await response.json();
    if (data.length === 0) break;

    for (const kline of data) {
      allCandles.push({
        timestamp: Math.floor(Number(kline[0]) / 1000), // openTime ms -> seconds
        open: Number(kline[1]),
        high: Number(kline[2]),
        low: Number(kline[3]),
        close: Number(kline[4]),
        volume: Number(kline[5]),
      });
    }

    onProgress?.(allCandles.length);

    // Move past the last candle's openTime
    const lastOpenTime = Number(data[data.length - 1][0]);
    currentStart = lastOpenTime + 1;

    // If we got fewer than the limit, we've reached the end
    if (data.length < BINANCE_API.candlesPerRequest) break;

    // Rate limit delay
    await new Promise(r => setTimeout(r, BINANCE_API.requestDelay));
  }

  return allCandles;
}
