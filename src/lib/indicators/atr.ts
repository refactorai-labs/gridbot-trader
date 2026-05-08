import { OHLC } from '../types';
import { aggregate5mTo } from '../data/aggregator';

export interface ATRResult {
  value: number;
}

export interface ATRSeries {
  values: number[];
}

export interface ATRBandsSeries {
  upper: number[];
  lower: number[];
}

function trueRange(curr: OHLC, prev: OHLC | null): number {
  const hl = curr.high - curr.low;
  if (prev === null) return hl;
  const hc = Math.abs(curr.high - prev.close);
  const lc = Math.abs(curr.low - prev.close);
  return Math.max(hl, hc, lc);
}

export function computeATR(candles: OHLC[], period: number): ATRSeries {
  const values: number[] = [];
  if (candles.length === 0 || period < 1) {
    return { values: candles.map(() => NaN) };
  }

  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    trs.push(trueRange(candles[i], i > 0 ? candles[i - 1] : null));
  }

  for (let i = 0; i < period - 1; i++) values.push(NaN);

  if (candles.length < period) {
    return { values: candles.map(() => NaN) };
  }

  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  values.push(atr);

  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    values.push(atr);
  }

  return { values };
}

export function computeATRAtIndex(candles: OHLC[], index: number, period: number): ATRResult {
  if (index < period - 1 || index >= candles.length) return { value: NaN };

  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trueRange(candles[i], i > 0 ? candles[i - 1] : null);
  }
  atr /= period;

  for (let i = period; i <= index; i++) {
    const tr = trueRange(candles[i], candles[i - 1]);
    atr = (atr * (period - 1) + tr) / period;
  }

  return { value: atr };
}

export function blendedATR(atr4h: number, atr1h: number, factor: number = 1.4): number {
  if (isNaN(atr4h) || isNaN(atr1h)) return NaN;
  return Math.max(atr4h, atr1h * factor);
}

// Blended 4H/1H ATR envelope projected onto the 5m timeline.
// Uses the same blendedATR convention used elsewhere in the codebase
// (max(atr4h, atr1h * factor)) and bands = close ± multiplier · ATR.
export function computeBlendedATRBands(
  candles: OHLC[],
  period: number = 14,
  bandMultiplier: number = 2,
  blendFactor: number = 1.4
): ATRBandsSeries {
  const upper: number[] = candles.map(() => NaN);
  const lower: number[] = candles.map(() => NaN);
  if (candles.length === 0) return { upper, lower };

  const candles1h = aggregate5mTo(candles, 60);
  const candles4h = aggregate5mTo(candles, 240);
  const atr1h = computeATR(candles1h, period).values;
  const atr4h = computeATR(candles4h, period).values;

  // Project from the most recently *closed* HTF bucket. The bucket that
  // contains candle i is still in progress — its high/low/close span the
  // rest of the hour / 4 hours, which would pull future bar data into past
  // candles during playback. 1H factor = 60/5 = 12, 4H factor = 240/5 = 48.
  for (let i = 0; i < candles.length; i++) {
    const idx1h = Math.floor(i / 12) - 1;
    const idx4h = Math.floor(i / 48) - 1;
    const a1 = idx1h >= 0 && idx1h < atr1h.length ? atr1h[idx1h] : NaN;
    const a4 = idx4h >= 0 && idx4h < atr4h.length ? atr4h[idx4h] : NaN;
    const blend = blendedATR(a4, a1, blendFactor);
    if (!isNaN(blend)) {
      upper[i] = candles[i].close + bandMultiplier * blend;
      lower[i] = candles[i].close - bandMultiplier * blend;
    }
  }
  return { upper, lower };
}
