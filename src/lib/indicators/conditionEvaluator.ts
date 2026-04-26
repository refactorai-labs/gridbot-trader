import { OHLC, IndicatorCondition, ConditionOperator, IndicatorType } from '../types';
import { ConditionState, EvaluationResult, CONDITION_HISTORY_LIMIT } from './indicatorTypes';
import { computeBBAtIndex } from './bollingerBandsB';
import { computeRSIAtIndex } from './rsi';
import { computeMACDAtIndex } from './macd';
import { computeATRAtIndex } from './atr';
import { computeERAtIndex } from './efficiencyRatio';

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
  candles: OHLC[],
  index: number,
  params: Record<string, number>
): number {
  const closes = candles.map(c => c.close);
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
    case 'ATR': {
      const result = computeATRAtIndex(candles, index, params.period ?? 14);
      return result.value;
    }
    case 'EFFICIENCY_RATIO': {
      const result = computeERAtIndex(closes, index, params.lookback ?? 10);
      return result.value;
    }
    case 'AVWAP': {
      // Dynamic anchor is Phase 3b responsibility; here we no-op so the evaluator
      // doesn't throw when a combo-bot config passes AVWAP through. The combo
      // supervisor evaluates AVWAP via its own anchor-aware path.
      return NaN;
    }
  }
}

function checkCondition(
  operator: ConditionOperator,
  currentValue: number,
  state: ConditionState,
  signalValue: number,
  params: Record<string, number>
): boolean {
  if (isNaN(currentValue)) return false;
  const previousValue = state.previousValue;

  switch (operator) {
    case 'CROSSING_UP':
      return previousValue !== null && previousValue <= signalValue && currentValue > signalValue;
    case 'CROSSING_DOWN':
      return previousValue !== null && previousValue >= signalValue && currentValue < signalValue;
    case 'LESS_THAN':
      return currentValue < signalValue;
    case 'GREATER_THAN':
      return currentValue > signalValue;
    case 'DECLINING_N': {
      // signalValue = N (number of consecutive strictly-decreasing values, current included)
      const n = Math.max(2, Math.floor(signalValue));
      if (state.history.length < n) return false;
      const tail = state.history.slice(-n);
      for (let i = 1; i < tail.length; i++) {
        if (tail[i] >= tail[i - 1]) return false;
      }
      return true;
    }
    case 'RATIO_BELOW': {
      // currentValue / max(history) < signalValue  (signalValue in (0, 1])
      // Uses history excluding current candle as reference peak.
      const ref = state.history.length > 1
        ? Math.max(...state.history.slice(0, -1))
        : currentValue;
      if (ref <= 0) return false;
      return currentValue / ref < signalValue;
    }
    case 'TOUCHED_AND_REJECTED': {
      // Two-step durable: once currentValue rises above signalValue, set flag;
      // then fires on the first candle where value falls back below signalValue - buffer.
      const buffer = params.rejectionBuffer ?? 0;
      const touched = state.flags.get('touched_avr') ?? false;
      if (!touched && currentValue > signalValue) {
        state.flags.set('touched_avr', true);
        return false;
      }
      if (touched && currentValue < signalValue - buffer) {
        state.flags.set('touched_avr', false);
        return true;
      }
      return false;
    }
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
          history: [],
          flags: new Map<string, boolean>(),
        });
      }
    }
  }

  /** Clear a named flag on all states (used by combo state machine on phase transitions). */
  clearFlag(flagName: string): void {
    for (const state of this.state.values()) {
      state.flags.delete(flagName);
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
        // Get the candles for this timeframe.
        // Higher timeframes: slice to the count of completed aggregated candles at currentIdx,
        // otherwise indexing the full precomputed series at .length-1 leaks future indicator values.
        let tfCandles: OHLC[];
        if (cond.timeframe === '5m') {
          tfCandles = candles5m.slice(0, currentIdx + 1);
        } else {
          const completedTfCount = Math.floor((currentIdx + 1) / multiplier);
          const fullTf = aggregatedCandles.get(cond.timeframe) ?? [];
          tfCandles = fullTf.slice(0, completedTfCount);
        }

        if (tfCandles.length > 0) {
          const value = getIndicatorValue(
            cond.indicator,
            tfCandles,
            tfCandles.length - 1,
            cond.params
          );

          state.previousValue = state.currentValue;
          state.currentValue = value;

          if (!isNaN(value)) {
            state.history.push(value);
            if (state.history.length > CONDITION_HISTORY_LIMIT) {
              state.history.shift();
            }
          }
        }
      }

      // Evaluate using latest state
      const currentValue = state.currentValue ?? NaN;
      const met = checkCondition(cond.condition, currentValue, state, cond.signalValue, cond.params);

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
      state.history = [];
      state.flags.clear();
    }
  }
}
