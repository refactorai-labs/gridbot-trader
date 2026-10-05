// Performance metrics for research runs. All Sharpe/Sortino figures are
// computed on DAILY-resampled equity returns and annualized with √365
// (crypto trades every day).

import { EquityPoint } from './types';

const DAY = 86_400;

// Last equity observation of each UTC day.
export function resampleDaily(equity: Array<{ timeSec: number; equity: number }>): number[] {
  const byDay = new Map<number, number>();
  for (const p of equity) {
    byDay.set(Math.floor(p.timeSec / DAY), p.equity);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

export function returnsOf(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) out.push(values[i] / values[i - 1] - 1);
  }
  return out;
}

export function annualizedSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 10) return NaN;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return mean > 0 ? Infinity : 0;
  return (mean / sd) * Math.sqrt(365);
}

export function annualizedSortino(dailyReturns: number[]): number {
  if (dailyReturns.length < 10) return NaN;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const downside = dailyReturns.filter(r => r < 0);
  if (downside.length === 0) return mean > 0 ? Infinity : 0;
  const dd = Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / dailyReturns.length);
  if (dd === 0) return 0;
  return (mean / dd) * Math.sqrt(365);
}

export function maxDrawdown(values: Array<{ equity: number }> | number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of values) {
    const eq = typeof v === 'number' ? v : v.equity;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

// Mean of the worst 5% of daily returns (negative number; more negative = fatter tail).
export function cvar5(dailyReturns: number[]): number {
  if (dailyReturns.length < 20) return NaN;
  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const n = Math.max(1, Math.floor(sorted.length * 0.05));
  return sorted.slice(0, n).reduce((s, r) => s + r, 0) / n;
}

export interface RunMetrics {
  totalReturn: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  cvar5: number;
  days: number;
}

export function computeRunMetrics(equity: Array<{ timeSec: number; equity: number }>): RunMetrics {
  const daily = resampleDaily(equity);
  const rets = returnsOf(daily);
  return {
    totalReturn: daily.length > 1 ? daily[daily.length - 1] / daily[0] - 1 : 0,
    sharpe: annualizedSharpe(rets),
    sortino: annualizedSortino(rets),
    maxDrawdown: maxDrawdown(daily),
    cvar5: cvar5(rets),
    days: daily.length,
  };
}

// Chain OOS segments into one compounded curve: each segment is normalized to
// start where the previous ended. Segments must be time-ordered.
export function stitchEquity(segments: EquityPoint[][], startValue = 10_000): Array<{ timeSec: number; equity: number; price: number }> {
  const out: Array<{ timeSec: number; equity: number; price: number }> = [];
  let base = startValue;
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const segStart = seg[0].equity;
    if (segStart <= 0) continue;
    for (const p of seg) {
      out.push({ timeSec: p.timeSec, equity: base * (p.equity / segStart), price: p.price });
    }
    base = out[out.length - 1].equity;
  }
  return out;
}

// Block bootstrap on daily returns (blocks preserve short-range autocorrelation).
// Returns the Sharpe and max-drawdown distribution across `n` resampled paths.
export function blockBootstrap(
  dailyReturns: number[],
  rng: () => number,
  n = 1000,
  blockLen = 7
): { sharpes: number[]; maxDDs: number[] } {
  const sharpes: number[] = [];
  const maxDDs: number[] = [];
  if (dailyReturns.length < blockLen * 2) return { sharpes, maxDDs };
  const maxStart = dailyReturns.length - blockLen;

  for (let i = 0; i < n; i++) {
    const path: number[] = [];
    while (path.length < dailyReturns.length) {
      const start = Math.floor(rng() * (maxStart + 1));
      for (let j = 0; j < blockLen && path.length < dailyReturns.length; j++) {
        path.push(dailyReturns[start + j]);
      }
    }
    sharpes.push(annualizedSharpe(path));
    let eq = 1;
    const curve: number[] = [1];
    for (const r of path) {
      eq *= 1 + r;
      curve.push(eq);
    }
    maxDDs.push(maxDrawdown(curve));
  }
  return { sharpes, maxDDs };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

// Deterministic RNG for reproducible random search.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
