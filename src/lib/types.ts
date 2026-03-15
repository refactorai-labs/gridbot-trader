// Core types for the Grid Bot Simulator

export interface OHLC {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface GeckoTerminalOHLCResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      ohlcv_list: [number, number, number, number, number, number][];
    };
  };
}

// Grid types
export type GridSide = 'long' | 'short';
export type GridType = 'arithmetic' | 'geometric';
export type OrderType = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled';
export type SimulationStatus = 'pending' | 'running' | 'completed' | 'failed';
export type TrendDirection = 'bullish' | 'bearish' | 'neutral';
export type PlaybackSpeed = 1 | 2 | 5 | 10;

export interface GridSideConfig {
  side: GridSide;
  gridLevels: number;
  gridType: GridType;
  upperBound: number;
  lowerBound: number;
  orderSizeType: 'fixed' | 'percent';
  orderSize: number;
  totalCapital: number;
  profitMode: 'next_level' | 'custom';
  customProfitDistance?: number;
}

export interface SimulationConfig {
  name: string;
  pair: string;
  poolAddress: string;
  chain: string;
  timeframe: string;
  startTime: string;
  endTime: string;
  longConfig: GridSideConfig;
  shortConfig: GridSideConfig;
  adaptiveEnabled: boolean;
  emaPeriod: number;
  volumeMultiplier: number;
  feeRate: number;
}

export interface GridLevel {
  index: number;
  price: number;
  side: GridSide;
}

export interface PendingOrder {
  id: string;
  side: GridSide;
  type: OrderType;
  levelIndex: number;
  price: number;
  size: number;
  sizeMultiplier: number;
}

export interface Fill {
  orderId: string;
  side: GridSide;
  type: OrderType;
  levelIndex: number;
  fillPrice: number;
  candleIdx: number;
  timestamp: number;
  size: number;
  fees: number;
  pnl?: number;
  pnlPct?: number;
  counterOrderId?: string;
}

export interface AdaptiveState {
  trend: TrendDirection;
  longMultiplier: number;
  shortMultiplier: number;
  deRiskPhase: 'none' | 'phase1' | 'phase2' | 'closed';
  deRiskSide?: GridSide;
  breakoutPrice?: number;
  breakoutDirection?: 'up' | 'down';
  reEntryConfirmations: number;
}

export interface AdaptiveEventData {
  type: 'trend_change' | 'breakout_detected' | 'de_risk' | 're_entry' | 'grid_resize';
  details: Record<string, unknown>;
  longMultiplier?: number;
  shortMultiplier?: number;
}

export interface SnapshotData {
  candleIdx: number;
  timestamp: number;
  price: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  longEquity: number;
  shortEquity: number;
  longOrdersActive: number;
  shortOrdersActive: number;
  longFillCount: number;
  shortFillCount: number;
}

export interface ReplayData {
  candles: OHLC[];
  pnlSnapshots: SnapshotData[];
  gridOrders: {
    id: string;
    side: GridSide;
    level: number;
    levelPrice: number;
    orderType: OrderType;
    status: OrderStatus;
    fillPrice?: number;
    fillCandleIdx?: number;
    pnl?: number;
  }[];
  adaptiveEvents: {
    candleIdx: number;
    timestamp: number;
    eventType: string;
    detailsJson: string;
    longMultiplier?: number;
    shortMultiplier?: number;
  }[];
  longLevels: GridLevel[];
  shortLevels: GridLevel[];
  totalCandles: number;
}

export interface SimulationSummary {
  id: string;
  name: string;
  pair: string;
  timeframe: string;
  status: SimulationStatus;
  createdAt: string;
  startTime: string;
  endTime: string;
  totalPnl?: number;
  totalPnlPct?: number;
  longPnl?: number;
  shortPnl?: number;
  totalTrades?: number;
  maxDrawdown?: number;
  maxDrawdownPct?: number;
  totalCandles?: number;
  winCount?: number;
  lossCount?: number;
}

// Pair configuration
export interface PairConfig {
  label: string;
  pair: string;
  poolAddress: string;
  chain: string;
}
