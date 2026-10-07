// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_COMBO_CONFIG } from '../components/config/ComboBotConfig';

// Main simulator page, classic grid flows (plan v4, C1.7): pre-run candle window,
// polling with "Stop waiting", reload resume, replay errors, legacy banner,
// open-position counts. Chart-heavy components are replaced.
vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: { children: React.ReactNode; href: string }) => <a href={href} {...p}>{children}</a>,
}));
vi.mock('@/components/ThemeToggle', () => ({ default: () => null }));
vi.mock('@/components/charts/TradingChart', () => ({
  default: ({ side }: { side: string }) => <div data-testid={`chart-${side}`} />,
}));
vi.mock('@/components/simulation/DCAChart', () => ({ default: () => null }));
vi.mock('@/components/combo/ComboPane', () => ({ default: () => <div data-testid="combo-pane" /> }));
vi.mock('@/components/OptimizerTab', () => ({ default: () => null }));

import SimulatorPage from '../app/page';

const P = 'gridbot.config.v1.';
const seed = (key: string, value: unknown) => localStorage.setItem(P + key, JSON.stringify(value));
const gridSide = (side: string) => ({
  side, gridLevels: 10, gridType: 'arithmetic', lowerBound: 90, upperBound: 110,
  orderSizeType: 'fixed', orderSize: 100, totalCapital: 1000, profitMode: 'next_level',
});

// ── fetch mock routed by method + path ──
interface Call { url: string; method: string; body: any }
let calls: Call[];
let handler: (url: string, method: string, body: any) => { status?: number; data: unknown };

function installFetch() {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const { status = 200, data } = handler(url, method, body);
    return { ok: status < 400, status, json: async () => data } as Response;
  }) as typeof fetch;
}
const callsTo = (url: string, method = 'GET') => calls.filter(c => c.url === url && c.method === method);

const T = Date.UTC(2025, 0, 1) / 1000;
const row = (o: Record<string, unknown> = {}) => ({
  id: 'sim1', name: 'n', pair: 'WETH/USDC', timeframe: '1h', status: 'completed', createdAt: '',
  startTime: '2025-01-01T00:00:00.000Z', endTime: '2025-01-02T00:00:00.000Z',
  totalPnl: 5, totalPnlPct: 0.5, comboBotEnabled: false, engineVersion: 1, startingCapital: 1000, ...o,
});
const candles = [0, 1, 2, 3].map(i => ({ timestamp: T + i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
const snap = { candleIdx: 0, timestamp: T, price: 100, equity: 1005, realizedPnl: 2, unrealizedPnl: 3,
  longRealizedPnl: 2, shortRealizedPnl: 0, longUnrealizedPnl: 3, shortUnrealizedPnl: 0, longEquity: 1005, shortEquity: 0,
  longOrdersActive: 3, shortOrdersActive: 0, longFillCount: 3, shortFillCount: 0 };
const fill = (id: string, positionId: string, role: string, idx: number, orderType: string) => ({
  id, side: 'long', level: 0, levelPrice: 100, orderType, status: 'filled', fillPrice: 100, fillCandleIdx: idx,
  quantity: 1, positionId, role, fillSeq: Number(id), fillTime: T, fees: 0.1,
});
const v1Replay = {
  candles, totalCandles: 4, pnlSnapshots: [snap], adaptiveEvents: [],
  gridOrders: [fill('0', 'long-0-0', 'initial', 0, 'buy'), fill('1', 'long-1-0', 'initial', 0, 'buy'),
    fill('2', 'long-2-0', 'entry', 0, 'buy'), fill('3', 'long-2-0', 'exit', 0, 'sell'), fill('4', 'long-0-0', 'exit', 2, 'sell')],
  longLevels: [{ index: 0, price: 90, side: 'long' }, { index: 1, price: 110, side: 'long' }], shortLevels: [],
  engineVersion: 1, effectiveStart: T + 300, effectiveEnd: T + 4 * 3600, chartTimeframeMins: 60, diagnosticEventCount: 0,
  _compactionStats: { rawEventCount: 0, emittedEventCount: 0, droppedOutOfRange: 0, compactedStateEvents: 3 },
};
const legacyReplay = { ...v1Replay, engineVersion: undefined, effectiveStart: undefined, effectiveEnd: undefined,
  _compactionStats: undefined, shortLevels: [{ index: 0, price: 90, side: 'short' }] };

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  installFetch();
  handler = () => ({ data: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function startRun() {
  render(<SimulatorPage />);
  await flush();
  await act(async () => { fireEvent.click(screen.getByText('Run Simulation')); });
  await flush();
}

describe('pre-run candle fetch', () => {
  const startLocal = '2025-03-01T00:02';
  const endLocal = '2025-03-01T00:33';
  const startIso = new Date(startLocal).toISOString();
  const endIso = new Date(endLocal).toISOString();
  const ceil5 = (iso: string) => new Date(Math.ceil(Date.parse(iso) / 300_000) * 300_000).toISOString();
  const floor5 = (iso: string) => new Date(Math.floor(Date.parse(iso) / 300_000) * 300_000).toISOString();

  beforeEach(() => {
    seed('startDate', startLocal);
    seed('endDate', endLocal);
    seed('longConfig', gridSide('long'));
    seed('shortConfig', gridSide('short'));
    handler = (url, method) => {
      if (url === '/api/simulations' && method === 'POST') return { data: { id: 'sim1', status: 'running' } };
      if (url === '/api/candles' && method === 'POST') return { data: { count: 6 } };
      return { data: { simulation: row({ status: 'running' }) } };
    };
  });

  it('classic sends the normalized 5m window', async () => {
    seed('gridShortEnabled', false);
    await startRun();
    const [candlePost] = callsTo('/api/candles', 'POST');
    expect(candlePost.body.startTime).toBe(ceil5(startIso));
    expect(candlePost.body.endTime).toBe(floor5(endIso));
    expect(candlePost.body.startTime).not.toBe(startIso);
    const [simPost] = callsTo('/api/simulations', 'POST');
    expect(simPost.body.longConfig.enabled).toBe(true);
    expect(simPost.body.shortConfig.enabled).toBe(false);
  });

  it('Combo keeps the raw dates', async () => {
    seed('comboConfig', { ...DEFAULT_COMBO_CONFIG, enabled: true });
    await startRun();
    const [candlePost] = callsTo('/api/candles', 'POST');
    expect(candlePost.body.startTime).toBe(startIso);
    expect(candlePost.body.endTime).toBe(endIso);
  });

  it('DCA keeps the raw dates', async () => {
    seed('gridLongEnabled', false);
    seed('gridShortEnabled', false);
    seed('dcaLongEnabled', true);
    handler = (url, method) => (url === '/api/simulations' && method === 'POST'
      ? { data: { snapshots: [], trades: [] } }
      : { data: { count: 0, candles: [] } });
    await startRun();
    const [candlePost] = callsTo('/api/candles', 'POST');
    expect(candlePost.body.startTime).toBe(startIso);
    expect(candlePost.body.endTime).toBe(endIso);
  });

  it('polls past the old 180 s cap until the user stops waiting; the run id is kept', async () => {
    await startRun();
    await flush(200_000);
    expect(callsTo('/api/simulations/sim1').length).toBeGreaterThanOrEqual(195);
    await act(async () => { fireEvent.click(screen.getByText('Stop waiting')); });
    const before = callsTo('/api/simulations/sim1').length;
    await flush(10_000);
    expect(callsTo('/api/simulations/sim1').length).toBeLessThanOrEqual(before + 1);
    expect(screen.getByText(/Stopped waiting\. The simulation keeps running/)).toBeTruthy();
    expect(screen.queryByText('Stop waiting')).toBeNull();
    expect(localStorage.getItem('lastSimulationId')).toBe('sim1');
    expect(screen.getByText('Run Simulation')).toBeTruthy();
  });

  it('a fresh run started without a saved id stops polling when the page unmounts', async () => {
    const { unmount } = render(<SimulatorPage />);
    await flush();
    await act(async () => { fireEvent.click(screen.getByText('Run Simulation')); });
    await flush(2000);
    const before = callsTo('/api/simulations/sim1').length;
    expect(before).toBeGreaterThanOrEqual(1);
    unmount();
    await flush(5000);
    expect(callsTo('/api/simulations/sim1').length).toBe(before);
  });

  it('surfaces a replay failure on a fresh run', async () => {
    handler = (url, method) => {
      if (url === '/api/simulations' && method === 'POST') return { data: { id: 'sim1' } };
      if (url === '/api/candles') return { data: { count: 6 } };
      if (url === '/api/simulations/sim1/replay') return { status: 500, data: { error: 'boom' } };
      return { data: { simulation: row() } };
    };
    await startRun();
    await flush(1000);
    expect(screen.getByText('Failed to load replay: boom')).toBeTruthy();
  });
});

describe('reload of the saved run', () => {
  beforeEach(() => localStorage.setItem('lastSimulationId', 'sim1'));

  it('resumes polling a running run, then shows the classic v1 result', async () => {
    let polls = 0;
    handler = (url) => {
      if (url === '/api/simulations/sim1/replay') return { data: v1Replay };
      polls++;
      return { data: { simulation: row({ status: polls < 3 ? 'running' : 'completed' }) } };
    };
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByText('Stop waiting')).toBeTruthy();
    await flush(3000);
    expect(callsTo('/api/simulations/sim1/replay').length).toBe(1);

    // Per-side charts follow the replay levels (short side disabled → no chart).
    expect(screen.getAllByTestId('chart-long').length).toBe(1);
    expect(screen.queryByTestId('chart-short')).toBeNull();
    // Window, chart timeframe, limitations note, no legacy banner.
    expect(screen.getByText(/Execution window 2025-01-01 00:05 UTC → 2025-01-01 04:00 UTC/)).toBeTruthy();
    expect(screen.getByText('Chart timeframe 1h')).toBeTruthy();
    expect(screen.getByText(/Execution on 5m candles; the selected timeframe is chart-only/)).toBeTruthy();
    expect(screen.queryByText(/Legacy result/)).toBeNull();
    // Headline = equity − startingCapital; open positions at bucket 0: long-0-0, long-1-0 (long-2-0 closed).
    expect(screen.getAllByText('+$5.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$1005.00')).toBeTruthy();
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getByText(/3 state events thinned/)).toBeTruthy();
  });

  it('shows the legacy banner for a classic v0 row, both charts from the replay levels', async () => {
    handler = (url) => (url === '/api/simulations/sim1/replay'
      ? { data: legacyReplay }
      : { data: { simulation: row({ engineVersion: 0, startingCapital: 2000 }) } });
    seed('gridShortEnabled', false); // current toggles must not hide a returned side
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByText(/Legacy result from the old neutral-grid engine/)).toBeTruthy();
    expect(screen.getByText('Legacy run: executed on the selected 1h candles, not on 5m.')).toBeTruthy();
    expect(screen.queryByText(/Execution on 5m candles/)).toBeNull();
    expect(screen.getAllByTestId('chart-long').length).toBe(1);
    expect(screen.getAllByTestId('chart-short').length).toBe(1);
    expect(screen.queryByText(/open$/)).toBeNull();
  });

  it('Combo rows show no banner and no classic notes', async () => {
    handler = (url) => (url === '/api/simulations/sim1/replay'
      ? { data: legacyReplay }
      : { data: { simulation: row({ engineVersion: 0, comboBotEnabled: true }) } });
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByTestId('combo-pane')).toBeTruthy();
    expect(screen.queryByText(/Legacy result/)).toBeNull();
    expect(screen.queryByText(/Execution on 5m candles/)).toBeNull();
  });

  it('surfaces a replay failure instead of a silent success', async () => {
    handler = (url) => (url === '/api/simulations/sim1/replay'
      ? { status: 409, data: { error: 'refused' } }
      : { data: { simulation: row() } });
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByText('Failed to load replay of the last simulation: refused')).toBeTruthy();
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['invalid replay JSON', () => Promise.resolve({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    } as unknown as Response)],
  ])('surfaces %s on the replay and keeps the saved id', async (_name, replayResponse) => {
    handler = () => ({ data: { simulation: row() } });
    const routed = globalThis.fetch;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      (String(input) === '/api/simulations/sim1/replay' ? replayResponse() : routed(input, init))) as typeof fetch;
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByText(/^Failed to load the last simulation: /)).toBeTruthy();
    expect(localStorage.getItem('lastSimulationId')).toBe('sim1');
  });

  it('a temporary detail error (503) keeps the saved id and shows an error', async () => {
    handler = () => ({ status: 503, data: { error: 'Service Unavailable' } });
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByText('Failed to load the last simulation: Service Unavailable')).toBeTruthy();
    expect(localStorage.getItem('lastSimulationId')).toBe('sim1');
  });

  it('a missing run (404) drops the saved id', async () => {
    handler = () => ({ status: 404, data: { error: 'Simulation not found' } });
    render(<SimulatorPage />);
    await flush();
    expect(localStorage.getItem('lastSimulationId')).toBeNull();
    expect(screen.queryByText(/Failed to load the last simulation/)).toBeNull();
  });

  // Reload finds a running run; the first poll (second detail GET) then fails.
  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['malformed JSON', () => Promise.resolve({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    } as unknown as Response)],
  ])('resumed polling: %s keeps the saved id and shows an error', async (_name, pollResponse) => {
    handler = () => ({ data: { simulation: row({ status: 'running' }) } });
    const routed = globalThis.fetch;
    let details = 0;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      (String(input) === '/api/simulations/sim1' && ++details > 1 ? pollResponse() : routed(input, init))) as typeof fetch;
    render(<SimulatorPage />);
    await flush(1500);
    expect(screen.getByText(/^Lost contact with the running simulation: .*Reload the page to resume waiting\.$/)).toBeTruthy();
    expect(localStorage.getItem('lastSimulationId')).toBe('sim1');
    expect(screen.queryByText('Stop waiting')).toBeNull();
  });

  it('resumed polling: a failed run drops the saved id and shows its error', async () => {
    let details = 0;
    handler = () => ({ data: { simulation: row(++details > 1 ? { status: 'failed', errorMessage: 'Coverage gap' } : { status: 'running' }) } });
    render(<SimulatorPage />);
    await flush(1500);
    expect(screen.getByText('Coverage gap')).toBeTruthy();
    expect(localStorage.getItem('lastSimulationId')).toBeNull();
  });

  it('a run already failed before reload drops the saved id and shows its error', async () => {
    handler = () => ({ data: { simulation: row({ status: 'failed', errorMessage: 'Coverage gap' }) } });
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByText('Coverage gap')).toBeTruthy();
    expect(localStorage.getItem('lastSimulationId')).toBeNull();
  });

  it('legacy 5m row: execution note without the "not on 5m" suffix', async () => {
    handler = (url) => (url === '/api/simulations/sim1/replay'
      ? { data: legacyReplay }
      : { data: { simulation: row({ engineVersion: 0, timeframe: '5m' }) } });
    render(<SimulatorPage />);
    await flush();
    expect(screen.getByText('Legacy run: executed on the selected 5m candles.')).toBeTruthy();
    expect(screen.queryByText(/not on 5m/)).toBeNull();
  });

  it('a late saved replay does not overwrite a run started meanwhile', async () => {
    // Saved sim1 (capital 1000, equity 1005) replay arrives only after the new sim2
    // (capital 2000, equity 2010) has been shown; the headline must stay +$10.00.
    seed('longConfig', gridSide('long'));
    seed('shortConfig', gridSide('short'));
    let releaseOld!: (v: unknown) => void;
    const oldReplay = new Promise(r => { releaseOld = r; });
    handler = (url, method) => {
      if (url === '/api/simulations/sim1/replay') return { data: oldReplay };
      if (url === '/api/simulations' && method === 'POST') return { data: { id: 'sim2' } };
      if (url === '/api/candles') return { data: { count: 6 } };
      if (url === '/api/simulations/sim2/replay') return { data: { ...v1Replay, pnlSnapshots: [{ ...snap, equity: 2010 }] } };
      if (url === '/api/simulations/sim2') return { data: { simulation: row({ id: 'sim2', startingCapital: 2000 }) } };
      return { data: { simulation: row() } };
    };
    await startRun();
    await flush(1500);
    expect(screen.getAllByText('+$10.00').length).toBeGreaterThan(0);
    releaseOld(v1Replay);
    await flush();
    expect(screen.getAllByText('+$10.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/995/)).toBeNull();
    expect(localStorage.getItem('lastSimulationId')).toBe('sim2');
  });

  it('a late saved status JSON does not overwrite a run completed meanwhile', async () => {
    // The saved sim1 detail body (capital 1000) resolves only after sim2 (capital 2000,
    // equity 2010) is shown; the headline must stay +$10.00, not become +$1010.00.
    seed('longConfig', gridSide('long'));
    seed('shortConfig', gridSide('short'));
    let releaseOld!: (v: unknown) => void;
    const oldStatus = new Promise(r => { releaseOld = r; });
    handler = (url, method) => {
      if (url === '/api/simulations/sim1') return { data: oldStatus };
      if (url === '/api/simulations' && method === 'POST') return { data: { id: 'sim2' } };
      if (url === '/api/candles') return { data: { count: 6 } };
      if (url === '/api/simulations/sim2/replay') return { data: { ...v1Replay, pnlSnapshots: [{ ...snap, equity: 2010 }] } };
      return { data: { simulation: row({ id: 'sim2', startingCapital: 2000 }) } };
    };
    await startRun();
    await flush(1500);
    expect(screen.getAllByText('+$10.00').length).toBeGreaterThan(0);
    releaseOld({ simulation: row() });
    await flush();
    expect(screen.getAllByText('+$10.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/1010/)).toBeNull();
    expect(callsTo('/api/simulations/sim1/replay').length).toBe(0);
  });

  it('a late poll JSON with a failed status after unmount keeps the saved id', async () => {
    let detailCalls = 0;
    let releaseOld!: (v: unknown) => void;
    const oldStatus = new Promise(r => { releaseOld = r; });
    handler = () => (++detailCalls === 1
      ? { data: { simulation: row({ status: 'running' }) } }
      : { data: oldStatus });
    const { unmount } = render(<SimulatorPage />);
    await flush(1500);
    expect(detailCalls).toBe(2);
    unmount();
    releaseOld({ simulation: row({ status: 'failed', errorMessage: 'old failure' }) });
    await flush(5000);
    expect(localStorage.getItem('lastSimulationId')).toBe('sim1');
    expect(detailCalls).toBe(2);
  });

  it('a late create response after unmount does not save the id or start polling', async () => {
    // Saved sim3 loads on mount; a new run's create request resolves (sim2) only after
    // the page is gone. The id must stay sim3 and sim2 must never be polled.
    localStorage.setItem('lastSimulationId', 'sim3');
    seed('longConfig', gridSide('long'));
    seed('shortConfig', gridSide('short'));
    let releaseCreate!: (v: unknown) => void;
    const created = new Promise(r => { releaseCreate = r; });
    handler = (url, method) => {
      if (url === '/api/simulations' && method === 'POST') return { data: created };
      if (url === '/api/candles') return { data: { count: 6 } };
      if (url === '/api/simulations/sim3/replay') return { data: new Promise(() => {}) };   // keeps the config panel open
      return { data: { simulation: row({ id: 'sim3' }) } };
    };
    const { unmount } = render(<SimulatorPage />);
    await flush();
    await act(async () => { fireEvent.click(screen.getByText('Run Simulation')); });
    await flush();
    expect(callsTo('/api/simulations', 'POST').length).toBe(1);
    unmount();
    releaseCreate({ id: 'sim2' });
    await flush(5000);
    expect(localStorage.getItem('lastSimulationId')).toBe('sim3');
    expect(callsTo('/api/simulations/sim2').length).toBe(0);
  });

  it('resumed polling stops when the page unmounts', async () => {
    handler = () => ({ data: { simulation: row({ status: 'running' }) } });
    const { unmount } = render(<SimulatorPage />);
    await flush(2500);
    expect(screen.getByText('Stop waiting')).toBeTruthy();
    unmount();
    const before = callsTo('/api/simulations/sim1').length;
    await flush(5000);
    expect(callsTo('/api/simulations/sim1').length).toBe(before);
  });
});
