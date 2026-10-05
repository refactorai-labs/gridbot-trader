// Binance USDT-M futures mark price klines (/fapi/v1/markPriceKlines).
// Same kline array shape as /fapi/v1/klines (volume column is 0). Cached under
// the `${symbol}MARK` pair key so mark rows never mix with last-price rows (plan §5).

import { OHLC } from '../types';
import { fetchBinanceKlines } from './binanceApi';
import { getOrFetchCandles } from './candleCache';
import { pionexMarkPair } from '../constants';

export function fetchBinanceMarkPriceKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  onProgress?: (fetched: number) => void
): Promise<OHLC[]> {
  return fetchBinanceKlines(symbol, interval, startTime, endTime, onProgress, 'futuresMark');
}

// Cached mark candles for a window; fills only the missing gaps.
export function getOrFetchMarkCandles(
  symbol: string,
  interval: string,
  startTime: Date,
  endTime: Date
): Promise<OHLC[]> {
  return getOrFetchCandles(pionexMarkPair(symbol), interval, startTime, endTime, undefined, {
    market: 'futuresMark',
    symbol,
  });
}
