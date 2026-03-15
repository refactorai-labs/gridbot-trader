import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { SimulationConfig } from '@/lib/types';
import { runSimulation } from '@/lib/simulation/engine';

// POST: Create and run a new simulation
export async function POST(request: NextRequest) {
  try {
    const config: SimulationConfig = await request.json();

    // Validate required fields
    if (!config.pair || !config.startTime || !config.endTime) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

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
