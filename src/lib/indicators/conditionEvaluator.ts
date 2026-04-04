import { OHLC, IndicatorCondition, ConditionOperator, IndicatorType } from '../types';
import { ConditionState, EvaluationResult } from './indicatorTypes';
import { computeBBAtIndex } from './bollingerBandsB';
import { computeRSIAtIndex } from './rsi';
import { computeMACDAtIndex } from './macd';

// How many 5m candles make up one candle of each timeframe
const TIMEFRAME_MULTIPLIER: Record<string, number> = {
  '5m': 1,
  '15m': 3,
  '1h': 12,
  '1H': 12,
  '4h': 48,
  '4H': 48,
};

function stateKey(indicator: IndicatorType, timeframe: string): string {
  return `${indicator}_${timeframe}`;
}

function getIndicatorValue(
  indicator: IndicatorType,
  closes: number[],
  index: number,
  params: Record<string, number>
): number {
  switch (indicator) {
    case 'BB_PERCENT_B': {
      const result = computeBBAtIndex(closes, index, params.period ?? 20, params.deviation ?? 2);
      return result.percentB;
    }
    case 'RSI': {
      const result = computeRSIAtIndex(closes, index, params.length ?? 14);
      return result.value;
    }
    case 'MACD_LINE': {
      const result = computeMACDAtIndex(
        closes, index,
        params.fastLength ?? 12, params.slowLength ?? 26, params.signalLength ?? 9
      );
      return result.macdLine;
    }
    case 'MACD_SIGNAL': {
      const result = computeMACDAtIndex(
        closes, index,
        params.fastLength ?? 12, params.slowLength ?? 26, params.signalLength ?? 9
      );
      return result.signalLine;
    }
    case 'MACD_HISTOGRAM': {
      const result = computeMACDAtIndex(
        closes, index,
        params.fastLength ?? 12, params.slowLength ?? 26, params.signalLength ?? 9
      );
      return result.histogram;
    }
  }
}

function checkCondition(
  operator: ConditionOperator,
  currentValue: number,
  previousValue: number | null,
  signalValue: number
): boolean {
  if (isNaN(currentValue)) return false;

  switch (operator) {
    case 'CROSSING_UP':
      return previousValue !== null && previousValue <= signalValue && currentValue > signalValue;
    case 'CROSSING_DOWN':
      return previousValue !== null && previousValue >= signalValue && currentValue < signalValue;
    case 'LESS_THAN':
      return currentValue < signalValue;
    case 'GREATER_THAN':
      return currentValue > signalValue;
  }
}

export class ConditionEvaluator {
  private conditions: IndicatorCondition[];
  private state: Map<string, ConditionState> = new Map();

  constructor(conditions: IndicatorCondition[]) {
    this.conditions = conditions;

    // Initialize state for each unique indicator+timeframe combo
    for (const cond of conditions) {
      const key = stateKey(cond.indicator, cond.timeframe);
      if (!this.state.has(key)) {
        this.state.set(key, {
          indicator: cond.indicator,
          timeframe: cond.timeframe,
          previousValue: null,
          currentValue: null,
        });
      }
    }
  }

  evaluate(
    candles5m: OHLC[],
    currentIdx: number,
    aggregatedCandles: Map<string, OHLC[]>
  ): EvaluationResult {
    const conditionResults: EvaluationResult['conditionResults'] = [];

    for (const cond of this.conditions) {
      const key = stateKey(cond.indicator, cond.timeframe);
      const state = this.state.get(key)!;
      const multiplier = TIMEFRAME_MULTIPLIER[cond.timeframe] ?? 1;

      // Determine if this timeframe's candle just closed
      const isTimeframeBoundary = (currentIdx + 1) % multiplier === 0;

      if (isTimeframeBoundary || multiplier === 1) {
        // Get the closes for this timeframe
        let closes: number[];
        if (cond.timeframe === '5m') {
          closes = candles5m.slice(0, currentIdx + 1).map(c => c.close);
        } else {
          const tfCandles = aggregatedCandles.get(cond.timeframe);
          closes = tfCandles ? tfCandles.map(c => c.close) : [];
        }

        if (closes.length > 0) {
          const value = getIndicatorValue(
            cond.indicator,
            closes,
            closes.length - 1,
            cond.params
          );

          state.previousValue = state.currentValue;
          state.currentValue = value;
        }
      }

      // Evaluate using latest state
      const currentValue = state.currentValue ?? NaN;
      const met = checkCondition(cond.condition, currentValue, state.previousValue, cond.signalValue);

      conditionResults.push({
        indicator: cond.indicator,
        condition: cond.condition,
        timeframe: cond.timeframe,
        currentValue,
        signalValue: cond.signalValue,
        met,
      });
    }

    return {
      allConditionsMet: conditionResults.every(r => r.met),
      conditionResults,
    };
  }

  reset(): void {
    for (const state of this.state.values()) {
      state.previousValue = null;
      state.currentValue = null;
    }
  }
}
