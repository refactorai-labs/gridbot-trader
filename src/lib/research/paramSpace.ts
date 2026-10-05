// Random-search parameter space for Strategy B walk-forward optimization.
// Sampled bounds follow the research brief: partial-close fraction 50–70%,
// ATR-linked invalidation/stop widths (stop strictly beyond invalidation),
// grid geometry, ER hysteresis thresholds, and the hedge-unwind level.

import { DEFAULT_STRATEGY_B, StrategyBConfig, StrategyMode } from './strategyB';

export interface SampledParams {
  partialFraction: number;
  bankAt: number;
  unwindAt: number;
  invalidationAtrMult: number;
  stopAtrMult: number;
  atrMult: number;
  gridLevels: number;
  donchianLookback: number;
  erLow: number;
  erHigh: number;
  confirmBars: number;
  volExpandRatio: number;
  deriskAfterBars: number;
  cooldownBars: number;
  deriskSoft: number;      // 0 = hard market close on de-risk, 1 = wind down passively
  initialFraction: number; // scale of TP-side inventory opened at arm
  anchorMaxOffset: number; // only anchor when |price-center| ≤ this fraction of half-width
}

function uniform(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

function uniformInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(uniform(rng, lo, hi + 1));
}

export type ParamSpace = 'full' | 'core' | 'lowChurn' | 'noInit';

// Structural parameters frozen at defaults (shared by 'core' and 'noInit').
const FROZEN_STRUCTURAL = {
  gridLevels: 21,
  donchianLookback: 336,
  confirmBars: 3,
  volExpandRatio: 1.75,
  deriskAfterBars: 8,
  cooldownBars: 16,
};

// 'full' samples all dimensions. 'core' freezes the structural parameters at
// defaults and samples only the economically central ones — a smaller space
// generalizes better when selection happens on a single IS window. 'lowChurn'
// (V4) biases toward fewer, longer cycles to cut turnover fee bleed. 'noInit'
// (V5) drops arm-time inventory entirely and banks on churn-accumulated lots.
export function sampleParams(rng: () => number, space: ParamSpace = 'full'): SampledParams {
  const w = uniform(rng, 1.0, 4.0);
  const erLow = uniform(rng, 0.15, 0.35);
  const bankAt = uniform(rng, 0.55, 0.9);
  const core = {
    partialFraction: uniform(rng, 0.5, 0.7),
    bankAt,
    unwindAt: uniform(rng, 0.1, Math.min(0.45, bankAt - 0.1)),
    invalidationAtrMult: w,
    stopAtrMult: w + uniform(rng, 0.5, 3.0),
    atrMult: uniform(rng, 4, 12),
    erLow,
    erHigh: erLow + uniform(rng, 0.1, 0.3),
    deriskSoft: rng() < 0.5 ? 1 : 0,
    initialFraction: uniform(rng, 0.25, 1.0),
    anchorMaxOffset: 0.6,
  };

  // V4 — fewer, longer cycles: stricter regime entry, slower passive exits,
  // wider/coarser grids, central anchors only, some hedge inventory.
  if (space === 'lowChurn') {
    const erLowLC = uniform(rng, 0.12, 0.25);
    return {
      partialFraction: uniform(rng, 0.5, 0.7),
      bankAt,
      unwindAt: uniform(rng, 0.1, Math.min(0.45, bankAt - 0.1)),
      invalidationAtrMult: w,
      stopAtrMult: w + uniform(rng, 0.5, 3.0),
      atrMult: uniform(rng, 6, 14),
      erLow: erLowLC,
      erHigh: erLowLC + uniform(rng, 0.1, 0.3),
      deriskSoft: 1, // fixed passive wind-down
      initialFraction: rng() < 0.5 ? 0.5 : 1.0,
      anchorMaxOffset: uniform(rng, 0.3, 0.5),
      gridLevels: uniformInt(rng, 7, 15),
      donchianLookback: 336,
      confirmBars: uniformInt(rng, 4, 8),
      volExpandRatio: 1.75,
      deriskAfterBars: uniformInt(rng, 12, 32),
      cooldownBars: uniformInt(rng, 24, 64),
    };
  }

  // V5 — no arm-time inventory; lower banking trigger acts on churn lots.
  if (space === 'noInit') {
    const bankAtNI = uniform(rng, 0.35, 0.6);
    return {
      ...core,
      ...FROZEN_STRUCTURAL,
      bankAt: bankAtNI,
      unwindAt: uniform(rng, 0.1, Math.min(0.45, bankAtNI - 0.1)),
      initialFraction: 0,
    };
  }

  if (space === 'core') {
    return { ...core, ...FROZEN_STRUCTURAL };
  }
  return {
    ...core,
    gridLevels: uniformInt(rng, 11, 31),
    donchianLookback: uniformInt(rng, 168, 672), // 3.5d–14d of 30m bars
    confirmBars: uniformInt(rng, 2, 6),
    volExpandRatio: uniform(rng, 1.4, 2.5),
    deriskAfterBars: uniformInt(rng, 4, 16),
    cooldownBars: uniformInt(rng, 8, 48),
  };
}

export function toStrategyConfig(p: SampledParams, mode: StrategyMode, totalCapital: number): StrategyBConfig {
  return {
    mode,
    totalCapital,
    regime: {
      ...DEFAULT_STRATEGY_B.regime,
      erLow: p.erLow,
      erHigh: p.erHigh,
      confirmBars: p.confirmBars,
      volExpandRatio: p.volExpandRatio,
    },
    anchor: {
      ...DEFAULT_STRATEGY_B.anchor,
      donchianLookback: p.donchianLookback,
      atrMult: p.atrMult,
      invalidationAtrMult: p.invalidationAtrMult,
      stopAtrMult: p.stopAtrMult,
      gridLevels: p.gridLevels,
      anchorMaxOffset: p.anchorMaxOffset,
    },
    bankAt: p.bankAt,
    partialFraction: p.partialFraction,
    unwindAt: p.unwindAt,
    deriskAfterBars: p.deriskAfterBars,
    cooldownBars: p.cooldownBars,
    deriskStyle: p.deriskSoft >= 0.5 ? 'soft' : 'hard',
    initialFraction: p.initialFraction,
  };
}

// ±pct perturbation of every continuous parameter (Monte Carlo robustness).
export function perturbParams(p: SampledParams, rng: () => number, pct: number): SampledParams {
  const j = (v: number) => v * (1 + (rng() * 2 - 1) * pct);
  const w = Math.max(0.5, j(p.invalidationAtrMult));
  const erLow = Math.min(0.45, Math.max(0.05, j(p.erLow)));
  const bankAt = Math.min(0.95, Math.max(0.5, j(p.bankAt)));
  return {
    partialFraction: Math.min(0.95, Math.max(0.05, j(p.partialFraction))),
    bankAt,
    unwindAt: Math.min(bankAt - 0.05, Math.max(0.05, j(p.unwindAt))),
    invalidationAtrMult: w,
    stopAtrMult: Math.max(w + 0.25, j(p.stopAtrMult)),
    atrMult: Math.max(2, j(p.atrMult)),
    gridLevels: Math.max(7, Math.round(j(p.gridLevels))),
    donchianLookback: Math.max(96, Math.round(j(p.donchianLookback))),
    erLow,
    erHigh: Math.max(erLow + 0.05, Math.min(0.8, j(p.erHigh))),
    confirmBars: Math.max(1, Math.round(j(p.confirmBars))),
    volExpandRatio: Math.max(1.1, j(p.volExpandRatio)),
    deriskAfterBars: Math.max(2, Math.round(j(p.deriskAfterBars))),
    cooldownBars: Math.max(4, Math.round(j(p.cooldownBars))),
    deriskSoft: p.deriskSoft, // structural switch — not perturbed
    initialFraction: Math.min(1, Math.max(0, j(p.initialFraction))),
    anchorMaxOffset: Math.min(0.7, Math.max(0.2, j(p.anchorMaxOffset))),
  };
}
