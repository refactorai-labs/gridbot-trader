import prisma from '../prisma';
import { ComboBotConfig, ComboBotSideConfig, ComboMode, OHLC } from '../types';
import { getCachedCandles } from '../data/candleCache';
import { getCachedFundingRates } from '../data/fundingCache';
import { aggregate5mTo } from '../data/aggregator';
import { SUPPORTED_PAIRS } from '../constants';
import { runComboSimulationCore } from './supervisor';

function getBinanceSymbol(poolAddress: string, pair: string): string {
  const match = SUPPORTED_PAIRS.find(p => p.poolAddress === poolAddress);
  return match?.binanceSymbol || pair;
}

function rowToSideCfg(row: {
  averagingDepth: number;
  slBasePercent: number;
  slAtrMultiplier: number;
  slFloor: number;
  slCap: number;
  tier1Size: number;
  tier2Size: number;
  tier3Size: number;
  cooldownCandles: number;
  retryCap: number;
  hibernationCandles: number;
}): ComboBotSideConfig {
  return {
    averagingDepth: row.averagingDepth,
    slBasePercent: row.slBasePercent,
    slAtrMultiplier: row.slAtrMultiplier,
    slFloor: row.slFloor,
    slCap: row.slCap,
    tier1Size: row.tier1Size,
    tier2Size: row.tier2Size,
    tier3Size: row.tier3Size,
    cooldownCandles: row.cooldownCandles,
    retryCap: row.retryCap,
    hibernationCandles: row.hibernationCandles,
  };
}

/**
 * Combo simulation runner — the DB-facing wrapper around `runComboSimulationCore`.
 * Loads config/candles/funding rates/anchor, runs the supervisor, writes results.
 */
export async function runComboSimulationFromDb(simulationId: string): Promise<void> {
  const sim = await prisma.simulation.findUnique({
    where: { id: simulationId },
    include: {
      gridConfigs: true,
      comboConfigs: true,
      avwapAnchor: true,
    },
  });
  if (!sim) throw new Error(`Simulation ${simulationId} not found`);
  if (!sim.comboBotEnabled) throw new Error('Combo supervisor called for non-combo simulation');

  await prisma.simulation.update({
    where: { id: simulationId },
    data: { status: 'running' },
  });

  try {
    const binanceSymbol = getBinanceSymbol(sim.poolAddress, sim.pair);
    const candles5m = await getCachedCandles(binanceSymbol, '5m', sim.startTime, sim.endTime);
    if (candles5m.length === 0) {
      throw new Error(
        `No cached candles for ${binanceSymbol} between ${sim.startTime.toISOString()} and ${sim.endTime.toISOString()}. Use the Data Manager to download.`
      );
    }
    const candles1h = aggregate5mTo(candles5m, 60);
    const candles4h = aggregate5mTo(candles5m, 240);

    const longSideRow = sim.comboConfigs.find(c => c.side === 'long');
    const shortSideRow = sim.comboConfigs.find(c => c.side === 'short');

    const mode = (sim.comboMode ?? 'dual') as ComboMode;
    const totalGridCapital = sim.gridConfigs.reduce((acc, c) => acc + c.totalCapital, 0);
    const totalCapital = totalGridCapital > 0 ? totalGridCapital : 10000;

    const cfg: ComboBotConfig = {
      enabled: true,
      mode,
      leverage: sim.comboLeverage ?? 5,
      allocationLong: sim.comboAllocationLong ?? 0.6,
      avwapEnabled: sim.comboAvwapEnabled,
      reopenPolicy: 'full_v31',
      totalCapital,
      gridLevels: 10,
      longSide: longSideRow ? rowToSideCfg(longSideRow) : undefined,
      shortSide: shortSideRow ? rowToSideCfg(shortSideRow) : undefined,
      atrPeriod: 14,
      erLookback: 10,
      erSmoothingLength: 3,
      erRegimeThreshold: 0.6,
      rsiLongThreshold: 35,
      rsiShortThreshold: 65,
    };

    const fundingRates = await getCachedFundingRates(binanceSymbol, sim.startTime, sim.endTime);

    const resumeAnchor = sim.avwapAnchor
      ? {
          candleIdx: sim.avwapAnchor.anchorCandleIdx,
          timestamp: Math.floor(sim.avwapAnchor.anchorTimestamp.getTime() / 1000),
          typicalPrice: sim.avwapAnchor.anchorTypicalPrice,
          volume: sim.avwapAnchor.anchorVolume,
        }
      : null;

    const result = runComboSimulationCore({
      candles5m,
      candles1h,
      candles4h,
      cfg,
      totalCapital,
      fundingRates,
      feeRate: sim.feeRate,
      resumeAnchor,
    });

    await persistComboResults(simulationId, result, totalCapital, candles5m);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await prisma.simulation.update({
      where: { id: simulationId },
      data: { status: 'failed', errorMessage: message },
    });
    throw error;
  }
}

async function persistComboResults(
  simulationId: string,
  result: Awaited<ReturnType<typeof runComboSimulationCore>>,
  totalCapital: number,
  candles5m: OHLC[]
): Promise<void> {
  const batchSize = 500;
  const { fills, snapshots, events, pnlState, finalAnchor } = result;

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
      pairedOrderId: null,
      pnl: f.pnl ?? null,
      pnlPct: f.pnlPct ?? null,
      fees: f.fees,
      sizeMultiplier: 1.0,
    }));
    for (let i = 0; i < orderData.length; i += batchSize) {
      await prisma.gridOrder.createMany({ data: orderData.slice(i, i + batchSize) });
    }
  }

  if (snapshots.length > 0) {
    const snapData = snapshots.map(s => ({
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
    for (let i = 0; i < snapData.length; i += batchSize) {
      await prisma.pnlSnapshot.createMany({ data: snapData.slice(i, i + batchSize) });
    }
  }

  if (events.length > 0) {
    await prisma.adaptiveEvent.createMany({
      data: events.map(e => ({
        simulationId,
        candleIdx: e.candleIdx,
        timestamp: new Date(e.timestamp * 1000),
        eventType: e.type,
        detailsJson: e.detailsJson,
        longMultiplier: e.longMultiplier,
        shortMultiplier: e.shortMultiplier,
      })),
    });
  }

  if (finalAnchor) {
    await prisma.aVWAPAnchor.upsert({
      where: { simulationId },
      create: {
        simulationId,
        anchorCandleIdx: finalAnchor.candleIdx,
        anchorTimestamp: new Date(finalAnchor.timestamp * 1000),
        anchorTypicalPrice: finalAnchor.typicalPrice,
        anchorVolume: finalAnchor.volume,
      },
      update: {
        anchorCandleIdx: finalAnchor.candleIdx,
        anchorTimestamp: new Date(finalAnchor.timestamp * 1000),
        anchorTypicalPrice: finalAnchor.typicalPrice,
        anchorVolume: finalAnchor.volume,
      },
    });
  }

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
      finalEquity: totalCapital + pnlState.realizedPnl,
      totalCandles: candles5m.length,
    },
  });
}
