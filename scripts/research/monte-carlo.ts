/**
 * Monte Carlo robustness analysis of walk-forward candidates.
 *
 * Candidates = the per-window winning parameter sets from a walk-forward
 * artifact. Each candidate is evaluated on the full OOS-union span
 * (first OOS start → holdout boundary):
 *   1. Base runs for B / fullClose / fullHold (same params, same data).
 *   2. Trade-path robustness: 7-day block bootstrap of mode-B daily returns
 *      (1000 paths) → Sharpe and maxDD distributions.
 *   3. Parameter robustness: ±15% perturbation of every continuous parameter
 *      (N runs) → Sharpe/DD scatter. Fragile peaks die here.
 *   4. Cross-window stability: normalized distance of the candidate's params
 *      to the per-parameter median across all window winners.
 *
 * Usage:
 *   npx tsx scripts/research/monte-carlo.ts --wf walkforward-v3 --perturbs 40 --boots 1000
 */

import * as fs from 'fs';
import * as path from 'path';
import prisma from '../../src/lib/prisma';
import { getCachedCandles } from '../../src/lib/data/candleCache';
import { getCachedFundingRates } from '../../src/lib/data/fundingCache';
import { runFillSim } from '../../src/lib/research/fillSim';
import { resetResearchIds } from '../../src/lib/research/account';
import { createStrategy, StrategyMode } from '../../src/lib/research/strategyB';
import { DEFAULT_PERP_FEES } from '../../src/lib/research/types';
import {
  blockBootstrap,
  computeRunMetrics,
  mulberry32,
  percentile,
  resampleDaily,
  returnsOf,
} from '../../src/lib/research/metrics';
import { perturbParams, toStrategyConfig, SampledParams } from '../../src/lib/research/paramSpace';

const CACHE_PAIR = 'ETHUSDTPERP';
const SYMBOL = 'ETHUSDT';
const CAPITAL = 10_000;
const WARMUP_SEC = 14 * 86_400;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const wfName = arg('wf', 'walkforward-v3');
  const nPerturbs = Number(arg('perturbs', '40'));
  const nBoots = Number(arg('boots', '1000'));

  const wfFile = path.join(process.cwd(), 'research-artifacts', `${wfName}.json`);
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  const windows = wf.windows as Array<{ window: number; oosStart: number; bestParams: SampledParams }>;
  const spanStart = Math.min(...windows.map(w => w.oosStart));
  const spanEnd = wf.wfSpan.holdoutStart as number;

  process.stdout.write(`[mc] ${wfName}: ${windows.length} candidates, span ${new Date(spanStart * 1000).toISOString().slice(0, 10)} → ${new Date(spanEnd * 1000).toISOString().slice(0, 10)}\n`);

  const [c1m, c30, funding] = await Promise.all([
    getCachedCandles(CACHE_PAIR, '1m', new Date((spanStart - WARMUP_SEC - 86_400) * 1000), new Date(spanEnd * 1000)),
    getCachedCandles(CACHE_PAIR, '30m', new Date((spanStart - WARMUP_SEC - 86_400) * 1000), new Date(spanEnd * 1000)),
    getCachedFundingRates(SYMBOL, new Date((spanStart - WARMUP_SEC - 86_400) * 1000), new Date(spanEnd * 1000)),
  ]);
  process.stdout.write(`[mc] data: ${c1m.length} 1m bars\n`);

  function runOne(params: SampledParams, mode: StrategyMode) {
    resetResearchIds();
    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: funding,
      config: { initialCapital: CAPITAL, fees: DEFAULT_PERP_FEES },
      hooks: createStrategy(toStrategyConfig(params, mode, CAPITAL)),
    });
    const equity = result.equity.filter(p => p.timeSec >= spanStart);
    return { equity, metrics: computeRunMetrics(equity) };
  }

  // per-parameter medians across window winners (for stability distance)
  const keys = Object.keys(windows[0].bestParams) as Array<keyof SampledParams>;
  const medians: Record<string, number> = {};
  const iqrs: Record<string, number> = {};
  for (const k of keys) {
    const vals = windows.map(w => Number(w.bestParams[k])).sort((a, b) => a - b);
    medians[k] = percentile(vals, 0.5);
    iqrs[k] = Math.max(1e-9, percentile(vals, 0.75) - percentile(vals, 0.25));
  }

  const t0 = Date.now();
  const candidates: Array<Record<string, unknown>> = [];

  for (const w of windows) {
    const p = w.bestParams;
    const base: Record<string, unknown> = {};
    let dailyB: number[] = [];
    for (const mode of ['B', 'fullClose', 'fullHold'] as StrategyMode[]) {
      const run = runOne(p, mode);
      base[mode] = run.metrics;
      if (mode === 'B') dailyB = returnsOf(resampleDaily(run.equity));
    }

    const boot = blockBootstrap(dailyB, mulberry32(7000 + w.window), nBoots, 7);
    boot.sharpes.sort((a, b) => a - b);
    boot.maxDDs.sort((a, b) => a - b);

    const rng = mulberry32(9000 + w.window);
    const perturbs: Array<{ sharpe: number; maxDrawdown: number; totalReturn: number }> = [];
    for (let i = 0; i < nPerturbs; i++) {
      const pp = perturbParams(p, rng, 0.15);
      const run = runOne(pp, 'B');
      perturbs.push({
        sharpe: run.metrics.sharpe,
        maxDrawdown: run.metrics.maxDrawdown,
        totalReturn: run.metrics.totalReturn,
      });
    }
    const pSharpes = perturbs.map(x => x.sharpe).filter(s => isFinite(s)).sort((a, b) => a - b);

    // normalized distance to the cross-window median parameter vector
    const stabilityDistance =
      keys.reduce((s, k) => s + Math.abs(Number(p[k]) - medians[k]) / iqrs[k], 0) / keys.length;

    const bm = (base.B as { sharpe: number });
    process.stdout.write(
      `[mc] cand W${w.window}: B full-span sharpe ${bm.sharpe.toFixed(2)}  ` +
      `boot p5/p50/p95 ${percentile(boot.sharpes, 0.05).toFixed(2)}/${percentile(boot.sharpes, 0.5).toFixed(2)}/${percentile(boot.sharpes, 0.95).toFixed(2)}  ` +
      `perturb p5/p50 ${percentile(pSharpes, 0.05).toFixed(2)}/${percentile(pSharpes, 0.5).toFixed(2)}  ` +
      `stability ${stabilityDistance.toFixed(2)}  [${((Date.now() - t0) / 1000).toFixed(0)}s]\n`
    );

    candidates.push({
      fromWindow: w.window,
      params: p,
      fullSpan: base,
      bootstrap: {
        sharpe: { p5: percentile(boot.sharpes, 0.05), p25: percentile(boot.sharpes, 0.25), p50: percentile(boot.sharpes, 0.5), p75: percentile(boot.sharpes, 0.75), p95: percentile(boot.sharpes, 0.95) },
        maxDD: { p50: percentile(boot.maxDDs, 0.5), p95: percentile(boot.maxDDs, 0.95) },
        n: nBoots,
      },
      perturbation: { points: perturbs, sharpeP5: percentile(pSharpes, 0.05), sharpeP50: percentile(pSharpes, 0.5), n: nPerturbs },
      stabilityDistance,
    });
  }

  const artifact = {
    kind: 'monte-carlo',
    generatedAt: new Date().toISOString(),
    sourceWalkForward: wfName,
    span: { start: spanStart, end: spanEnd },
    paramMedians: medians,
    candidates,
  };
  const out = path.join(process.cwd(), 'research-artifacts', `montecarlo-${wfName.replace('walkforward-', '')}.json`);
  fs.writeFileSync(out, JSON.stringify(artifact));
  process.stdout.write(`[mc] artifact written: ${out} in ${((Date.now() - t0) / 60000).toFixed(1)} min\n`);
}

main()
  .catch(err => {
    process.stderr.write(`[mc] ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
