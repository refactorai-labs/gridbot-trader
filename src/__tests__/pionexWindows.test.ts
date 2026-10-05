import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OHLC } from '../lib/types';

// In-memory funding cache with INSERT OR IGNORE on (symbol, fundingTime), like SQLite.
const fundingStore = new Map<number, number>();

vi.mock('../lib/prisma', () => ({ default: {} }));
vi.mock('../lib/data/fetch', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../lib/data/fundingCache', () => ({
  getCachedFundingRates: vi.fn(async (_s: string, start: Date, end: Date) =>
    [...fundingStore.entries()]
      .filter(([t]) => t >= start.getTime() && t <= end.getTime())
      .sort((a, b) => a[0] - b[0])
      .map(([t, r]) => ({ fundingTimeSec: t / 1000, fundingRate: r }))
  ),
  storeFundingRates: vi.fn(async (_s: string, rows: { fundingTime: number; fundingRate: number }[]) => {
    for (const r of rows) if (!fundingStore.has(r.fundingTime)) fundingStore.set(r.fundingTime, r.fundingRate);
    return rows.length;
  }),
}));
vi.mock('../lib/data/candleCache', async importActual => ({
  ...(await importActual<typeof import('../lib/data/candleCache')>()),
  getOrFetchCandles: vi.fn(),
  getCachedCandles: vi.fn(),
}));
vi.mock('../lib/data/markPrice', () => ({ getOrFetchMarkCandles: vi.fn() }));

import { fetchWithTimeout } from '../lib/data/fetch';
import { getOrFetchCandles, getCachedCandles } from '../lib/data/candleCache';
import { getOrFetchMarkCandles } from '../lib/data/markPrice';
import { loadFundingStrict } from '../lib/pionex/funding';
import { loadWindow } from '../lib/data/windows';
import { getFullHistory1h, topDrawdowns } from '../lib/pionex/drawdowns';

const mockedFetch = fetchWithTimeout as ReturnType<typeof vi.fn>;
const mockedCandles = getOrFetchCandles as ReturnType<typeof vi.fn>;
const mockedCached = getCachedCandles as ReturnType<typeof vi.fn>;
const mockedMark = getOrFetchMarkCandles as ReturnType<typeof vi.fn>;

const H = 3_600_000;
const T0 = Date.UTC(2022, 10, 10); // a settlement minute

const apiRows = (times: number[]) => times.map(t => ({ symbol: 'SOLUSDT', fundingTime: t, fundingRate: '0.0001' }));
const okResponse = (data: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => data });
const bar = (sec: number, p = 1): OHLC => ({ timestamp: sec, open: p, high: p, low: p, close: p, volume: 0 });
const minutes = (startMs: number, endMs: number): OHLC[] => {
  const out: OHLC[] = [];
  for (let t = startMs; t < endMs; t += 60_000) out.push(bar(t / 1000));
  return out;
};

beforeEach(() => {
  fundingStore.clear();
  mockedFetch.mockReset();
  mockedCandles.mockReset();
  mockedCached.mockReset();
  mockedMark.mockReset();
});

describe('pionex funding — reconciled with Binance (review F1/F2/F6)', () => {
  it('a short window on an empty cache is fetched, not silently "covered"', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse(apiRows([T0 + 2])));
    const r = await loadFundingStrict('SOLUSDT', T0, T0 + H);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(r.records).toEqual([{ fundingTimeMs: T0 + 2, rate: 0.0001 }]);
    expect(r.gaps).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('a missing first settlement is filled from the API even though spacing looked fine', async () => {
    fundingStore.set(T0 + 8 * H, 0.0001);
    mockedFetch.mockResolvedValueOnce(okResponse(apiRows([T0, T0 + 8 * H])));
    const r = await loadFundingStrict('SOLUSDT', T0 - H, T0 + 9 * H);
    expect(r.records.map(x => x.fundingTimeMs)).toEqual([T0, T0 + 8 * H]);
    expect(r.gaps).toEqual([]);
  });

  it('a skipped settlement on a 4h schedule is filled from the API', async () => {
    const times = [0, 4, 8, 12, 16, 20].map(h => T0 + h * H);
    for (const t of times) if (t !== T0 + 8 * H) fundingStore.set(t, 0.0001);
    mockedFetch.mockResolvedValueOnce(okResponse(apiRows(times)));
    const r = await loadFundingStrict('SOLUSDT', T0, T0 + 24 * H);
    expect(r.records.length).toBe(6);
  });

  it('a network/API failure returns the cache with a whole-window gap and the reason', async () => {
    fundingStore.set(T0, 0.0001);
    mockedFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const r = await loadFundingStrict('SOLUSDT', T0, T0 + 4 * H);
    expect(r.records.length).toBe(1);
    expect(r.gaps).toEqual([{ startMs: T0, endMs: T0 + 4 * H }]);
    expect(r.error).toMatch(/ECONNRESET/);

    mockedFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });
    expect((await loadFundingStrict('SOLUSDT', T0, T0 + 4 * H)).error).toMatch(/503/);
  });

  it('an invalid settlement from the API is a data error, not a gap', async () => {
    mockedFetch.mockResolvedValueOnce(okResponse([{ fundingTime: T0, fundingRate: '' }]));
    await expect(loadFundingStrict('SOLUSDT', T0, T0 + H)).rejects.toThrow(/Funding data error/);
  });

  it('a cached settlement Binance does not have is a data error', async () => {
    fundingStore.set(T0 + 4 * H, 0.0001);
    mockedFetch.mockResolvedValueOnce(okResponse(apiRows([T0])));
    await expect(loadFundingStrict('SOLUSDT', T0, T0 + 8 * H)).rejects.toThrow(/cache holds 2 settlements.*Binance 1/);
  });
});

describe('pionex loadWindow (review F2/F6)', () => {
  const start = T0;
  const end = T0 + 2 * H;

  it('a duplicate funding bucket stops the load', async () => {
    mockedCandles.mockResolvedValue(minutes(start, end));
    mockedMark.mockResolvedValue(minutes(start, end));
    fundingStore.set(T0 + 1, 0.0001);
    mockedFetch.mockResolvedValueOnce(okResponse(apiRows([T0 + 3])));
    await expect(loadWindow('SOLUSDT', start, end)).rejects.toThrow(/two settlements/);
  });

  it('a funding fetch failure keeps the candle coverage and reports data-incomplete with the reason', async () => {
    mockedCandles.mockResolvedValue(minutes(start, end));
    mockedMark.mockResolvedValue(minutes(start, end));
    fundingStore.set(T0, 0.0001);
    mockedFetch.mockRejectedValueOnce(new Error('timeout'));
    const w = await loadWindow('SOLUSDT', start, end);
    expect(w.report.last.gaps).toEqual([]);
    expect(w.report.mark.gaps).toEqual([]);
    expect(w.report.funding.gaps.length).toBe(1);
    expect(w.report.errors).toEqual([expect.stringMatching(/^funding: .*timeout/)]);
    expect(w.report.complete).toBe(false);
  });

  it('a candle fetch failure becomes a reported gap with its reason; a database error propagates', async () => {
    mockedCandles.mockRejectedValueOnce(new Error('Binance API error: 418'));
    mockedCached.mockResolvedValueOnce(minutes(start, start + H));
    mockedMark.mockResolvedValue(minutes(start, end));
    mockedFetch.mockResolvedValueOnce(okResponse(apiRows([T0])));
    const w = await loadWindow('SOLUSDT', start, end);
    expect(w.report.last.gaps).toEqual([{ startMs: start + H, endMs: end, minutes: 60 }]);
    expect(w.report.errors).toEqual(['SOLUSDTPERP: Binance API error: 418']);
    expect(w.report.complete).toBe(false);

    const dbError = Object.assign(new Error('disk I/O'), { name: 'PrismaClientUnknownRequestError' });
    mockedCandles.mockRejectedValueOnce(dbError);
    await expect(loadWindow('SOLUSDT', start, end)).rejects.toThrow('disk I/O');
  });
});

describe('pionex 1h history and drawdowns (review F4)', () => {
  const listing = Date.UTC(2020, 8, 14, 7); // SOLUSDT first 1h futures bar
  const hours = (from: number, count: number) => Array.from({ length: count }, (_, i) => bar(from / 1000 + i * 3600));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(listing + 48 * H + 30 * 60_000);
  });
  afterEach(() => vi.useRealTimers());

  it('starts at the real listing bar, so a full history has no gaps', async () => {
    mockedCandles.mockResolvedValueOnce(hours(listing, 48));
    const h = await getFullHistory1h('SOLUSDT');
    expect(mockedCandles.mock.calls[0][2]).toEqual(new Date(listing));
    expect(h.gaps).toEqual([]);
    expect(h.error).toBeNull();
  });

  it('a failed fetch reports the residual gaps and the reason instead of passing as full history', async () => {
    mockedCandles.mockRejectedValueOnce(new Error('Unable to fetch'));
    mockedCached.mockResolvedValueOnce(hours(listing, 40));
    const h = await getFullHistory1h('SOLUSDT');
    expect(h.error).toBe('Unable to fetch');
    expect(h.gaps).toEqual([{ startMs: listing + 40 * H, endMs: listing + 48 * H }]);
  });

  it('lookback is measured in time: bars 100 days apart are not one 30-day episode', () => {
    const split = [bar(0, 100), bar(100 * 86_400, 50)];
    expect(topDrawdowns(split, 5, 30)).toEqual([]);
  });
});
