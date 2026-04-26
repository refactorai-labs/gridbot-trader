import { emaSeries } from '../analysis/technical';

export interface ERResult {
  value: number;
}

export interface ERSeries {
  raw: number[];
  smoothed: number[];
}

export function computeER(closes: number[], lookback: number, smoothingLength: number = 3): ERSeries {
  const raw: number[] = [];

  if (closes.length === 0 || lookback < 1) {
    return { raw: [], smoothed: [] };
  }

  for (let i = 0; i < closes.length; i++) {
    if (i < lookback) {
      raw.push(NaN);
      continue;
    }
    const direction = Math.abs(closes[i] - closes[i - lookback]);
    let volatility = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      volatility += Math.abs(closes[j] - closes[j - 1]);
    }
    raw.push(volatility === 0 ? 0 : direction / volatility);
  }

  const validIdx = raw.findIndex(v => !isNaN(v));
  let smoothed: number[];
  if (validIdx === -1) {
    smoothed = raw.map(() => NaN);
  } else {
    const tail = raw.slice(validIdx);
    const smoothedTail = emaSeries(tail, smoothingLength);
    smoothed = [
      ...raw.slice(0, validIdx).map(() => NaN),
      ...smoothedTail,
    ];
  }

  return { raw, smoothed };
}

export function computeERAtIndex(closes: number[], index: number, lookback: number): ERResult {
  if (index < lookback || index >= closes.length) return { value: NaN };
  const direction = Math.abs(closes[index] - closes[index - lookback]);
  let volatility = 0;
  for (let j = index - lookback + 1; j <= index; j++) {
    volatility += Math.abs(closes[j] - closes[j - 1]);
  }
  return { value: volatility === 0 ? 0 : direction / volatility };
}
