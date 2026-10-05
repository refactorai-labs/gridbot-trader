/**
 * Walk-forward optimization for Strategy B vs baselines.
 *
 * Protocol:
 *   - Windows: 6 months in-sample / 2 months out-of-sample, rolling 2 months,
 *     spanning 2024-02-15 → 2026-02-11 (the final-holdout boundary).
 *   - Per window: random search (N samples, seeded) on IS with mode B;
 *     fitness = annualized daily Sharpe, constrained (maxDD ≤ 20%, ≥3 cycles).
 *   - The winning params run OOS on ALL FOUR modes — identical data, regime
 *     filter, anchors and grids; only the banking rule differs.
 *   - OOS segments are stitched (compounded) per mode; final judgement happens
 *     on the stitched curves.
 *
 * Usage:
 *   npx tsx scripts/research/walk-forward.ts                # 150 samples/window
 *   npx tsx scripts/research/walk-forward.ts --samples 50   # quicker shakedown
 *   npx tsx scripts/research/walk-forward.ts --tag v2       # artifact suffix
 */

import * as fs from 'fs';
import * as path from 'path';
import prisma from '../../src/lib/prisma';
import { getCachedCandles } from '../../src/lib/data/candleCache';
import { getCachedFundingRates } from '../../src/lib/data/fundingCache';
import { OHLC } from '../../src/lib/types';
import { FundingRateEntry } from '../../src/lib/simulation/funding';
import { runFillSim } from '../../src/lib/research/fillSim';
import { resetResearchIds } from '../../src/lib/research/account';
import { createStrategy, StrategyMode } from '../../src/lib/research/strategyB';
import { DEFAULT_PERP_FEES, EquityPoint } from '../../src/lib/research/types';
import { computeRunMetrics, mulberry32, stitchEquity, RunMetrics } from '../../src/lib/research/metrics';
import { sampleParams, toStrategyConfig, SampledParams, ParamSpace } from '../../src/lib/research/paramSpace';

const CACHE_PAIR = 'ETHUSDTPERP';
const SYMBOL = 'ETHUSDT';
const CAPITAL = 10_000;
const WARMUP_SEC = 14 * 86_400;
const MONTH_SEC = 30.44 * 86_400;
const WF_START = Date.UTC(2024, 1, 15) / 1000;     // 2024-02-15
const HOLDOUT_START = Date.UTC(2026, 1, 11) / 1000; // 2026-02-11 — never crossed here
const IS_MONTHS = 6;
const OOS_MONTHS = 2;
const MODES: StrategyMode[] = ['B', 'fullClose', 'fullHold', 'oneSided'];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function lowerBound(arr: { timestamp: number }[], sec: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface RunOutput {
  metrics: RunMetrics;
  equity: EquityPoint[];
  cycles: number;
  banks: number;
  unwinds: number;
  derisks: number;
  stops: number;
}

function makeRunner(c1m: OHLC[], c30: OHLC[], funding: FundingRateEntry[]) {
  return function runOne(params: SampledParams, mode: StrategyMode, startSec: number, endSec: number): RunOutput {
    const warmStart = startSec - WARMUP_SEC;
    const c1 = c1m.slice(lowerBound(c1m, warmStart), lowerBound(c1m, endSec));
    const c3 = c30.slice(lowerBound(c30, warmStart), lowerBound(c30, endSec));
    resetResearchIds();
    const strategy = createStrategy(toStrategyConfig(params, mode, CAPITAL));
    const result = runFillSim({
      candles1m: c1,
      candles30m: c3,
      fundingRates: funding,
      config: { initialCapital: CAPITAL, fees: DEFAULT_PERP_FEES },
      hooks: strategy,
    });
    const equity = result.equity.filter(p => p.timeSec >= startSec);
    const d = strategy.diagnostics;
    return {
      metrics: computeRunMetrics(equity),
      equity,
      cycles: d.cyclesStarted,
      banks: d.banks,
      unwinds: d.unwinds,
      derisks: d.derisks,
      stops: result.account.legs.long.stopCount + result.account.legs.short.stopCount,
    };
  };
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Per-parameter median of a set of candidates. Parameter averaging is more
// robust than argmax; ordering constraints (unwind < bank, stop ≥ invalidation)
// are re-enforced after taking independent medians.
function medianParams(list: SampledParams[]): SampledParams {
  const med = (sel: (p: SampledParams) => number) => median(list.map(sel));
  const bankAt = med(p => p.bankAt);
  const w = med(p => p.invalidationAtrMult);
  return {
    partialFraction: med(p => p.partialFraction),
    bankAt,
    unwindAt: Math.min(bankAt - 0.05, med(p => p.unwindAt)),
    invalidationAtrMult: w,
    stopAtrMult: Math.max(w + 0.25, med(p => p.stopAtrMult)),
    atrMult: med(p => p.atrMult),
    erLow: med(p => p.erLow),
    erHigh: med(p => p.erHigh),
    deriskSoft: med(p => p.deriskSoft) >= 0.5 ? 1 : 0,
    initialFraction: med(p => p.initialFraction),
    anchorMaxOffset: med(p => p.anchorMaxOffset),
    gridLevels: Math.round(med(p => p.gridLevels)),
    donchianLookback: Math.round(med(p => p.donchianLookback)),
    confirmBars: Math.round(med(p => p.confirmBars)),
    volExpandRatio: med(p => p.volExpandRatio),
    deriskAfterBars: Math.round(med(p => p.deriskAfterBars)),
    cooldownBars: Math.round(med(p => p.cooldownBars)),
  };
}

function fitness(run: RunOutput): number {
  let violations = 0;
  if (run.metrics.maxDrawdown > 0.20) violations++;
  if (run.cycles < 3) violations++;
  if (!isFinite(run.metrics.sharpe)) violations++;
  if (violations > 0) return -100 * violations + (isFinite(run.metrics.sharpe) ? run.metrics.sharpe : 0);
  return run.metrics.sharpe;
}

async function main(): Promise<void> {
  const samples = Number(arg('samples', '150'));
  const tag = arg('tag', 'v1');
  const space = arg('space', 'full') as ParamSpace;
  // 'is': argmax IS Sharpe. 'val': rank on first 2/3 of IS, evaluate the
  // top-K on the held-back last 1/3, select by validation fitness. 'median':
  // like 'val' but the chosen params are the per-parameter median of the top-K.
  const select = arg('select', 'is') as 'is' | 'val' | 'median';
  const topK = Number(arg('topk', '20'));
  const dataStart = new Date((WF_START - WARMUP_SEC - 86_400) * 1000);
  const dataEnd = new Date(HOLDOUT_START * 1000);

  process.stdout.write(`[wf] loading data…\n`);
  const [c1m, c30, funding] = await Promise.all([
    getCachedCandles(CACHE_PAIR, '1m', dataStart, dataEnd),
    getCachedCandles(CACHE_PAIR, '30m', dataStart, dataEnd),
    getCachedFundingRates(SYMBOL, dataStart, dataEnd),
  ]);
  process.stdout.write(`[wf] ${c1m.length} 1m bars, ${c30.length} 30m bars, ${funding.length} funding rows\n`);
  const runOne = makeRunner(c1m, c30, funding);

  // build rolling windows
  const windows: Array<{ isStart: number; isEnd: number; oosStart: number; oosEnd: number }> = [];
  for (let i = 0; ; i++) {
    const isStart = WF_START + i * OOS_MONTHS * MONTH_SEC;
    const isEnd = isStart + IS_MONTHS * MONTH_SEC;
    const oosEnd = Math.min(isEnd + OOS_MONTHS * MONTH_SEC, HOLDOUT_START);
    if (isEnd >= HOLDOUT_START - 7 * 86_400) break; // need a real OOS segment
    windows.push({ isStart, isEnd, oosStart: isEnd, oosEnd });
    if (oosEnd >= HOLDOUT_START) break;
  }
  process.stdout.write(
    `[wf] ${windows.length} windows, ${samples} IS samples each, space=${space}, select=${select}, modes: ${MODES.join(',')}\n`
  );

  const t0 = Date.now();
  const windowResults: Array<Record<string, unknown>> = [];
  const oosSegments: Record<StrategyMode, EquityPoint[][]> = { B: [], fullClose: [], fullHold: [], oneSided: [] };

  windows.forEach((w, wIdx) => {
    const rng = mulberry32(1000 + wIdx);
    let best: { params: SampledParams; score: number; run: RunOutput } | null = null;

    if (select === 'is') {
      for (let s = 0; s < samples; s++) {
        const params = sampleParams(rng, space);
        const run = runOne(params, 'B', w.isStart, w.isEnd);
        const score = fitness(run);
        if (!best || score > best.score) best = { params, score, run };
      }
    } else {
      // optimize on the first 2/3 of IS, rank, keep the top-K
      const optEnd = w.isStart + ((w.isEnd - w.isStart) * 2) / 3;
      const scored: Array<{ params: SampledParams; optScore: number }> = [];
      for (let s = 0; s < samples; s++) {
        const params = sampleParams(rng, space);
        const run = runOne(params, 'B', w.isStart, optEnd);
        scored.push({ params, optScore: fitness(run) });
      }
      scored.sort((a, b) => b.optScore - a.optScore);
      const topParams = scored.slice(0, topK).map(c => c.params);
      if (select === 'median') {
        // one synthetic candidate: the per-parameter median of the top-K
        const mp = medianParams(topParams);
        const valRun = runOne(mp, 'B', optEnd, w.isEnd);
        best = { params: mp, score: fitness(valRun), run: valRun };
      } else {
        // validate each top-K candidate on the final 1/3, pick the best
        for (const params of topParams) {
          const valRun = runOne(params, 'B', optEnd, w.isEnd);
          const valScore = fitness(valRun);
          if (!best || valScore > best.score) best = { params, score: valScore, run: valRun };
        }
      }
    }
    const oos: Partial<Record<StrategyMode, { metrics: RunMetrics; counters: Omit<RunOutput, 'metrics' | 'equity'> }>> = {};
    for (const mode of MODES) {
      const run = runOne(best!.params, mode, w.oosStart, w.oosEnd);
      oosSegments[mode].push(run.equity);
      oos[mode] = {
        metrics: run.metrics,
        counters: { cycles: run.cycles, banks: run.banks, unwinds: run.unwinds, derisks: run.derisks, stops: run.stops },
      };
    }
    const fmt = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
    process.stdout.write(
      `[wf] W${wIdx + 1}/${windows.length}  IS ${fmt(w.isStart)}→${fmt(w.isEnd)} score ${best!.score.toFixed(2)} ` +
      `(DD ${(best!.run.metrics.maxDrawdown * 100).toFixed(1)}%)  ` +
      `OOS ${fmt(w.oosStart)}→${fmt(w.oosEnd)}: ` +
      MODES.map(m => `${m}=${oos[m]!.metrics.sharpe.toFixed(2)}`).join(' ') +
      `  [${((Date.now() - t0) / 1000).toFixed(0)}s]\n`
    );
    windowResults.push({
      window: wIdx + 1,
      isStart: w.isStart, isEnd: w.isEnd, oosStart: w.oosStart, oosEnd: w.oosEnd,
      bestParams: best!.params,
      isScore: best!.score,
      isMetrics: best!.run.metrics,
      oos,
    });
  });

  // stitched curves + metrics per mode, plus stitched buy & hold
  const stitched: Record<string, unknown> = {};
  for (const mode of MODES) {
    const curve = stitchEquity(oosSegments[mode], CAPITAL);
    stitched[mode] = { curve, metrics: computeRunMetrics(curve) };
  }
  const bhSegments = oosSegments.B.map(seg => seg.map(p => ({ ...p, equity: p.price })));
  const bhCurve = stitchEquity(bhSegments, CAPITAL);
  stitched.buyHold = { curve: bhCurve, metrics: computeRunMetrics(bhCurve) };

  process.stdout.write(`\n=== STITCHED OOS (${windows.length} windows) ===\n`);
  for (const key of [...MODES, 'buyHold']) {
    const m = (stitched[key] as { metrics: RunMetrics }).metrics;
    process.stdout.write(
      `${key.padEnd(10)} return ${(m.totalReturn * 100).toFixed(1).padStart(7)}%  sharpe ${m.sharpe.toFixed(2).padStart(6)}  ` +
      `sortino ${m.sortino.toFixed(2).padStart(6)}  maxDD ${(m.maxDrawdown * 100).toFixed(1).padStart(5)}%  cvar5 ${(m.cvar5 * 100).toFixed(2)}%\n`
    );
  }

  const artifact = {
    kind: 'walk-forward',
    generatedAt: new Date().toISOString(),
    protocol: { isMonths: IS_MONTHS, oosMonths: OOS_MONTHS, samples, space, select, topK, capital: CAPITAL, fees: DEFAULT_PERP_FEES, seedBase: 1000 },
    wfSpan: { start: WF_START, holdoutStart: HOLDOUT_START },
    windows: windowResults,
    stitched,
  };
  const dir = path.join(process.cwd(), 'research-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `walkforward-${tag}.json`);
  fs.writeFileSync(file, JSON.stringify(artifact));
  process.stdout.write(`[wf] artifact written: ${file} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB) in ${((Date.now() - t0) / 60000).toFixed(1)} min\n`);
}

main()
  .catch(err => {
    process.stderr.write(`[wf] ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
