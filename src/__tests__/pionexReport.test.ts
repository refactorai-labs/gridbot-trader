import { describe, it, expect } from 'vitest';
import { OHLC } from '../lib/types';
import { runPionex } from '../lib/pionex/engine';
import { aggregateTo5m, fiveMinuteBucketSec } from '../lib/pionex/aggregate';
import { computeMetrics, decideVerdict } from '../lib/pionex/metrics';
import { buildReport, liqSeriesByBucket } from '../lib/pionex/report';
import { validateRunRequest } from '../lib/pionex/runStore';
import { seriesFor } from '../components/pionex/SubCharts';
import { BOT_A_PARAMS, PionexParams, toRunRequest, trioRequests } from '../lib/pionex/params';
import type { PionexRunPayload } from '../lib/pionex/runStore';
import { buildChartData } from '../components/pionex/chartData';
import { PionexRunConfig } from '../lib/pionex/types';

const T0 = Date.UTC(2022, 4, 10); // 5m aligned
const M = 60_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 0): OHLC => ({
  timestamp: (T0 + i * M) / 1000, open: o, high: h, low: l, close: c, volume: v,
});
const flat = (i: number, p: number) => bar(i, p, p, p, p);
const flats = (from: number, to: number, p: number) => Array.from({ length: to - from + 1 }, (_, k) => flat(from + k, p));

// Band 90–110, 10 grids, I 100, E 100, 10x, zero costs, capital 400. The drop to 85
// fills bot 1 completely; the 5m close at minute 4 (85 < 90 · 0.99) starts bot 2 at
// minute 5 with band [70, 90] and I2 + E2 = 200. Minute 11 recovers to 92.
const twoBotConfig: PionexRunConfig = {
  bot: { lower: 90, upper: 110, gridCount: 10, mode: 'arithmetic', investment: 100, extraMargin: 100, leverage: 10 },
  costs: { makerFee: 0, takerFee: 0, mmr: 0 },
  marginCheck: false,
  capitalTotal: 400,
  bot2: { triggerOffsetPct: 0.01, capitalMultiplier: 1 },
};
const twoBotLast = [flat(0, 100), bar(1, 100, 100, 85, 85), ...flats(2, 10, 85), bar(11, 85, 92, 85, 92), ...flats(12, 14, 92)];

describe('pionex 1m → 5m display aggregation', () => {
  it('buckets by timestamp, so holes never shift minutes into another candle', () => {
    const c = [bar(0, 10, 12, 9, 11, 1), bar(1, 11, 13, 10, 12, 1), bar(3, 12, 12, 8, 9, 1), bar(5, 20, 21, 19, 20, 2), bar(9, 20, 25, 18, 24, 2), bar(17, 30, 30, 30, 30, 1)];
    expect(aggregateTo5m(c)).toEqual([
      { timestamp: T0 / 1000, open: 10, high: 13, low: 8, close: 9, volume: 3 },
      { timestamp: T0 / 1000 + 300, open: 20, high: 25, low: 18, close: 24, volume: 4 },
      { timestamp: T0 / 1000 + 900, open: 30, high: 30, low: 30, close: 30, volume: 1 },
    ]);
    expect(fiveMinuteBucketSec(T0 + 7 * M + 1234)).toBe(T0 / 1000 + 300);
  });
});

describe('pionex run report (plan §5, §6.1)', () => {
  const a = runPionex(twoBotLast, twoBotLast, [], twoBotConfig, 'A');
  const b = runPionex(twoBotLast, twoBotLast, [], twoBotConfig, 'B');
  const report = buildReport(a, b, true);

  it('samples carry one P_liq per bot that exists at the time', () => {
    expect(a.bots.length).toBe(2);
    const bot2At = T0 + 5 * M;
    // Within the start minute, samples taken before bot 2's start still have one bot.
    let prev = 1;
    for (const s of a.samples) {
      const n = s.liqPrices.length;
      if (s.timeMs < bot2At) expect(n).toBe(1);
      if (s.timeMs > bot2At) expect(n).toBe(2);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    const afterStart = a.samples.find(s => s.liqPrices.length === 2)!;
    expect(afterStart.liqPrices[0]).not.toBeNull();
    expect(afterStart.liqPrices[1]).not.toBeNull();
  });

  it('keeps verdict and metrics of the full stream; thinning keeps the minima', () => {
    expect(report.verdict).toBe(decideVerdict(a, b, true));
    expect(report.paths.A.metrics).toEqual(computeMetrics(a.samples));
    expect(report.paths.B.metrics).toEqual(computeMetrics(b.samples));
    expect(report.events.A).toBe(a.events);
    expect(report.paths.A.summary).not.toHaveProperty('events');
    expect(report.paths.A.summary).not.toHaveProperty('samples');
    expect(Math.min(...report.equity.A.map(s => s.wealth))).toBe(Math.min(...a.samples.map(s => s.wealth)));
    const minLiq = (xs: { liqDistPct: number | null }[]) => Math.min(...xs.filter(s => s.liqDistPct !== null).map(s => s.liqDistPct!));
    expect(minLiq(report.equity.A)).toBe(minLiq(a.samples));
  });

  it('P1/2: the liquidation line keeps every bot\'s bucket maximum from the FULL stream', () => {
    for (const [r, series] of [[a, report.liqSeries.A], [b, report.liqSeries.B]] as const) {
      for (const pt of series) {
        const inBucket = r.samples.filter(s => Math.floor(s.timeMs / 300_000) * 300_000 === pt.timeMs);
        for (let bot = 0; bot < 2; bot++) {
          const vals = inBucket.map(s => s.liqPrices[bot]).filter((x): x is number => x != null);
          expect(pt.liqPrices[bot] ?? null).toBe(vals.length ? Math.max(...vals) : null);
        }
      }
    }
    // A bot's extreme that the wealth thinning drops is still kept: the bucket's
    // min-wealth / min-distance / last samples all miss bot 2's 900.
    const s = (t: number, wealth: number, liqDistPct: number, liqPrices: (number | null)[]) => ({ timeMs: T0 + t, wealth, liqDistPct, qty: 1, liqPrices });
    const series = liqSeriesByBucket([s(0, 90, 0.01, [500, 700]), s(1000, 100, 0.05, [400, 900]), s(2000, 95, 0.04, [450, null])]);
    expect(series).toEqual([{ timeMs: T0, liqPrices: [500, 900] }]);
  });

  it('P2/5: per-bot liquidation levels at start and at the end of the window', () => {
    const [b1, b2] = a.bots;
    expect(b1.startLiq).toEqual(a.startLiq);
    expect(b2.startLiq).not.toBeNull();
    expect(b2.startLiq!.fullGrid).not.toBeNull();
    // Both bots still open at the end: end values are the final state's.
    expect(b1.status).toBe('active');
    expect(b1.endLiq).not.toBeNull();
    expect(b2.endLiq).not.toBeNull();
    expect(b2.endLiq).not.toEqual(b2.startLiq); // the recovery to 92 sold bot 2's lots
  });

  it('data-incomplete wins over everything', () => {
    expect(buildReport(a, b, false).verdict).toBe('data_incomplete');
  });

  it('survives a JSON round-trip (what PionexRun stores)', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('chart overlays: fills per grid event, interventions as markers, ascending unique line times, bot 2 band', () => {
    const run = {
      id: 'x', name: 'x', symbol: 'ETHUSDT', startMs: T0, endMs: T0 + 15 * M, createdAt: '',
      config: twoBotConfig, band: null, report, dataReport: undefined as never,
      candles5m: aggregateTo5m(twoBotLast), stale: false,
    } as PionexRunPayload;
    const c = buildChartData(run, 'A');
    expect(c.levels.map(l => l.price)).toEqual([90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110]);
    expect(c.fills.length).toBe(a.events.filter(e => e.type === 'buy' || e.type === 'sell').length);
    expect(c.markers.map(m => m.text?.split(' ').slice(0, 2).join(' '))).toEqual(['B1 start', 'B2 start']);
    const liq = c.lineSeries.filter(l => l.id.startsWith('liq'));
    expect(liq.map(l => l.id)).toEqual(['liq0', 'liq1']);
    for (const l of c.lineSeries) {
      const t = l.data.map(d => d.time as number);
      expect(t).toEqual([...t].sort((x, y) => x - y));
      expect(new Set(t).size).toBe(t.length);
      expect(Math.max(...t)).toBeLessThanOrEqual(run.candles5m[run.candles5m.length - 1].timestamp);
    }
    // Per 5m bucket the highest P_liq; a non-positive P_liq (no liquidation possible)
    // and a bot that does not exist yet are line breaks, never a value ≤ 0.
    const synthetic = {
      ...run,
      report: { ...report, liqSeries: { ...report.liqSeries, A: [
        { timeMs: T0, liqPrices: [-500] },
        { timeMs: T0 + M, liqPrices: [80] },
        { timeMs: T0 + 5 * M, liqPrices: [81, -3] },
        { timeMs: T0 + 6 * M, liqPrices: [82, 60] },
      ] } },
    };
    const [l0, l1] = buildChartData(synthetic, 'A').lineSeries;
    expect(l0.data).toEqual([{ time: T0 / 1000, value: 80 }, { time: T0 / 1000 + 300, value: 82 }]);
    expect(l1.data).toEqual([{ time: T0 / 1000 }, { time: T0 / 1000 + 300, value: 60 }]);
    for (const l of liq) expect(l.data.every(d => d.value === undefined || d.value > 0)).toBe(true);
    // P2/6: the hovered 5m candle lists its events with the original minute and bot.
    expect(c.hoverLines(T0 / 1000 + 300)).toEqual(['00:05 B2 start @ 85.00 0.0000 · 2 grids bought at market']);
    const first = c.hoverLines(T0 / 1000)!;
    const inFirst = a.events.filter(e => e.timeMs < T0 + 5 * M).length;
    expect(inFirst).toBeGreaterThan(12);
    expect(first.slice(0, 2)).toEqual(['00:00 B1 start @ 100.00 0.0000 · 5 grids bought at market', '00:01 B1 buy @ 98.00']);
    expect(first).toHaveLength(13);
    expect(first[12]).toBe(`… ${inFirst - 12} more (Events tab)`);
    expect(c.hoverLines(T0 / 1000 + 3600)).toBeNull();
    const band = c.lineSeries.filter(l => l.id.startsWith('bot2'));
    expect(band.map(l => l.data[0].value)).toEqual([70, 90]);
    expect(band.every(l => l.dashed)).toBe(true);
  });
});

describe('pionex UI params (plan §6, §6.3)', () => {
  const W0 = Date.UTC(2022, 4, 4);
  const W1 = Date.UTC(2022, 4, 20);

  it('percent inputs become fractions; offset band is resolved on the server', () => {
    const r = toRunRequest({ ...BOT_A_PARAMS, cycleOn: true }, 'ETHUSDT', W0, W1);
    expect(r.band).toEqual({ lowerPct: -0.06665, upperPct: 0.0404 });
    expect(r.config.costs).toEqual({ makerFee: 0.0002, takerFee: 0.0005, mmr: 0.005, fundingRateOverride: null });
    expect(r.config.cycle).toEqual({ takeProfitPct: 0.05, reinvestPct: 0.5 });
    expect(r.config.topUp).toBeNull();
    expect(r.config.capitalTotal).toBeUndefined();
    expect(toRunRequest({ ...BOT_A_PARAMS, bandMode: 'absolute' }, 'ETHUSDT', W0, W1).band).toBeNull();
  });

  it('trio: same capital and window; all E up front · top-ups · two bots', () => {
    const p = { ...BOT_A_PARAMS, capitalTotal: 600, cycleOn: true };
    const [one, two, three] = trioRequests(p, 'ETHUSDT', W0, W1);
    for (const r of [one, two, three]) {
      expect(r.config.capitalTotal).toBe(600);
      expect([r.startMs, r.endMs]).toEqual([W0, W1]);
      expect(r.config.cycle).toEqual({ takeProfitPct: 0.05, reinvestPct: 0.5 });
      expect(r.name).toMatch(/^trio: /);
    }
    expect(one.config.bot.extraMargin).toBeCloseTo(600 - 134.68, 9);
    expect([one.config.topUp, one.config.bot2]).toEqual([null, null]);
    expect(two.config.bot.extraMargin).toBe(103.59);
    expect(two.config.topUp).toEqual({ triggerPct: 0.05, amount: 50 });
    expect(two.config.bot2).toBeNull();
    expect(three.config.bot2).toEqual({ triggerOffsetPct: 0.01, capitalMultiplier: 1 });
    expect(three.config.topUp).toBeNull();
  });
});

describe('pionex position sub-chart (P2/3)', () => {
  it('keeps the last state of a minute: a close at minute 5 shows 0 at minute 5', () => {
    const eq = [
      { timeMs: T0, wealth: 100, liqDistPct: 0.5, qty: 5 },
      { timeMs: T0 + 5 * M, wealth: 101, liqDistPct: 0.5, qty: 5 },
      { timeMs: T0 + 5 * M, wealth: 102, liqDistPct: null, qty: 0 },
      { timeMs: T0 + 20 * M, wealth: 102, liqDistPct: null, qty: 0 },
    ];
    const run = { report: { equity: { A: eq, B: eq }, events: { A: [], B: [] } } } as unknown as PionexRunPayload;
    expect(seriesFor(run, 'position', 'A').map(p => p.value)).toEqual([5, 0, 0]);
    expect(seriesFor(run, 'wealth', 'A').map(p => p.value)).toEqual([100, 101, 102]); // worst of the minute
  });
});

describe('pionex run request validation (P1/1)', () => {
  const W0 = Date.UTC(2022, 4, 4);
  const valid = () => toRunRequest({ ...BOT_A_PARAMS, cycleOn: true, topUpOn: true, bot2On: true, closeOn: true, capitalTotal: 600 }, 'ETHUSDT', W0, W0 + 86_400_000);
  const withConfig = (patch: (c: PionexRunConfig) => void) => {
    const r = valid();
    patch(r.config);
    return validateRunRequest(r);
  };

  it('accepts the full valid request', () => {
    expect(validateRunRequest(valid())).toBeNull();
    expect(withConfig(c => { c.cycle!.reinvestPct = 1; c.bot2!.triggerOffsetPct = 0; })).toBeNull();
  });

  it.each([
    ['bot 2 multiplier −1', (c: PionexRunConfig) => { c.bot2!.capitalMultiplier = -1; }],
    ['bot 2 multiplier 0', (c: PionexRunConfig) => { c.bot2!.capitalMultiplier = 0; }],
    ['bot 2 offset 100 %', (c: PionexRunConfig) => { c.bot2!.triggerOffsetPct = 1; }],
    ['top-up amount −50', (c: PionexRunConfig) => { c.topUp!.amount = -50; }],
    ['top-up trigger 0', (c: PionexRunConfig) => { c.topUp!.triggerPct = 0; }],
    ['reinvest 200 %', (c: PionexRunConfig) => { c.cycle!.reinvestPct = 2; }],
    ['reinvest −10 %', (c: PionexRunConfig) => { c.cycle!.reinvestPct = -0.1; }],
    ['take profit 0', (c: PionexRunConfig) => { c.cycle!.takeProfitPct = 0; }],
    ['mmr 100 %', (c: PionexRunConfig) => { c.costs.mmr = 1; }],
    ['taker fee NaN', (c: PionexRunConfig) => { c.costs.takerFee = NaN; }],
    ['maker fee negative', (c: PionexRunConfig) => { c.costs.makerFee = -0.0001; }],
    ['funding override Infinity', (c: PionexRunConfig) => { c.costs.fundingRateOverride = Infinity; }],
    ['fixed close 0', (c: PionexRunConfig) => { c.bot1ClosePrice = 0; }],
    ['capital NaN (JSON null of an emptied field → number check)', (c: PionexRunConfig) => { c.capitalTotal = NaN; }],
    ['extra margin null', (c: PionexRunConfig) => { (c.bot as { extraMargin: unknown }).extraMargin = null; }],
    ['leverage Infinity', (c: PionexRunConfig) => { c.bot.leverage = Infinity; }],
    ['grid count 2.5', (c: PionexRunConfig) => { c.bot.gridCount = 2.5; }],
    ['scheduled top-ups (test hook)', (c: PionexRunConfig) => { c.scheduledTopUps = [{ atMs: W0, amount: 10 }]; }],
  ])('rejects %s', (_label, patch) => {
    expect(withConfig(patch)).not.toBeNull();
  });

  // The real data path: panel params → request → JSON (NaN becomes null) → server check.
  const viaJson = (patch: Partial<PionexParams>) => {
    const req = toRunRequest({ ...BOT_A_PARAMS, ...patch }, 'ETHUSDT', W0, W0 + 86_400_000);
    return validateRunRequest(JSON.parse(JSON.stringify(req)));
  };

  it.each([
    ['common capital on, emptied field', { capitalTotal: NaN }],
    ['fixed close on, emptied price', { closeOn: true, closePrice: NaN }],
    ['top-up on, emptied amount', { topUpOn: true, topUpAmount: NaN }],
    ['bot 2 on, emptied multiplier', { bot2On: true, bot2Mult: NaN }],
    ['cycle on, emptied reinvest', { cycleOn: true, reinvestPct: NaN }],
  ] as [string, Partial<PionexParams>][])('rejects after JSON: %s', (_label, patch) => {
    expect(viaJson(patch)).not.toBeNull();
  });

  it('accepts after JSON: options off (absent keys), empty funding override (= Binance rate), all options on', () => {
    expect(viaJson({ capitalTotal: null, closeOn: false, closePrice: NaN })).toBeNull();
    expect(viaJson({ fundingOverridePct: null })).toBeNull();
    expect(viaJson({ capitalTotal: 600, cycleOn: true, topUpOn: true, bot2On: true, closeOn: true })).toBeNull();
  });

  it('rejects non-finite band offsets', () => {
    const r = valid();
    r.band = { lowerPct: NaN, upperPct: 0.04 };
    expect(validateRunRequest(r)).not.toBeNull();
    r.band = { lowerPct: -0.05, upperPct: Infinity };
    expect(validateRunRequest(r)).not.toBeNull();
  });
});
