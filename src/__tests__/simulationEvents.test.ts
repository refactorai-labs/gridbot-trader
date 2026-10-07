import { beforeEach, describe, expect, it, vi } from 'vitest';

// Paginated events endpoint (plan v4, Contract D). Prisma is mocked with a small
// in-memory store that honours the where/skip/take the route passes, and every
// test also asserts the exact query arguments.

vi.mock('../lib/prisma', () => ({
  default: {
    simulation: { findUnique: vi.fn() },
    adaptiveEvent: { findMany: vi.fn(), count: vi.fn() },
  },
}));

import prisma from '../lib/prisma';
import { GET } from '../app/api/simulations/[id]/events/route';

const findUniqueSim = prisma.simulation.findUnique as ReturnType<typeof vi.fn>;
const findManyEvents = prisma.adaptiveEvent.findMany as ReturnType<typeof vi.fn>;
const countEvents = prisma.adaptiveEvent.count as ReturnType<typeof vi.fn>;

const SIM_ID = 'v1-sim';
const T0 = Date.UTC(2026, 0, 1);

type Row = {
  id: string; candleIdx: number; timestamp: Date; eventType: string;
  detailsJson: string; longMultiplier: number | null; shortMultiplier: number | null;
};

// 6,000 diagnostics: alternating type, alternating side (independent cycle), two
// rows per candle so the (candleIdx, id) tiebreak is exercised. Stored shuffled.
const ROWS: Row[] = Array.from({ length: 6000 }, (_, i) => {
  const candleIdx = Math.floor(i / 2);
  const side = Math.floor(i / 3) % 2 ? 'short' : 'long';
  return {
    id: `id${String(i).padStart(5, '0')}`,
    candleIdx,
    timestamp: new Date(T0 + candleIdx * 300_000),
    eventType: i % 2 ? 'entry_skipped' : 'restoration_entry',
    detailsJson: JSON.stringify({ side, slotIndex: i % 40 }),
    longMultiplier: null,
    shortMultiplier: null,
  };
}).reverse();

type Where = {
  simulationId: string;
  eventType?: { in: string[] };
  detailsJson?: { contains: string };
  candleIdx?: { gte?: number; lte?: number };
};
const matches = (w: Where) => (r: Row) =>
  (!w.eventType || w.eventType.in.includes(r.eventType)) &&
  (!w.detailsJson || r.detailsJson.includes(w.detailsJson.contains)) &&
  (w.candleIdx?.gte === undefined || r.candleIdx >= w.candleIdx.gte) &&
  (w.candleIdx?.lte === undefined || r.candleIdx <= w.candleIdx.lte);
const sorted = (rows: Row[]) =>
  [...rows].sort((a, b) => a.candleIdx - b.candleIdx || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

async function callGET(query = '') {
  const req = new Request(`http://localhost/api/simulations/${SIM_ID}/events${query}`);
  const res = await GET(req as unknown as Parameters<typeof GET>[0], { params: { id: SIM_ID } });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueSim.mockResolvedValue({ id: SIM_ID });
  countEvents.mockImplementation(async ({ where }: { where: Where }) => ROWS.filter(matches(where)).length);
  findManyEvents.mockImplementation(async ({ where, skip, take }: { where: Where; skip: number; take: number }) =>
    sorted(ROWS.filter(matches(where))).slice(skip, skip + take));
});

describe('events endpoint', () => {
  it('pages through 6,000 diagnostics with the default limit, ordered by (candleIdx, id)', async () => {
    const { status, body } = await callGET();
    expect(status).toBe(200);
    expect(body.total).toBe(6000);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(200);
    expect(body.events).toHaveLength(200);

    const args = findManyEvents.mock.calls[0][0];
    expect(args).toEqual({
      where: { simulationId: SIM_ID },
      orderBy: [{ candleIdx: 'asc' }, { id: 'asc' }],
      skip: 0,
      take: 200,
    });
    expect(countEvents.mock.calls[0][0]).toEqual({ where: { simulationId: SIM_ID } });

    expect(body.events[0]).toEqual({
      id: 'id00000',
      candleIdx: 0,
      timestamp: T0 / 1000,
      eventType: 'restoration_entry',
      details: { side: 'long', slotIndex: 0 },
      longMultiplier: null,
      shortMultiplier: null,
    });
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(sorted(ROWS).slice(0, 200).map(r => r.id));

    // Walk every page: every row exactly once, in order.
    const seen: string[] = [];
    for (let offset = 0; offset < 6000; offset += 500) {
      const page = await callGET(`?offset=${offset}&limit=500`);
      seen.push(...page.body.events.map((e: { id: string }) => e.id));
    }
    expect(seen).toEqual(sorted(ROWS).map(r => r.id));
  });

  it('applies offset and returns an empty page past the end', async () => {
    let { body } = await callGET('?offset=5950&limit=100');
    expect(body.events).toHaveLength(50);
    expect(body.offset).toBe(5950);
    expect(findManyEvents.mock.calls[0][0].skip).toBe(5950);
    ({ body } = await callGET('?offset=7000'));
    expect(body.events).toEqual([]);
    expect(body.total).toBe(6000);
  });

  it('clamps limit to 1..500 and offset to ≥ 0', async () => {
    let { body } = await callGET('?limit=0');
    expect(body.limit).toBe(1);
    expect(body.events).toHaveLength(1);
    expect(findManyEvents.mock.calls[0][0].take).toBe(1);

    ({ body } = await callGET('?limit=10000'));
    expect(body.limit).toBe(500);
    expect(body.events).toHaveLength(500);
    expect(findManyEvents.mock.calls[1][0].take).toBe(500);

    ({ body } = await callGET('?offset=-5&limit=abc'));
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(200);
    expect(findManyEvents.mock.calls[2][0].skip).toBe(0);
  });

  it('filters by type, side and inclusive candle range', async () => {
    const { body } = await callGET('?types=entry_skipped&side=short&fromIdx=100&toIdx=199&limit=500');
    const where = {
      simulationId: SIM_ID,
      eventType: { in: ['entry_skipped'] },
      detailsJson: { contains: '"side":"short"' },
      candleIdx: { gte: 100, lte: 199 },
    };
    expect(findManyEvents.mock.calls[0][0].where).toEqual(where);
    expect(countEvents.mock.calls[0][0].where).toEqual(where);
    const expected = sorted(ROWS.filter(matches(where)));
    expect(body.total).toBe(expected.length);
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(expected.map(r => r.id));
    for (const e of body.events) {
      expect(e.eventType).toBe('entry_skipped');
      expect(e.details.side).toBe('short');
      expect(e.candleIdx).toBeGreaterThanOrEqual(100);
      expect(e.candleIdx).toBeLessThanOrEqual(199);
    }
    expect(body.events.some((e: { candleIdx: number }) => e.candleIdx === 100 || e.candleIdx === 199)).toBe(true);
  });

  it('accepts several types and a one-sided range; ignores an unknown side', async () => {
    await callGET('?types=entry_skipped,restoration_entry&fromIdx=2990&side=both');
    expect(findManyEvents.mock.calls[0][0].where).toEqual({
      simulationId: SIM_ID,
      eventType: { in: ['entry_skipped', 'restoration_entry'] },
      candleIdx: { gte: 2990 },
    });
  });

  it('404 for an unknown simulation', async () => {
    findUniqueSim.mockResolvedValue(null);
    const { status } = await callGET();
    expect(status).toBe(404);
    expect(findManyEvents).not.toHaveBeenCalled();
  });
});
