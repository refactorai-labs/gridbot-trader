import { OHLC } from '../types';

export interface AVWAPResult {
  value: number;
}

export interface AVWAPSeries {
  values: number[];
}

function typicalPrice(candle: OHLC): number {
  return (candle.high + candle.low + candle.close) / 3;
}

export function computeAVWAP(candles: OHLC[], anchorIdx: number): AVWAPSeries {
  const values: number[] = candles.map(() => NaN);
  if (anchorIdx < 0 || anchorIdx >= candles.length) return { values };

  let cumPV = 0;
  let cumV = 0;
  for (let i = anchorIdx; i < candles.length; i++) {
    const tp = typicalPrice(candles[i]);
    const v = candles[i].volume;
    cumPV += tp * v;
    cumV += v;
    values[i] = cumV === 0 ? NaN : cumPV / cumV;
  }
  return { values };
}

export function computeAVWAPAtIndex(candles: OHLC[], anchorIdx: number, index: number): AVWAPResult {
  if (anchorIdx < 0 || index < anchorIdx || index >= candles.length) return { value: NaN };

  let cumPV = 0;
  let cumV = 0;
  for (let i = anchorIdx; i <= index; i++) {
    const tp = typicalPrice(candles[i]);
    cumPV += tp * candles[i].volume;
    cumV += candles[i].volume;
  }
  return { value: cumV === 0 ? NaN : cumPV / cumV };
}
