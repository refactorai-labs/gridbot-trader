// Technical analysis functions for grid bot adaptive layer
// Adapted from memecoin-trader — pure deterministic functions

import { OHLC } from '../types';

// Simple Moving Average
export function sma(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Exponential Moving Average
export function ema(data: number[], period: number): number {
  if (data.length === 0) return 0;
  if (data.length === 1) return data[0];

  const multiplier = 2 / (period + 1);
  let emaValue = data[0];

  for (let i = 1; i < data.length; i++) {
    emaValue = (data[i] - emaValue) * multiplier + emaValue;
  }

  return emaValue;
}

// Rolling EMA series — returns EMA at each point
export function emaSeries(data: number[], period: number): number[] {
  if (data.length === 0) return [];

  const multiplier = 2 / (period + 1);
  const result: number[] = [data[0]];

  for (let i = 1; i < data.length; i++) {
    const prev = result[i - 1];
    result.push((data[i] - prev) * multiplier + prev);
  }

  return result;
}

// Volume ratio: recent average vs historical average
export function volumeRatio(candles: OHLC[], recentPeriod: number = 5): number {
  if (candles.length < recentPeriod + 10) return 1;

  const volumes = candles.map(c => c.volume);
  const recentAvg = sma(volumes.slice(-recentPeriod), recentPeriod);
  const historicalAvg = sma(volumes.slice(0, -recentPeriod), volumes.length - recentPeriod);

  if (historicalAvg === 0) return 1;
  return recentAvg / historicalAvg;
}

// Find support and resistance levels from swing highs/lows
export function findLevels(candles: OHLC[], lookback: number = 50): { support: number; resistance: number } {
  if (candles.length === 0) {
    return { support: 0, resistance: 0 };
  }

  const recent = candles.slice(-lookback);
  const currentPrice = recent[recent.length - 1].close;

  const lows = recent.map(c => c.low);
  const highs = recent.map(c => c.high);

  // Support: highest of recent lows below current price
  const supportCandidates = lows.filter(l => l < currentPrice);
  const support = supportCandidates.length > 0
    ? Math.max(...supportCandidates.slice(-5))
    : Math.min(...lows);

  // Resistance: lowest of recent highs above current price
  const resistanceCandidates = highs.filter(h => h > currentPrice);
  const resistance = resistanceCandidates.length > 0
    ? Math.min(...resistanceCandidates.slice(-5))
    : Math.max(...highs);

  return { support, resistance };
}

// Calculate average volume over a period
export function avgVolume(candles: OHLC[], period: number = 20): number {
  if (candles.length === 0) return 0;
  const recent = candles.slice(-period);
  return recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
}
