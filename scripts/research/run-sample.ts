/**
 * Strategy B sample run — prints a full trade log for manual sanity checking
 * and writes a JSON artifact for the /research dashboard.
 *
 * Usage:
 *   npx tsx scripts/research/run-sample.ts                    # mode B, 2025-03-01 → 2025-06-01
 *   npx tsx scripts/research/run-sample.ts --mode fullClose
 *   npx tsx scripts/research/run-sample.ts --mode B --start 2025-03-01 --end 2025-06-01
 *
 * The engine runs with a 14-day warmup prefix (regime/anchor indicators need
 * history); the log, metrics, and artifact cover only the requested window.
 */

import * as fs from 'fs';
import * as path from 'path';
import prisma from '../../src/lib/prisma';
import { getCachedCandles } from '../../src/lib/data/candleCache';
import { getCachedFundingRates } from '../../src/lib/data/fundingCache';
import { runFillSim } from '../../src/lib/research/fillSim';
import { createStrategy, DEFAULT_STRATEGY_B, StrategyMode } from '../../src/lib/research/strategyB';
import { DEFAULT_PERP_FEES, ResearchEvent } from '../../src/lib/research/types';

const CACHE_PAIR = 'ETHUSDTPERP';
const SYMBOL = 'ETHUSDT';
const WARMUP_DAYS = 14;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fmtTime(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

function fmtEvent(e: ResearchEvent): string {
  const base = `${fmtTime(e.timeSec)}  ${e.type.padEnd(12)} ${(e.leg ?? '').padEnd(5)} ${(e.orderType ?? '').padEnd(4)}`;
  const px = e.price !== undefined ? `@ ${e.price.toFixed(2)}` : '';
  const qty = e.qty !== undefined ? `qty ${e.qty.toFixed(4)}` : '';
  const pnl = e.realizedPnl !== undefined ? `pnl ${e.realizedPnl >= 0 ? '+' : ''}${e.realizedPnl.toFixed(2)}` : '';
  const frac = e.fraction !== undefined && e.type === 'partialClose' ? `(${(e.fraction * 100).toFixed(0)}% closed)` : '';
  const lvl = e.levelIndex !== undefined ? `L${e.levelIndex}` : '';
  const tag = e.reason ?? (e.reduceOnly ? 'tp' : '');
  return [base, px, qty, lvl, pnl, frac, tag].filter(Boolean).join('  ');
}

function maxDrawdown(equity: Array<{ equity: number }>): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

async function main(): Promise<void> {
  const mode = arg('mode', 'B') as StrategyMode;
  const start = new Date(`${arg('start', '2025-03-01')}T00:00:00.000Z`);
  const end = new Date(`${arg('end', '2025-06-01')}T00:00:00.000Z`);
  const capital = Number(arg('capital', '10000'));
  const warmupStart = new Date(start.getTime() - WARMUP_DAYS * 86_400_000);

  process.stdout.write(`[sample] mode=${mode}  window ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}  (+${WARMUP_DAYS}d warmup)\n`);

  const [c1m, c30, funding] = await Promise.all([
    getCachedCandles(CACHE_PAIR, '1m', warmupStart, end),
    getCachedCandles(CACHE_PAIR, '30m', warmupStart, end),
    getCachedFundingRates(SYMBOL, warmupStart, end),
  ]);
  process.stdout.write(`[sample] data: ${c1m.length} 1m bars, ${c30.length} 30m bars, ${funding.length} funding rows\n`);
  if (c1m.length === 0 || c30.length === 0) throw new Error('no cached data — run fetch-data.ts first');

  const cfg = { ...DEFAULT_STRATEGY_B, mode, totalCapital: capital };
  const strategy = createStrategy(cfg);
  const t0 = Date.now();
  const result = runFillSim({
    candles1m: c1m,
    candles30m: c30,
    fundingRates: funding,
    config: { initialCapital: capital, fees: DEFAULT_PERP_FEES },
    hooks: strategy,
  });
  process.stdout.write(`[sample] simulated ${c1m.length} 1m bars in ${Date.now() - t0}ms\n\n`);

  const startSec = start.getTime() / 1000;
  const events = result.events.filter(e => e.timeSec >= startSec);
  const equity = result.equity.filter(p => p.timeSec >= startSec);

  // ---- trade log -----------------------------------------------------------
  process.stdout.write(`=== TRADE LOG (${events.filter(e => e.type !== 'funding').length} events, funding rows summarized) ===\n`);
  for (const e of events) {
    if (e.type === 'funding') continue;
    process.stdout.write(fmtEvent(e) + '\n');
  }

  // ---- summary ---------------------------------------------------------------
  const acc = result.account;
  const fundingEvents = events.filter(e => e.type === 'funding');
  const fundingTotal = fundingEvents.reduce((s, e) => s + (e.fee ?? 0), 0);
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const eqStart = equity[0]?.equity ?? capital;
  const eqEnd = equity[equity.length - 1]?.equity ?? capital;
  const bh = equity.length > 1 ? (equity[equity.length - 1].price / equity[0].price - 1) : 0;
  // Open lots' entry fees already left cash but only hit realizedPnl at close.
  const openEntryFees = [...acc.legs.long.lots, ...acc.legs.short.lots].reduce((s, l) => s + l.entryFee, 0);
  const ledgerDrift = acc.cash - (acc.initialCapital
    + acc.legs.long.realizedPnl + acc.legs.short.realizedPnl
    - acc.legs.long.fundingPaid - acc.legs.short.fundingPaid
    - openEntryFees);

  const d = strategy.diagnostics;
  process.stdout.write(`
=== SUMMARY (${mode}) ===
window equity:    ${eqStart.toFixed(2)} → ${eqEnd.toFixed(2)}  (${(((eqEnd / eqStart) - 1) * 100).toFixed(2)}%)
buy & hold:       ${(bh * 100).toFixed(2)}%
max drawdown:     ${(maxDrawdown(equity) * 100).toFixed(2)}%
realized P&L:     long ${acc.legs.long.realizedPnl.toFixed(2)}  short ${acc.legs.short.realizedPnl.toFixed(2)}
fees paid:        long ${acc.legs.long.feesPaid.toFixed(2)}  short ${acc.legs.short.feesPaid.toFixed(2)}
funding (window): ${fundingTotal.toFixed(2)}  (${fundingEvents.length} settlements)
stops:            long ${acc.legs.long.stopCount}  short ${acc.legs.short.stopCount}
cycles/banks/unwinds/derisks: ${d.cyclesStarted}/${d.banks}/${d.unwinds}/${d.derisks}
events:           ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}
open at end:      long ${acc.legQty('long').toFixed(4)}  short ${acc.legQty('short').toFixed(4)}
ledger drift:     ${ledgerDrift.toExponential(2)}  (should be ~0)
`);

  // ---- artifact --------------------------------------------------------------
  const artifactDir = path.join(process.cwd(), 'research-artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  const candles30Window = c30.filter(c => c.timestamp >= startSec);
  const artifact = {
    kind: 'sample-run',
    generatedAt: new Date().toISOString(),
    mode,
    window: { start: start.toISOString(), end: end.toISOString() },
    capital,
    config: cfg,
    candles30m: candles30Window,
    events,
    equity,
    diagnostics: {
      regimeSeries: d.regimeSeries.filter(p => p.timeSec >= startSec),
      anchors: d.anchors, // keep all — a cycle may have anchored just before the window
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
      maxDrawdown: maxDrawdown(equity),
      buyHoldReturn: bh,
      fundingTotal,
      stops: { long: acc.legs.long.stopCount, short: acc.legs.short.stopCount },
    },
  };
  const file = path.join(artifactDir, `sample-${mode}.json`);
  fs.writeFileSync(file, JSON.stringify(artifact));
  process.stdout.write(`[sample] artifact written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} kB)\n`);
}

main()
  .catch(err => {
    process.stderr.write(`[sample] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
