// Pionex backtester — run execution and persistence (plan §5, §7 phase 3).
// One run = load window → path A and B → report → PionexRun row. Saved runs are
// reopened with their 5m display candles read back from the 1m cache (the row
// stores no candles, plan §5).

import prisma from '../prisma';
import { OHLC } from '../types';
import { pionexLastPair } from '../constants';
import { getCachedCandles } from '../data/candleCache';
import { loadWindow } from '../data/windows';
import { DataGapReport } from './dataQuality';
import { aggregateTo5m } from './aggregate';
import { bandFromOffsets } from './gridLevels';
import { runPionex } from './engine';
import { buildReport, PionexReport } from './report';
import { PionexRunConfig } from './types';

// Band as % offsets from the start price (plan §2/7); null = absolute bot.lower/upper.
export interface BandOffsets { lowerPct: number; upperPct: number }

export interface PionexRunRequest {
  name?: string;
  symbol: string;
  startMs: number;
  endMs: number;
  band: BandOffsets | null;
  config: PionexRunConfig;
}

export interface PionexRunPayload {
  id: string;
  name: string;
  symbol: string;
  startMs: number;
  endMs: number;
  createdAt: string;
  config: PionexRunConfig; // with the resolved absolute band
  band: BandOffsets | null;
  report: PionexReport;
  dataReport: DataGapReport;
  candles5m: OHLC[];
  stale: boolean; // saved with an older report version: re-run for a correct report
}

export interface PionexRunListItem {
  id: string;
  name: string;
  symbol: string;
  startMs: number;
  endMs: number;
  verdict: string;
  createdAt: string;
}

const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Bumped when the stored report changes meaning. 2 = per-bot liq line from the full
// sample stream + per-bot start/end liq levels; rows without it were saved before.
export const REPORT_VERSION = 2;

// No minute with both last and mark: nothing can run. Not an error but a data-incomplete
// result with the gap report and no survival claim (plan §3.10); nothing is saved.
// Same shape as POST /api/pionex/data.
export interface NoDataResult {
  error: string;
  report: DataGapReport;
  timingMs: { last: number; mark: number; funding: number };
  counts: { last1m: number; mark1m: number; funding: number };
}

export type ExecuteRunResult =
  | { ok: true; run: PionexRunPayload; timingMs: { load: number; compute: number; save: number } }
  | ({ ok: false } & NoDataResult);

export async function executeRun(req: PionexRunRequest): Promise<ExecuteRunResult> {
  let t = Date.now();
  const w = await loadWindow(req.symbol, req.startMs, req.endMs);
  const loadMs = Date.now() - t;

  t = Date.now();
  // The engine starts on the first minute present in both series (plan §3.3, §3.10).
  const marks = new Set(w.mark1m.map(c => c.timestamp));
  const first = w.last1m.find(c => marks.has(c.timestamp));
  if (!first) {
    return {
      ok: false,
      error: 'data-incomplete: no minute with both 1m last and 1m mark in the window — nothing to simulate',
      report: w.report,
      timingMs: w.timingMs,
      counts: { last1m: w.last1m.length, mark1m: w.mark1m.length, funding: w.funding.length },
    };
  }
  const config: PionexRunConfig = req.band
    ? { ...req.config, bot: { ...req.config.bot, ...bandFromOffsets(first.open, req.band.lowerPct, req.band.upperPct) } }
    : req.config;
  const a = runPionex(w.last1m, w.mark1m, w.funding, config, 'A');
  const b = runPionex(w.last1m, w.mark1m, w.funding, config, 'B');
  const report = buildReport(a, b, w.report.complete);
  const candles5m = aggregateTo5m(w.last1m);
  const computeMs = Date.now() - t;

  t = Date.now();
  const name = req.name?.trim() || `${req.symbol} ${fmtDay(req.startMs)} → ${fmtDay(req.endMs)}`;
  const row = await prisma.pionexRun.create({
    data: {
      name,
      symbol: req.symbol,
      startTs: new Date(req.startMs),
      endTs: new Date(req.endMs),
      configJson: JSON.stringify({ config, band: req.band }),
      metricsJson: JSON.stringify({ verdict: report.verdict, paths: report.paths, reportVersion: REPORT_VERSION }),
      equityJson: JSON.stringify(report.equity),
      liqSeriesJson: JSON.stringify(report.liqSeries),
      eventsJson: JSON.stringify(report.events),
      verdict: report.verdict,
      dataGapsJson: JSON.stringify(w.report),
    },
  });
  const saveMs = Date.now() - t;

  const payload: PionexRunPayload = {
    id: row.id, name, symbol: req.symbol, startMs: req.startMs, endMs: req.endMs,
    createdAt: row.createdAt.toISOString(), config, band: req.band, report, dataReport: w.report, candles5m, stale: false,
  };
  return { ok: true, run: payload, timingMs: { load: loadMs, compute: computeMs, save: saveMs } };
}

export async function loadRun(id: string): Promise<PionexRunPayload | null> {
  const row = await prisma.pionexRun.findUnique({ where: { id } });
  if (!row) return null;
  const { config, band } = JSON.parse(row.configJson);
  const metrics = JSON.parse(row.metricsJson);
  const report: PionexReport = {
    verdict: metrics.verdict,
    paths: metrics.paths,
    equity: JSON.parse(row.equityJson),
    liqSeries: JSON.parse(row.liqSeriesJson),
    events: JSON.parse(row.eventsJson),
  };
  const last1m = await getCachedCandles(pionexLastPair(row.symbol), '1m', row.startTs, row.endTs);
  return {
    id: row.id, name: row.name, symbol: row.symbol,
    startMs: row.startTs.getTime(), endMs: row.endTs.getTime(), createdAt: row.createdAt.toISOString(),
    config, band, report, dataReport: JSON.parse(row.dataGapsJson), candles5m: aggregateTo5m(last1m),
    stale: metrics.reportVersion !== REPORT_VERSION,
  };
}

export async function listRuns(limit = 100): Promise<PionexRunListItem[]> {
  const rows = await prisma.pionexRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, name: true, symbol: true, startTs: true, endTs: true, verdict: true, createdAt: true },
  });
  return rows.map(r => ({
    id: r.id, name: r.name, symbol: r.symbol, startMs: r.startTs.getTime(), endMs: r.endTs.getTime(),
    verdict: r.verdict, createdAt: r.createdAt.toISOString(),
  }));
}

export async function deleteRun(id: string): Promise<void> {
  await prisma.pionexRun.delete({ where: { id } });
}

// Input check before a run (before any download or save); returns the reason or null.
// Every number must be finite and inside the range the model is defined for.
export function validateRunRequest(r: PionexRunRequest): string | null {
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const pos = (x: unknown) => num(x) && x > 0;
  const nonNeg = (x: unknown) => num(x) && x >= 0;
  const frac = (x: unknown) => num(x) && x >= 0 && x < 1; // [0, 1)
  const c = r.config;
  if (!c?.bot || !c.costs) return 'config.bot and config.costs required';
  const { bot, costs } = c;
  if (!Number.isInteger(bot.gridCount) || bot.gridCount < 1 || bot.gridCount > 500) return 'gridCount must be an integer 1..500';
  if (!pos(bot.investment) || !nonNeg(bot.extraMargin) || !pos(bot.leverage)) return 'investment, leverage > 0 and extraMargin ≥ 0 required';
  if (bot.mode !== 'arithmetic' && bot.mode !== 'geometric') return 'mode must be arithmetic or geometric';
  if (r.band) {
    if (!num(r.band.lowerPct) || !num(r.band.upperPct) || !(r.band.lowerPct > -1 && r.band.upperPct > r.band.lowerPct)) {
      return 'band offsets invalid (−100% < lower < upper)';
    }
  } else if (!(pos(bot.lower) && num(bot.upper) && bot.upper > bot.lower)) return 'absolute band invalid (0 < lower < upper)';
  if (![costs.makerFee, costs.takerFee].every(frac)) return 'fees must be in [0, 100%)';
  if (!frac(costs.mmr)) return 'mmr must be in [0, 100%)';
  if (costs.fundingRateOverride != null && !num(costs.fundingRateOverride)) return 'funding override must be a number';
  // Optional fields: an absent key = off. A present key must be valid — an emptied
  // input (NaN) arrives as JSON null and must not read as "off".
  if (c.capitalTotal !== undefined && !pos(c.capitalTotal)) return 'capitalTotal must be > 0';
  if (c.cycle) {
    if (!pos(c.cycle.takeProfitPct)) return 'take profit must be > 0';
    if (c.cycle.takeProfitPricePct != null && !pos(c.cycle.takeProfitPricePct)) return 'TP price must be > 0';
    if (!(num(c.cycle.reinvestPct) && c.cycle.reinvestPct >= 0 && c.cycle.reinvestPct <= 1)) return 'reinvest must be in [0, 100%]';
  }
  if (c.topUp) {
    if (!(frac(c.topUp.triggerPct) && c.topUp.triggerPct > 0)) return 'top-up trigger must be in (0, 100%)';
    if (!pos(c.topUp.amount)) return 'top-up amount must be > 0';
  }
  if (c.bot2) {
    if (!frac(c.bot2.triggerOffsetPct)) return 'bot 2 trigger offset must be in [0, 100%)';
    if (!pos(c.bot2.capitalMultiplier)) return 'bot 2 capital multiplier must be > 0';
  }
  if (c.bot1ClosePrice !== undefined && !pos(c.bot1ClosePrice)) return 'fixed close price must be > 0';
  if (c.scheduledTopUps?.length) return 'scheduledTopUps is a test hook, not a run input';
  return null;
}
