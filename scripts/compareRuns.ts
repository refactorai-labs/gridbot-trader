/**
 * Compare two Combo Bot baseline runs side-by-side.
 *
 * Usage:
 *   npx tsx scripts/compareRuns.ts <runA-id> <runB-id>
 *
 * Reads each Simulation row, its AdaptiveEvents, and its filled GridOrders, then
 * prints a markdown comparison table covering PnL, costs, event counts per side,
 * and drawdown. Read-only — used to document the Phase 3 baseline.
 */

import prisma from '../src/lib/prisma';

type Side = 'long' | 'short';

interface RunStats {
  id: string;
  name: string;
  comboGridLevels: number;
  totalPnl: number | null;
  longPnl: number | null;
  shortPnl: number | null;
  fees: { total: number; long: number; short: number };
  slippage: { total: number | null; long: number | null; short: number | null };
  funding: { total: number | null; long: number | null; short: number | null; missing: boolean };
  reopens: { long: number; short: number };
  sls: { long: number; short: number };
  breakouts: { long: number; short: number };
  maxDrawdown: number | null;
  maxDrawdownPct: number | null;
  finalEquity: number | null;
}

const TRACKED_EVENT_TYPES = ['tier1_reopen', 'sl_triggered', 'breakout_entered'] as const;
type TrackedEventType = (typeof TRACKED_EVENT_TYPES)[number];

async function loadRun(id: string): Promise<RunStats | null> {
  const sim = await prisma.simulation.findUnique({ where: { id } });
  if (!sim) return null;

  const events = await prisma.adaptiveEvent.findMany({
    where: { simulationId: id, eventType: { in: [...TRACKED_EVENT_TYPES] } },
    select: { eventType: true, detailsJson: true },
  });

  const counts: Record<TrackedEventType, { long: number; short: number }> = {
    tier1_reopen: { long: 0, short: 0 },
    sl_triggered: { long: 0, short: 0 },
    breakout_entered: { long: 0, short: 0 },
  };

  for (const e of events) {
    let side: Side | null = null;
    try {
      const parsed = JSON.parse(e.detailsJson) as { side?: unknown };
      if (parsed.side === 'long' || parsed.side === 'short') side = parsed.side;
    } catch {
      // Malformed payload — skip; counts will under-report rather than blow up.
    }
    if (!side) continue;
    const bucket = counts[e.eventType as TrackedEventType];
    if (bucket) bucket[side]++;
  }

  const orders = await prisma.gridOrder.findMany({
    where: { simulationId: id, status: 'filled' },
    select: { side: true, fees: true },
  });
  const fees = { total: 0, long: 0, short: 0 };
  for (const o of orders) {
    const f = o.fees ?? 0;
    fees.total += f;
    if (o.side === 'long') fees.long += f;
    else if (o.side === 'short') fees.short += f;
  }

  return {
    id: sim.id,
    name: sim.name,
    comboGridLevels: sim.comboGridLevels,
    totalPnl: sim.totalPnl,
    longPnl: sim.longPnl,
    shortPnl: sim.shortPnl,
    fees,
    slippage: {
      total: sim.totalSlippageCost,
      long: sim.longSlippageCost,
      short: sim.shortSlippageCost,
    },
    funding: {
      total: sim.totalFundingCost,
      long: sim.longFundingCost,
      short: sim.shortFundingCost,
      missing: sim.fundingDataMissing,
    },
    reopens: counts.tier1_reopen,
    sls: counts.sl_triggered,
    breakouts: counts.breakout_entered,
    maxDrawdown: sim.maxDrawdown,
    maxDrawdownPct: sim.maxDrawdownPct,
    finalEquity: sim.finalEquity,
  };
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number | null | undefined): string {
  // maxDrawdownPct is persisted as percent already (×100), see supervisor.ts:214.
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(2)}%`;
}

function row(label: string, a: string, b: string, widths: { l: number; a: number; b: number }): string {
  return `| ${label.padEnd(widths.l)} | ${a.padStart(widths.a)} | ${b.padStart(widths.b)} |`;
}

function render(a: RunStats, b: RunStats): string {
  const headerA = `Run A · ${a.id}`;
  const headerB = `Run B · ${b.id}`;
  const lines: Array<[string, string, string]> = [
    ['Name', a.name, b.name],
    ['gridLevels (engine)', String(a.comboGridLevels), String(b.comboGridLevels)],
    ['Total PnL', fmtUsd(a.totalPnl), fmtUsd(b.totalPnl)],
    ['Long PnL', fmtUsd(a.longPnl), fmtUsd(b.longPnl)],
    ['Short PnL', fmtUsd(a.shortPnl), fmtUsd(b.shortPnl)],
    ['Fees (total)', fmtUsd(a.fees.total), fmtUsd(b.fees.total)],
    ['Fees (long / short)', `${fmtUsd(a.fees.long)} / ${fmtUsd(a.fees.short)}`, `${fmtUsd(b.fees.long)} / ${fmtUsd(b.fees.short)}`],
    ['Slippage (total)', fmtUsd(a.slippage.total), fmtUsd(b.slippage.total)],
    ['Slippage (long / short)', `${fmtUsd(a.slippage.long)} / ${fmtUsd(a.slippage.short)}`, `${fmtUsd(b.slippage.long)} / ${fmtUsd(b.slippage.short)}`],
    ['Funding (total)', a.funding.missing ? 'missing' : fmtUsd(a.funding.total), b.funding.missing ? 'missing' : fmtUsd(b.funding.total)],
    ['Funding (long / short)', `${fmtUsd(a.funding.long)} / ${fmtUsd(a.funding.short)}`, `${fmtUsd(b.funding.long)} / ${fmtUsd(b.funding.short)}`],
    ['Reopens (long / short)', `${a.reopens.long} / ${a.reopens.short}`, `${b.reopens.long} / ${b.reopens.short}`],
    ['SLs (long / short)', `${a.sls.long} / ${a.sls.short}`, `${b.sls.long} / ${b.sls.short}`],
    ['Breakouts (long / short)', `${a.breakouts.long} / ${a.breakouts.short}`, `${b.breakouts.long} / ${b.breakouts.short}`],
    ['Max drawdown ($)', fmtUsd(a.maxDrawdown), fmtUsd(b.maxDrawdown)],
    ['Max drawdown (%)', fmtPct(a.maxDrawdownPct), fmtPct(b.maxDrawdownPct)],
    ['Final equity', fmtUsd(a.finalEquity), fmtUsd(b.finalEquity)],
  ];

  const widths = {
    l: Math.max('Metric'.length, ...lines.map(([l]) => l.length)),
    a: Math.max(headerA.length, ...lines.map(([, v]) => v.length)),
    b: Math.max(headerB.length, ...lines.map(([, , v]) => v.length)),
  };

  const out: string[] = [];
  out.push(row('Metric', headerA, headerB, widths));
  out.push(`| ${'-'.repeat(widths.l)} | ${'-'.repeat(widths.a)} | ${'-'.repeat(widths.b)} |`);
  for (const [l, va, vb] of lines) out.push(row(l, va, vb, widths));
  return out.join('\n');
}

async function main(): Promise<void> {
  const [idA, idB] = process.argv.slice(2);
  if (!idA || !idB) {
    process.stderr.write('Usage: npx tsx scripts/compareRuns.ts <runA-id> <runB-id>\n');
    process.exit(1);
  }
  const [a, b] = await Promise.all([loadRun(idA), loadRun(idB)]);
  if (!a) {
    process.stderr.write(`Simulation not found: ${idA}\n`);
    process.exit(1);
  }
  if (!b) {
    process.stderr.write(`Simulation not found: ${idB}\n`);
    process.exit(1);
  }
  process.stdout.write(`${render(a, b)}\n`);
}

main()
  .catch(err => {
    process.stderr.write(`compareRuns failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
