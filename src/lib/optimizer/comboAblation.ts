import { OHLC, ComboBotConfig, GridSide, ReopenPolicyName } from '../types';
import { aggregate5mTo } from '../data/aggregator';
import { runComboSimulationCore } from '../combo/supervisor';
import { FundingRateEntry } from '../simulation/funding';
import { calculateUnrealizedPnl } from '../simulation/pnlTracker';
import { FoldPerformance, stitchedFitness, StitchedFitnessResult } from './stitchedFitness';

export interface ComboAblationInput {
  candles5m: OHLC[];
  baseConfig: ComboBotConfig;
  totalCapital: number;
  feeRate: number;
  fundingRates?: FundingRateEntry[];
  policies?: ReopenPolicyName[];
  avwapOptions?: boolean[];
}

export interface ComboAblationSideMetrics {
  stopOuts: number;
  reopenAttempts: number;
  successfulReopens: number;
  falseReopens: number;
  cooldownCandles: number;
  hibernationCandles: number;
  realizedPnl: number;
  unrealizedPnl: number;
  maxDrawdownPct: number;
  fundingCost: number;
  slippageCost: number;
  tradeCount: number;
}

export interface ComboAblationRun {
  policy: ReopenPolicyName;
  avwapEnabled: boolean;
  long: ComboAblationSideMetrics;
  short: ComboAblationSideMetrics;
  stitched: StitchedFitnessResult;
}

const DEFAULT_POLICIES: ReopenPolicyName[] = ['mvp_current', 'atr_rsi', 'atr_rsi_avwap', 'full_v31'];
const DEFAULT_AVWAP_OPTIONS = [true, false];

function emptySideMetrics(): ComboAblationSideMetrics {
  return {
    stopOuts: 0,
    reopenAttempts: 0,
    successfulReopens: 0,
    falseReopens: 0,
    cooldownCandles: 0,
    hibernationCandles: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    maxDrawdownPct: 0,
    fundingCost: 0,
    slippageCost: 0,
    tradeCount: 0,
  };
}

function parseDetails(detailsJson: string): { side?: GridSide } {
  try {
    const parsed = JSON.parse(detailsJson) as { side?: GridSide };
    return parsed && (parsed.side === 'long' || parsed.side === 'short') ? parsed : {};
  } catch {
    return {};
  }
}

function returnsFromEquity(snapshots: { equity: number }[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].equity;
    returns.push(prev > 0 ? (snapshots[i].equity - prev) / prev : 0);
  }
  return returns;
}

function eventMetrics(
  events: { candleIdx: number; type: string; detailsJson: string }[],
  finalCandleIdx: number,
): Record<GridSide, Pick<ComboAblationSideMetrics,
  'stopOuts' | 'reopenAttempts' | 'successfulReopens' | 'falseReopens' | 'cooldownCandles' | 'hibernationCandles'
>> {
  const metrics = {
    long: {
      stopOuts: 0,
      reopenAttempts: 0,
      successfulReopens: 0,
      falseReopens: 0,
      cooldownCandles: 0,
      hibernationCandles: 0,
    },
    short: {
      stopOuts: 0,
      reopenAttempts: 0,
      successfulReopens: 0,
      falseReopens: 0,
      cooldownCandles: 0,
      hibernationCandles: 0,
    },
  };
  const cooldownStart: Record<GridSide, number | null> = { long: null, short: null };
  const hibernationStart: Record<GridSide, number | null> = { long: null, short: null };
  const reopeningActive: Record<GridSide, boolean> = { long: false, short: false };

  for (const event of events) {
    const side = parseDetails(event.detailsJson).side;
    if (!side) continue;
    const sideMetrics = metrics[side];

    if (event.type === 'sl_triggered') {
      sideMetrics.stopOuts++;
      if (reopeningActive[side]) sideMetrics.falseReopens++;
      reopeningActive[side] = false;
    } else if (event.type === 'cooldown_entered') {
      cooldownStart[side] = event.candleIdx;
    } else if (event.type === 'retry_incremented') {
      sideMetrics.reopenAttempts++;
    } else if (event.type === 'tier1_reopen') {
      reopeningActive[side] = true;
      if (cooldownStart[side] !== null) {
        sideMetrics.cooldownCandles += Math.max(0, event.candleIdx - cooldownStart[side]);
        cooldownStart[side] = null;
      }
    } else if (event.type === 'tier3_scale') {
      sideMetrics.successfulReopens++;
      reopeningActive[side] = false;
    } else if (event.type === 'hibernation_entered') {
      if (cooldownStart[side] !== null) {
        sideMetrics.cooldownCandles += Math.max(0, event.candleIdx - cooldownStart[side]);
        cooldownStart[side] = null;
      }
      hibernationStart[side] = event.candleIdx;
    } else if (event.type === 'hibernation_exit') {
      if (hibernationStart[side] !== null) {
        sideMetrics.hibernationCandles += Math.max(0, event.candleIdx - hibernationStart[side]);
        hibernationStart[side] = null;
      }
    }
  }

  for (const side of ['long', 'short'] as const) {
    if (cooldownStart[side] !== null) {
      metrics[side].cooldownCandles += Math.max(0, finalCandleIdx - cooldownStart[side]);
    }
    if (hibernationStart[side] !== null) {
      metrics[side].hibernationCandles += Math.max(0, finalCandleIdx - hibernationStart[side]);
    }
  }

  return metrics;
}

export function runComboAblation(input: ComboAblationInput): ComboAblationRun[] {
  if (input.candles5m.length === 0) {
    throw new Error('Combo ablation requires at least one cached 5m candle');
  }

  const candles1h = aggregate5mTo(input.candles5m, 60);
  const candles4h = aggregate5mTo(input.candles5m, 240);
  const policies = input.policies ?? DEFAULT_POLICIES;
  const avwapOptions = input.avwapOptions ?? DEFAULT_AVWAP_OPTIONS;
  const runs: ComboAblationRun[] = [];

  for (const policy of policies) {
    for (const avwapEnabled of avwapOptions) {
      const cfg: ComboBotConfig = {
        ...input.baseConfig,
        reopenPolicy: policy,
        avwapEnabled,
        longSide: input.baseConfig.longSide ? { ...input.baseConfig.longSide } : undefined,
        shortSide: input.baseConfig.shortSide ? { ...input.baseConfig.shortSide } : undefined,
      };
      const result = runComboSimulationCore({
        candles5m: input.candles5m,
        candles1h,
        candles4h,
        cfg,
        totalCapital: input.totalCapital,
        feeRate: input.feeRate,
        fundingRates: input.fundingRates ?? [],
      });
      const finalPrice = input.candles5m[input.candles5m.length - 1].close;
      const unrealized = calculateUnrealizedPnl(result.pnlState, finalPrice);
      const finalCandleIdx = input.candles5m.length - 1;
      const lifecycle = eventMetrics(result.events, finalCandleIdx);
      const returns = returnsFromEquity(result.snapshots);
      const nTrades = result.fills.filter(f => (f.pnl ?? 0) !== 0).length;
      const foldPerf: FoldPerformance = {
        returns,
        nTrades,
        maxDrawdownPct: result.pnlState.maxDrawdownPct / 100,
      };
      const commonMaxDd = result.pnlState.maxDrawdownPct;

      runs.push({
        policy,
        avwapEnabled,
        long: {
          ...emptySideMetrics(),
          ...lifecycle.long,
          realizedPnl: result.pnlState.longRealizedPnl,
          unrealizedPnl: unrealized.long,
          maxDrawdownPct: commonMaxDd,
          fundingCost: result.longFundingCost,
          slippageCost: result.longSlippageCost,
          tradeCount: result.fills.filter(f => f.side === 'long').length,
        },
        short: {
          ...emptySideMetrics(),
          ...lifecycle.short,
          realizedPnl: result.pnlState.shortRealizedPnl,
          unrealizedPnl: unrealized.short,
          maxDrawdownPct: commonMaxDd,
          fundingCost: result.shortFundingCost,
          slippageCost: result.shortSlippageCost,
          tradeCount: result.fills.filter(f => f.side === 'short').length,
        },
        stitched: stitchedFitness([foldPerf]),
      });
    }
  }

  return runs;
}

