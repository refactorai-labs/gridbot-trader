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
      include: { gridConfigs: true },
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

    // Load 5m candles and aggregate to sim timeframe (matches engine behavior)
    const pairConfig = SUPPORTED_PAIRS.find(p => p.poolAddress === simulation.poolAddress);
    const binanceSymbol = pairConfig?.binanceSymbol || simulation.pair;
    const candles5m = await getCachedCandles(
      binanceSymbol, '5m',
      simulation.startTime, simulation.endTime
    );
    const simTimeframeMins = getTimeframeMinutes(simulation.timeframe);
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

    // Generate grid levels for display
    const longConfig = simulation.gridConfigs.find(c => c.side === 'long');
    const shortConfig = simulation.gridConfigs.find(c => c.side === 'short');

    const longLevels = longConfig
      ? generateGridLevels(
          longConfig.lowerBound, longConfig.upperBound,
          longConfig.gridLevels, 'long',
          longConfig.gridType as 'arithmetic' | 'geometric'
        )
      : [];

    const shortLevels = shortConfig
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
