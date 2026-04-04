// Aggregate 5m candles to higher timeframes (15m, 1H, 4H)

import { OHLC } from '../types';

// How many source candles make one target candle
export function getAggregationFactor(fromMinutes: number, toMinutes: number): number {
  if (toMinutes <= fromMinutes) return 1;
  return Math.floor(toMinutes / fromMinutes);
}

// Aggregate 5m candles to a target timeframe
// Drops incomplete groups at the end
export function aggregate5mTo(candles: OHLC[], targetMinutes: number): OHLC[] {
  const factor = getAggregationFactor(5, targetMinutes);
  if (factor <= 1) return candles;

  const result: OHLC[] = [];

  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    result.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }

  return result;
}
