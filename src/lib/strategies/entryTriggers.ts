// Entry trigger interface + breakout trigger implementation

import { OHLC, IndicatorCondition } from '../types';
import { ConditionEvaluator } from '../indicators/conditionEvaluator';

export interface EntryTrigger {
  name: string;
  check(candles5m: OHLC[], currentIdx: number, aggregatedCandles: Map<string, OHLC[]>): boolean;
}

export class BreakoutTrigger implements EntryTrigger {
  name = 'breakout';
  private evaluator: ConditionEvaluator;

  constructor(conditions: IndicatorCondition[]) {
    this.evaluator = new ConditionEvaluator(conditions);
  }

  check(candles5m: OHLC[], currentIdx: number, aggregatedCandles: Map<string, OHLC[]>): boolean {
    const result = this.evaluator.evaluate(candles5m, currentIdx, aggregatedCandles);
    return result.allConditionsMet;
  }
}
