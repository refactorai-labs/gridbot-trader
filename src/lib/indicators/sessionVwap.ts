import { OHLC } from '../types';

const SECONDS_PER_DAY = 86400;

function typicalPrice(c: OHLC): number {
  return (c.high + c.low + c.close) / 3;
}

// Session VWAP — cumulative VWAP that resets at each UTC midnight (24/7 crypto convention).
// Returns NaN for any candle whose session has zero cumulative volume so far.
export function computeSessionVWAP(candles: OHLC[]): number[] {
  const values: number[] = candles.map(() => NaN);
  if (candles.length === 0) return values;

  let cumPV = 0;
  let cumV = 0;
  let currentDay = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = Math.floor(c.timestamp / SECONDS_PER_DAY);
    if (day !== currentDay) {
      cumPV = 0;
      cumV = 0;
      currentDay = day;
    }
    cumPV += typicalPrice(c) * c.volume;
    cumV += c.volume;
    values[i] = cumV === 0 ? NaN : cumPV / cumV;
  }

  return values;
}
