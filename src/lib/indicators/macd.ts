import { emaSeries } from '../analysis/technical';
import { MACDSeries, MACDResult } from './indicatorTypes';

export function computeMACD(
  closes: number[],
  fastLength: number,
  slowLength: number,
  signalLength: number
): MACDSeries {
  const fastEMA = emaSeries(closes, fastLength);
  const slowEMA = emaSeries(closes, slowLength);

  const macdLine = fastEMA.map((f, i) => f - slowEMA[i]);
  const signalLine = emaSeries(macdLine, signalLength);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);

  return { macdLine, signalLine, histogram };
}

export function computeMACDAtIndex(
  closes: number[],
  index: number,
  fastLength: number,
  slowLength: number,
  signalLength: number
): MACDResult {
  if (index < 0 || index >= closes.length) {
    return { macdLine: NaN, signalLine: NaN, histogram: NaN };
  }

  // Compute up to index
  const slice = closes.slice(0, index + 1);
  const result = computeMACD(slice, fastLength, slowLength, signalLength);

  const last = result.macdLine.length - 1;
  return {
    macdLine: result.macdLine[last],
    signalLine: result.signalLine[last],
    histogram: result.histogram[last],
  };
}
