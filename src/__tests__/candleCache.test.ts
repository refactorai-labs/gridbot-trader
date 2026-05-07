import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OHLC } from '../lib/types';

vi.mock('../lib/prisma', () => ({
  default: {
    binanceCandle: { findMany: vi.fn() },
    $executeRawUnsafe: vi.fn(),
  },
}));

vi.mock('../lib/data/binanceApi', () => ({
  fetchBinanceKlines: vi.fn(),
}));

import prisma from '../lib/prisma';
import { fetchBinanceKlines } from '../lib/data/binanceApi';
import { computeMissingGaps, getOrFetchCandles } from '../lib/data/candleCache';

const findMany = prisma.binanceCandle.findMany as ReturnType<typeof vi.fn>;
const executeRawUnsafe = prisma.$executeRawUnsafe as ReturnType<typeof vi.fn>;
const mockedFetch = fetchBinanceKlines as ReturnType<typeof vi.fn>;

const FIVE_MIN_MS = 5 * 60_000;

// Build an OHLC at a given openTime (ms since epoch).
function ohlc(openTimeMs: number, close = 100): OHLC {
  return {
    timestamp: openTimeMs / 1000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  };
}

// Build a Prisma row shape (what findMany returns) for openTimeMs.
function row(openTimeMs: number, close = 100) {
  return {
    id: openTimeMs,
    pair: 'ETHUSDT',
    openTime: BigInt(openTimeMs),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    interval: '5m',
  };
}

// A reference epoch aligned to a 5m bucket: 2024-01-01T00:00:00Z.
const T0 = Date.UTC(2024, 0, 1);

describe('computeMissingGaps', () => {
  it('returns one gap covering the full range when cache is empty', () => {
    const gaps = computeMissingGaps([], T0, T0 + 4 * FIVE_MIN_MS, FIVE_MIN_MS);
    expect(gaps).toEqual([{ startMs: T0, endMs: T0 + 4 * FIVE_MIN_MS }]);
  });

  it('returns [] when cache fully covers the range', () => {
    const cached = [0, 1, 2, 3].map(i => ohlc(T0 + i * FIVE_MIN_MS));
    const gaps = computeMissingGaps(cached, T0, T0 + 4 * FIVE_MIN_MS, FIVE_MIN_MS);
    expect(gaps).toEqual([]);
  });

  it('detects head-only gap', () => {
    const cached = [2, 3].map(i => ohlc(T0 + i * FIVE_MIN_MS));
    const gaps = computeMissingGaps(cached, T0, T0 + 4 * FIVE_MIN_MS, FIVE_MIN_MS);
    expect(gaps).toEqual([{ startMs: T0, endMs: T0 + 2 * FIVE_MIN_MS }]);
  });

  it('detects tail-only gap', () => {
    const cached = [0, 1].map(i => ohlc(T0 + i * FIVE_MIN_MS));
    const gaps = computeMissingGaps(cached, T0, T0 + 4 * FIVE_MIN_MS, FIVE_MIN_MS);
    expect(gaps).toEqual([{ startMs: T0 + 2 * FIVE_MIN_MS, endMs: T0 + 4 * FIVE_MIN_MS }]);
  });

  it('detects single mid-range gap', () => {
    const cached = [0, 1, 4, 5].map(i => ohlc(T0 + i * FIVE_MIN_MS));
    const gaps = computeMissingGaps(cached, T0, T0 + 6 * FIVE_MIN_MS, FIVE_MIN_MS);
    expect(gaps).toEqual([
      { startMs: T0 + 2 * FIVE_MIN_MS, endMs: T0 + 4 * FIVE_MIN_MS },
    ]);
  });

  it('detects two disjoint gaps', () => {
    const cached = [1, 4].map(i => ohlc(T0 + i * FIVE_MIN_MS));
    const gaps = computeMissingGaps(cached, T0, T0 + 6 * FIVE_MIN_MS, FIVE_MIN_MS);
    expect(gaps).toEqual([
      { startMs: T0, endMs: T0 + FIVE_MIN_MS },
      { startMs: T0 + 2 * FIVE_MIN_MS, endMs: T0 + 4 * FIVE_MIN_MS },
      { startMs: T0 + 5 * FIVE_MIN_MS, endMs: T0 + 6 * FIVE_MIN_MS },
    ]);
  });

  it('snaps off-grid startMs forward via Math.ceil (12:33 -> 12:35)', () => {
    const offGridStart = T0 + 33 * 60_000; // 12:33 if T0 were 12:00
    const gaps = computeMissingGaps([], offGridStart, T0 + 50 * 60_000, FIVE_MIN_MS);
    expect(gaps).toEqual([{ startMs: T0 + 35 * 60_000, endMs: T0 + 45 * 60_000 + FIVE_MIN_MS }]);
  });

  it('snaps off-grid endMs backward via Math.floor((endMs - 1) / tfMs)', () => {
    // endMs at 12:38 — last fully-included bucket is 12:35.
    const gaps = computeMissingGaps([], T0, T0 + 38 * 60_000, FIVE_MIN_MS);
    expect(gaps).toEqual([{ startMs: T0, endMs: T0 + 35 * 60_000 + FIVE_MIN_MS }]);
  });

  it('returns [] for endMs <= startMs', () => {
    expect(computeMissingGaps([], T0 + FIVE_MIN_MS, T0, FIVE_MIN_MS)).toEqual([]);
    expect(computeMissingGaps([], T0, T0, FIVE_MIN_MS)).toEqual([]);
  });

  it('returns [] for sub-bucket ranges that contain no whole bucket', () => {
    // Range narrower than a single bucket and not aligned: no expected bucket inside.
    expect(computeMissingGaps([], T0 + 1, T0 + FIVE_MIN_MS - 1, FIVE_MIN_MS)).toEqual([]);
  });
});

describe('getOrFetchCandles', () => {
  beforeEach(() => {
    findMany.mockReset();
    executeRawUnsafe.mockReset();
    mockedFetch.mockReset();
    executeRawUnsafe.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached when range is fully covered; never calls Binance', async () => {
    const rows = [0, 1, 2, 3].map(i => row(T0 + i * FIVE_MIN_MS));
    findMany.mockResolvedValueOnce(rows);

    const start = new Date(T0);
    const end = new Date(T0 + 4 * FIVE_MIN_MS);
    const result = await getOrFetchCandles('ETHUSDT', '5m', start, end);

    expect(result).toHaveLength(4);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('fetches once over the full range when cache is empty, then re-queries', async () => {
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([0, 1, 2, 3].map(i => row(T0 + i * FIVE_MIN_MS)));
    mockedFetch.mockResolvedValueOnce([0, 1, 2, 3].map(i => ohlc(T0 + i * FIVE_MIN_MS)));

    const result = await getOrFetchCandles(
      'ETHUSDT', '5m',
      new Date(T0), new Date(T0 + 4 * FIVE_MIN_MS)
    );

    expect(result).toHaveLength(4);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(
      'ETHUSDT', '5m', T0, T0 + 4 * FIVE_MIN_MS, undefined
    );
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('fetches only the missing middle hole, not the whole range', async () => {
    const initial = [0, 1, 4, 5].map(i => row(T0 + i * FIVE_MIN_MS));
    const final = [0, 1, 2, 3, 4, 5].map(i => row(T0 + i * FIVE_MIN_MS));
    findMany.mockResolvedValueOnce(initial).mockResolvedValueOnce(final);
    mockedFetch.mockResolvedValueOnce([2, 3].map(i => ohlc(T0 + i * FIVE_MIN_MS)));

    const result = await getOrFetchCandles(
      'ETHUSDT', '5m',
      new Date(T0), new Date(T0 + 6 * FIVE_MIN_MS)
    );

    expect(result).toHaveLength(6);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(
      'ETHUSDT', '5m',
      T0 + 2 * FIVE_MIN_MS, T0 + 4 * FIVE_MIN_MS,
      undefined,
    );
  });

  it('fetches each gap separately when there are head + tail holes', async () => {
    const initial = [2, 3].map(i => row(T0 + i * FIVE_MIN_MS)); // missing head [0,1] and tail [4,5]
    const final = [0, 1, 2, 3, 4, 5].map(i => row(T0 + i * FIVE_MIN_MS));
    findMany.mockResolvedValueOnce(initial).mockResolvedValueOnce(final);
    mockedFetch
      .mockResolvedValueOnce([0, 1].map(i => ohlc(T0 + i * FIVE_MIN_MS)))
      .mockResolvedValueOnce([4, 5].map(i => ohlc(T0 + i * FIVE_MIN_MS)));

    const result = await getOrFetchCandles(
      'ETHUSDT', '5m',
      new Date(T0), new Date(T0 + 6 * FIVE_MIN_MS)
    );

    expect(result).toHaveLength(6);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch.mock.calls[0]).toEqual([
      'ETHUSDT', '5m', T0, T0 + 2 * FIVE_MIN_MS, undefined,
    ]);
    expect(mockedFetch.mock.calls[1]).toEqual([
      'ETHUSDT', '5m', T0 + 4 * FIVE_MIN_MS, T0 + 6 * FIVE_MIN_MS, undefined,
    ]);
  });

  it('throws ISO-formatted error when Binance returns nothing for a gap', async () => {
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mockedFetch.mockResolvedValueOnce([]); // Binance has nothing for this range

    const start = new Date(T0);
    const end = new Date(T0 + 4 * FIVE_MIN_MS);

    let caught: Error | null = null;
    try {
      await getOrFetchCandles('ETHUSDT', '5m', start, end);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/Unable to fetch ETHUSDT 5m candles for \[/);
    expect(caught!.message).toContain(start.toISOString());
    expect(caught!.message).toContain(end.toISOString());
  });

  it('returns [] for malformed ranges (endTime <= startTime) without calling Binance', async () => {
    findMany.mockResolvedValueOnce([]);

    const result = await getOrFetchCandles(
      'ETHUSDT', '5m',
      new Date(T0 + FIVE_MIN_MS), new Date(T0)
    );

    expect(result).toEqual([]);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
