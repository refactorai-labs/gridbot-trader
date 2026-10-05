/**
 * FINAL HOLDOUT runner (GATED) — Strategy B vs its three baselines on the
 * never-touched out-of-sample tail (2026-02-11 → 2026-06-11, +14d warmup).
 *
 * The winning parameter set is pulled from a walk-forward artifact window
 * (the Phase-4 candidate identified at the robustness gate). All four modes
 * run once on identical data; per-mode metrics, a ledger-drift check, and a
 * combined `holdout-final.json` are produced. Per-mode artifacts (sample-run
 * shape) render in the /research ANATOMY tab.
 *
 * HARD RULES: runs exactly once, only after explicit user approval at the
 * Phase-4 gate. Results are reported verbatim whatever they are — the holdout
 * confirms a candidate, it does not rescue one.
 *
 * Usage:
 *   npx tsx scripts/research/holdout.ts --wf walkforward-v4 --window 3
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
import { computeRunMetrics } from '../../src/lib/research/metrics';
import { toStrategyConfig, SampledParams } from '../../src/lib/research/paramSpace';

const CACHE_PAIR = 'ETHUSDTPERP';
const SYMBOL = 'ETHUSDT';
const CAPITAL = 10_000;
const WARMUP_DAYS = 14;
const HOLDOUT_START = '2026-02-11';
const HOLDOUT_END = '2026-06-11';
const MODES: StrategyMode[] = ['B', 'fullClose', 'fullHold', 'oneSided'];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const wfName = arg('wf', '');
  const windowNo = Number(arg('window', '0'));
  if (!wfName || !windowNo) {
    throw new Error('specify --wf <walkforward-artifact> --window <n> to select the winning params');
  }

  // ---- pull the winning parameter set from the walk-forward artifact --------
  const wfFile = path.join(process.cwd(), 'research-artifacts', `${wfName}.json`);
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  const win = (wf.windows as Array<{ window: number; bestParams: SampledParams }>).find(w => w.window === windowNo);
  if (!win) throw new Error(`window ${windowNo} not found in ${wfName}`);
  const params = win.bestParams;
  process.stdout.write(`[holdout] params from ${wfName} window ${windowNo}:\n${JSON.stringify(params, null, 2)}\n`);

  // ---- load data ------------------------------------------------------------
  const start = new Date(`${HOLDOUT_START}T00:00:00.000Z`);
  const end = new Date(`${HOLDOUT_END}T00:00:00.000Z`);
  const warmupStart = new Date(start.getTime() - WARMUP_DAYS * 86_400_000);
  const startSec = start.getTime() / 1000;
  process.stdout.write(`[holdout] window ${HOLDOUT_START} → ${HOLDOUT_END} (+${WARMUP_DAYS}d warmup)\n`);

  const [c1m, c30, funding] = await Promise.all([
    getCachedCandles(CACHE_PAIR, '1m', warmupStart, end),
    getCachedCandles(CACHE_PAIR, '30m', warmupStart, end),
    getCachedFundingRates(SYMBOL, warmupStart, end),
  ]);
  process.stdout.write(`[holdout] data: ${c1m.length} 1m bars, ${c30.length} 30m bars, ${funding.length} funding rows\n`);
  if (c1m.length === 0 || c30.length === 0) throw new Error('no cached data — run fetch-data.ts first');

  const candles30Window = c30.filter(c => c.timestamp >= startSec);
  const summary: Record<string, unknown>[] = [];
  const artifactDir = path.join(process.cwd(), 'research-artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });

  // ---- run all four modes once on identical data ----------------------------
  for (const mode of MODES) {
    const cfg = toStrategyConfig(params, mode, CAPITAL);
    resetResearchIds();
    const strategy = createStrategy(cfg);
    const result = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: funding,
      config: { initialCapital: CAPITAL, fees: DEFAULT_PERP_FEES },
      hooks: strategy,
    });
    const events = result.events.filter(e => e.timeSec >= startSec);
    const equity = result.equity.filter(p => p.timeSec >= startSec);
    const metrics = computeRunMetrics(equity);
    const acc = result.account;

    // ledger-drift check (same identity as run-sample.ts)
    const openEntryFees = [...acc.legs.long.lots, ...acc.legs.short.lots].reduce((s, l) => s + l.entryFee, 0);
    const ledgerDrift = acc.cash - (acc.initialCapital
      + acc.legs.long.realizedPnl + acc.legs.short.realizedPnl
      - acc.legs.long.fundingPaid - acc.legs.short.fundingPaid
      - openEntryFees);

    const eqStart = equity[0]?.equity ?? CAPITAL;
    const eqEnd = equity[equity.length - 1]?.equity ?? CAPITAL;
    const bh = equity.length > 1 ? equity[equity.length - 1].price / equity[0].price - 1 : 0;
    const d = strategy.diagnostics;

    // per-mode artifact (sample-run shape → renders in the ANATOMY tab)
    const artifact = {
      kind: 'holdout-run',
      generatedAt: new Date().toISOString(),
      mode,
      window: { start: start.toISOString(), end: end.toISOString() },
      capital: CAPITAL,
      config: cfg,
      candles30m: candles30Window,
      events,
      equity,
      diagnostics: {
        regimeSeries: d.regimeSeries.filter(p => p.timeSec >= startSec),
        anchors: d.anchors,
        cycles: d.cycles,
        cyclesStarted: d.cyclesStarted,
        banks: d.banks,
        unwinds: d.unwinds,
        derisks: d.derisks,
        stopsHandled: d.stopsHandled,
      },
      summary: {
        equityStart: eqStart,
        equityEnd: eqEnd,
        maxDrawdown: metrics.maxDrawdown,
        buyHoldReturn: bh,
        fundingTotal: acc.legs.long.fundingPaid + acc.legs.short.fundingPaid,
        stops: { long: acc.legs.long.stopCount, short: acc.legs.short.stopCount },
      },
    };
    fs.writeFileSync(path.join(artifactDir, `holdout-${mode}.json`), JSON.stringify(artifact));

    summary.push({
      mode,
      metrics,
      cycles: d.cyclesStarted,
      banks: d.banks,
      unwinds: d.unwinds,
      derisks: d.derisks,
      stops: { long: acc.legs.long.stopCount, short: acc.legs.short.stopCount },
      ledgerDrift,
    });
    process.stdout.write(
      `[holdout] ${mode.padEnd(10)} return ${(metrics.totalReturn * 100).toFixed(1).padStart(7)}%  ` +
      `sharpe ${metrics.sharpe.toFixed(2).padStart(6)}  sortino ${metrics.sortino.toFixed(2).padStart(6)}  ` +
      `maxDD ${(metrics.maxDrawdown * 100).toFixed(1).padStart(5)}%  cvar5 ${(metrics.cvar5 * 100).toFixed(2)}%  ` +
      `cyc/bank/unwind ${d.cyclesStarted}/${d.banks}/${d.unwinds}  drift ${ledgerDrift.toExponential(1)}\n`
    );
  }

  // buy & hold reference over the same window
  const bhRef = candles30Window.length > 1
    ? candles30Window[candles30Window.length - 1].close / candles30Window[0].close - 1
    : 0;

  const final = {
    kind: 'holdout-final',
    generatedAt: new Date().toISOString(),
    sourceWalkForward: wfName,
    sourceWindow: windowNo,
    params,
    window: { start: HOLDOUT_START, end: HOLDOUT_END },
    capital: CAPITAL,
    buyHoldReturn: bhRef,
    modes: summary,
  };
  fs.writeFileSync(path.join(artifactDir, 'holdout-final.json'), JSON.stringify(final));
  process.stdout.write(`[holdout] buy & hold over window: ${(bhRef * 100).toFixed(1)}%\n`);
  process.stdout.write(`[holdout] artifacts written: holdout-{${MODES.join(',')},final}.json\n`);
}

main()
  .catch(err => {
    process.stderr.write(`[holdout] ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
