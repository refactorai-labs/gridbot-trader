// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OHLC } from '../lib/types';
import type { PionexRunPayload } from '../lib/pionex/runStore';
import type { DataGapReport } from '../lib/pionex/dataQuality';
import type { DrawdownEpisode } from '../lib/pionex/drawdowns';
import { CycleRecord, LedgerEvent, PionexRunConfig } from '../lib/pionex/types';
import { runPionex } from '../lib/pionex/engine';
import { buildReport } from '../lib/pionex/report';
import { aggregateTo5m } from '../lib/pionex/aggregate';
import { BOT_A_PARAMS } from '../lib/pionex/params';

// /pionex page state (window ↔ result consistency): the real page and its handlers,
// with a controllable, delayed fetch. Only the chart components are replaced.
vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => <a href={href} {...p}>{children}</a>,
}));
vi.mock('@/components/ThemeToggle', () => ({ default: () => null }));
vi.mock('@/components/charts/TradingChart', () => ({ default: () => <div data-testid="main-chart" /> }));
vi.mock('@/components/pionex/SubCharts', () => ({ default: () => <div data-testid="sub-charts" /> }));

import PionexPage from '../app/pionex/page';

const DAY = 86_400_000;
const M = 60_000;
const T0 = Date.UTC(2022, 4, 10, 13, 37); // not midnight
const T1 = Date.UTC(2022, 4, 18, 9, 5);

// ── fetch mock: the run list and the drawdowns answer at once, everything else waits ──
interface Call { url: string; method: string; body: any; respond: (data: unknown, status?: number) => Promise<void> }
let calls: Call[] = [];
let episodes: DrawdownEpisode[] = [];

function installFetch() {
  calls = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
    if (url === '/api/pionex/runs' && method === 'GET') return Promise.resolve(reply({ runs: listed }));
    if (url.startsWith('/api/pionex/drawdowns')) return Promise.resolve(reply({ complete: true, gaps: [], episodes }));
    return new Promise<Response>(resolve => {
      calls.push({
        url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined,
        respond: async (data, status = 200) => {
          await act(async () => {
            resolve(reply(data, status));
            await new Promise(r => setTimeout(r, 0));
          });
        },
      });
    });
  }) as typeof fetch;
}

const pending = (url: string) => calls.filter(c => c.url === url);
const runPosts = () => pending('/api/pionex/run');
const lastCall = (url: string) => { const c = pending(url); return c[c.length - 1]; };

// ── real payloads from the engine (a few flat-ish minutes) ──
const baseConfig: PionexRunConfig = {
  bot: { lower: 90, upper: 110, gridCount: 10, mode: 'arithmetic', investment: 100, extraMargin: 50, leverage: 10 },
  costs: { makerFee: 0.0002, takerFee: 0.0005, mmr: 0.005 },
  marginCheck: true,
};

const gapReport = (startMs: number, endMs: number, found: number, complete = true): DataGapReport => ({
  symbol: 'ETHUSDT', startMs, endMs,
  last: { expected: 10, found, gaps: complete ? [] : [{ startMs, endMs, minutes: 10 - found }] },
  mark: { expected: 10, found, gaps: complete ? [] : [{ startMs, endMs, minutes: 10 - found }] },
  funding: { records: 0, gaps: [] },
  errors: [],
  complete,
} as DataGapReport);

function makeRun(id: string, o: Partial<Pick<PionexRunPayload, 'symbol' | 'startMs' | 'endMs' | 'stale' | 'config'>> = {}): PionexRunPayload {
  const startMs = o.startMs ?? Date.UTC(2022, 4, 4);
  const config = o.config ?? baseConfig;
  const last: OHLC[] = Array.from({ length: 10 }, (_, i) => {
    const p = 100 + (i % 3) - 1;
    return { timestamp: (startMs + i * M) / 1000, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 0 };
  });
  return {
    id, name: `run ${id}`, symbol: o.symbol ?? 'ETHUSDT', startMs, endMs: o.endMs ?? startMs + 10 * M,
    createdAt: '2026-10-06T00:00:00.000Z', config, band: null,
    report: buildReport(runPionex(last, last, [], config, 'A'), runPionex(last, last, [], config, 'B'), true),
    dataReport: gapReport(startMs, startMs + 10 * M, 10), candles5m: aggregateTo5m(last), stale: o.stale ?? false,
  };
}

const runResponse = (run: PionexRunPayload) => ({ run, timingMs: { load: 1000, compute: 10, save: 5 } });
let listed: { id: string; name: string; symbol: string; startMs: number; endMs: number; verdict: string; createdAt: string }[] = [];
const list = (...runs: PionexRunPayload[]) => {
  listed = runs.map(r => ({ id: r.id, name: r.name, symbol: r.symbol, startMs: r.startMs, endMs: r.endMs, verdict: r.report.verdict, createdAt: r.createdAt }));
};

// ── page helpers ──
const shown = (name: string) => [...document.querySelectorAll('.card-header')].some(e => e.textContent === name);
const anyResult = () => screen.queryByTestId('main-chart') !== null;
const timingShown = () => screen.queryByText(/^load \d/) !== null;
const dateInputs = () => document.querySelectorAll<HTMLInputElement>('input[type="date"]');
const setFrom = (v: string) => fireEvent.change(dateInputs()[0], { target: { value: v } });
const setTo = (v: string) => fireEvent.change(dateInputs()[1], { target: { value: v } });
const clickRun = () => fireEvent.click(screen.getAllByTitle(/current window/)[1]);
const runsList = () => within(screen.getByText('Runs').closest('section') as HTMLElement);
const openSaved = (name: string) => fireEvent.click(runsList().getByText(name).closest('button') as HTMLElement);

async function renderPage() {
  render(<PionexPage />);
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function runAndShow(run: PionexRunPayload) {
  clickRun();
  await lastCall('/api/pionex/run').respond(runResponse(run));
  await waitFor(() => expect(shown(run.name)).toBe(true));
}

beforeEach(() => {
  window.localStorage.clear();
  episodes = [];
  list();
  installFetch();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/pionex window ↔ result consistency', () => {
  it('a window change clears the result; a late success or failure of the old request changes nothing', async () => {
    await renderPage();
    const r1 = makeRun('r1');
    await runAndShow(r1);
    expect(timingShown()).toBe(true);

    clickRun();
    expect(anyResult()).toBe(false); // cleared at once on a new run
    const old = lastCall('/api/pionex/run');
    setFrom('2022-05-06');
    expect(screen.queryByText('Running A + B…')).toBeNull();
    await old.respond(runResponse(makeRun('late')));
    expect(shown('run late')).toBe(false);
    expect(anyResult()).toBe(false);
    expect(timingShown()).toBe(false);

    clickRun();
    const old2 = lastCall('/api/pionex/run');
    setTo('2022-05-21');
    await old2.respond({ error: 'late boom' }, 500);
    expect(screen.queryByText('late boom')).toBeNull();
    expect(anyResult()).toBe(false);
    expect(screen.queryByText('Running A + B…')).toBeNull();
  });

  it('settling an old request does not clear the running line of the new one', async () => {
    await renderPage();
    clickRun();
    const a = lastCall('/api/pionex/run');
    fireEvent.change(screen.getByDisplayValue('ETHUSDT PERP'), { target: { value: 'BTCUSDT' } });
    clickRun();
    const b = lastCall('/api/pionex/run');
    expect(b.body.symbol).toBe('BTCUSDT');
    await a.respond({ error: 'old failed' }, 500);
    expect(screen.getByText('Running A + B…')).toBeTruthy();
    expect(screen.queryByText('old failed')).toBeNull();
    await b.respond(runResponse(makeRun('b', { symbol: 'BTCUSDT' })));
    await waitFor(() => expect(shown('run b')).toBe(true));
    expect(screen.queryByText('Running A + B…')).toBeNull();
  });

  it('two opens answered in reverse order keep the latest choice; a date change drops a pending open', async () => {
    const r1 = makeRun('r1', { startMs: Date.UTC(2021, 0, 3, 4, 5) });
    const r2 = makeRun('r2', { startMs: Date.UTC(2023, 6, 8, 9, 10), symbol: 'SOLUSDT' });
    const r3 = makeRun('r3');
    list(r1, r2, r3);
    await renderPage();
    await screen.findByText('run r1');

    openSaved('run r1');
    openSaved('run r2');
    const [o1, o2] = pending('/api/pionex/runs/r1').concat(pending('/api/pionex/runs/r2'));
    await o2.respond({ run: r2 });
    await o1.respond({ run: r1 });
    expect(shown('run r2')).toBe(true);
    expect(shown('run r1')).toBe(false);
    expect(dateInputs()[0].value).toBe('2023-07-08');
    expect(screen.getByDisplayValue('SOLUSDT PERP')).toBeTruthy();

    openSaved('run r3');
    expect(anyResult()).toBe(false); // cleared at once on open
    setFrom('2023-07-01');
    await lastCall('/api/pionex/runs/r3').respond({ run: r3 });
    expect(shown('run r3')).toBe(false);
    expect(anyResult()).toBe(false);
    expect(dateInputs()[0].value).toBe('2023-07-01');
  });

  it('a general run or open error leaves no old result or timing; the error stays visible', async () => {
    const saved = makeRun('s1');
    list(saved);
    await renderPage();
    await runAndShow(makeRun('r1'));

    clickRun();
    await lastCall('/api/pionex/run').respond({ error: 'boom' }, 500);
    expect(screen.getByText('boom')).toBeTruthy();
    expect(anyResult()).toBe(false);
    expect(timingShown()).toBe(false);

    await runAndShow(makeRun('r2'));
    openSaved('run s1');
    await lastCall('/api/pionex/runs/s1').respond({ error: 'run not found' }, 404);
    expect(screen.getByText('run not found')).toBeTruthy();
    expect(anyResult()).toBe(false);
    expect(timingShown()).toBe(false);
  });

  it('422: no old result, the current data report is shown and a pending manual check is dropped', async () => {
    await renderPage();
    await runAndShow(makeRun('r1'));

    fireEvent.click(screen.getByRole('button', { name: /Check data window/ }));
    const check = lastCall('/api/pionex/data');
    clickRun();
    const noData = gapReport(Date.UTC(2022, 4, 4), Date.UTC(2022, 4, 20), 3, false);
    await lastCall('/api/pionex/run').respond({
      error: 'data-incomplete: nothing to simulate', report: noData,
      timingMs: { last: 1, mark: 2, funding: 3 }, counts: { last1m: 3, mark1m: 3, funding: 0 },
    }, 422);
    expect(screen.getByText('data-incomplete: nothing to simulate')).toBeTruthy();
    expect(anyResult()).toBe(false);
    expect(timingShown()).toBe(false);
    expect(screen.getByText('data-incomplete · no survival verdict')).toBeTruthy();
    expect(screen.getAllByText('3 / 10 min')).toHaveLength(2);

    await check.respond({
      report: gapReport(Date.UTC(2022, 4, 4), Date.UTC(2022, 4, 20), 10),
      timingMs: { last: 1, mark: 2, funding: 3 }, counts: { last1m: 10, mark1m: 10, funding: 0 },
    });
    expect(screen.getAllByText('3 / 10 min')).toHaveLength(2);
    expect(screen.queryByText('10 / 10 min')).toBeNull();
  });

  it('an invalidated trio does not send its next sub-run', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Trio' }));
    expect(runPosts()).toHaveLength(1);
    expect(screen.getByText('Running trio 1/3…')).toBeTruthy();
    setFrom('2022-05-06');
    await runPosts()[0].respond(runResponse(makeRun('t1')));
    expect(runPosts()).toHaveLength(1);
    expect(anyResult()).toBe(false);
    expect(screen.queryByText(/Running trio/)).toBeNull();
  });

  it('open and re-run keep non-midnight times; Run sends the panel, Re-run the saved config', async () => {
    const savedConfig = { ...baseConfig, bot: { ...baseConfig.bot, investment: 777 } };
    const saved = makeRun('old', { startMs: T0, endMs: T1, stale: true, config: savedConfig });
    list(saved);
    await renderPage();
    await screen.findByText('run old');

    openSaved('run old');
    await lastCall('/api/pionex/runs/old').respond({ run: saved });
    expect(shown('run old')).toBe(true);
    expect(dateInputs()[0].value).toBe('2022-05-10');

    const rerun = screen.getByRole('button', { name: 'Re-run saved settings' });
    expect(rerun.getAttribute('title')).toMatch(/saved run's window and settings/);
    fireEvent.click(rerun);
    expect(anyResult()).toBe(false);
    const rr = lastCall('/api/pionex/run').body;
    expect([rr.startMs, rr.endMs]).toEqual([T0, T1]);
    expect(rr.config.bot.investment).toBe(777);
    expect(rr.band).toBeNull();
    await lastCall('/api/pionex/run').respond(runResponse(makeRun('fresh', { startMs: T0, endMs: T1, config: savedConfig })));
    await waitFor(() => expect(shown('run fresh')).toBe(true));

    clickRun();
    const r = lastCall('/api/pionex/run').body;
    expect([r.startMs, r.endMs]).toEqual([T0, T1]);
    expect(r.config.bot.investment).toBe(BOT_A_PARAMS.investment);
    expect(r.band).not.toBeNull();
  });

  it('Top drops: picking sets the window, recovery labels, the window is capped at now; a gate runs its own window', async () => {
    const NOW = Date.UTC(2026, 9, 6, 12, 0);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const recovered: DrawdownEpisode = {
      peakMs: Date.UTC(2022, 4, 5, 3), peakPrice: 3000, troughMs: Date.UTC(2022, 4, 12, 7), troughPrice: 1800,
      depthPct: 0.4, recoveredMs: Date.UTC(2024, 2, 11, 5),
    };
    const open: DrawdownEpisode = {
      peakMs: Date.UTC(2026, 8, 28, 10), peakPrice: 2000, troughMs: Date.UTC(2026, 9, 3, 22), troughPrice: 1500,
      depthPct: 0.25, recoveredMs: null,
    };
    episodes = [recovered, open];
    await renderPage();
    await runAndShow(makeRun('r1'));

    expect(screen.getByText('Top drops · full history')).toBeTruthy();
    const recLabel = screen.getByText('recovered 2024-03-11');
    expect(recLabel.getAttribute('title')).toMatch(/Price recovery, not a bot survival result/);
    expect(screen.getByText('not recovered').getAttribute('title')).toMatch(/end of the loaded history/);

    const openBtn = screen.getByText('not recovered').closest('button') as HTMLElement;
    expect(openBtn.getAttribute('title')).toBe(
      'Window 2026-09-26 10:00 → 2026-10-06 12:00 UTC\npeak − 2 d → trough + 7 d, capped at now');
    fireEvent.click(openBtn);
    expect(anyResult()).toBe(false);
    expect(screen.getByText('hindsight')).toBeTruthy();
    expect(dateInputs()[0].value).toBe('2026-09-26');
    clickRun();
    const body = lastCall('/api/pionex/run').body;
    expect([body.startMs, body.endMs]).toEqual([open.peakMs - 2 * DAY, NOW]);

    // leadDays alone does not move the picked window
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '5' } });
    expect(dateInputs()[0].value).toBe('2026-09-26');

    fireEvent.click(screen.getByText('recovered 2024-03-11').closest('button') as HTMLElement);
    expect(dateInputs()[0].value).toBe('2022-04-30'); // 5 d before the peak
    fireEvent.click(screen.getByRole('button', { name: '2022-11' }));
    expect(screen.queryByText('hindsight')).toBeNull();
    const gate = lastCall('/api/pionex/run').body;
    expect([gate.startMs, gate.endMs]).toEqual([Date.UTC(2022, 10, 6), Date.UTC(2022, 10, 24)]);
    expect([dateInputs()[0].value, dateInputs()[1].value]).toEqual(['2022-11-06', '2022-11-24']);
  });

  it('pinned comparison cards stay after a window change', async () => {
    const p1 = makeRun('p1');
    window.localStorage.setItem('gridbot.config.v1.pionex.pinned', JSON.stringify(['p1']));
    await renderPage();
    await lastCall('/api/pionex/runs/p1').respond({ run: p1 });
    expect(shown('📌 run p1')).toBe(true);
    await runAndShow(makeRun('r1'));
    setFrom('2022-05-06');
    expect(anyResult()).toBe(false);
    expect(shown('📌 run p1')).toBe(true);
  });
});

// ── cycle table (trailing plan, decisions 10–11): hand-built records and events ──
const cycleConfig: PionexRunConfig = { ...baseConfig, cycle: { takeProfitPct: 0.05, reinvestPct: 0.5 } };
const S = Date.UTC(2022, 4, 4);
const rec = (index: number, o: Partial<CycleRecord> = {}): CycleRecord => ({
  index, startMs: S, endMs: S + 2 * M, startPrice: 100, closePrice: 105, rounds: 3,
  profit: 1.5, withdrawn: 0.75, eNext: 50.75, trigger: 'profit', ...o,
});

// A missing key (not undefined) marks an old saved run without cycle details.
function withCycles(run: PionexRunPayload, log: { A?: CycleRecord[]; B?: CycleRecord[] }, eventsA?: LedgerEvent[]) {
  for (const p of ['A', 'B'] as const) {
    const s = run.report.paths[p].summary;
    if (log[p]) s.cycleLog = log[p]; else delete s.cycleLog;
    s.bots[0].status = 'active';
  }
  if (eventsA) run.report.events.A = eventsA;
  return run;
}
const cycleTable = () => within(screen.getByText('Cycles (bot 1)').closest('section') as HTMLElement);
const rerunButton = () => screen.queryByRole('button', { name: 'Re-run saved settings' });

describe('/pionex cycle table', () => {
  it('shows the closed cycles of the selected path; A/B switch', async () => {
    await renderPage();
    const run = withCycles(makeRun('c1', { config: cycleConfig }), {
      A: [rec(1, { closePrice: 123.45 }), rec(2, { startMs: S + 2 * M, endMs: S + 5 * M, closePrice: 111.11, trigger: 'price' })],
      B: [rec(1, { closePrice: 234.56, trigger: 'price' })],
    });
    await runAndShow(run);
    const t = cycleTable();
    expect(t.getByText('123.45')).toBeTruthy();
    expect(t.getByText('111.11')).toBeTruthy();
    expect(t.getByText('profit')).toBeTruthy();
    expect(t.getByText('11.11%')).toBeTruthy(); // Δ % = 111.11 / 100 − 1
    expect(t.queryByText('234.56')).toBeNull();

    fireEvent.change(t.getByDisplayValue('Path A'), { target: { value: 'B' } });
    expect(t.getByText('234.56')).toBeTruthy();
    expect(t.queryByText('123.45')).toBeNull();
    expect(t.queryByText('profit')).toBeNull();
    expect(t.getByText('price')).toBeTruthy();
    expect(rerunButton()).toBeNull();
  });

  it('open row: since the last start / restart event of bot 1, not the window start', async () => {
    await renderPage();
    const events: LedgerEvent[] = [
      { type: 'start', bot: 0, timeMs: S + 3 * M, price: 101 },
      { type: 'restart', bot: 0, timeMs: S + 7 * M, price: 103 },
      { type: 'start', bot: 1, timeMs: S + 9 * M, price: 99 }, // bot 2 is ignored
    ];
    const run = withCycles(makeRun('c2', { config: cycleConfig }), { A: [], B: [] }, events);
    await runAndShow(run);
    const t = cycleTable();
    expect(t.getByText('No closed cycle')).toBeTruthy();
    expect(t.getByText('open since 2022-05-04 00:07')).toBeTruthy();
    expect(t.getByText('103.00')).toBeTruthy();
    expect(t.queryByText(/00:00/)).toBeNull();
    expect(t.queryByText(/00:03/)).toBeNull();
  });

  it('no open row when bot 1 is not active', async () => {
    await renderPage();
    const run = withCycles(makeRun('c3', { config: cycleConfig }), { A: [rec(1)], B: [rec(1)] });
    run.report.paths.A.summary.bots[0].status = 'stopped';
    await runAndShow(run);
    expect(cycleTable().queryByText(/open since/)).toBeNull();
  });

  it('missing cycle data: note and re-run button even when not stale; no table without a cycle rule', async () => {
    await renderPage();
    const old = withCycles(makeRun('c4', { config: cycleConfig }), {});
    expect(old.stale).toBe(false);
    await runAndShow(old);
    expect(cycleTable().getByText('Re-run for cycle details')).toBeTruthy();
    expect(cycleTable().queryByText('No closed cycle')).toBeNull();
    expect(rerunButton()).toBeTruthy();

    await runAndShow(withCycles(makeRun('c5', { config: cycleConfig }), { A: [], B: [] }));
    expect(rerunButton()).toBeNull();

    await runAndShow(makeRun('c6'));
    expect(screen.queryByText('Cycles (bot 1)')).toBeNull();
    expect(rerunButton()).toBeNull();
  });
});
