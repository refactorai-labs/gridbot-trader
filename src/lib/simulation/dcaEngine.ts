// DCA simulation engine — runs DCA breakout strategy over candle data

import { OHLC, DCASimulationConfig, DCATradeRecord, StrategyMetrics } from '../types';
import { DCATradeSnapshot } from '../strategies/dcaTypes';
import { DCABreakoutStrategy } from '../strategies/dcaBreakout';

export interface DCASimulationResult {
  trades: DCATradeRecord[];
  snapshots: DCATradeSnapshot[];
  metrics: StrategyMetrics;
}

function runSingleDirection(
  config: DCASimulationConfig,
  candles5m: OHLC[],
  directionConfig: NonNullable<DCASimulationConfig['longConfig']>
): DCASimulationResult {
  const strategy = new DCABreakoutStrategy(directionConfig, config.feeRate);
  strategy.initialize(candles5m);

  // Determine snapshot interval — cap at ~2000 snapshots
  const snapshotInterval = Math.max(1, Math.floor(candles5m.length / 2000));

  for (let i = 0; i < candles5m.length; i++) {
    strategy.onCandle(candles5m[i], i);

    // Record snapshot periodically
    if (i % snapshotInterval === 0 || i === candles5m.length - 1) {
      const snapshot = strategy.createSnapshot(candles5m[i], i);
      strategy.addSnapshot(snapshot);
    }
  }

  // Close any open trade at end of data
  if (candles5m.length > 0) {
    strategy.closeOpenTrade(candles5m[candles5m.length - 1], candles5m.length - 1);
  }

  return {
    trades: strategy.getTradeRecords(),
    snapshots: strategy.getDCASnapshots(),
    metrics: strategy.getMetrics(),
  };
}

function combineMetrics(a: StrategyMetrics, b: StrategyMetrics): StrategyMetrics {
  const totalTrades = a.totalTrades + b.totalTrades;
  const totalPnl = a.totalPnl + b.totalPnl;

  // Combine returns for Sharpe calculation
  const combinedCapital = (a.totalPnlPct !== 0 ? a.totalPnl / (a.totalPnlPct / 100) : 0)
    + (b.totalPnlPct !== 0 ? b.totalPnl / (b.totalPnlPct / 100) : 0);
  const totalPnlPct = combinedCapital > 0 ? (totalPnl / combinedCapital) * 100 : 0;

  const grossProfit =
    (a.profitFactor > 0 && a.profitFactor !== Infinity ? a.totalPnl > 0 ? a.avgTradePnl * a.winCount : 0 : a.totalPnl > 0 ? a.totalPnl : 0)
    + (b.profitFactor > 0 && b.profitFactor !== Infinity ? b.totalPnl > 0 ? b.avgTradePnl * b.winCount : 0 : b.totalPnl > 0 ? b.totalPnl : 0);
  const grossLoss =
    Math.abs(a.avgTradePnl * a.lossCount) + Math.abs(b.avgTradePnl * b.lossCount);

  return {
    totalPnl,
    totalPnlPct,
    totalTrades,
    winCount: a.winCount + b.winCount,
    lossCount: a.lossCount + b.lossCount,
    maxDrawdown: Math.max(a.maxDrawdown, b.maxDrawdown),
    maxDrawdownPct: Math.max(a.maxDrawdownPct, b.maxDrawdownPct),
    sharpeRatio: (a.sharpeRatio + b.sharpeRatio) / 2, // simple average
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgTradePnl: totalTrades > 0 ? totalPnl / totalTrades : 0,
    avgTradeDuration: totalTrades > 0
      ? (a.avgTradeDuration * a.totalTrades + b.avgTradeDuration * b.totalTrades) / totalTrades
      : 0,
  };
}

export async function runDCASimulation(
  config: DCASimulationConfig,
  candles5m: OHLC[]
): Promise<DCASimulationResult> {
  const results: DCASimulationResult[] = [];

  if (config.longConfig) {
    results.push(runSingleDirection(config, candles5m, config.longConfig));
  }

  if (config.shortConfig) {
    results.push(runSingleDirection(config, candles5m, config.shortConfig));
  }

  if (results.length === 0) {
    return {
      trades: [],
      snapshots: [],
      metrics: {
        totalPnl: 0, totalPnlPct: 0, totalTrades: 0,
        winCount: 0, lossCount: 0,
        maxDrawdown: 0, maxDrawdownPct: 0,
        sharpeRatio: 0, profitFactor: 0,
        avgTradePnl: 0, avgTradeDuration: 0,
      },
    };
  }

  if (results.length === 1) {
    return results[0];
  }

  // Combine long + short results
  return {
    trades: [...results[0].trades, ...results[1].trades].sort((a, b) => a.openTime - b.openTime),
    snapshots: [...results[0].snapshots, ...results[1].snapshots].sort((a, b) => a.timestamp - b.timestamp),
    metrics: combineMetrics(results[0].metrics, results[1].metrics),
  };
}
