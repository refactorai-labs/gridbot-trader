// Core types for the Grid Bot Simulator

export interface OHLC {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Grid types
export type GridSide = 'long' | 'short';
export type GridType = 'arithmetic' | 'geometric';
export type OrderType = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled';
export type SimulationStatus = 'pending' | 'running' | 'completed' | 'failed';
export type TrendDirection = 'bullish' | 'bearish' | 'neutral';
export type PlaybackSpeed = 1 | 2 | 5 | 10;
export type StrategyType = 'grid' | 'dca';
export type Direction = 'LONG' | 'SHORT';

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
  // Combo Bot (v3.1) — optional. Presence of `combo` triggers supervisor path.
  combo?: ComboBotConfig;
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
  positionId?: string;
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
  pathSegment?: number;
  positionId?: string;
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
  longRealizedPnl: number;
  shortRealizedPnl: number;
  longUnrealizedPnl: number;
  shortUnrealizedPnl: number;
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
  avwapAnchor?: AVWAPAnchorData | null;
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
  comboBotEnabled?: boolean;
  comboMode?: ComboMode | null;
}

// Pair configuration
export interface PairConfig {
  label: string;
  pair: string;
  poolAddress: string;
  chain: string;
  binanceSymbol?: string;
}

// ──── DCA Strategy Types ────

export type DCATradeState = 'IDLE' | 'OPEN' | 'CLOSING';
export type StopLossAction = 'CLOSE_TRADE' | 'CLOSE_AND_STOP';
export type CloseReason = 'TAKE_PROFIT' | 'TRAILING_TP' | 'STOP_LOSS' | 'CLOSE_CONDITION' | 'END_OF_DATA';

export interface DCABreakoutConfig {
  direction: Direction;
  baseOrderSize: number;          // USDT
  leverageType: 'isolated';
  leverageValue: number;
  startConditions: IndicatorCondition[];  // AND logic
  closeConditions?: IndicatorCondition[];
  // Averaging (safety orders)
  deviationFirstOrder: number;    // %
  deviationStepMultiplier: number;
  averagingOrderSize: number;     // USDT
  orderSizeMultiplier: number;
  maxAveragingOrders: number;
  // Take Profit
  takeProfitPercent: number;      // % from avg price
  trailingEnabled: boolean;
  trailingPercent: number;        // % pullback from peak
  reinvestProfit: number;         // % of profit reinvested
  // Stop Loss
  stopLossEnabled: boolean;
  stopLossPercent: number;        // % from base order price
  stopLossAction: StopLossAction;
}

export interface DCATradeRecord {
  tradeNumber: number;
  direction: Direction;
  baseOrderPrice: number;
  baseOrderSize: number;
  avgEntryPrice: number;
  safetyOrdersFilled: number;
  closePrice: number;
  closeReason: CloseReason;
  pnl: number;
  pnlPercent: number;
  openTime: number;   // unix timestamp
  closeTime: number;
  durationMinutes: number;
}

export interface DCATradeState_Live {
  state: DCATradeState;
  direction: Direction;
  baseOrderPrice: number;
  totalInvested: number;
  totalQuantity: number;
  avgEntryPrice: number;
  safetyOrdersFilled: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  trailingHighPrice: number;  // highest price seen since TP level was hit (for trailing)
  trailingActive: boolean;
  openTime: number;
}

// ──── Indicator Types ────

export type IndicatorType =
  | 'BB_PERCENT_B'
  | 'RSI'
  | 'MACD_LINE'
  | 'MACD_SIGNAL'
  | 'MACD_HISTOGRAM'
  | 'ATR'
  | 'EFFICIENCY_RATIO'
  | 'AVWAP';
export type ConditionOperator =
  | 'CROSSING_UP'
  | 'CROSSING_DOWN'
  | 'LESS_THAN'
  | 'GREATER_THAN'
  | 'DECLINING_N'
  | 'RATIO_BELOW'
  | 'TOUCHED_AND_REJECTED';

export interface IndicatorCondition {
  indicator: IndicatorType;
  params: Record<string, number>;  // e.g. { period: 20, deviation: 2 } for BB
  condition: ConditionOperator;
  signalValue: number;
  timeframe: string;               // '5m', '15m', '1h', '4h'
}

// ──── Combo Bot (Dual Trailing v3.1) ────

export type ComboMode = 'dual' | 'long' | 'short';

// Lifecycle phases (diagram 3). Hibernation is semi-absorbing.
export type BotPhase =
  | 'IDLE'           // Phase 1 — waiting for breakout conditions
  | 'BREAKOUT'       // Phase 2 — breakout detected, scaling in
  | 'RUNNING'        // Phase 3 — position open, grid active
  | 'COOLDOWN'       // Phase 4 — post-SL recovery wait
  | 'SL_RETRY'       // Phase 5 — retry after SL, evaluating reopen stack
  | 'REOPENING'      // Phase 6 — reopen tier ramp (25 → 50 → 100)
  | 'HIBERNATING';   // exits only when ER<0.3 sustained for hibernationCandles

export interface ComboBotSideConfig {
  averagingDepth: number;
  slBasePercent: number;
  slAtrMultiplier: number;
  slFloor: number;
  slCap: number;
  tier1Size: number;
  tier2Size: number;
  tier3Size: number;
  cooldownCandles: number;
  retryCap: number;
  hibernationCandles: number;
}

export interface ComboBotConfig {
  enabled: boolean;
  mode: ComboMode;
  leverage: number;
  allocationLong: number; // only used in dual; 0.5..0.75
  avwapEnabled: boolean;
  totalCapital: number; // USDT — single source of truth when combo is on
  gridLevels: number;   // grid levels per side (spec §1 averaging depth × 2)
  longSide?: ComboBotSideConfig;
  shortSide?: ComboBotSideConfig;
  // Adaptive layer knobs
  atrPeriod: number;
  erLookback: number;
  erSmoothingLength: number;
  erRegimeThreshold: number;   // ER_smooth > threshold → AVWAP anchor drops, regime = "trending"
  rsiLongThreshold: number;    // 35 default
  rsiShortThreshold: number;   // 65 default
}

export interface BotState {
  side: GridSide;
  phase: BotPhase;
  retryCount: number;
  hibernationCandlesRemaining: number;
  cooldownCandlesRemaining: number;
  currentTier: 0 | 1 | 2 | 3; // 0 = no reopen position, 1..3 = tier index
  lastSLCandleIdx: number | null;
  lastSLPrice: number | null;
  atrAtPhaseEntry: number | null;
  breakoutPrice: number | null;
}

export interface AVWAPAnchorData {
  candleIdx: number;
  timestamp: number;
  typicalPrice: number;
  volume: number;
}

// ──── Strategy Metrics ────

export interface StrategyMetrics {
  totalPnl: number;
  totalPnlPct: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  profitFactor: number;
  avgTradePnl: number;
  avgTradeDuration: number;  // minutes
}

// ──── Simulation Config (extended) ────

export interface DCASimulationConfig {
  name: string;
  pair: string;
  timeframe: string;       // always '5m' for DCA
  startTime: string;
  endTime: string;
  feeRate: number;
  longConfig?: DCABreakoutConfig;
  shortConfig?: DCABreakoutConfig;
}
