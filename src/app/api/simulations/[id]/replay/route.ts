import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getCachedCandles, getTimeframeMinutes } from '@/lib/data/candleCache';
import { aggregate5mTo } from '@/lib/data/aggregator';
import { SUPPORTED_PAIRS } from '@/lib/constants';
import { generateGridLevels } from '@/lib/simulation/gridGenerator';

// GET: Fetch replay data for a simulation
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { searchParams } = new URL(request.url);
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');

    const simulation = await prisma.simulation.findUnique({
      where: { id: params.id },
      include: { gridConfigs: true, avwapAnchor: true },
    });

    if (!simulation) {
      return NextResponse.json({ error: 'Simulation not found' }, { status: 404 });
    }

    if (simulation.status !== 'completed') {
      return NextResponse.json({
        error: 'Simulation not completed',
        status: simulation.status,
      }, { status: 400 });
    }

    // Load 5m candles and aggregate to sim timeframe (matches engine behavior).
    // Combo simulations persist fillCandleIdx + AdaptiveEvent.candleIdx in 5m-index space
    // (supervisor loop runs over candles5m), so replay MUST return 5m candles for combo
    // regardless of the configured grid timeframe — otherwise indexes point past the array.
    const pairConfig = SUPPORTED_PAIRS.find(p => p.poolAddress === simulation.poolAddress);
    const binanceSymbol = pairConfig?.binanceSymbol || simulation.pair;
    const candles5m = await getCachedCandles(
      binanceSymbol, '5m',
      simulation.startTime, simulation.endTime
    );
    if (candles5m.length === 0) {
      return NextResponse.json({
        error: `No cached candles for ${binanceSymbol} between ${simulation.startTime.toISOString()} and ${simulation.endTime.toISOString()}. Use the Data Manager to download.`,
      }, { status: 404 });
    }
    const simTimeframeMins = simulation.comboBotEnabled ? 5 : getTimeframeMinutes(simulation.timeframe);
    const candles = simTimeframeMins === 5 ? candles5m : aggregate5mTo(candles5m, simTimeframeMins);

    // Compute range — default to all candles when no params given
    const from = fromParam ? parseInt(fromParam) : 0;
    const to = toParam ? parseInt(toParam) : candles.length - 1;

    // Slice candles to requested range
    const slicedCandles = candles.slice(from, to + 1);

    // Load grid orders (fills in this range)
    const gridOrders = await prisma.gridOrder.findMany({
      where: {
        simulationId: params.id,
        fillCandleIdx: { gte: from, lte: to },
      },
      orderBy: { fillCandleIdx: 'asc' },
      select: {
        id: true,
        side: true,
        level: true,
        levelPrice: true,
        orderType: true,
        status: true,
        fillPrice: true,
        fillCandleIdx: true,
        pnl: true,
      },
    });

    // Load P&L snapshots
    const pnlSnapshots = await prisma.pnlSnapshot.findMany({
      where: {
        simulationId: params.id,
        candleIdx: { gte: from, lte: to },
      },
      orderBy: { candleIdx: 'asc' },
    });

    // Load adaptive events
    const adaptiveEvents = await prisma.adaptiveEvent.findMany({
      where: {
        simulationId: params.id,
        candleIdx: { gte: from, lte: to },
      },
      orderBy: { candleIdx: 'asc' },
    });

    // Generate grid levels for display.
    // Combo bot uses ATR-based dynamic grids (not the saved GridConfiguration bounds),
    // so return empty arrays — fills are the primary visual in combo mode.
    const longConfig = simulation.gridConfigs.find(c => c.side === 'long');
    const shortConfig = simulation.gridConfigs.find(c => c.side === 'short');

    const longLevels = !simulation.comboBotEnabled && longConfig
      ? generateGridLevels(
          longConfig.lowerBound, longConfig.upperBound,
          longConfig.gridLevels, 'long',
          longConfig.gridType as 'arithmetic' | 'geometric'
        )
      : [];

    const shortLevels = !simulation.comboBotEnabled && shortConfig
      ? generateGridLevels(
          shortConfig.lowerBound, shortConfig.upperBound,
          shortConfig.gridLevels, 'short',
          shortConfig.gridType as 'arithmetic' | 'geometric'
        )
      : [];

    return NextResponse.json({
      candles: slicedCandles,
      pnlSnapshots: pnlSnapshots.map(s => ({
        candleIdx: s.candleIdx,
        timestamp: Math.floor(s.timestamp.getTime() / 1000),
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
      })),
      gridOrders: gridOrders.map(o => ({
        id: o.id,
        side: o.side,
        level: o.level,
        levelPrice: o.levelPrice,
        orderType: o.orderType,
        status: o.status,
        fillPrice: o.fillPrice,
        fillCandleIdx: o.fillCandleIdx,
        pnl: o.pnl,
      })),
      adaptiveEvents: adaptiveEvents.map(ae => ({
        candleIdx: ae.candleIdx,
        timestamp: Math.floor(ae.timestamp.getTime() / 1000),
        eventType: ae.eventType,
        detailsJson: ae.detailsJson,
        longMultiplier: ae.longMultiplier,
        shortMultiplier: ae.shortMultiplier,
      })),
      longLevels,
      shortLevels,
      totalCandles: candles.length,
      avwapAnchor: simulation.avwapAnchor ? {
        candleIdx: simulation.avwapAnchor.anchorCandleIdx,
        timestamp: Math.floor(simulation.avwapAnchor.anchorTimestamp.getTime() / 1000),
        typicalPrice: simulation.avwapAnchor.anchorTypicalPrice,
        volume: simulation.avwapAnchor.anchorVolume,
      } : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
