// Indicator computation types — used by BB%B, RSI, MACD, and conditionEvaluator

import { IndicatorType, ConditionOperator } from '../types';

// ──── Indicator Parameter Types ────

export interface BollingerBandsParams {
  period: number;      // 2-200
  deviation: number;   // 1-10
}

export interface RSIParams {
  length: number;      // 2-30
}

export interface MACDParams {
  fastLength: number;   // typically 12
  slowLength: number;   // typically 26
  signalLength: number; // typically 9
}

// ──── Indicator Output Types ────

export interface BollingerBandsResult {
  upper: number;
  middle: number;  // SMA basis
  lower: number;
  percentB: number;  // (price - lower) / (upper - lower)
}

export interface RSIResult {
  value: number;  // 0-100
}

export interface MACDResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

// ──── Series Results (for chart rendering) ────

export interface BollingerBandsSeries {
  upper: number[];
  middle: number[];
  lower: number[];
  percentB: number[];
}

export interface RSISeries {
  values: number[];
}

export interface MACDSeries {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

// ──── Condition Evaluation ────

export const CONDITION_HISTORY_LIMIT = 20;

export interface ConditionState {
  indicator: IndicatorType;
  timeframe: string;
  previousValue: number | null;
  currentValue: number | null;
  // Ring buffer of recent values on this indicator+timeframe, most recent last.
  // Capped at CONDITION_HISTORY_LIMIT; older values dropped from the front.
  history: number[];
  // Durable boolean flags set by stateful operators (e.g. TOUCHED_AND_REJECTED).
  // Cleared explicitly by operators or by state-machine phase transitions.
  flags: Map<string, boolean>;
}

export interface EvaluationResult {
  allConditionsMet: boolean;
  conditionResults: {
    indicator: IndicatorType;
    condition: ConditionOperator;
    timeframe: string;
    currentValue: number;
    signalValue: number;
    met: boolean;
  }[];
}
