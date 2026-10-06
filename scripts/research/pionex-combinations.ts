// Reproducible read-only research. Usage: tsx scripts/research/pionex-combinations.ts <stage>
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { runPionex } from '../../src/lib/pionex/engine';
import { computeMetrics } from '../../src/lib/pionex/metrics';
import { bandFromOffsets } from '../../src/lib/pionex/gridLevels';
import { fundingCoverageGaps } from '../../src/lib/pionex/funding';
import type { FundingRecord } from '../../src/lib/pionex/funding';
import type { PionexRunConfig, PathId } from '../../src/lib/pionex/types';
import type { OHLC } from '../../src/lib/types';
import { runSpotReference, validateSpotReference } from './pionex-spot-reference';

const OUT = 'tasks/pionex-combinations-2026-10-06';
mkdirSync(OUT, { recursive: true });
const JOURNAL = `${OUT}/results.jsonl`;
const DB = 'prisma/dev.db';
const stage = process.argv[2] ?? 'baseline';
const sql = <T,>(query: string): T => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', DB, query], { maxBuffer: 256 * 1024 * 1024 }).toString() || '[]');
const D = (s: string) => Date.parse(`${s}T00:00:00Z`);
type Window = { id: string; start: number; end: number; saved?: string };
const primary: Window[] = [
  { id: 'jan01', start: D('2026-01-01'), end: D('2026-03-31'), saved: 'cmuwc5g6c0006j5i8s41pugoi' },
  { id: 'jan16', start: D('2026-01-16'), end: D('2026-04-17'), saved: 'cmuwcstrd0007j5i8tsl5droh' },
];
const stress: Window[] = [
  { id: 'terra2022', start: D('2022-05-04'), end: D('2022-05-20') },
  { id: 'ftx2022', start: D('2022-11-06'), end: D('2022-11-24') },
  { id: 'drop2025', start: D('2025-01-04'), end: D('2025-02-10') },
];
const shifted: Window[] = ['2026-01-05', '2026-01-10', '2026-01-20', '2026-01-25', '2026-02-01'].map(s => ({ id: `start${s}`, start: D(s), end: D('2026-03-31') }));
const base: PionexRunConfig = {
  bot: { lower: 0, upper: 0, gridCount: 60, mode: 'arithmetic', investment: 150, extraMargin: 200, leverage: 15 },
  costs: { makerFee: 0.0002, takerFee: 0.0005, mmr: 0.005, fundingRateOverride: null },
  marginCheck: true, capitalTotal: 1000,
  cycle: { takeProfitPct: 0.012, reinvestPct: 0.2 },
  topUp: { triggerPct: 0.05, amount: 50 }, bot2: { triggerOffsetPct: 0.01, capitalMultiplier: 1 },
};
type Candidate = { id: string; cfg: PionexRunConfig; band: [number, number]; note?: string };
const candidate = (id: string, lev: number, I: number, E: number, total = 1000): Candidate => ({ id, band: [-0.15, 0.012], cfg: { ...structuredClone(base), capitalTotal: total, bot: { ...base.bot, leverage: lev, investment: I, extraMargin: E } } });
const cache = new Map<string, { last: OHLC[]; mark: OHLC[]; funding: FundingRecord[]; complete: boolean }>();
function load(w: Window) {
  if (cache.has(w.id)) return cache.get(w.id)!;
  const candles = (pair: string) => sql<OHLC[]>(`SELECT openTime/1000 AS timestamp,open,high,low,close,volume FROM BinanceCandle WHERE pair='${pair}' AND interval='1m' AND openTime>=${w.start} AND openTime<${w.end} ORDER BY openTime`);
  const last = candles('ETHUSDTPERP'), mark = candles('ETHUSDTMARK');
  const funding = sql<FundingRecord[]>(`SELECT fundingTime AS fundingTimeMs,fundingRate AS rate FROM BinanceFundingRate WHERE symbol='ETHUSDT' AND fundingTime>=${w.start} AND fundingTime<${w.end} ORDER BY fundingTime`);
  const contiguous = (a: OHLC[]) => a.length === (w.end - w.start) / 60000 && a[0]?.timestamp * 1000 === w.start && a.every((c, i) => i === 0 || c.timestamp - a[i - 1].timestamp === 60);
  const complete = contiguous(last) && contiguous(mark) && fundingCoverageGaps(funding, w.start, w.end).length === 0;
  const certificates = sql<{ id: string; startTs: number; endTs: number; dataGapsJson: string }[]>(`SELECT id,startTs,endTs,dataGapsJson FROM PionexRun WHERE symbol='ETHUSDT' AND startTs<=${w.start} AND endTs>=${w.end} AND json_extract(dataGapsJson,'$.complete')=1`);
  assert(certificates.length > 0, `no previously API-reconciled complete report covering ${w.id}`);
  for (const cert of certificates) if (cert.startTs === w.start && cert.endTs === w.end) {
    assert(JSON.parse(cert.dataGapsJson).funding.records === funding.length, 'funding count differs from reconciled report');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ last, mark, funding })).digest('hex');
  console.log(JSON.stringify({ data: w.id, last: last.length, mark: mark.length, funding: funding.length, complete, fingerprint }));
  appendFileSync(`${OUT}/data.jsonl`, JSON.stringify({ ...w, last: last.length, mark: mark.length, funding: funding.length, complete, fingerprint, fundingCoverage: 'cached settlements + spacing + covering previously API-reconciled complete saved reports', certificates: certificates.map(c => c.id) }) + '\n');
  const d = { last, mark, funding, complete }; cache.set(w.id, d); return d;
}
function summarize(c: Candidate, w: Window, path: PathId) {
  const d = load(w);
  assert(d.complete, `incomplete futures window ${w.id}`);
  const cfg = { ...c.cfg, bot: { ...c.cfg.bot, ...bandFromOffsets(d.last[0].open, ...c.band) } };
  const r = runPionex(d.last, d.mark, d.funding, cfg, path);
  const metrics = computeMetrics(r.samples);
  let peak = cfg.capitalTotal!, maxDrawdownUSDT = 0, minWealth = peak, peakQty = 0;
  for (const s of r.samples) { peak = Math.max(peak, s.wealth); maxDrawdownUSDT = Math.max(maxDrawdownUSDT, peak - s.wealth); minWealth = Math.min(minWealth, s.wealth); peakQty = Math.max(peakQty, s.qty); }
  assert(r.maxInvariantError < 1e-7 && r.skippedMinutes === 0, 'accounting/data assertion');
  const result = {
    ...metrics, finalWealth: r.finalWealth, returnPct: (r.finalWealth / cfg.capitalTotal! - 1) * 100,
    maxDrawdownUSDT, minWealth, peakQty, bots: r.bots, rounds: r.rounds, cycles: r.cycles,
    gridProfit: r.gridProfit, finalWallet: r.finalWallet, freeCash: r.freeCash, withdrawn: r.withdrawn,
    fees: r.totals.fees, funding: r.totals.funding, topUps: r.totals.topUps, realized: r.totals.realizedTradePnl,
    liquidationLoss: r.totals.liquidationLoss, unrealized: r.finalWealth - r.freeCash - r.withdrawn - r.finalWallet,
    skippedBuys: r.events.filter(e => e.type === 'buy_skipped').length,
    rejected: r.events.filter(e => /rejected|cancelled|missed/.test(e.type)).length,
    bot2Rejected: r.events.filter(e => e.type === 'bot2_rejected').length,
    bothActive: r.bots.length === 2 && r.bots.every(b => b.status === 'active'),
    allExpectedActive: r.bots.length === (cfg.bot2 ? 2 : 1) && r.bots.every(b => b.status === 'active'),
    maxInvariantError: r.maxInvariantError,
    starts: r.events.filter(e => e.type === 'start').map(e => ({ bot: e.bot, timeMs: e.timeMs, price: e.price })),
  };
  if (c.id === 'baseline' && w.saved) {
    const rows = sql<{ metricsJson: string; dataGapsJson: string }[]>(`SELECT metricsJson,dataGapsJson FROM PionexRun WHERE id='${w.saved}'`);
    const saved = JSON.parse(rows[0].metricsJson).paths[path].summary;
    assert(Math.abs(saved.finalWealth - r.finalWealth) < 1e-8 && saved.bots.length === r.bots.length, 'baseline mismatch');
    assert(JSON.parse(rows[0].dataGapsJson).complete, 'saved data incomplete');
  }
  return result;
}
const existing = new Set(existsSync(JOURNAL) ? readFileSync(JOURNAL, 'utf8').trim().split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return `${r.stage}/${r.id}/${r.window}/${r.path}/${r.market}`; }) : []);
let count = 0;
function run(candidates: Candidate[], windows = primary) {
  for (const c of candidates) for (const w of windows) for (const path of ['A', 'B'] as const) {
    const key = `${stage}/${c.id}/${w.id}/${path}/futures`;
    if (existing.has(key)) continue;
    const result = summarize(c, w, path);
    appendFileSync(JOURNAL, JSON.stringify({ stage, id: c.id, window: w.id, path, market: 'futures', config: c.cfg, band: c.band, result }) + '\n');
    count++; if (count % 8 === 0) console.log(JSON.stringify({ stage, completed: count, latest: c.id, wealth: result.finalWealth }));
  }
}
function selected(): Candidate[] {
  // Locked before independent validation; straightforward risk/exposure tiers.
  return [candidate('cautious2', 2, 100, 300), candidate('balanced3', 3, 150, 200), candidate('higher5', 5, 100, 300)];
}
function main() {
  const runCountBefore = sql<{ n: number }[]>('SELECT count(*) AS n FROM PionexRun')[0].n;
  if (stage === 'baseline') run([candidate('baseline', 15, 150, 200)]);
  else if (stage === 'sweep') {
    const list: Candidate[] = [];
    for (const lev of [2, 3, 5, 15]) for (const I of [50, 100, 150]) for (const E of [50, 100, 200, 300]) list.push(candidate(`L${lev}-I${I}-E${E}`, lev, I, E));
    run(list);
  } else if (stage === 'controls') {
    const list: Candidate[] = [];
    for (const lev of [2, 3, 5, 15]) {
      const c = candidate(`equal450-L${lev}`, lev, 450 / lev, 350 - 450 / lev);
      c.cfg.cycle!.takeProfitPct = 1.8 / c.cfg.bot.investment; list.push(c);
      for (const T of [700, 1000, 2000]) list.push(candidate(`reserve-L${lev}-T${T}`, lev, 150, 200, T));
    }
    for (const E of [500, 900, 1200, 1600, 2200]) list.push(candidate(`15-margin-E${E}`, 15, 150, E, 2 * (150 + E) + 300));
    for (const c of selected()) for (const T of [500, 2000]) {
      const k = T / 1000;
      const s = candidate(`${c.id}-scaled${T}`, c.cfg.bot.leverage, c.cfg.bot.investment * k, c.cfg.bot.extraMargin * k, T);
      s.cfg.topUp!.amount *= k; list.push(s);
    }
    run(list);
  } else if (stage === 'sensitivity') {
    const list: Candidate[] = [];
    for (const original of selected()) {
      list.push(original);
      const add = (suffix: string, edit: (c: Candidate) => void) => { const c = structuredClone(original); c.id += suffix; edit(c); list.push(c); };
      add('-wide', c => { c.band = [-0.20, 0.05]; });
      for (const n of [30, 90]) add(`-grid${n}`, c => { c.cfg.bot.gridCount = n; });
      for (const offset of [0.05, 0.1]) add(`-offset${offset}`, c => { c.cfg.bot2!.triggerOffsetPct = offset; });
      add('-halfbot2', c => { c.cfg.bot2!.capitalMultiplier = 0.5; });
      add('-single', c => { c.cfg.bot2 = null; });
      add('-nocycle', c => { c.cfg.cycle = null; });
      add('-tp3', c => { c.cfg.cycle!.takeProfitPct = 0.03; });
      for (const r of [0, 0.5]) add(`-reinvest${r}`, c => { c.cfg.cycle!.reinvestPct = r; });
      add('-notopup', c => { c.cfg.topUp = null; });
      for (const trigger of [0.05, 0.1, 0.15]) for (const amount of [50, 100]) add(`-topup${trigger}-${amount}`, c => { c.cfg.topUp = { triggerPct: trigger, amount }; });
    }
    run(list);
  } else if (stage === 'validation') {
    const list = [...selected(), candidate('15equal450', 15, 30, 320), candidate('15bigmargin', 15, 150, 2200, 5000)];
    list[3].cfg.cycle!.takeProfitPct = 0.06;
    list.push(candidate('medium3', 3, 100, 300));
    for (const suffix of ['halfbot2', 'single', 'wide']) {
      const c = selected()[0]; c.id += `-${suffix}`;
      if (suffix === 'halfbot2') c.cfg.bot2!.capitalMultiplier = 0.5;
      else if (suffix === 'single') c.cfg.bot2 = null;
      else c.band = [-0.20, 0.05];
      list.push(c);
    }
    // Include no-cycle variants chosen on the primary windows, without tuning stress windows.
    for (const c of selected()) { const n = structuredClone(c); n.id += '-nocycle'; n.cfg.cycle = null; list.push(n); }
    run(list, [...stress, ...shifted]);
  } else if (stage === 'spot') {
    validateSpotReference();
    const monthly = new Map<string, OHLC[]>();
    for (const w of [...primary, ...stress, ...shifted]) {
      const months: string[] = [];
      for (let t = w.start; t < w.end; t += 86400000) { const m = new Date(t).toISOString().slice(0, 7); if (!months.includes(m)) months.push(m); }
      for (const m of months) if (!monthly.has(m)) monthly.set(m, JSON.parse(readFileSync(`/private/tmp/pionex-spot-research/${m}.json`, 'utf8')));
      const candles = months.flatMap(m => monthly.get(m)!).filter(c => c.timestamp * 1000 >= w.start && c.timestamp * 1000 < w.end);
      assert(candles.length === (w.end - w.start) / 60000 && candles.every((c, i) => i === 0 || c.timestamp - candles[i - 1].timestamp === 60), `spot gaps ${w.id}`);
      for (const I of [150, 300, 450]) for (const cycleOn of [true, false]) for (const path of ['A', 'B'] as const) {
        const c = candidate(`spot-I${I}-${cycleOn ? 'cycle' : 'nocycle'}`, 1, I, I * 0.01);
        c.cfg.bot = { ...c.cfg.bot, ...bandFromOffsets(candles[0].open, ...c.band) };
        c.cfg.costs = { makerFee: 0.0005, takerFee: 0.0005, mmr: 0 };
        c.cfg.topUp = null; if (!cycleOn) c.cfg.cycle = null;
        const key = `${stage}/${c.id}/${w.id}/${path}/spot`;
        if (existing.has(key)) continue;
        const result = runSpotReference(candles, c.cfg, path);
        assert(result.maxInvariantError < 1e-7, 'spot invariant');
        appendFileSync(JOURNAL, JSON.stringify({ stage, id: c.id, window: w.id, path, market: 'spot', config: c.cfg, band: c.band, result }) + '\n');
        count++;
      }
      const fee = 0.0005, buyQty = 1000 / (candles[0].open * (1 + fee));
      const final = buyQty * candles.at(-1)!.close * (1 - fee);
      let peak = 1000, dd = 0;
      for (const c of candles) { peak = Math.max(peak, buyQty * c.high); dd = Math.max(dd, (peak - buyQty * c.low) / peak); }
      appendFileSync(`${OUT}/benchmarks.jsonl`, JSON.stringify({ window: w.id, spotMinutes: candles.length, first: candles[0].open, last: candles.at(-1)!.close, cash: 1000, buyHoldLiquidated: final, buyHoldReturnPct: (final / 1000 - 1) * 100, buyHoldDrawdownPct: dd }) + '\n');
      console.log(JSON.stringify({ stage, window: w.id, completed: count }));
    }
  } else throw new Error(`unknown stage ${stage}`);
  assert(sql<{ n: number }[]>('SELECT count(*) AS n FROM PionexRun')[0].n === runCountBefore, 'run list changed during research');
  console.log(JSON.stringify({ stage, newRuns: count, savedRunCount: runCountBefore }));
}
main();
