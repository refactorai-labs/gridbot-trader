import { beforeEach, describe, expect, it, vi } from 'vitest';

// Simulation create/list/detail routes (plan v4, C1.4/C1.5). Prisma and the
// engine are mocked; the handlers are driven directly.

vi.mock('../lib/prisma', () => ({
  default: {
    simulation: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock('@/lib/simulation/engine', () => ({ runSimulation: vi.fn() }));

import prisma from '../lib/prisma';
import { runSimulation } from '@/lib/simulation/engine';
import { POST, GET as LIST } from '../app/api/simulations/route';
import { GET as DETAIL } from '../app/api/simulations/[id]/route';

const createSim = prisma.simulation.create as ReturnType<typeof vi.fn>;
const findManySims = prisma.simulation.findMany as ReturnType<typeof vi.fn>;
const findUniqueSim = prisma.simulation.findUnique as ReturnType<typeof vi.fn>;
const mockedRun = runSimulation as ReturnType<typeof vi.fn>;

function side(s: 'long' | 'short', extra: Record<string, unknown> = {}) {
  return {
    side: s, gridLevels: 10, gridType: 'arithmetic', upperBound: 2300, lowerBound: 1900,
    orderSizeType: 'fixed', orderSize: 100, totalCapital: 4000, profitMode: 'next_level', ...extra,
  };
}

function classicBody(extra: Record<string, unknown> = {}) {
  return {
    name: 'Classic', pair: 'ETH/USDT', poolAddress: '0xpool', chain: 'eth', timeframe: '1h',
    startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-02-01T00:00:00.000Z',
    longConfig: side('long'), shortConfig: side('short'),
    adaptiveEnabled: false, emaPeriod: 50, volumeMultiplier: 1.5, feeRate: 0.0008,
    ...extra,
  };
}

async function post(body: unknown) {
  const req = new Request('http://localhost/api/simulations', { method: 'POST', body: JSON.stringify(body) });
  const res = await POST(req as unknown as Parameters<typeof POST>[0]);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  createSim.mockResolvedValue({ id: 'new-sim' });
  mockedRun.mockResolvedValue(undefined);
});

describe('POST /api/simulations — classic validation', () => {
  it('accepts a valid classic request, persists engineVersion 1, enabled flags and adaptive off', async () => {
    const body = classicBody({ adaptiveEnabled: undefined, shortConfig: side('short', { enabled: false }) });
    const { status, body: res } = await post(body);
    expect(status).toBe(200);
    expect(res).toEqual({ id: 'new-sim', status: 'running' });
    const data = createSim.mock.calls[0][0].data;
    expect(data.engineVersion).toBe(1);
    expect(data.adaptiveEnabled).toBe(false);
    expect(data.comboBotEnabled).toBe(false);
    expect(data.gridConfigs.create[0].enabled).toBe(true);
    expect(data.gridConfigs.create[1].enabled).toBe(false);
    expect(mockedRun).toHaveBeenCalledWith('new-sim');
  });

  it('stores a disabled side as sent without bounds validation', async () => {
    const badShort = side('short', { enabled: false, lowerBound: 5000, upperBound: 10, gridLevels: 1, orderSize: -1, totalCapital: 0 });
    const { status } = await post(classicBody({ shortConfig: badShort }));
    expect(status).toBe(200);
    const stored = createSim.mock.calls[0][0].data.gridConfigs.create[1];
    expect(stored).toMatchObject({ side: 'short', enabled: false, lowerBound: 5000, upperBound: 10, gridLevels: 1, orderSize: -1, totalCapital: 0 });
  });

  const invalid: [string, Record<string, unknown>, RegExp][] = [
    ['unparsable start date', { startTime: 'not-a-date' }, /valid dates/],
    ['start not before end', { endTime: '2026-01-01T00:00:00.000Z' }, /before end/],
    ['no complete 5m candle (00:00–00:02)', { endTime: '2026-01-01T00:02:00.000Z' }, /no complete 5m candle/],
    ['window entirely in the future', { startTime: '2999-01-01T00:00:00.000Z', endTime: '2999-02-01T00:00:00.000Z' }, /no complete 5m candle/],
    ['unsupported timeframe', { timeframe: '1d' }, /timeframe/],
    ['negative fee rate', { feeRate: -0.001 }, /Fee rate/],
    ['non-finite fee rate', { feeRate: 'abc' }, /Fee rate/],
    ['no enabled side', { longConfig: side('long', { enabled: false }), shortConfig: side('short', { enabled: false }) }, /at least one side/],
    ['lower ≤ 0', { longConfig: side('long', { lowerBound: 0 }) }, /Long: bounds/],
    ['lower ≥ upper', { shortConfig: side('short', { lowerBound: 2300, upperBound: 2300 }) }, /Short: bounds/],
    ['non-integer levels', { longConfig: side('long', { gridLevels: 10.5 }) }, /integer between 2 and 2000/],
    ['levels < 2', { longConfig: side('long', { gridLevels: 1 }) }, /integer between 2 and 2000/],
    ['levels > 2000', { longConfig: side('long', { gridLevels: 2001 }) }, /integer between 2 and 2000/],
    ['order size ≤ 0', { longConfig: side('long', { orderSize: 0 }) }, /order size/],
    ['non-finite capital', { shortConfig: side('short', { totalCapital: null }) }, /total capital/],
    ['levels not strictly increasing', { longConfig: side('long', { lowerBound: 1, upperBound: 1.000001, gridLevels: 2000 }) }, /strictly increasing/],
  ];
  it.each(invalid)('400 for %s', async (_name, patch, message) => {
    const { status, body } = await post(classicBody(patch));
    expect(status).toBe(400);
    expect(body.error).toMatch(message);
    expect(createSim).not.toHaveBeenCalled();
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it.each([
    ['adaptive layer', { adaptiveEnabled: true }, /not available until checkpoint 3; switch it off in the panel/],
    ['percent order size', { longConfig: side('long', { orderSizeType: 'percent' }) }, /not available until checkpoint 2; switch it off in the panel/],
    ['custom profit target', { shortConfig: side('short', { profitMode: 'custom', customProfitDistance: 5 }) }, /not available until checkpoint 2; switch it off in the panel/],
  ])('400 "not available until checkpoint" for %s', async (_name, patch, message) => {
    const { status, body } = await post(classicBody(patch));
    expect(status).toBe(400);
    expect(body.error).toMatch(message);
    expect(createSim).not.toHaveBeenCalled();
  });

  it('percent / custom on a disabled side are not rejected', async () => {
    const { status } = await post(classicBody({
      shortConfig: side('short', { enabled: false, orderSizeType: 'percent', profitMode: 'custom' }),
    }));
    expect(status).toBe(200);
  });
});

describe('POST /api/simulations — Combo passes through unchanged', () => {
  it('persists exactly today\'s mapping (no classic validation, no engineVersion/enabled)', async () => {
    const combo = {
      enabled: true, mode: 'dual', leverage: 3, allocationLong: 0.6, avwapEnabled: true,
      totalCapital: 8000, gridLevels: 12, atrPeriod: 14, erLookback: 10, erSmoothingLength: 3,
      erRegimeThreshold: 0.4, rsiLongThreshold: 35, rsiShortThreshold: 65,
      longSide: { slBasePercent: 1 }, shortSide: { slBasePercent: 2 },
    };
    // Classic-invalid values (adaptive on, percent sizing, 1d timeframe) must not matter here.
    const longConfig = side('long', { orderSizeType: 'percent', enabled: false });
    const shortConfig = side('short');
    const body = classicBody({ combo, adaptiveEnabled: undefined, timeframe: '1d', longConfig, shortConfig });

    const { status } = await post(body);
    expect(status).toBe(200);
    expect(createSim.mock.calls[0][0]).toEqual({
      data: {
        name: 'Classic', pair: 'ETH/USDT', poolAddress: '0xpool', chain: 'eth',
        startTime: new Date('2026-01-01T00:00:00.000Z'), endTime: new Date('2026-02-01T00:00:00.000Z'),
        timeframe: '1d', feeRate: 0.0008, adaptiveEnabled: true, emaPeriod: 50, volumeMultiplier: 1.5,
        comboBotEnabled: true, comboMode: 'dual', comboLeverage: 3, comboAllocationLong: 0.6,
        comboAvwapEnabled: true, comboGridLevels: 12, requireDirectionalConfirmation: false,
        gridConfigs: {
          create: [
            { side: 'long', gridLevels: 10, gridType: 'arithmetic', upperBound: 2300, lowerBound: 1900, orderSizeType: 'percent', orderSize: 100, totalCapital: 4000, profitMode: 'next_level', customProfitDistance: undefined },
            { side: 'short', gridLevels: 10, gridType: 'arithmetic', upperBound: 2300, lowerBound: 1900, orderSizeType: 'fixed', orderSize: 100, totalCapital: 4000, profitMode: 'next_level', customProfitDistance: undefined },
          ],
        },
        comboConfigs: {
          create: [{ side: 'long', slBasePercent: 1 }, { side: 'short', slBasePercent: 2 }],
        },
      },
    });
    expect(createSim.mock.calls[0][0].data).not.toHaveProperty('engineVersion');
    expect(createSim.mock.calls[0][0].data.gridConfigs.create[0]).not.toHaveProperty('enabled');
    expect(mockedRun).toHaveBeenCalledWith('new-sim');
  });
});

describe('GET /api/simulations (list)', () => {
  it('selects engineVersion, comboBotEnabled and finalEquity alongside the existing fields', async () => {
    findManySims.mockResolvedValue([{ id: 'a' }]);
    const res = await LIST();
    expect(await res.json()).toEqual({ simulations: [{ id: 'a' }] });
    const { select, orderBy } = findManySims.mock.calls[0][0];
    expect(orderBy).toEqual({ createdAt: 'desc' });
    for (const f of ['id', 'name', 'status', 'totalPnl', 'totalTrades', 'maxDrawdown', 'winCount', 'lossCount',
      'engineVersion', 'comboBotEnabled', 'finalEquity']) {
      expect(select[f]).toBe(true);
    }
  });
});

describe('GET /api/simulations/[id] (detail)', () => {
  async function detail(row: unknown) {
    findUniqueSim.mockResolvedValue(row);
    const req = new Request('http://localhost/api/simulations/x');
    const res = await DETAIL(req as unknown as Parameters<typeof DETAIL>[0], { params: { id: 'x' } });
    return { status: res.status, body: await res.json() };
  }
  const cfg = (s: string, enabled: boolean, totalCapital: number) => ({ side: s, enabled, totalCapital });

  it('classic v1: startingCapital = Σ enabled sides', async () => {
    const { body } = await detail({ id: 'x', engineVersion: 1, comboBotEnabled: false, totalPnl: 5, gridConfigs: [cfg('long', true, 6000), cfg('short', false, 5000)] });
    expect(body.simulation.startingCapital).toBe(6000);
    expect(body.simulation.totalPnl).toBe(5);
    expect(body.simulation.gridConfigs).toHaveLength(2);
  });

  it('classic legacy v0: startingCapital = Σ enabled sides (both enabled by default)', async () => {
    const { body } = await detail({ id: 'x', engineVersion: 0, comboBotEnabled: false, gridConfigs: [cfg('long', true, 6000), cfg('short', true, 5000)] });
    expect(body.simulation.startingCapital).toBe(11000);
  });

  it('Combo: startingCapital = Σ both sides regardless of enabled', async () => {
    const { body } = await detail({ id: 'x', engineVersion: 0, comboBotEnabled: true, gridConfigs: [cfg('long', true, 3000), cfg('short', false, 2000)] });
    expect(body.simulation.startingCapital).toBe(5000);
  });

  it('404 for an unknown simulation', async () => {
    const { status } = await detail(null);
    expect(status).toBe(404);
  });
});
