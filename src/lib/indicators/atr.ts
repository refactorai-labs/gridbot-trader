import { OHLC } from '../types';

export interface ATRResult {
  value: number;
}

export interface ATRSeries {
  values: number[];
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
