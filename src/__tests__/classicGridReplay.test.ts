import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OHLC } from '../lib/types';

// Classic engine v1 replay (plan v4, Contract D). Same mocking pattern as
// replayCompaction.test.ts: prisma + candle cache mocked, GET driven directly.

vi.mock('../lib/prisma', () => ({
  default: {
    simulation: { findUnique: vi.fn() },
    gridOrder: { findMany: vi.fn() },
    pnlSnapshot: { findMany: vi.fn() },
    adaptiveEvent: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock('../lib/data/candleCache', () => ({
  getCachedCandles: vi.fn(),
  getTimeframeMinutes: (tf: string) => ({ '5m': 5, '15m': 15, '1h': 60, '4h': 240 } as Record<string, number>)[tf] ?? 60,
}));

import prisma from '../lib/prisma';
import { getCachedCandles } from '../lib/data/candleCache';
import { GET } from '../app/api/simulations/[id]/replay/route';
import { DIAGNOSTIC_EVENT_TYPES } from '../lib/simulation/classicGridTypes';

const findUniqueSim = prisma.simulation.findUnique as ReturnType<typeof vi.fn>;
const findManyOrders = prisma.gridOrder.findMany as ReturnType<typeof vi.fn>;
const findManySnapshots = prisma.pnlSnapshot.findMany as ReturnType<typeof vi.fn>;
const findManyEvents = prisma.adaptiveEvent.findMany as ReturnType<typeof vi.fn>;
const countEvents = prisma.adaptiveEvent.count as ReturnType<typeof vi.fn>;
const mockedGetCachedCandles = getCachedCandles as ReturnType<typeof vi.fn>;

const SIM_ID = 'v1-sim';
const DAY0 = Date.UTC(2026, 0, 1) / 1000; // 2026-01-01 00:00 UTC, seconds
const FIVE = 300;

function makeCandles(startSec: number, count: number): OHLC[] {
  return Array.from({ length: count }, (_, i) => {
    const p = 2000 + (i % 40);
    return { timestamp: startSec + i * FIVE, open: p, high: p + 2, low: p - 2, close: p + 1, volume: 5 };
  });
}

function gridConfig(side: 'long' | 'short', extra: Record<string, unknown> = {}) {
  return { side, enabled: true, lowerBound: 1900, upperBound: 2100, gridLevels: 5, gridType: 'arithmetic', totalCapital: 1000, ...extra };
}

function v1Row(candles: OHLC[], extra: Record<string, unknown> = {}) {
  return {
    id: SIM_ID,
    pair: 'ETHUSDT',
    poolAddress: 'none',
    timeframe: '5m',
    status: 'completed',
    startTime: new Date(candles[0].timestamp * 1000 - 60_000),
    endTime: new Date((candles[candles.length - 1].timestamp + FIVE) * 1000 + 60_000),
    effectiveStartTime: new Date(candles[0].timestamp * 1000),
    effectiveEndTime: new Date((candles[candles.length - 1].timestamp + FIVE) * 1000),
    comboBotEnabled: false,
    engineVersion: 1,
    gridConfigs: [gridConfig('long'), gridConfig('short')],
    avwapAnchor: null,
    ...extra,
  };
}

function snapshotAt(candleIdx: number, tsSec: number, equity = 2000) {
  return {
    candleIdx, timestamp: new Date(tsSec * 1000), price: 2000, equity,
    realizedPnl: 0, unrealizedPnl: 0, longRealizedPnl: 0, shortRealizedPnl: 0,
    longUnrealizedPnl: 0, shortUnrealizedPnl: 0, longEquity: 1000, shortEquity: 1000,
    longOrdersActive: 2, shortOrdersActive: 2, longFillCount: 0, shortFillCount: 0,
  };
}

function fillAt(fillSeq: number, candleIdx: number, tsSec: number, extra: Record<string, unknown> = {}) {
  return {
    id: `o${fillSeq}`, side: 'long', level: 1, levelPrice: 1950, orderType: 'buy', status: 'filled',
    fillPrice: 1950, fillTime: new Date(tsSec * 1000), fillCandleIdx: candleIdx, pnl: null,
    quantity: 0.05, positionId: 'long-1-0', role: 'entry', fillSeq, fees: 0.078, ...extra,
  };
}

function eventAt(candleIdx: number, tsSec: number, eventType: string, details: Record<string, unknown> = {}) {
  return {
    id: `e${candleIdx}-${eventType}-${JSON.stringify(details)}`,
    candleIdx, timestamp: new Date(tsSec * 1000), eventType,
    detailsJson: JSON.stringify({ side: 'long', ...details }),
    longMultiplier: 1, shortMultiplier: 1,
  };
}

// Mocked event store that honours the eventType in/notIn filter, so the tests
// prove the route itself keeps diagnostics out of the payload.
function useEventStore(rows: ReturnType<typeof eventAt>[]) {
  type Where = { eventType?: { in?: string[]; notIn?: string[] } };
  const match = (where: Where) => (r: { eventType: string }) =>
    (!where.eventType?.in || where.eventType.in.includes(r.eventType)) &&
    (!where.eventType?.notIn || !where.eventType.notIn.includes(r.eventType));
  findManyEvents.mockImplementation(async ({ where }: { where: Where }) => rows.filter(match(where)));
  countEvents.mockImplementation(async ({ where }: { where: Where }) => rows.filter(match(where)).length);
}

// Mirrors checkReplayPayload in src/app/page.tsx (kept unchanged there).
function passesPageGuard(body: { candles: unknown[]; adaptiveEvents: unknown[] }) {
  return body.candles.length <= 3000 && body.adaptiveEvents.length <= 5000;
}

async function callGET(query = '') {
  const req = new Request(`http://localhost/api/simulations/${SIM_ID}/replay${query}`);
  const res = await GET(req as unknown as Parameters<typeof GET>[0], { params: { id: SIM_ID } });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyOrders.mockResolvedValue([]);
  findManySnapshots.mockResolvedValue([]);
  useEventStore([]);
});

describe('classic v1 replay — buckets and timestamp mapping', () => {
  it('keeps partial buckets and maps rows by timestamp, final snapshot in final bucket', async () => {
    // 1h chart over 30 candles starting 00:35 → buckets 00:00 (5, partial), 01:00 (12),
    // 02:00 (12), 03:00 (1, partial).
    const candles = makeCandles(DAY0 + 35 * 60, 30);
    findUniqueSim.mockResolvedValue(v1Row(candles, { timeframe: '1h' }));
    mockedGetCachedCandles.mockResolvedValue(candles);
    // Fill at 5m index 7 = 01:10 → bucket 1 (an index-based floor(7/12) would give 0).
    findManyOrders.mockResolvedValue([fillAt(0, 7, candles[7].timestamp)]);
    findManySnapshots.mockResolvedValue([
      snapshotAt(0, candles[0].timestamp, 1999),
      snapshotAt(29, candles[29].timestamp, 2042),
    ]);

    const { status, body } = await callGET();
    expect(status).toBe(200);
    expect(body.chartTimeframeMins).toBe(60);
    expect(body.candles.map((c: { complete: boolean }) => c.complete)).toEqual([false, true, true, false]);
    expect(body.candles[0].timestamp).toBe(DAY0);
    expect(body.totalCandles).toBe(4);
    expect(body.gridOrders[0].fillCandleIdx).toBe(1);
    const last = body.pnlSnapshots[body.pnlSnapshots.length - 1];
    expect(last.candleIdx).toBe(body.candles.length - 1);
    expect(last.equity).toBe(2042);
    expect(body.engineVersion).toBe(1);
    expect(body.effectiveStart).toBe(candles[0].timestamp);
    expect(body.effectiveEnd).toBe(candles[29].timestamp + FIVE);
    // Candles were loaded for the effective [start, end) window.
    const [, interval, from, to] = mockedGetCachedCandles.mock.calls[0];
    expect(interval).toBe('5m');
    expect((from as Date).getTime()).toBe(candles[0].timestamp * 1000);
    expect((to as Date).getTime()).toBe((candles[29].timestamp + FIVE) * 1000);
  });

  it('snapshots collapsing into one bucket: last wins', async () => {
    const candles = makeCandles(DAY0, 24);
    findUniqueSim.mockResolvedValue(v1Row(candles, { timeframe: '1h' }));
    mockedGetCachedCandles.mockResolvedValue(candles);
    findManySnapshots.mockResolvedValue([
      snapshotAt(0, candles[0].timestamp, 1),
      snapshotAt(5, candles[5].timestamp, 2),
      snapshotAt(13, candles[13].timestamp, 3),
    ]);
    const { body } = await callGET();
    expect(body.pnlSnapshots.map((s: { candleIdx: number; equity: number }) => [s.candleIdx, s.equity])).toEqual([[0, 2], [1, 3]]);
  });

  it('snaps to the smallest factor whose actual bucket count is ≤ 3000', async () => {
    // Aligned 9,000 × 5m → 15m gives exactly 3,000 buckets.
    const aligned = makeCandles(DAY0, 9000);
    findUniqueSim.mockResolvedValue(v1Row(aligned));
    mockedGetCachedCandles.mockResolvedValue(aligned);
    let { body } = await callGET();
    expect(body.chartTimeframeMins).toBe(15);
    expect(body.candles.length).toBe(3000);

    // Shifted by one 5m candle: 15m would give 3,001 buckets (partial first/last) → 30m.
    const unaligned = makeCandles(DAY0 + FIVE, 9000);
    findUniqueSim.mockResolvedValue(v1Row(unaligned));
    mockedGetCachedCandles.mockResolvedValue(unaligned);
    findManySnapshots.mockResolvedValue([snapshotAt(8999, unaligned[8999].timestamp)]);
    ({ body } = await callGET());
    expect(body.chartTimeframeMins).toBe(30);
    expect(body.candles.length).toBeLessThanOrEqual(3000);
    expect(body.candles[body.candles.length - 1].complete).toBe(false);
    expect(body.pnlSnapshots[0].candleIdx).toBe(body.candles.length - 1);
  });

  it('never goes below the simulation timeframe', async () => {
    const candles = makeCandles(DAY0, 600);
    findUniqueSim.mockResolvedValue(v1Row(candles, { timeframe: '4h' }));
    mockedGetCachedCandles.mockResolvedValue(candles);
    const { body } = await callGET();
    expect(body.chartTimeframeMins).toBe(240);
    expect(body.candles.length).toBe(13); // 600 × 5m = 50h → 12 full 4h buckets + 1 partial
  });
});

describe('classic v1 replay — fills and levels', () => {
  it('orders fills by fillSeq and returns the v1 fill fields', async () => {
    const candles = makeCandles(DAY0, 100);
    findUniqueSim.mockResolvedValue(v1Row(candles));
    mockedGetCachedCandles.mockResolvedValue(candles);
    // Two fills in the same candle: fillSeq decides the order, not fillCandleIdx.
    const rows = [
      fillAt(0, 3, candles[3].timestamp, { role: 'initial' }),
      fillAt(1, 10, candles[10].timestamp),
      fillAt(2, 10, candles[10].timestamp, { orderType: 'sell', role: 'exit', pnl: 1.2, pairedOrderId: 'o1' }),
    ];
    findManyOrders.mockResolvedValue(rows);

    const { body } = await callGET();
    const args = findManyOrders.mock.calls[0][0];
    expect(args.orderBy).toEqual({ fillSeq: 'asc' });
    expect(args.where).toEqual({ simulationId: SIM_ID, fillCandleIdx: { gte: 0, lte: 99 } });
    expect(body.gridOrders.map((o: { fillSeq: number }) => o.fillSeq)).toEqual([0, 1, 2]);
    expect(body.gridOrders[2]).toEqual({
      id: 'o2', side: 'long', level: 1, levelPrice: 1950, orderType: 'sell', status: 'filled',
      fillPrice: 1950, fillCandleIdx: 10, pnl: 1.2, quantity: 0.05, positionId: 'long-1-0',
      role: 'exit', fillSeq: 2, fillTime: candles[10].timestamp, fees: 0.078,
    });
  });

  it('returns empty levels for a disabled side', async () => {
    const candles = makeCandles(DAY0, 100);
    findUniqueSim.mockResolvedValue(v1Row(candles, {
      gridConfigs: [gridConfig('long'), gridConfig('short', { enabled: false })],
    }));
    mockedGetCachedCandles.mockResolvedValue(candles);
    const { body } = await callGET();
    expect(body.longLevels).toHaveLength(5);
    expect(body.shortLevels).toEqual([]);
  });

  it('applies from/to as 5m DB indexes', async () => {
    const candles = makeCandles(DAY0, 100);
    findUniqueSim.mockResolvedValue(v1Row(candles));
    mockedGetCachedCandles.mockResolvedValue(candles);
    findManyOrders.mockResolvedValue([fillAt(0, 25, candles[25].timestamp)]);
    const { body } = await callGET('?from=20&to=39');
    expect(findManyOrders.mock.calls[0][0].where.fillCandleIdx).toEqual({ gte: 20, lte: 39 });
    expect(findManyEvents.mock.calls[0][0].where.candleIdx).toEqual({ gte: 20, lte: 39 });
    expect(body.candles).toHaveLength(20);
    expect(body.gridOrders[0].fillCandleIdx).toBe(5);
  });
});

describe('classic v1 replay — legacy rows keep the v0 path', () => {
  it('classic engineVersion 0 row: index-based aggregation, no v1 fields', async () => {
    const candles = makeCandles(DAY0 + 35 * 60, 30);
    findUniqueSim.mockResolvedValue(v1Row(candles, { timeframe: '1h', engineVersion: 0, startTime: new Date(DAY0 * 1000), endTime: new Date((DAY0 + 4 * 3600) * 1000) }));
    mockedGetCachedCandles.mockResolvedValue(candles);
    const { body } = await callGET();
    expect(body.engineVersion).toBeUndefined();
    expect(body.diagnosticEventCount).toBeUndefined();
    expect(countEvents).not.toHaveBeenCalled();
    expect(findManyEvents.mock.calls[0][0].where.eventType).toBeUndefined();
    expect(findManyOrders.mock.calls[0][0].orderBy).toEqual({ fillCandleIdx: 'asc' });
    // aggregate5mTo drops the 6-candle tail: 30 → 2 full hourly candles.
    expect(body.candles).toHaveLength(2);
    // v0 loads candles for the raw window.
    expect((mockedGetCachedCandles.mock.calls[0][2] as Date).getTime()).toBe(DAY0 * 1000);
  });

  it('Combo row keeps the v0 path even with engineVersion ≥ 1', async () => {
    const candles = makeCandles(DAY0, 100);
    findUniqueSim.mockResolvedValue(v1Row(candles, { comboBotEnabled: true }));
    mockedGetCachedCandles.mockResolvedValue(candles);
    const { body } = await callGET();
    expect(body.engineVersion).toBeUndefined();
    expect(countEvents).not.toHaveBeenCalled();
  });
});

describe('classic v1 replay — event payload', () => {
  const N = 36_000; // 125 days of 5m → 1h chart, 3,000 buckets

  it('6,000 diagnostics + 10 state events → exactly the 10 state events', async () => {
    const candles = makeCandles(DAY0, N);
    findUniqueSim.mockResolvedValue(v1Row(candles));
    mockedGetCachedCandles.mockResolvedValue(candles);
    const diagnostics = Array.from({ length: 6000 }, (_, i) => {
      const idx = i * 5;
      return eventAt(idx, candles[idx].timestamp, i % 2 ? 'entry_skipped' : 'restoration_entry', { slotIndex: i });
    });
    const state = Array.from({ length: 10 }, (_, i) => {
      const idx = 1000 + i * 3000;
      return eventAt(idx, candles[idx].timestamp, 'trend_change', { n: i });
    });
    useEventStore([...diagnostics, ...state].sort((a, b) => a.candleIdx - b.candleIdx));
    const fills = Array.from({ length: 50 }, (_, i) => fillAt(i, i * 700, candles[i * 700].timestamp));
    findManyOrders.mockResolvedValue(fills);

    const { status, body } = await callGET();
    expect(status).toBe(200);

    const eventArgs = findManyEvents.mock.calls[0][0];
    expect(eventArgs.where.eventType).toEqual({ notIn: [...DIAGNOSTIC_EVENT_TYPES] });
    expect(eventArgs.orderBy).toEqual([{ candleIdx: 'asc' }, { id: 'asc' }]);
    expect(countEvents).toHaveBeenCalledTimes(1);
    expect(countEvents.mock.calls[0][0].where.eventType).toEqual({ in: [...DIAGNOSTIC_EVENT_TYPES] });

    expect(body.adaptiveEvents).toHaveLength(10);
    expect(body.adaptiveEvents.every((e: { eventType: string }) => e.eventType === 'trend_change')).toBe(true);
    expect(body.adaptiveEvents.map((e: { candleIdx: number }) => e.candleIdx)).toEqual(
      state.map(s => Math.floor(s.candleIdx / 12)),
    );
    expect(body.diagnosticEventCount).toBe(6000);
    expect(body._compactionStats.compactedStateEvents).toBe(0);
    expect(body.gridOrders).toHaveLength(50);
    expect(body.candles.length).toBeLessThanOrEqual(3000);
    expect(passesPageGuard(body)).toBe(true);
  });

  it('5,001 state events → ≤ 3,000 rows, latest per bucket preserved', async () => {
    const candles = makeCandles(DAY0, N);
    findUniqueSim.mockResolvedValue(v1Row(candles));
    mockedGetCachedCandles.mockResolvedValue(candles);
    const state = Array.from({ length: 5001 }, (_, i) => {
      const idx = i * 7;
      return eventAt(idx, candles[idx].timestamp, i % 2 ? 'de_risk' : 'trend_change', { n: i });
    });
    useEventStore(state);

    const { body } = await callGET();
    expect(body.chartTimeframeMins).toBe(60);
    expect(body.adaptiveEvents.length).toBeLessThanOrEqual(3000);
    expect(passesPageGuard(body)).toBe(true);

    // Expected: the last input row per 1h bucket.
    const expected = new Map<number, number>();
    for (const s of state) expected.set(Math.floor(s.candleIdx / 12), JSON.parse(s.detailsJson).n);
    expect(body.adaptiveEvents).toHaveLength(expected.size);
    for (const e of body.adaptiveEvents) {
      expect(JSON.parse(e.detailsJson).n).toBe(expected.get(e.candleIdx));
    }
    const idxs = body.adaptiveEvents.map((e: { candleIdx: number }) => e.candleIdx);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
    expect(body._compactionStats.rawEventCount).toBe(5001);
    expect(body._compactionStats.compactedStateEvents).toBe(5001 - expected.size);
    expect(body._compactionStats.emittedEventCount).toBe(expected.size);
  });
});
