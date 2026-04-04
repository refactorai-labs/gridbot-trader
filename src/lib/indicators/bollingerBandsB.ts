import { sma } from '../analysis/technical';
import { BollingerBandsSeries, BollingerBandsResult } from './indicatorTypes';

function stddev(data: number[], mean: number): number {
  const sumSquares = data.reduce((sum, x) => sum + (x - mean) ** 2, 0);
  return Math.sqrt(sumSquares / data.length);
}

export function computeBB(
  closes: number[],
  period: number,
  deviation: number
): BollingerBandsSeries {
  const upper: number[] = [];
  const middle: number[] = [];
  const lower: number[] = [];
  const percentB: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(NaN);
      middle.push(NaN);
      lower.push(NaN);
      percentB.push(NaN);
      continue;
    }

    const slice = closes.slice(i - period + 1, i + 1);
    const mid = sma(slice, period);
    const sd = stddev(slice, mid);
    const up = mid + deviation * sd;
    const lo = mid - deviation * sd;
    const pb = up === lo ? 0 : (closes[i] - lo) / (up - lo);

    upper.push(up);
    middle.push(mid);
    lower.push(lo);
    percentB.push(pb);
  }

  return { upper, middle, lower, percentB };
}

export function computeBBAtIndex(
  closes: number[],
  index: number,
  period: number,
  deviation: number
): BollingerBandsResult {
  if (index < period - 1 || index >= closes.length) {
    return { upper: NaN, middle: NaN, lower: NaN, percentB: NaN };
  }

  const slice = closes.slice(index - period + 1, index + 1);
  const mid = sma(slice, period);
  const sd = stddev(slice, mid);
  const up = mid + deviation * sd;
  const lo = mid - deviation * sd;
  const pb = up === lo ? 0 : (closes[index] - lo) / (up - lo);

  return { upper: up, middle: mid, lower: lo, percentB: pb };
}
