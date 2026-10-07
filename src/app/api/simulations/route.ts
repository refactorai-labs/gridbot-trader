import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { SimulationConfig, DCASimulationConfig, ComboBotConfig, GridSideConfig } from '@/lib/types';
import { runSimulation } from '@/lib/simulation/engine';
import { generateGridLevels } from '@/lib/simulation/gridGenerator';
import { CLASSIC_ENGINE_VERSION } from '@/lib/simulation/classicGridTypes';
import { TIMEFRAMES } from '@/lib/constants';
import { normalizeExecutionWindow } from '@/lib/data/executionWindow';
import { runDCASimulation } from '@/lib/simulation/dcaEngine';
import { getOrFetchCandles } from '@/lib/data/candleCache';
import { clampGridLevels } from '@/lib/combo/sizing';

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
    const isClassic = !combo?.enabled;

    if (isClassic) {
      const error = validateClassicConfig(config);
      if (error) return NextResponse.json({ error }, { status: 400 });
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
        adaptiveEnabled: config.adaptiveEnabled ?? !isClassic,
        emaPeriod: config.emaPeriod ?? 50,
        volumeMultiplier: config.volumeMultiplier ?? 1.5,
        comboBotEnabled: combo?.enabled ?? false,
        comboMode: combo?.enabled ? combo.mode : null,
        comboLeverage: combo?.leverage ?? 5,
        comboAllocationLong: combo?.allocationLong ?? 0.6,
        comboAvwapEnabled: combo?.avwapEnabled ?? true,
        comboGridLevels: clampGridLevels(combo?.gridLevels),
        requireDirectionalConfirmation: combo?.requireDirectionalConfirmation ?? false,
        ...(isClassic ? { engineVersion: CLASSIC_ENGINE_VERSION } : {}),
        gridConfigs: {
          create: [
            {
              side: 'long',
              ...(isClassic ? { enabled: config.longConfig.enabled ?? true } : {}),
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
              ...(isClassic ? { enabled: config.shortConfig.enabled ?? true } : {}),
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

// Classic grid request validation (checkpoint 1). Returns an error message or null.
// Disabled sides are stored as sent and never bounds-checked.
function validateClassicConfig(config: SimulationConfig): string | null {
  const start = Date.parse(config.startTime);
  const end = Date.parse(config.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Start and end dates must be valid dates';
  if (start >= end) return 'Start date must be before end date';
  try {
    normalizeExecutionWindow(start, end, Date.now());   // same window rule as the page and engine (Contract E)
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid execution window';
  }

  const timeframe = config.timeframe || '1h';
  if (!TIMEFRAMES.some(t => t.value === timeframe)) return `Unsupported timeframe "${timeframe}"`;

  const feeRate = config.feeRate ?? 0.001;
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate) || feeRate < 0) return 'Fee rate must be a finite number ≥ 0';

  if (config.adaptiveEnabled === true) {
    return 'The adaptive layer is not available until checkpoint 3; switch it off in the panel';
  }

  if (!config.longConfig || !config.shortConfig) return 'Missing long/short grid configuration';
  const sides: [string, GridSideConfig][] = [['Long', config.longConfig], ['Short', config.shortConfig]];
  const enabled = sides.filter(([, c]) => c.enabled ?? true);
  if (enabled.length === 0) return 'Enable at least one side (Long or Short)';

  const isPositive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  for (const [label, c] of enabled) {
    if (c.orderSizeType === 'percent') {
      return `${label}: percent order size is not available until checkpoint 2; switch it off in the panel`;
    }
    if (c.profitMode === 'custom') {
      return `${label}: custom profit target is not available until checkpoint 2; switch it off in the panel`;
    }
    if (!isPositive(c.lowerBound) || !isPositive(c.upperBound) || c.lowerBound >= c.upperBound) {
      return `${label}: bounds must satisfy 0 < lower < upper`;
    }
    if (!Number.isInteger(c.gridLevels) || c.gridLevels < 2 || c.gridLevels > 2000) {
      return `${label}: grid levels must be an integer between 2 and 2000`;
    }
    if (!isPositive(c.orderSize)) return `${label}: order size must be a positive number`;
    if (!isPositive(c.totalCapital)) return `${label}: total capital must be a positive number`;
    const levels = generateGridLevels(c.lowerBound, c.upperBound, c.gridLevels, c.side, c.gridType);
    if (levels.some((l, i) => i > 0 && l.price <= levels[i - 1].price)) {
      return `${label}: grid levels are too close together (prices must be strictly increasing)`;
    }
  }
  return null;
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
    return NextResponse.json({
      error: `No candle data available for ${config.pair} between ${new Date(config.startTime).toISOString()} and ${new Date(config.endTime).toISOString()} (Binance returned no klines).`,
    }, { status: 400 });
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
        engineVersion: true,
        comboBotEnabled: true,
        finalEquity: true,
      },
    });

    return NextResponse.json({ simulations });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
