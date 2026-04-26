import { NextRequest, NextResponse } from 'next/server';
import { getCachedCandles } from '@/lib/data/candleCache';
import { getCachedFundingRates } from '@/lib/data/fundingCache';
import { runWalkForwardCombo, WalkForwardComboConfig } from '@/lib/optimizer/walkForwardCombo';
import { ComboBotConfig } from '@/lib/types';

// One Optuna trial = one POST to this endpoint = one full walk-forward run.
// Returns the stitched-OOS fitness the optimizer will maximize.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      symbol: string;
      startTime: string;
      endTime: string;
      trainCandles: number;
      oosCandles: number;
      stepCandles: number;
      comboCfg: ComboBotConfig;
      totalCapital: number;
      feeRate: number;
    };

    const { symbol, startTime, endTime, trainCandles, oosCandles, stepCandles, comboCfg, totalCapital, feeRate } = body;

    if (!symbol || !startTime || !endTime) {
      return NextResponse.json({ error: 'Missing symbol / startTime / endTime' }, { status: 400 });
    }

    const candles5m = await getCachedCandles(symbol, '5m', new Date(startTime), new Date(endTime));
    if (candles5m.length === 0) {
      return NextResponse.json({ error: 'No candles cached for the requested window' }, { status: 404 });
    }
    const fundingRates = await getCachedFundingRates(symbol, new Date(startTime), new Date(endTime));

    const cfg: WalkForwardComboConfig = {
      candles5m,
      trainCandles,
      oosCandles,
      stepCandles,
      comboCfg,
      totalCapital,
      feeRate,
      fundingRates,
    };

    const result = runWalkForwardCombo(cfg);

    // Trim per-fold return arrays in the response — Optuna only needs the summary.
    const summaryFolds = result.folds.map(f => ({
      foldIndex: f.foldIndex,
      trainStartIdx: f.trainStartIdx,
      trainEndIdx: f.trainEndIdx,
      oosStartIdx: f.oosStartIdx,
      oosEndIdx: f.oosEndIdx,
      oosTrades: f.oosTrades,
      oosMaxDrawdownPct: f.oosMaxDrawdownPct,
      oosFinalPnl: f.oosFinalPnl,
      oosReturnCount: f.oosReturns.length,
    }));

    return NextResponse.json({
      success: true,
      folds: summaryFolds,
      stitched: result.stitched,
      foldStabilityScore: result.foldStabilityScore,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
