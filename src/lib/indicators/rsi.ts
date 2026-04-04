import { RSISeries, RSIResult } from './indicatorTypes';

export function computeRSI(closes: number[], length: number): RSISeries {
  const values: number[] = [];

  if (closes.length < length + 1) {
    return { values: closes.map(() => NaN) };
  }

  // First `length` values are NaN (need length+1 prices to get length changes)
  for (let i = 0; i < length; i++) {
    values.push(NaN);
  }

  // Calculate first average gain/loss from first `length` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= length;
  avgLoss /= length;

  // First RSI value
  const firstRSI = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  values.push(firstRSI);

  // Subsequent values using Wilder's smoothing
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;

    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    values.push(rsi);
  }

  return { values };
}

export function computeRSIAtIndex(
  closes: number[],
  index: number,
  length: number
): RSIResult {
  if (index < length || index >= closes.length) {
    return { value: NaN };
  }

  // Must compute from beginning for accurate Wilder's smoothing
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= length;
  avgLoss /= length;

  if (index === length) {
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    return { value: rsi };
  }

  for (let i = length + 1; i <= index; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
  }

  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  return { value: rsi };
}
