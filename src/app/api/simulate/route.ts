// Headless simulation endpoint — runs DCA simulation and returns metrics only
// Used by the optimizer for parameter search (no database writes)

import { NextRequest, NextResponse } from 'next/server';
import { DCASimulationConfig, OHLC } from '@/lib/types';
import { runDCASimulation } from '@/lib/simulation/dcaEngine';
import { getCachedCandles } from '@/lib/data/candleCache';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { strategyType, config, candles: providedCandles } = body as {
      strategyType: 'dca';
      config: DCASimulationConfig;
      candles?: OHLC[];
    };

    if (strategyType !== 'dca') {
      return NextResponse.json({ error: 'Only dca strategy supported' }, { status: 400 });
    }

    if (!config || (!config.longConfig && !config.shortConfig)) {
      return NextResponse.json({ error: 'At least one direction config required' }, { status: 400 });
    }

    // Use provided candles or fetch from cache
    let candles5m: OHLC[];
    if (providedCandles && providedCandles.length > 0) {
      candles5m = providedCandles;
    } else {
      if (!config.pair || !config.startTime || !config.endTime) {
        return NextResponse.json({ error: 'Missing pair/startTime/endTime and no candles provided' }, { status: 400 });
      }
      candles5m = await getCachedCandles(
        config.pair, '5m',
        new Date(config.startTime), new Date(config.endTime)
      );
    }

    if (candles5m.length === 0) {
      return NextResponse.json({ error: 'No candle data available' }, { status: 400 });
    }

    // Run simulation synchronously
    const result = await runDCASimulation(config, candles5m);

    return NextResponse.json({
      metrics: result.metrics,
      trades: result.trades,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
