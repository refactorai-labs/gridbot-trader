// Stitched-OOS fitness: Probabilistic Sharpe Ratio with N<30 Sharpe fallback,
// stability co-fitness across folds, and drawdown penalty.
//
// Formula:
//   fitness = primary * stabilityFactor - DD_PENALTY_LAMBDA * (maxDD% / 100)
//   primary = PSR(returns)  if nTrades >= TRADE_THRESHOLD
//           = Sharpe        otherwise (critique point #5: PSR unreliable with few trades)

export const TRADE_THRESHOLD = 30;
export const DD_PENALTY_LAMBDA = 0.2;

/**
 * Annualized Sharpe ratio given per-period returns. Assumes risk-free ≈ 0.
 * `periodsPerYear` should match return granularity (e.g. 5m returns → 525600/5 = 105120).
 * Pass 1 if the returns are already period-agnostic.
 */
export function sharpe(returns: number[], periodsPerYear: number = 1): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(periodsPerYear);
}

function standardNormalCDF(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation for the error function.
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado 2012).
 * Returns P(true SR > srRef | observed SR, n, skew, kurt).
 */
export function psr(returns: number[], srRef: number = 0): number {
  if (returns.length < 4) return 0;
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  const sr = mean / sd;

  // Skewness and excess kurtosis of returns
  const m3 = returns.reduce((s, r) => s + ((r - mean) / sd) ** 3, 0) / n;
  const m4 = returns.reduce((s, r) => s + ((r - mean) / sd) ** 4, 0) / n;
  const skew = m3;
  const kurtExcess = m4 - 3;

  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + (kurtExcess / 4) * sr * sr));
  const z = (sr - srRef) * Math.sqrt(n - 1) / denom;
  return standardNormalCDF(z);
}

export interface FoldPerformance {
  /** Equity returns for this fold's OOS window (per-snapshot returns). */
  returns: number[];
  /** Number of trades closed in this fold's OOS window. */
  nTrades: number;
  /** Max drawdown fraction on this fold's stitched equity (e.g. 0.15 = 15%). */
  maxDrawdownPct: number;
}

export interface StitchedFitnessResult {
  primary: number;       // PSR or Sharpe
  usedPSR: boolean;
  stability: number;     // 0..1
  maxDrawdownPct: number;
  fitness: number;
  nTradesTotal: number;
}

/**
 * Aggregate per-fold performance into a single stitched-OOS fitness score.
 *
 *  - Concatenates all fold returns end-to-end ("stitched OOS").
 *  - Computes PSR if stitched nTrades >= TRADE_THRESHOLD, else plain Sharpe.
 *  - Stability factor = 1 - normalized variance of per-fold Sharpes (clamped to [0, 1]).
 *  - Subtracts λ * worst max drawdown across folds.
 */
export function stitchedFitness(folds: FoldPerformance[]): StitchedFitnessResult {
  if (folds.length === 0) {
    return { primary: 0, usedPSR: false, stability: 0, maxDrawdownPct: 0, fitness: 0, nTradesTotal: 0 };
  }

  const stitchedReturns: number[] = [];
  for (const f of folds) stitchedReturns.push(...f.returns);
  const nTradesTotal = folds.reduce((s, f) => s + f.nTrades, 0);
  const worstDD = folds.reduce((m, f) => Math.max(m, f.maxDrawdownPct), 0);

  const usedPSR = nTradesTotal >= TRADE_THRESHOLD;
  const primary = usedPSR ? psr(stitchedReturns, 0) : sharpe(stitchedReturns, 1);

  // Stability: normalized variance of per-fold Sharpes
  const foldSharpes = folds.map(f => sharpe(f.returns, 1));
  let stability = 1;
  if (foldSharpes.length >= 2) {
    const mean = foldSharpes.reduce((s, x) => s + x, 0) / foldSharpes.length;
    const variance = foldSharpes.reduce((s, x) => s + (x - mean) ** 2, 0) / foldSharpes.length;
    const sd = Math.sqrt(variance);
    const denom = Math.max(1, Math.abs(mean));
    stability = 1 - Math.min(1, sd / denom);
  }

  const fitness = primary * stability - DD_PENALTY_LAMBDA * worstDD;

  return {
    primary,
    usedPSR,
    stability,
    maxDrawdownPct: worstDD,
    fitness,
    nTradesTotal,
  };
}
