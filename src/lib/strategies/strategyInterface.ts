// Common strategy interface for Grid and DCA simulation engines

import { OHLC, StrategyMetrics, SnapshotData } from '../types';

export interface StrategyResult {
  metrics: StrategyMetrics;
  snapshots: SnapshotData[];
  trades: StrategyTrade[];
}

export interface StrategyTrade {
  id: string;
  type: string;       // strategy-specific (e.g. 'grid_fill', 'dca_base_order', 'dca_safety_order', 'dca_take_profit')
  side: string;
  price: number;
  size: number;
  fees: number;
  pnl: number;
  timestamp: number;
  candleIdx: number;
  metadata?: Record<string, unknown>;
}

export interface Strategy {
  name: string;

  /** Called once before simulation starts */
  initialize(candles: OHLC[]): void;

  /** Called for each candle during simulation */
  onCandle(candle: OHLC, candleIdx: number): void;

  /** Get current strategy metrics */
  getMetrics(): StrategyMetrics;

  /** Get all equity snapshots */
  getSnapshots(): SnapshotData[];

  /** Get all trades */
  getTrades(): StrategyTrade[];
}
