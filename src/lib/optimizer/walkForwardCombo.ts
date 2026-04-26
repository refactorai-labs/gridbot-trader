// Combo-bot walk-forward runner.
//
// Split the data into N folds of (trainMonths, oosMonths, step), run the combo supervisor
// on each fold's OOS window with the SAME parameter set, stitch the OOS equity curves, and
// return a stitched-OOS fitness score for Optuna to optimize.
//
// This is the parameter-stability variant ("is this one param set robust across regimes?")
// rather than classic Pardo walk-forward (which performs per-fold inner optimization).

import { OHLC, ComboBotConfig } from '../types';
import { aggregate5mTo } from '../data/aggregator';
import { runComboSimulationCore } from '../combo/supervisor';
import { FundingRateEntry } from '../simulation/funding';
import { FoldPerformance, stitchedFitness, StitchedFitnessResult } from './stitchedFitness';

export interface WalkForwardFold {
  foldIndex: number;
  trainStartIdx: number;
  trainEndIdx: number;
  oosStartIdx: number;
  oosEndIdx: number;
}

export interface WalkForwardComboConfig {
  /** 5-minute candles covering the entire data range. */
  candles5m: OHLC[];
  /** Training window length in 5m candles (12 months ≈ 12*30*24*12 = 103680). */
  trainCandles: number;
  /** OOS window length in 5m candles (3 months ≈ 25920). */
  oosCandles: number;
  /** Step between fold starts in 5m candles (3 months by default). */
  stepCandles: number;
  /** Combo parameters under test (one set; stability is measured across folds). */
  comboCfg: ComboBotConfig;
  totalCapital: number;
  feeRate: number;
  fundingRates: FundingRateEntry[];
}

export interface WalkForwardComboResult {
  folds: (WalkForwardFold & {
    oosReturns: number[];
    oosTrades: number;
    oosMaxDrawdownPct: number;
    oosFinalPnl: number;
  })[];
  stitched: StitchedFitnessResult;
  /** Per-fold best-param variance is only meaningful when nested optimization is used;
   *  for this single-set walk-forward we return 0 but keep the field so the shape matches
   *  the plan's StitchedWalkForwardResult contract. */
  foldStabilityScore: number;
}

/** Precompute fold boundaries given train/OOS/step window sizes. */
export function computeFolds(
  totalLen: number,
  trainCandles: number,
  oosCandles: number,
  stepCandles: number
): WalkForwardFold[] {
  const folds: WalkForwardFold[] = [];
  let foldIdx = 0;
  for (let start = 0; start + trainCandles + oosCandles <= totalLen; start += stepCandles) {
    folds.push({
      foldIndex: foldIdx++,
      trainStartIdx: start,
      trainEndIdx: start + trainCandles,
      oosStartIdx: start + trainCandles,
      oosEndIdx: start + trainCandles + oosCandles,
    });
  }
  return folds;
}

function equityReturns(snapshots: { equity: number }[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].equity;
    if (prev <= 0) { returns.push(0); continue; }
    returns.push((snapshots[i].equity - prev) / prev);
  }
  return returns;
}

export function runWalkForwardCombo(config: WalkForwardComboConfig): WalkForwardComboResult {
  const { candles5m, trainCandles, oosCandles, stepCandles, comboCfg, totalCapital, feeRate, fundingRates } = config;

  const foldBounds = computeFolds(candles5m.length, trainCandles, oosCandles, stepCandles);

  const folds: WalkForwardComboResult['folds'] = [];
  const foldPerfs: FoldPerformance[] = [];

  for (const bounds of foldBounds) {
    const oosSlice = candles5m.slice(bounds.oosStartIdx, bounds.oosEndIdx);
    const oos1h = aggregate5mTo(oosSlice, 60);
    const oos4h = aggregate5mTo(oosSlice, 240);

    // Filter funding to OOS window
    const oosStartTs = oosSlice[0]?.timestamp ?? 0;
    const oosEndTs = oosSlice[oosSlice.length - 1]?.timestamp ?? 0;
    const foldFunding = fundingRates.filter(r => r.fundingTimeSec >= oosStartTs && r.fundingTimeSec <= oosEndTs);

    const res = runComboSimulationCore({
      candles5m: oosSlice,
      candles1h: oos1h,
      candles4h: oos4h,
      cfg: comboCfg,
      totalCapital,
      fundingRates: foldFunding,
      feeRate,
      snapshotInterval: Math.max(1, Math.floor(oosSlice.length / 500)),
    });

    const returns = equityReturns(res.snapshots);
    const maxDDPct = res.pnlState.maxDrawdownPct / 100; // stored as %, normalize to fraction
    const finalPnl = res.pnlState.realizedPnl;
    const nTrades = res.fills.filter(f => (f.pnl ?? 0) !== 0).length;

    folds.push({
      ...bounds,
      oosReturns: returns,
      oosTrades: nTrades,
      oosMaxDrawdownPct: maxDDPct,
      oosFinalPnl: finalPnl,
    });
    foldPerfs.push({ returns, nTrades, maxDrawdownPct: maxDDPct });
  }

  const stitched = stitchedFitness(foldPerfs);
  return { folds, stitched, foldStabilityScore: stitched.stability };
}
