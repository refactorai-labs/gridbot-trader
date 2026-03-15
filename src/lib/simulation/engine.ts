// Main simulation engine — processes candles through grid strategy

import prisma from '../prisma';
import { OHLC, GridLevel, PendingOrder, Fill, AdaptiveState, AdaptiveEventData, SnapshotData } from '../types';
import { generateGridLevels, getGridSpacing } from './gridGenerator';
import { initializeOrders, matchOrders, createCounterOrder, resetOrderIdCounter } from './orderMatcher';
import { createInitialPnLState, processFill, createSnapshot, PnLState } from './pnlTracker';
import { createInitialAdaptiveState, evaluateAdaptive } from './adaptiveLayer';
import { getCachedCandles } from '../data/candleCache';
import { findLevels } from '../analysis/technical';

export async function runSimulation(simulationId: string): Promise<void> {
  // Reset order ID counter for clean simulation
  resetOrderIdCounter();

  // 1. Load simulation config
  const sim = await prisma.simulation.findUnique({
    where: { id: simulationId },
    include: { gridConfigs: true },
  });

  if (!sim) throw new Error(`Simulation ${simulationId} not found`);

  const longConfig = sim.gridConfigs.find(c => c.side === 'long');
  const shortConfig = sim.gridConfigs.find(c => c.side === 'short');

  if (!longConfig || !shortConfig) {
    throw new Error('Missing grid configuration for long or short side');
  }

  // Mark as running
  await prisma.simulation.update({
    where: { id: simulationId },
    data: { status: 'running' },
  });

  try {
    // 2. Load candles
    const candles = await getCachedCandles(
      sim.poolAddress, sim.timeframe, sim.startTime, sim.endTime
    );

    if (candles.length === 0) {
      throw new Error('No candle data available for the specified range');
    }

    // Load 4H candles for adaptive layer (if enabled)
    let candles4H: OHLC[] = [];
    if (sim.adaptiveEnabled) {
      candles4H = await getCachedCandles(
        sim.poolAddress, '4h', sim.startTime, sim.endTime
      );
    }

    // 3. Generate grid levels
    const longLevels = generateGridLevels(
      longConfig.lowerBound, longConfig.upperBound,
      longConfig.gridLevels, 'long', longConfig.gridType as 'arithmetic' | 'geometric'
    );
    const shortLevels = generateGridLevels(
      shortConfig.lowerBound, shortConfig.upperBound,
      shortConfig.gridLevels, 'short', shortConfig.gridType as 'arithmetic' | 'geometric'
    );

    // Store grid spacing
    const longSpacing = getGridSpacing(longConfig.lowerBound, longConfig.upperBound, longConfig.gridLevels, longConfig.gridType as 'arithmetic' | 'geometric');
    const shortSpacing = getGridSpacing(shortConfig.lowerBound, shortConfig.upperBound, shortConfig.gridLevels, shortConfig.gridType as 'arithmetic' | 'geometric');

    await Promise.all([
      prisma.gridConfiguration.update({
        where: { id: longConfig.id },
        data: { gridSpacing: longSpacing.spacing, gridSpacingPct: longSpacing.spacingPct },
      }),
      prisma.gridConfiguration.update({
        where: { id: shortConfig.id },
        data: { gridSpacing: shortSpacing.spacing, gridSpacingPct: shortSpacing.spacingPct },
      }),
    ]);

    // 4. Initialize orders
    const firstPrice = candles[0].close;
    let pendingOrders: PendingOrder[] = [
      ...initializeOrders(firstPrice, longLevels, 'long', longConfig.orderSize),
      ...initializeOrders(firstPrice, shortLevels, 'short', shortConfig.orderSize),
    ];

    // 5. Initialize state
    const totalCapital = longConfig.totalCapital + shortConfig.totalCapital;
    const pnlState = createInitialPnLState();
    pnlState.maxEquity = totalCapital;
    let adaptiveState = createInitialAdaptiveState();

    // Detect initial S/R levels
    const initialCandles = candles.slice(0, Math.min(50, candles.length));
    let { support, resistance } = findLevels(initialCandles);

    // Collect results for batch insert
    const allFills: Fill[] = [];
    const allSnapshots: SnapshotData[] = [];
    const allAdaptiveEvents: { candleIdx: number; timestamp: number; event: AdaptiveEventData }[] = [];

    // Snapshot interval — take a snapshot every N candles, capped at ~2000 total
    const snapshotInterval = Math.max(1, Math.floor(candles.length / 2000));
    let fourHourIdx = 0;

    // 6. Process each candle
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];

      // 6a. Adaptive layer on 4H boundaries (if enabled)
      if (sim.adaptiveEnabled && candles4H.length > 0) {
        // Check if we've crossed into a new 4H candle
        while (fourHourIdx < candles4H.length && candles4H[fourHourIdx].timestamp <= candle.timestamp) {
          fourHourIdx++;
        }

        // Evaluate at 4H boundaries
        const relevantCandles4H = candles4H.slice(0, fourHourIdx);
        if (relevantCandles4H.length > 0 && (i === 0 || isNew4HBoundary(candle, candles[i - 1]))) {
          const { newState, events } = evaluateAdaptive(
            relevantCandles4H, candle, adaptiveState, support, resistance,
            { emaPeriod: sim.emaPeriod, volumeMultiplier: sim.volumeMultiplier }
          );

          adaptiveState = newState;

          // Apply multipliers to pending orders
          for (const order of pendingOrders) {
            if (order.side === 'long') {
              order.sizeMultiplier = adaptiveState.longMultiplier;
            } else {
              order.sizeMultiplier = adaptiveState.shortMultiplier;
            }
          }

          // Store adaptive events
          for (const event of events) {
            allAdaptiveEvents.push({
              candleIdx: i,
              timestamp: candle.timestamp,
              event,
            });
          }
        }
      }

      // 6b. Match orders
      const fills = matchOrders(candle, i, pendingOrders, sim.feeRate, longLevels, shortLevels);

      // 6c. Process fills
      for (const fill of fills) {
        // Remove the filled order
        pendingOrders = pendingOrders.filter(o => o.id !== fill.orderId);

        // Calculate P&L
        const { pnl, pnlPct } = processFill(pnlState, fill, totalCapital);
        fill.pnl = pnl;
        fill.pnlPct = pnlPct;

        // Create counter-order
        const multiplier = fill.side === 'long' ? adaptiveState.longMultiplier : adaptiveState.shortMultiplier;
        const orderSize = fill.side === 'long' ? longConfig.orderSize : shortConfig.orderSize;
        const counterOrder = createCounterOrder(fill, longLevels, shortLevels, orderSize, multiplier);

        if (counterOrder) {
          fill.counterOrderId = counterOrder.id;
          pendingOrders.push(counterOrder);
        }

        allFills.push(fill);
      }

      // 6d. Take P&L snapshot
      if (i % snapshotInterval === 0 || i === candles.length - 1) {
        const longActive = pendingOrders.filter(o => o.side === 'long' && o.sizeMultiplier > 0).length;
        const shortActive = pendingOrders.filter(o => o.side === 'short' && o.sizeMultiplier > 0).length;

        const snapshot = createSnapshot(
          pnlState, i, candle.timestamp, candle.close,
          totalCapital, longActive, shortActive
        );
        allSnapshots.push(snapshot);
      }
    }

    // 7. Batch store all results
    await storeResults(simulationId, allFills, allSnapshots, allAdaptiveEvents, longLevels, shortLevels);

    // 8. Update simulation with aggregate results
    const lastCandle = candles[candles.length - 1];
    const finalEquity = totalCapital + pnlState.realizedPnl +
      (lastCandle ? calculateFinalUnrealized(pnlState, lastCandle.close) : 0);

    await prisma.simulation.update({
      where: { id: simulationId },
      data: {
        status: 'completed',
        totalPnl: pnlState.realizedPnl,
        totalPnlPct: totalCapital > 0 ? (pnlState.realizedPnl / totalCapital) * 100 : 0,
        longPnl: pnlState.longRealizedPnl,
        shortPnl: pnlState.shortRealizedPnl,
        totalTrades: pnlState.longFillCount + pnlState.shortFillCount,
        longTrades: pnlState.longFillCount,
        shortTrades: pnlState.shortFillCount,
        winCount: pnlState.winCount,
        lossCount: pnlState.lossCount,
        maxDrawdown: pnlState.maxDrawdown,
        maxDrawdownPct: pnlState.maxDrawdownPct,
        finalEquity,
        totalCandles: candles.length,
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

// Check if we crossed a 4H boundary between two consecutive candles
function isNew4HBoundary(current: OHLC, previous: OHLC): boolean {
  const fourHours = 4 * 60 * 60;
  const currentBucket = Math.floor(current.timestamp / fourHours);
  const previousBucket = Math.floor(previous.timestamp / fourHours);
  return currentBucket !== previousBucket;
}

function calculateFinalUnrealized(state: PnLState, currentPrice: number): number {
  let unrealized = 0;
  for (const pos of state.openPositions) {
    if (pos.side === 'long' && pos.entryType === 'buy') {
      unrealized += (currentPrice - pos.entryPrice) * (pos.size / pos.entryPrice);
    } else if (pos.side === 'short' && pos.entryType === 'sell') {
      unrealized += (pos.entryPrice - currentPrice) * (pos.size / pos.entryPrice);
    }
  }
  return unrealized;
}

// Batch store simulation results in database
async function storeResults(
  simulationId: string,
  fills: Fill[],
  snapshots: SnapshotData[],
  adaptiveEvents: { candleIdx: number; timestamp: number; event: AdaptiveEventData }[],
  longLevels: GridLevel[],
  shortLevels: GridLevel[]
): Promise<void> {
  const batchSize = 500;

  // Store grid orders (fills)
  if (fills.length > 0) {
    const orderData = fills.map(f => ({
      simulationId,
      side: f.side,
      level: f.levelIndex,
      levelPrice: f.fillPrice,
      orderType: f.type,
      orderSize: f.size,
      status: 'filled' as const,
      fillPrice: f.fillPrice,
      fillTime: new Date(f.timestamp * 1000),
      fillCandleIdx: f.candleIdx,
      pairedOrderId: f.counterOrderId || null,
      pnl: f.pnl || null,
      pnlPct: f.pnlPct || null,
      fees: f.fees,
      sizeMultiplier: 1.0,
    }));

    for (let i = 0; i < orderData.length; i += batchSize) {
      await prisma.gridOrder.createMany({
        data: orderData.slice(i, i + batchSize),
      });
    }
  }

  // Store P&L snapshots
  if (snapshots.length > 0) {
    const snapshotData = snapshots.map(s => ({
      simulationId,
      candleIdx: s.candleIdx,
      timestamp: new Date(s.timestamp * 1000),
      price: s.price,
      equity: s.equity,
      realizedPnl: s.realizedPnl,
      unrealizedPnl: s.unrealizedPnl,
      longEquity: s.longEquity,
      shortEquity: s.shortEquity,
      longOrdersActive: s.longOrdersActive,
      shortOrdersActive: s.shortOrdersActive,
      longFillCount: s.longFillCount,
      shortFillCount: s.shortFillCount,
    }));

    for (let i = 0; i < snapshotData.length; i += batchSize) {
      await prisma.pnlSnapshot.createMany({
        data: snapshotData.slice(i, i + batchSize),
      });
    }
  }

  // Store adaptive events
  if (adaptiveEvents.length > 0) {
    await prisma.adaptiveEvent.createMany({
      data: adaptiveEvents.map(ae => ({
        simulationId,
        candleIdx: ae.candleIdx,
        timestamp: new Date(ae.timestamp * 1000),
        eventType: ae.event.type,
        detailsJson: JSON.stringify(ae.event.details),
        longMultiplier: ae.event.longMultiplier ?? null,
        shortMultiplier: ae.event.shortMultiplier ?? null,
      })),
    });
  }
}
