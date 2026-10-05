import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OHLC } from '../lib/types';
import type { PionexWindowData } from '../lib/data/windows';
import type { DataGapReport } from '../lib/pionex/dataQuality';

// runStore integration (phase 3 review): window → engine → report → PionexRun row →
// reload, with the window loader, the cache and Prisma mocked (no network, no DB).
const rows = new Map<string, Record<string, unknown>>();
vi.mock('../lib/prisma', () => ({
  default: {
    pionexRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `run${rows.size + 1}`, createdAt: new Date(Date.UTC(2026, 9, 6)) };
        rows.set(row.id as string, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    },
  },
}));
const loadWindow = vi.fn<(symbol: string, startMs: number, endMs: number) => Promise<PionexWindowData>>();
vi.mock('../lib/data/windows', () => ({ loadWindow: (...a: [string, number, number]) => loadWindow(...a) }));
const cached: { candles: OHLC[] } = { candles: [] };
vi.mock('../lib/data/candleCache', () => ({ getCachedCandles: vi.fn(async () => cached.candles) }));

import { executeRun, loadRun, PionexRunRequest, validateRunRequest } from '../lib/pionex/runStore';
import { rerunRequest } from '../lib/pionex/params';

const T0 = Date.UTC(2022, 4, 10);
const M = 60_000;
const flat = (i: number, p: number): OHLC => ({ timestamp: (T0 + i * M) / 1000, open: p, high: p, low: p, close: p, volume: 0 });

const gapReport = (complete: boolean): DataGapReport => ({
  symbol: 'ETHUSDT', startMs: T0, endMs: T0 + 10 * M,
  last: { expected: 10, found: complete ? 10 : 0, gaps: complete ? [] : [{ startMs: T0, endMs: T0 + 10 * M, minutes: 10 }] },
  mark: { expected: 10, found: complete ? 10 : 0, gaps: complete ? [] : [{ startMs: T0, endMs: T0 + 10 * M, minutes: 10 }] },
  funding: { records: 0, gaps: [] },
  errors: complete ? [] : ['ETHUSDTPERP: fetch failed'],
  complete,
} as DataGapReport);

const window = (last: OHLC[], complete: boolean): PionexWindowData => ({
  symbol: 'ETHUSDT', startMs: T0, endMs: T0 + 10 * M, last1m: last, mark1m: last, funding: [],
  report: gapReport(complete), timingMs: { last: 1, mark: 2, funding: 3 },
});

const request: PionexRunRequest = {
  symbol: 'ETHUSDT', startMs: T0, endMs: T0 + 10 * M,
  band: { lowerPct: -0.1, upperPct: 0.1 },
  config: {
    bot: { lower: 0, upper: 0, gridCount: 10, mode: 'arithmetic', investment: 100, extraMargin: 50, leverage: 10 },
    costs: { makerFee: 0.0002, takerFee: 0.0005, mmr: 0.005 },
    marginCheck: true,
  },
};

describe('pionex runStore integration', () => {
  beforeEach(() => { rows.clear(); });

  it('P2/4: no common last/mark minute → structured data-incomplete result with the gap report, nothing saved', async () => {
    loadWindow.mockResolvedValueOnce(window([], false));
    const r = await executeRun(request);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.report.complete).toBe(false);
    expect(r.report.last.gaps).toHaveLength(1);
    expect(r.report.errors).toEqual(['ETHUSDTPERP: fetch failed']);
    expect(r.counts).toEqual({ last1m: 0, mark1m: 0, funding: 0 });
    expect(r.error).toMatch(/^data-incomplete/);
    expect(rows.size).toBe(0);
  });

  it('save → reload returns the same run (band resolved from the start price)', async () => {
    const last = [flat(0, 100), flat(1, 99), flat(2, 97), flat(3, 101), flat(4, 100)];
    loadWindow.mockResolvedValueOnce(window(last, true));
    cached.candles = last;
    const r = await executeRun(request);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.config.bot.lower).toBeCloseTo(90, 9);
    expect(r.run.config.bot.upper).toBeCloseTo(110, 9);
    expect(r.run.name).toBe('ETHUSDT 2022-05-10 → 2022-05-10');
    expect(r.run.report.paths.A.summary.rounds).toBeGreaterThan(0);

    const row = rows.get(r.run.id)!;
    expect(row.verdict).toBe(r.run.report.verdict);
    const reloaded = await loadRun(r.run.id);
    expect(reloaded).toEqual(JSON.parse(JSON.stringify(r.run)));
    expect(reloaded!.stale).toBe(false);
    expect(await loadRun('missing')).toBeNull();
  });

  it('a row saved before the report version loads as stale, and its re-run request is valid', async () => {
    const last = [flat(0, 100), flat(1, 99), flat(2, 97), flat(3, 101), flat(4, 100)];
    loadWindow.mockResolvedValueOnce(window(last, true));
    cached.candles = last;
    const r = await executeRun(request);
    if (!r.ok) throw new Error('run failed');
    // Old row: metrics without reportVersion, a switched-off fixed close stored as null.
    const row = rows.get(r.run.id)!;
    const { reportVersion: _v, ...oldMetrics } = JSON.parse(row.metricsJson as string);
    row.metricsJson = JSON.stringify(oldMetrics);
    const cfg = JSON.parse(row.configJson as string);
    row.configJson = JSON.stringify({ ...cfg, config: { ...cfg.config, bot1ClosePrice: null } });

    const old = (await loadRun(r.run.id))!;
    expect(old.stale).toBe(true);
    const req = JSON.parse(JSON.stringify(rerunRequest(old)));
    expect(validateRunRequest(req)).toBeNull();
    expect(req).toMatchObject({ symbol: 'ETHUSDT', startMs: T0, endMs: T0 + 10 * M, band: request.band });
  });
});
