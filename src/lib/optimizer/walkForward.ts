// Walk-forward validation — tests parameter stability across sliding windows

import { OHLC, DCABreakoutConfig, DCASimulationConfig, StrategyMetrics } from '../types';
import { runDCASimulation } from '../simulation/dcaEngine';
import { evaluateFitness, FitnessConstraints, FitnessResult } from './fitnessFunction';

export interface WalkForwardConfig {
  totalCandles: OHLC[];
  windowCount: number;           // number of sliding windows (3-5)
  inSampleRatio: number;         // e.g., 0.7 = 70% in-sample, 30% out-of-sample
  baseConfig: DCASimulationConfig; // template config (pair, feeRate, etc.)
  constraints: FitnessConstraints;
}

export interface WindowResult {
  windowIndex: number;
  inSampleStart: number;     // candle index
  inSampleEnd: number;
  outOfSampleStart: number;
  outOfSampleEnd: number;
  inSampleMetrics: StrategyMetrics;
  outOfSampleMetrics: StrategyMetrics;
  inSampleFitness: FitnessResult;
  outOfSampleFitness: FitnessResult;
}

export interface WalkForwardResult {
  windows: WindowResult[];
  passedAllWindows: boolean;    // true only if ALL out-of-sample windows meet constraints
  avgOutOfSampleSharpe: number;
  avgOutOfSamplePnlPct: number;
}

// Compute the sliding window boundaries
export function computeWindows(
  totalLen: number,
  windowCount: number,
  inSampleRatio: number
): { isStart: number; isEnd: number; oosStart: number; oosEnd: number }[] {
  // Each window spans 60% of the total data, split into IS (front) and OOS (back)
  const effectiveWindowSize = Math.floor(totalLen * 0.6);
  const isLen = Math.floor(effectiveWindowSize * inSampleRatio);
  const oosLen = effectiveWindowSize - isLen;
  const stride = windowCount > 1
    ? Math.floor((totalLen - effectiveWindowSize) / (windowCount - 1))
    : 0;

  const windows: { isStart: number; isEnd: number; oosStart: number; oosEnd: number }[] = [];

  for (let w = 0; w < windowCount; w++) {
    const start = w * stride;
    const isStart = start;
    const isEnd = start + isLen;
    const oosStart = isEnd;
    const oosEnd = Math.min(start + effectiveWindowSize, totalLen);

    // Skip if windows are too small
    if (isEnd - isStart < 100 || oosEnd - oosStart < 50) continue;

    windows.push({ isStart, isEnd, oosStart, oosEnd });
  }

  return windows;
}

export async function runWalkForward(
  config: WalkForwardConfig,
  dcaConfig: DCABreakoutConfig
): Promise<WalkForwardResult> {
  const windowBounds = computeWindows(
    config.totalCandles.length,
    config.windowCount,
    config.inSampleRatio
  );

  const windows: WindowResult[] = [];

  for (let w = 0; w < windowBounds.length; w++) {
    const bounds = windowBounds[w];
    const isCandles = config.totalCandles.slice(bounds.isStart, bounds.isEnd);
    const oosCandles = config.totalCandles.slice(bounds.oosStart, bounds.oosEnd);

    // Build simulation config with the DCA direction config
    const simConfig: DCASimulationConfig = {
      ...config.baseConfig,
      longConfig: dcaConfig.direction === 'LONG' ? dcaConfig : undefined,
      shortConfig: dcaConfig.direction === 'SHORT' ? dcaConfig : undefined,
    };

    // Run simulation on in-sample
    const isResult = await runDCASimulation(simConfig, isCandles);

    // Run simulation on out-of-sample
    const oosResult = await runDCASimulation(simConfig, oosCandles);

    windows.push({
      windowIndex: w,
      inSampleStart: bounds.isStart,
      inSampleEnd: bounds.isEnd,
      outOfSampleStart: bounds.oosStart,
      outOfSampleEnd: bounds.oosEnd,
      inSampleMetrics: isResult.metrics,
      outOfSampleMetrics: oosResult.metrics,
      inSampleFitness: evaluateFitness(isResult.metrics, config.constraints),
      outOfSampleFitness: evaluateFitness(oosResult.metrics, config.constraints),
    });
  }

  const passedAll = windows.length > 0 &&
    windows.every(w => w.outOfSampleFitness.meetsConstraints);

  const avgSharpe = windows.length > 0
    ? windows.reduce((s, w) => s + w.outOfSampleMetrics.sharpeRatio, 0) / windows.length
    : 0;

  const avgPnlPct = windows.length > 0
    ? windows.reduce((s, w) => s + w.outOfSampleMetrics.totalPnlPct, 0) / windows.length
    : 0;

  return {
    windows,
    passedAllWindows: passedAll,
    avgOutOfSampleSharpe: avgSharpe,
    avgOutOfSamplePnlPct: avgPnlPct,
  };
}
