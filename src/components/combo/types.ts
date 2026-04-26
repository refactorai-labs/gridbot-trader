import { AVWAPAnchorData as _AVWAPAnchorData, BotPhase, ComboMode, GridSide } from '@/lib/types';

export type AVWAPAnchorData = _AVWAPAnchorData;

export interface SessionView {
  pair: string;
  timeframe: string;
  startTime: Date;
  endTime: Date;
  totalCandles: number;
  currentCandleIdx: number;
  leverage: number;
  allocationLong: number;
  mode: ComboMode;
  playbackSpeed: number;
}

export interface ReopenLights {
  cooldownElapsed: boolean;
  regimeTrending: boolean;
  atrCompressed: boolean;
  avwapAligned: boolean;
}

export interface BotPhaseView {
  side: GridSide;
  phase: BotPhase;
  retryCount: number;
  retryCap: number;
  currentTier: 0 | 1 | 2 | 3;
  cooldownCandlesRemaining: number;
  hibernationCandlesRemaining: number;
  reopenLights?: ReopenLights;
  lastEventType?: string;
  lastEventCandleIdx?: number;
}

export interface PnLView {
  totalEquity: number;
  baseCapital: number;
  totalPnl: number;
  totalPnlPct: number;
  longRealized: number;
  longUnrealized: number;
  shortRealized: number;
  shortUnrealized: number;
  fundingCost: number;
  notional: number;
  maxDrawdownPct: number;
  winCount: number;
  lossCount: number;
}

export interface AdaptiveEventView {
  candleIdx: number;
  timestamp: number;
  eventType: string;
  detailsJson: string;
}

export interface WalkForwardFoldView {
  foldIndex: number;
  sharpe: number;
  pnl: number;
}

export interface WalkForwardView {
  foldCount: number;
  trainCandles: number;
  oosCandles: number;
  stepCandles: number;
  psr: number;
  usedPSR: boolean;
  stability: number;
  maxDrawdownPct: number;
  nTrades: number;
  fitness: number;
  folds: WalkForwardFoldView[];
  stitchedEquity: number[];
}
