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

export interface ConditionState {
  indicator: IndicatorType;
  timeframe: string;
  previousValue: number | null;
  currentValue: number | null;
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
