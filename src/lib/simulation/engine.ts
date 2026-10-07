// Main simulation engine — classic grid runs go through the pure v1 core
// (classicGridCore.ts); this file loads inputs and persists results. Combo
// simulations branch to the supervisor runner unchanged.

import prisma from '../prisma';
import type { GridConfiguration } from '@prisma/client';
import { SnapshotData } from '../types';
import { getGridSpacing } from './gridGenerator';
import { getCachedCandles, computeMissingGaps } from '../data/candleCache';
import { normalizeExecutionWindow, EXECUTION_TF_MS } from '../data/executionWindow';
import { SUPPORTED_PAIRS } from '../constants';
import { runComboSimulationFromDb } from '../combo/supervisorRunner';
import { runClassicGrid } from './classicGridCore';
import { ClassicFill, ClassicEvent, ClassicSideInput, CLASSIC_ENGINE_VERSION } from './classicGridTypes';

function getBinanceSymbol(poolAddress: string, pair: string): string {
  const config = SUPPORTED_PAIRS.find(p => p.poolAddress === poolAddress);
  return config?.binanceSymbol || pair;
}

function toSideInput(config: GridConfiguration | undefined): ClassicSideInput | null {
  if (!config || !config.enabled) return null;
  return {
    lowerBound: config.lowerBound,
    upperBound: config.upperBound,
    gridLevels: config.gridLevels,
    gridType: config.gridType as 'arithmetic' | 'geometric',
    orderSize: config.orderSize,
    totalCapital: config.totalCapital,
    profitMode: config.profitMode as 'next_level' | 'custom',
    customProfitDistance: config.customProfitDistance ?? undefined,
  };
}

export async function runSimulation(simulationId: string): Promise<void> {
  // 1. Load simulation config
  const sim = await prisma.simulation.findUnique({
    where: { id: simulationId },
    include: { gridConfigs: true },
  });

  if (!sim) throw new Error(`Simulation ${simulationId} not found`);

  // Branch: combo supervisor wraps grids when enabled (spec §1, plan Phase 3c).
  if (sim.comboBotEnabled) {
    await runComboSimulationFromDb(simulationId);
    return;
  }

  // Mark as running
  await prisma.simulation.update({
    where: { id: simulationId },
    data: { status: 'running' },
  });

  try {
    const longConfig = sim.gridConfigs.find(c => c.side === 'long');
    const shortConfig = sim.gridConfigs.find(c => c.side === 'short');
    const long = toSideInput(longConfig);
    const short = toSideInput(shortConfig);
    if (!long && !short) throw new Error('No enabled grid side');
    if (sim.adaptiveEnabled) throw new Error('Adaptive layer is not available until checkpoint 3; switch it off in the panel');

    // 2. Effective 5m window (Contract E) and coverage check — no carry-forward.
    const { effStart, effEnd } = normalizeExecutionWindow(sim.startTime.getTime(), sim.endTime.getTime(), Date.now());
    const binanceSymbol = getBinanceSymbol(sim.poolAddress, sim.pair);
    const candles = await getCachedCandles(binanceSymbol, '5m', new Date(effStart), new Date(effEnd));
    const gaps = computeMissingGaps(candles, effStart, effEnd, EXECUTION_TF_MS);
    if (gaps.length > 0) {
      const ranges = gaps
        .map(g => `[${new Date(g.startMs).toISOString()}, ${new Date(g.endMs).toISOString()})`)
        .join(', ');
      throw new Error(`Missing cached 5m candles for ${binanceSymbol}: ${ranges}. Use the Data Manager to download.`);
    }

    // 3. Store grid spacing for display (enabled sides only)
    for (const config of [longConfig, shortConfig]) {
      if (!config?.enabled) continue;
      const { spacing, spacingPct } = getGridSpacing(
        config.lowerBound, config.upperBound, config.gridLevels, config.gridType as 'arithmetic' | 'geometric'
      );
      await prisma.gridConfiguration.update({
        where: { id: config.id },
        data: { gridSpacing: spacing, gridSpacingPct: spacingPct },
      });
    }

    // 4. Run the pure core
    const result = runClassicGrid({ candles, feeRate: sim.feeRate, long, short });

    // 5. Persist fills, snapshots, events, then the aggregate row
    await storeResults(simulationId, result.fills, result.snapshots, result.events, result.startingCapital);

    await prisma.simulation.update({
      where: { id: simulationId },
      data: {
        status: 'completed',
        engineVersion: CLASSIC_ENGINE_VERSION,
        effectiveStartTime: new Date(effStart),
        effectiveEndTime: new Date(effEnd),
        finalEquity: result.finalEquity,
        totalPnl: result.totalPnl,
        totalPnlPct: result.totalPnlPct,
        realizedPnl: result.realizedGross,
        totalFees: result.totalFees,
        unrealizedPnl: result.unrealized,
        longPnl: result.long ? result.long.finalEquity - result.long.totalCapital : 0,
        shortPnl: result.short ? result.short.finalEquity - result.short.totalCapital : 0,
        totalTrades: result.fills.length,
        longTrades: result.long?.fills ?? 0,
        shortTrades: result.short?.fills ?? 0,
        roundTrips: result.roundTrips,
        winCount: result.winCount,
        lossCount: result.lossCount,
        maxDrawdown: result.maxDrawdown,
        maxDrawdownPct: result.maxDrawdownPct,
        totalCandles: result.totalCandles,
        skippedEntries: result.skippedEntries,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await prisma.simulation.update({
      where: { id: simulationId },
      data: { status: 'failed', errorMessage: message },
    });
    throw error;
  }
}

// Batch store simulation results in database. Fill ids are derived from fillSeq
// so a closing leg can reference its entry fill (pairedOrderId) without a lookup.
async function storeResults(
  simulationId: string,
  fills: ClassicFill[],
  snapshots: SnapshotData[],
  events: ClassicEvent[],
  startingCapital: number
): Promise<void> {
  const batchSize = 500;
  const fillId = (seq: number) => `${simulationId}_f${seq}`;

  // Store grid orders (fills). Rows are built per batch: dense grids can produce
  // over a million fills, so a second full-size array is avoided.
  const toOrderRow = (f: ClassicFill) => ({
    id: fillId(f.fillSeq),
    simulationId,
    side: f.side,
    level: f.level,
    levelPrice: f.levelPrice,
    orderType: f.orderType,
    orderSize: f.notional,
    status: 'filled' as const,
    fillPrice: f.fillPrice,
    fillTime: new Date(f.timestamp * 1000),
    fillCandleIdx: f.candleIdx,
    fillSeq: f.fillSeq,
    quantity: f.quantity,
    slotIndex: f.slotIndex,
    positionId: f.positionId,
    role: f.role,
    pairedOrderId: f.pairedFillSeq != null ? fillId(f.pairedFillSeq) : null,
    pnl: f.pnl,
    pnlPct: f.pnl != null && startingCapital > 0 ? (f.pnl / startingCapital) * 100 : null,
    fees: f.fees,
    sizeMultiplier: 1.0,
  });
  for (let i = 0; i < fills.length; i += batchSize) {
    await prisma.gridOrder.createMany({ data: fills.slice(i, i + batchSize).map(toOrderRow) });
  }

  // Store P&L snapshots
  const snapshotData = snapshots.map(s => ({
    simulationId,
    candleIdx: s.candleIdx,
    timestamp: new Date(s.timestamp * 1000),
    price: s.price,
    equity: s.equity,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    longRealizedPnl: s.longRealizedPnl,
    shortRealizedPnl: s.shortRealizedPnl,
    longUnrealizedPnl: s.longUnrealizedPnl,
    shortUnrealizedPnl: s.shortUnrealizedPnl,
    longEquity: s.longEquity,
    shortEquity: s.shortEquity,
    longOrdersActive: s.longOrdersActive,
    shortOrdersActive: s.shortOrdersActive,
    longFillCount: s.longFillCount,
    shortFillCount: s.shortFillCount,
  }));
  for (let i = 0; i < snapshotData.length; i += batchSize) {
    await prisma.pnlSnapshot.createMany({ data: snapshotData.slice(i, i + batchSize) });
  }

  // Store events (state events and per-order diagnostics, all in full)
  const eventData = events.map(e => ({
    simulationId,
    candleIdx: e.candleIdx,
    timestamp: new Date(e.timestamp * 1000),
    eventType: e.eventType,
    detailsJson: JSON.stringify(e.details),
    longMultiplier: e.longMultiplier,
    shortMultiplier: e.shortMultiplier,
  }));
  for (let i = 0; i < eventData.length; i += batchSize) {
    await prisma.adaptiveEvent.createMany({ data: eventData.slice(i, i + batchSize) });
  }
}
