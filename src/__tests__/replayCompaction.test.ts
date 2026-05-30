import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OHLC } from '../lib/types';

// Mock prisma + candle-cache BEFORE importing the route handler. The replay route
// is a Next.js GET handler, so we drive it with a fake NextRequest and inspect the
// JSON response. We never go through Next's runtime — the imports below are pure
// modules and behave deterministically under vitest.

vi.mock('../lib/prisma', () => ({
  default: {
    simulation: { findUnique: vi.fn() },
    gridOrder: { findMany: vi.fn() },
    pnlSnapshot: { findMany: vi.fn() },
    adaptiveEvent: { findMany: vi.fn() },
  },
}));

vi.mock('../lib/data/candleCache', () => ({
  getCachedCandles: vi.fn(),
  // Engine-side helper: 1h → 60 etc. Not exercised by combo (always 5m) but the
  // route imports it, so we provide a thin shim.
  getTimeframeMinutes: (tf: string) => {
    if (tf === '5m') return 5;
    if (tf === '15m') return 15;
    if (tf === '1h') return 60;
    if (tf === '4h') return 240;
    return 5;
  },
}));

import prisma from '../lib/prisma';
import { getCachedCandles } from '../lib/data/candleCache';
import { GET } from '../app/api/simulations/[id]/replay/route';

const findUniqueSim = prisma.simulation.findUnique as ReturnType<typeof vi.fn>;
const findManyOrders = prisma.gridOrder.findMany as ReturnType<typeof vi.fn>;
const findManySnapshots = prisma.pnlSnapshot.findMany as ReturnType<typeof vi.fn>;
const findManyEvents = prisma.adaptiveEvent.findMany as ReturnType<typeof vi.fn>;
const mockedGetCachedCandles = getCachedCandles as ReturnType<typeof vi.fn>;

const SIM_ID = 'test-sim';
const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2026-05-11T00:00:00Z');
const FIVE_MIN_S = 5 * 60;

function ohlc(ts: number, close: number = 100): OHLC {
  return { timestamp: ts, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

function makeCandles(count: number): OHLC[] {
  return Array.from({ length: count }, (_, i) => ohlc(1_735_689_600 + i * FIVE_MIN_S, 100 + (i % 50)));
}

function baseSimRow(extra: Record<string, unknown> = {}) {
  return {
    id: SIM_ID,
    pair: 'WETH/USDC',
    timeframe: '5m',
    status: 'completed',
    startTime: START,
    endTime: END,
    comboBotEnabled: true,
    poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    gridConfigs: [],
    avwapAnchor: null,
    ...extra,
  };
}

function makeRequest(query = ''): Request {
  return new Request(`http://localhost/api/simulations/${SIM_ID}/replay${query}`);
}

async function callGET(query = '') {
  // Cast — the handler accepts a NextRequest at runtime but a Request works in tests.
  const res = await GET(makeRequest(query) as unknown as Parameters<typeof GET>[0], {
    params: { id: SIM_ID },
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  findUniqueSim.mockReset();
  findManyOrders.mockReset();
  findManySnapshots.mockReset();
  findManyEvents.mockReset();
  mockedGetCachedCandles.mockReset();
  findManyOrders.mockResolvedValue([]);
  findManySnapshots.mockResolvedValue([]);
  findManyEvents.mockResolvedValue([]);
});

describe('replay route — chart aggregation', () => {
  it('aggregates long 5m sims down to ≤ MAX_CHART_CANDLES buckets', async () => {
    const candleCount = 36_852; // failing-sim size
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(candleCount));

    const { status, body } = await callGET();

    expect(status).toBe(200);
    expect(body.candles.length).toBeLessThanOrEqual(3000);
    expect(body.candles.length).toBeGreaterThan(0);
    // For 36,852 candles, raw factor = ceil(36852/3000) = 13 → snaps to 48 → 4h.
    expect(body.chartTimeframeMins).toBe(240);
  });

  it('skips aggregation when candle count is below the cap', async () => {
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(2_000));

    const { body } = await callGET();
    expect(body.candles.length).toBe(2_000);
    expect(body.chartTimeframeMins).toBe(5);
  });

  it('exposes totalCandles equal to slicedCandles.length', async () => {
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(36_852));

    const { body } = await callGET();
    expect(body.totalCandles).toBe(body.candles.length);
  });
});

describe('replay route — reopen_check_failed compaction', () => {
  it('collapses tens of thousands of diagnostic events to ≤ buckets × sides', async () => {
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(36_852));

    // Build 66,749 reopen_check_failed events, alternating sides — mimics the
    // failing-sim distribution. Each event has a unique original candleIdx, so
    // the post-aggregation bucket index is dbIdx / 48.
    const failed = [];
    for (let i = 0; i < 66_749; i++) {
      const side = i % 2 === 0 ? 'long' : 'short';
      failed.push({
        candleIdx: i,
        timestamp: new Date(START.getTime() + i * FIVE_MIN_S * 1000),
        eventType: 'reopen_check_failed',
        detailsJson: JSON.stringify({ side, snapshot: { price: 3000 + (i % 100) }, reopenDiagnostics: { atrRatioOk: false } }),
        longMultiplier: null,
        shortMultiplier: null,
      });
    }
    findManyEvents.mockResolvedValue(failed);

    const { body } = await callGET();

    // 36,852 5m candles → factor 48 → 768 chart buckets × 2 sides = 1,536 max.
    const chartBuckets = body.candles.length;
    expect(body.adaptiveEvents.length).toBeLessThanOrEqual(chartBuckets * 2);
    expect(body.adaptiveEvents.length).toBeGreaterThan(0);
    // Per (slicedIdx, side) bucket: at most one event.
    const seen = new Set<string>();
    for (const ev of body.adaptiveEvents) {
      const d = JSON.parse(ev.detailsJson);
      const key = `${ev.candleIdx}|${d.side}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Of 66,749 input events, those with dbIdx > 36,815 spill past slicedMax (dropped
    // to droppedOutOfRange); the remainder collapse into ≤ 1,536 buckets and the rest
    // increment droppedFailedChecks. Combined, well over 60k must be dropped.
    const totalDropped = body._compactionStats.droppedFailedChecks + body._compactionStats.droppedOutOfRange;
    expect(totalDropped).toBeGreaterThan(60_000);
  });

  it('keeps the LATEST DB row per (slicedIdx, side) bucket', async () => {
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(36_852));

    // Two long-side rows that land in the same chart bucket (idx 0 and idx 47
    // both → bucket 0 at factor 48). The idx=47 row carries a distinctive price
    // we can assert on.
    findManyEvents.mockResolvedValue([
      {
        candleIdx: 0,
        timestamp: new Date(START),
        eventType: 'reopen_check_failed',
        detailsJson: JSON.stringify({ side: 'long', snapshot: { price: 1000 } }),
        longMultiplier: null,
        shortMultiplier: null,
      },
      {
        candleIdx: 47,
        timestamp: new Date(START.getTime() + 47 * FIVE_MIN_S * 1000),
        eventType: 'reopen_check_failed',
        detailsJson: JSON.stringify({ side: 'long', snapshot: { price: 9999 } }),
        longMultiplier: null,
        shortMultiplier: null,
      },
    ]);

    const { body } = await callGET();
    const survivors = body.adaptiveEvents.filter((e: { eventType: string }) => e.eventType === 'reopen_check_failed');
    expect(survivors.length).toBe(1);
    const details = JSON.parse(survivors[0].detailsJson);
    expect(details.snapshot.price).toBe(9999);
  });
});

describe('replay route — structural events', () => {
  it('preserves all 11 structural event types and sorts by sliced candleIdx', async () => {
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(36_852));

    // Plant one of each structural type, plus one reopen_check_failed to confirm
    // it does NOT pollute the structural pass-through.
    const types = [
      'breakout_entered', 'position_opened', 'sl_triggered', 'cooldown_entered',
      'tier1_reopen', 'tier2_scale', 'tier3_scale', 'cycle_complete',
      'hibernation_entered', 'hibernation_exit', 'retry_incremented',
    ];
    findManyEvents.mockResolvedValue([
      ...types.map((t, i) => ({
        candleIdx: i * 200, // distinct buckets
        timestamp: new Date(START.getTime() + i * FIVE_MIN_S * 1000),
        eventType: t,
        detailsJson: JSON.stringify({ side: 'long' }),
        longMultiplier: null,
        shortMultiplier: null,
      })),
      {
        candleIdx: 5000,
        timestamp: new Date(START),
        eventType: 'reopen_check_failed',
        detailsJson: JSON.stringify({ side: 'long' }),
        longMultiplier: null,
        shortMultiplier: null,
      },
    ]);

    const { body } = await callGET();
    const emittedTypes = body.adaptiveEvents.map((e: { eventType: string }) => e.eventType);
    for (const t of types) {
      expect(emittedTypes).toContain(t);
    }
    // Sorted ascending by sliced candleIdx.
    const idxs = body.adaptiveEvents.map((e: { candleIdx: number }) => e.candleIdx);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
  });
});

describe('replay route — from/to slicing', () => {
  it('returns zero-based candleIdx values against the sliced array', async () => {
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(36_852));

    // factor=48 → chart bucket size 48. We request DB-space [4800, 9600) →
    // chart [100, 200) → sliced 0..99. Events at dbIdx 4800, 5040 (=bucket 105),
    // 9550 (=bucket 198) should remap to sliced 0, 5, 98.
    findManyEvents.mockResolvedValue([
      { candleIdx: 4800, timestamp: new Date(START), eventType: 'breakout_entered', detailsJson: '{"side":"long"}', longMultiplier: null, shortMultiplier: null },
      { candleIdx: 5040, timestamp: new Date(START), eventType: 'position_opened', detailsJson: '{"side":"long"}', longMultiplier: null, shortMultiplier: null },
      { candleIdx: 9550, timestamp: new Date(START), eventType: 'sl_triggered',    detailsJson: '{"side":"long"}', longMultiplier: null, shortMultiplier: null },
      // Out of range — should be dropped.
      { candleIdx: 10000, timestamp: new Date(START), eventType: 'breakout_entered', detailsJson: '{"side":"long"}', longMultiplier: null, shortMultiplier: null },
    ]);

    const { body } = await callGET('?from=4800&to=9600');

    const idxs = body.adaptiveEvents.map((e: { candleIdx: number }) => e.candleIdx);
    expect(idxs).toEqual([0, 5, 98]);
    // OOR row dropped:
    expect(body.adaptiveEvents.length).toBe(3);
    // totalCandles matches sliced length, not chart length. The inclusive
    // [chartFrom=100, chartTo=200] slice gives 101 candles.
    expect(body.totalCandles).toBe(body.candles.length);
    expect(body.totalCandles).toBe(101);
  });
});

describe('replay route — payload size sanity (failing-sim repro)', () => {
  it('shrinks the failing-sim payload from ~66k events to ≤ ~1.5k', async () => {
    findUniqueSim.mockResolvedValue(baseSimRow());
    mockedGetCachedCandles.mockResolvedValue(makeCandles(36_852));

    const failed = Array.from({ length: 66_749 }, (_, i) => ({
      candleIdx: i,
      timestamp: new Date(START),
      eventType: 'reopen_check_failed',
      detailsJson: JSON.stringify({ side: i % 2 === 0 ? 'long' : 'short' }),
      longMultiplier: null,
      shortMultiplier: null,
    }));
    findManyEvents.mockResolvedValue(failed);

    const { body } = await callGET();
    // Was 66,749 → after compaction at most 2 × ~768 = 1,536.
    expect(body.adaptiveEvents.length).toBeLessThanOrEqual(2000);
  });
});
