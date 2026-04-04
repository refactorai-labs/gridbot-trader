// Fitness evaluation for optimizer — scores strategy metrics against constraints

import { StrategyMetrics } from '../types';

export interface FitnessConstraints {
  minTrades: number;       // minimum number of trades (e.g., 5)
  maxDrawdownPct: number;  // max acceptable drawdown % (e.g., 30)
  minProfitFactor: number; // minimum profit factor (e.g., 1.0)
}

export interface FitnessResult {
  score: number;           // primary score (higher is better)
  meetsConstraints: boolean;
  violations: string[];    // which constraints were violated
}

export function evaluateFitness(
  metrics: StrategyMetrics,
  constraints: FitnessConstraints
): FitnessResult {
  // Check constraints
  const violations: string[] = [];

  if (metrics.totalTrades < constraints.minTrades) {
    violations.push(`Too few trades: ${metrics.totalTrades} < ${constraints.minTrades}`);
  }
  if (metrics.maxDrawdownPct > constraints.maxDrawdownPct) {
    violations.push(`Drawdown too high: ${metrics.maxDrawdownPct.toFixed(1)}% > ${constraints.maxDrawdownPct}%`);
  }
  if (metrics.profitFactor < constraints.minProfitFactor && metrics.totalTrades > 0) {
    violations.push(`Profit factor too low: ${metrics.profitFactor.toFixed(2)} < ${constraints.minProfitFactor}`);
  }

  // Primary metric: Sharpe ratio (risk-adjusted return)
  // Penalize heavily for constraint violations
  let score = metrics.sharpeRatio;
  if (violations.length > 0) {
    score = -100 - violations.length; // heavily negative for violated configs
  }

  return {
    score,
    meetsConstraints: violations.length === 0,
    violations,
  };
}

export const DEFAULT_CONSTRAINTS: FitnessConstraints = {
  minTrades: 5,
  maxDrawdownPct: 30,
  minProfitFactor: 1.0,
};
