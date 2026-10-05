// Binance public API client for OHLCV candle data
// Spot: /api/v3/klines — Futures (USDT-M perp): /fapi/v1/klines. No API key required.

import { OHLC } from '../types';
import { fetchWithTimeout } from './fetch';
import { BINANCE_API, BINANCE_FUTURES_API } from '../constants';

// 'futuresMark' = /fapi/v1/markPriceKlines: same kline array shape as /fapi/v1/klines (volume column is 0).
export type BinanceMarket = 'spot' | 'futures' | 'futuresMark';

// Fetch paginated klines from Binance, forward from startTime
export async function fetchBinanceKlines(
  pair: string,
  interval: string,
  startTime: number,
  endTime: number,
  onProgress?: (fetched: number) => void,
  market: BinanceMarket = 'spot'
): Promise<OHLC[]> {
  const allCandles: OHLC[] = [];
  let currentStart = startTime;

  const api = market !== 'spot'
    ? { base: `${BINANCE_FUTURES_API.baseUrl}/fapi/v1/${market === 'futuresMark' ? 'markPriceKlines' : 'klines'}`, delay: BINANCE_FUTURES_API.requestDelay }
    : { base: `${BINANCE_API.baseUrl}/api/v3/klines`, delay: BINANCE_API.requestDelay };

  while (currentStart < endTime) {
    const url = `${api.base}?symbol=${pair}&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=${BINANCE_API.candlesPerRequest}`;

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
    await new Promise(r => setTimeout(r, api.delay));
  }

  return allCandles;
}
