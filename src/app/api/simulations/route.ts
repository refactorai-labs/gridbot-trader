import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { SimulationConfig, DCASimulationConfig, ComboBotConfig } from '@/lib/types';
import { runSimulation } from '@/lib/simulation/engine';
import { runDCASimulation } from '@/lib/simulation/dcaEngine';
import { getOrFetchCandles } from '@/lib/data/candleCache';

// POST: Create and run a new simulation
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Route to DCA simulation if strategyType is 'dca'
    if (body.strategyType === 'dca') {
      return handleDCASimulation(body);
    }

    // Existing grid simulation path
    const config: SimulationConfig = body;

    // Validate required fields
    if (!config.pair || !config.startTime || !config.endTime) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const combo = config.combo;

    // Create simulation record
    const simulation = await prisma.simulation.create({
      data: {
        name: config.name || 'Untitled Simulation',
        pair: config.pair,
        poolAddress: config.poolAddress,
        chain: config.chain || 'eth',
        startTime: new Date(config.startTime),
        endTime: new Date(config.endTime),
        timeframe: config.timeframe || '1h',
        feeRate: config.feeRate ?? 0.001,
        adaptiveEnabled: config.adaptiveEnabled ?? true,
        emaPeriod: config.emaPeriod ?? 50,
        volumeMultiplier: config.volumeMultiplier ?? 1.5,
        comboBotEnabled: combo?.enabled ?? false,
        comboMode: combo?.enabled ? combo.mode : null,
        comboLeverage: combo?.leverage ?? 5,
        comboAllocationLong: combo?.allocationLong ?? 0.6,
        comboAvwapEnabled: combo?.avwapEnabled ?? true,
        gridConfigs: {
          create: [
            {
              side: 'long',
              gridLevels: config.longConfig.gridLevels,
              gridType: config.longConfig.gridType,
              upperBound: config.longConfig.upperBound,
              lowerBound: config.longConfig.lowerBound,
              orderSizeType: config.longConfig.orderSizeType,
              orderSize: config.longConfig.orderSize,
              totalCapital: config.longConfig.totalCapital,
              profitMode: config.longConfig.profitMode,
              customProfitDistance: config.longConfig.customProfitDistance,
            },
            {
              side: 'short',
              gridLevels: config.shortConfig.gridLevels,
              gridType: config.shortConfig.gridType,
              upperBound: config.shortConfig.upperBound,
              lowerBound: config.shortConfig.lowerBound,
              orderSizeType: config.shortConfig.orderSizeType,
              orderSize: config.shortConfig.orderSize,
              totalCapital: config.shortConfig.totalCapital,
              profitMode: config.shortConfig.profitMode,
              customProfitDistance: config.shortConfig.customProfitDistance,
            },
          ],
        },
        ...(combo?.enabled ? {
          comboConfigs: {
            create: [
              combo.longSide ? { side: 'long', ...combo.longSide } : null,
              combo.shortSide ? { side: 'short', ...combo.shortSide } : null,
            ].filter(Boolean) as Array<NonNullable<ComboBotConfig['longSide']> & { side: string }>,
          },
        } : {}),
      },
    });

    // Run simulation (fire and forget — client polls for status)
    runSimulation(simulation.id).catch(err => {
      console.error(`Simulation ${simulation.id} failed:`, err);
    });

    return NextResponse.json({
      id: simulation.id,
      status: 'running',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleDCASimulation(body: DCASimulationConfig & { strategyType: string }) {
  const config: DCASimulationConfig = body;

  if (!config.pair || !config.startTime || !config.endTime) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  if (!config.longConfig && !config.shortConfig) {
    return NextResponse.json({ error: 'At least one direction config required' }, { status: 400 });
  }

  // Fetch 5m candles
  const candles5m = await getOrFetchCandles(
    config.pair,
    '5m',
    new Date(config.startTime),
    new Date(config.endTime)
  );

  if (candles5m.length === 0) {
    return NextResponse.json({ error: 'No candle data available for the specified range' }, { status: 400 });
  }

  // Run DCA simulation
  const result = await runDCASimulation(config, candles5m);

  // Store trade results in DCATradeLog
  if (result.trades.length > 0) {
    const simulationId = `dca_${Date.now()}`;
    await prisma.dCATradeLog.createMany({
      data: result.trades.map(t => ({
        simulationId,
        tradeNumber: t.tradeNumber,
        direction: t.direction,
        baseOrderPrice: t.baseOrderPrice,
        baseOrderSize: t.baseOrderSize,
        avgEntryPrice: t.avgEntryPrice,
        safetyOrdersFilled: t.safetyOrdersFilled,
        closePrice: t.closePrice,
        closeReason: t.closeReason,
        pnl: t.pnl,
        pnlPercent: t.pnlPercent,
        openTime: BigInt(Math.floor(t.openTime * 1000)),
        closeTime: BigInt(Math.floor(t.closeTime * 1000)),
        durationMinutes: Math.floor(t.durationMinutes),
      })),
    });
  }

  return NextResponse.json({
    status: 'completed',
    trades: result.trades,
    snapshots: result.snapshots,
    metrics: result.metrics,
    candleCount: candles5m.length,
  });
}

// GET: List all simulations
export async function GET() {
  try {
    const simulations = await prisma.simulation.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        pair: true,
        timeframe: true,
        status: true,
        createdAt: true,
        startTime: true,
        endTime: true,
        totalPnl: true,
        totalPnlPct: true,
        longPnl: true,
        shortPnl: true,
        totalTrades: true,
        maxDrawdown: true,
        maxDrawdownPct: true,
        totalCandles: true,
        winCount: true,
        lossCount: true,
      },
    });

    return NextResponse.json({ simulations });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
