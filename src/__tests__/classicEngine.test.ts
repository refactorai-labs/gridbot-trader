import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OHLC } from '../lib/types';

vi.mock('../lib/prisma', () => ({
  default: {
    simulation: { findUnique: vi.fn(), update: vi.fn() },
    gridConfiguration: { update: vi.fn() },
    gridOrder: { createMany: vi.fn() },
    pnlSnapshot: { createMany: vi.fn() },
    adaptiveEvent: { createMany: vi.fn() },
  },
}));

vi.mock('../lib/data/candleCache', async () => {
  const actual = await vi.importActual<typeof import('../lib/data/candleCache')>('../lib/data/candleCache');
  return { ...actual, getCachedCandles: vi.fn() };
});

vi.mock('../lib/combo/supervisorRunner', () => ({ runComboSimulationFromDb: vi.fn() }));

import prisma from '../lib/prisma';
import { getCachedCandles } from '../lib/data/candleCache';
import { runComboSimulationFromDb } from '../lib/combo/supervisorRunner';
import { runSimulation } from '../lib/simulation/engine';

const findUnique = prisma.simulation.findUnique as ReturnType<typeof vi.fn>;
const simUpdate = prisma.simulation.update as ReturnType<typeof vi.fn>;
const ordersCreate = prisma.gridOrder.createMany as ReturnType<typeof vi.fn>;
const cached = getCachedCandles as ReturnType<typeof vi.fn>;

const T0 = Date.UTC(2026, 0, 1) / 1000;
const S = 300;

// Saw-tooth around 100 so both sides trade.
function candles(n: number): OHLC[] {
  return Array.from({ length: n }, (_, i) => {
    const mid = 100 + 6 * Math.sin(i / 3);
    return { timestamp: T0 + i * S, open: mid, high: mid + 2, low: mid - 2, close: mid + 0.5, volume: 1 };
  });
}

function gridConfig(side: 'long' | 'short', enabled = true) {
  return {
    id: `${side}-cfg`, simulationId: 'sim', side, enabled, gridLevels: 11, gridType: 'arithmetic',
    lowerBound: 90, upperBound: 110, orderSizeType: 'fixed', orderSize: 50, totalCapital: 1000,
    profitMode: 'next_level', customProfitDistance: null, gridSpacing: null, gridSpacingPct: null,
  };
}

function simRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'sim', pair: 'WETH/USDC', poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
    startTime: new Date((T0 + 60) * 1000), endTime: new Date((T0 + 100 * S + 120) * 1000),
    timeframe: '5m', feeRate: 0.001, adaptiveEnabled: false, comboBotEnabled: false,
    gridConfigs: [gridConfig('long'), gridConfig('short')],
    ...extra,
  };
}

const allFills = () => ordersCreate.mock.calls.flatMap(c => c[0].data);
const finalUpdate = () => simUpdate.mock.calls[simUpdate.mock.calls.length - 1][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  // Window [T0+60s, …) normalizes to first open T0+300 → 100 candles requested.
  cached.mockImplementation(async (_p: string, _i: string, start: Date, end: Date) =>
    candles(200).filter(c => c.timestamp * 1000 >= start.getTime() && c.timestamp * 1000 < end.getTime()));
});

describe('classic engine wrapper (C1.3)', () => {
  it('uses the normalized 5m window and persists the v1 row shape', async () => {
    findUnique.mockResolvedValue(simRow());
    await runSimulation('sim');

    const [, interval, start, end] = cached.mock.calls[0];
    expect(interval).toBe('5m');
    expect(start.getTime()).toBe((T0 + S) * 1000);
    expect(end.getTime()).toBe((T0 + 100 * S) * 1000);

    const data = finalUpdate();
    expect(data).toMatchObject({ status: 'completed', engineVersion: 1, totalCandles: 99 });
    expect(data.effectiveStartTime.getTime()).toBe((T0 + S) * 1000);
    expect(data.totalPnl).toBeCloseTo(data.finalEquity - 2000, 9);
    expect(data.longPnl + data.shortPnl).toBeCloseTo(data.totalPnl, 9);

    const rows = allFills();
    expect(rows.length).toBe(data.totalTrades);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r, i) => expect(r.fillSeq).toBe(i));
    const exit = rows.find(r => r.role === 'exit');
    const entry = rows.find(r => r.id === exit.pairedOrderId);
    expect(entry.positionId).toBe(exit.positionId);
    expect(['entry', 'initial']).toContain(entry.role);
  });

  it('trading results are independent of the selected (chart) timeframe', async () => {
    findUnique.mockResolvedValue(simRow({ timeframe: '5m' }));
    await runSimulation('sim');
    const a = { fills: allFills(), result: finalUpdate() };
    vi.clearAllMocks();
    findUnique.mockResolvedValue(simRow({ timeframe: '4h' }));
    await runSimulation('sim');
    expect(allFills()).toEqual(a.fills);
    expect(finalUpdate()).toEqual(a.result);
  });

  it('refuses a window with missing cached candles, naming the gap', async () => {
    cached.mockResolvedValue(candles(200).filter((c, i) => i >= 1 && i < 100 && i !== 40));
    findUnique.mockResolvedValue(simRow());
    await expect(runSimulation('sim')).rejects.toThrow(/Missing cached 5m candles .*2026-01-01T03:20:00\.000Z, 2026-01-01T03:25:00\.000Z/);
    expect(finalUpdate()).toMatchObject({ status: 'failed' });
    expect(ordersCreate).not.toHaveBeenCalled();
  });

  it('a disabled side does not trade and does not count toward capital', async () => {
    findUnique.mockResolvedValue(simRow({ gridConfigs: [gridConfig('long'), gridConfig('short', false)] }));
    await runSimulation('sim');
    expect(allFills().every(r => r.side === 'long')).toBe(true);
    const data = finalUpdate();
    expect(data.shortTrades).toBe(0);
    expect(data.totalPnl).toBeCloseTo(data.finalEquity - 1000, 9);
  });

  it('Combo rows still go to the supervisor runner', async () => {
    findUnique.mockResolvedValue(simRow({ comboBotEnabled: true }));
    await runSimulation('sim');
    expect(runComboSimulationFromDb).toHaveBeenCalledWith('sim');
    expect(simUpdate).not.toHaveBeenCalled();
  });
});
