import { describe, it, expect } from 'vitest';
import { computeBB, computeBBAtIndex } from '../lib/indicators/bollingerBandsB';
import { computeRSI, computeRSIAtIndex } from '../lib/indicators/rsi';
import { computeMACD, computeMACDAtIndex } from '../lib/indicators/macd';
import { ConditionEvaluator } from '../lib/indicators/conditionEvaluator';
import { emaSeries } from '../lib/analysis/technical';
import { OHLC, IndicatorCondition } from '../lib/types';

// ──── Bollinger Bands %B ────

describe('Bollinger Bands %B', () => {
  // 20 closing prices
  const closes = [
    44.34, 44.09, 43.61, 44.33, 44.83,
    45.10, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28, 46.00,
    46.03, 46.41, 46.22, 45.64, 46.21,
  ];

  it('should return NaN for indices before period is available', () => {
    const result = computeBB(closes, 20, 2);
    for (let i = 0; i < 19; i++) {
      expect(result.middle[i]).toBeNaN();
      expect(result.upper[i]).toBeNaN();
      expect(result.lower[i]).toBeNaN();
      expect(result.percentB[i]).toBeNaN();
    }
  });

  it('should compute middle as SMA of period', () => {
    const result = computeBB(closes, 20, 2);
    // Middle at index 19 = average of all 20 values
    const expectedSMA = closes.reduce((a, b) => a + b, 0) / 20;
    expect(result.middle[19]).toBeCloseTo(expectedSMA, 4);
  });

  it('should compute bands at correct stddev distance', () => {
    const result = computeBB(closes, 20, 2);
    const mid = result.middle[19];
    const sum = closes.reduce((s, x) => s + (x - mid) ** 2, 0);
    const sd = Math.sqrt(sum / 20);

    expect(result.upper[19]).toBeCloseTo(mid + 2 * sd, 4);
    expect(result.lower[19]).toBeCloseTo(mid - 2 * sd, 4);
  });

  it('should compute %B = (price - lower) / (upper - lower)', () => {
    const result = computeBB(closes, 20, 2);
    const price = closes[19];
    const expectedPB = (price - result.lower[19]) / (result.upper[19] - result.lower[19]);
    expect(result.percentB[19]).toBeCloseTo(expectedPB, 6);
  });

  it('computeBBAtIndex should match series result', () => {
    const series = computeBB(closes, 20, 2);
    const point = computeBBAtIndex(closes, 19, 20, 2);
    expect(point.upper).toBeCloseTo(series.upper[19], 10);
    expect(point.middle).toBeCloseTo(series.middle[19], 10);
    expect(point.lower).toBeCloseTo(series.lower[19], 10);
    expect(point.percentB).toBeCloseTo(series.percentB[19], 10);
  });

  it('computeBBAtIndex returns NaN for insufficient data', () => {
    const point = computeBBAtIndex(closes, 5, 20, 2);
    expect(point.middle).toBeNaN();
  });
});

// ──── RSI ────

describe('RSI (Wilder)', () => {
  // 21 prices → 20 changes, enough for length=14
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33,
    44.83, 45.10, 45.42, 45.84, 46.08,
    45.89, 46.03, 45.61, 46.28, 46.28,
    46.00, 46.03, 46.41, 46.22, 45.64,
    46.21,
  ];

  it('first `length` values should be NaN', () => {
    const result = computeRSI(closes, 14);
    for (let i = 0; i < 14; i++) {
      expect(result.values[i]).toBeNaN();
    }
    expect(result.values[14]).not.toBeNaN();
  });

  it('RSI should be between 0 and 100', () => {
    const result = computeRSI(closes, 14);
    for (const v of result.values) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('all gains should produce RSI near 100', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = computeRSI(rising, 14);
    const lastRSI = result.values[result.values.length - 1];
    expect(lastRSI).toBe(100);
  });

  it('all losses should produce RSI near 0', () => {
    const falling = Array.from({ length: 20 }, (_, i) => 200 - i);
    const result = computeRSI(falling, 14);
    const lastRSI = result.values[result.values.length - 1];
    expect(lastRSI).toBe(0);
  });

  it('hand-calculated Wilder RSI check', () => {
    const result = computeRSI(closes, 14);

    // Manually compute first 14 changes
    const changes: number[] = [];
    for (let i = 1; i <= 14; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }
    let avgGain = changes.filter(c => c > 0).reduce((s, c) => s + c, 0) / 14;
    let avgLoss = changes.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / 14;
    const expectedFirst = 100 - 100 / (1 + avgGain / avgLoss);
    expect(result.values[14]).toBeCloseTo(expectedFirst, 6);

    // Next value (index 15)
    const change15 = closes[15] - closes[14];
    const gain15 = change15 > 0 ? change15 : 0;
    const loss15 = change15 < 0 ? Math.abs(change15) : 0;
    avgGain = (avgGain * 13 + gain15) / 14;
    avgLoss = (avgLoss * 13 + loss15) / 14;
    const expectedSecond = 100 - 100 / (1 + avgGain / avgLoss);
    expect(result.values[15]).toBeCloseTo(expectedSecond, 6);
  });

  it('computeRSIAtIndex matches series result', () => {
    const series = computeRSI(closes, 14);
    for (let i = 14; i < closes.length; i++) {
      const point = computeRSIAtIndex(closes, i, 14);
      expect(point.value).toBeCloseTo(series.values[i], 10);
    }
  });
});

// ──── MACD ────

describe('MACD', () => {
  // 30 values — enough for EMA(26) to stabilize
  const closes = [
    22.27, 22.19, 22.08, 22.17, 22.18,
    22.13, 22.23, 22.43, 22.24, 22.29,
    22.15, 22.39, 22.38, 22.61, 23.36,
    24.05, 23.75, 23.83, 23.95, 23.63,
    23.82, 23.87, 23.65, 23.19, 23.10,
    23.33, 22.68, 23.10, 22.40, 22.17,
  ];

  it('MACD line = fast EMA - slow EMA', () => {
    const result = computeMACD(closes, 12, 26, 9);
    // Check a few points
    expect(result.macdLine.length).toBe(closes.length);

    // emaSeries computes from index 0, so we can verify the last MACD value
    const fastEMA = emaSeries(closes, 12);
    const slowEMA = emaSeries(closes, 26);
    for (let i = 0; i < closes.length; i++) {
      expect(result.macdLine[i]).toBeCloseTo(fastEMA[i] - slowEMA[i], 10);
    }
  });

  it('signal line is EMA of MACD line', () => {
    const result = computeMACD(closes, 12, 26, 9);
    const expectedSignal = emaSeries(result.macdLine, 9);
    for (let i = 0; i < closes.length; i++) {
      expect(result.signalLine[i]).toBeCloseTo(expectedSignal[i], 10);
    }
  });

  it('histogram = MACD line - signal line', () => {
    const result = computeMACD(closes, 12, 26, 9);
    for (let i = 0; i < closes.length; i++) {
      expect(result.histogram[i]).toBeCloseTo(
        result.macdLine[i] - result.signalLine[i], 10
      );
    }
  });

  it('computeMACDAtIndex matches series result', () => {
    const series = computeMACD(closes, 12, 26, 9);
    const point = computeMACDAtIndex(closes, 29, 12, 26, 9);
    expect(point.macdLine).toBeCloseTo(series.macdLine[29], 10);
    expect(point.signalLine).toBeCloseTo(series.signalLine[29], 10);
    expect(point.histogram).toBeCloseTo(series.histogram[29], 10);
  });
});

// ──── ConditionEvaluator ────

describe('ConditionEvaluator', () => {
  function makeCandle(close: number, index: number): OHLC {
    return {
      timestamp: 1000000 + index * 300000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100,
    };
  }

  it('should detect CROSSING_UP', () => {
    // RSI crossing up through 30
    // We need enough candles. Create 20 candles where RSI goes from low to high.
    // Use a simple sequence: falling prices then rising prices
    const falling = Array.from({ length: 16 }, (_, i) => 100 - i * 0.5);
    const rising = [92.5, 93.5, 95.0, 97.0, 99.0, 101.0, 103.0, 105.0];
    const allCloses = [...falling, ...rising];
    const candles = allCloses.map((c, i) => makeCandle(c, i));

    const conditions: IndicatorCondition[] = [{
      indicator: 'RSI',
      params: { length: 14 },
      condition: 'CROSSING_UP',
      signalValue: 50,
      timeframe: '5m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();

    let crossedUp = false;
    for (let i = 0; i < candles.length; i++) {
      const result = evaluator.evaluate(candles, i, aggregated);
      if (result.allConditionsMet) {
        crossedUp = true;
        break;
      }
    }

    expect(crossedUp).toBe(true);
  });

  it('AND logic: all conditions must be met', () => {
    // Two conditions: RSI > 50 AND RSI < 80
    // Create prices that would produce RSI in this range
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i * 0.3) * 2);
    const candles = prices.map((c, i) => makeCandle(c, i));

    const conditions: IndicatorCondition[] = [
      {
        indicator: 'RSI',
        params: { length: 14 },
        condition: 'GREATER_THAN',
        signalValue: 30,
        timeframe: '5m',
      },
      {
        indicator: 'RSI',
        params: { length: 14 },
        condition: 'LESS_THAN',
        signalValue: 70,
        timeframe: '5m',
      },
    ];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();

    // Run through all candles
    let bothMet = false;
    for (let i = 0; i < candles.length; i++) {
      const result = evaluator.evaluate(candles, i, aggregated);
      if (result.allConditionsMet) {
        bothMet = true;
        // Verify both conditions individually met
        expect(result.conditionResults[0].met).toBe(true);
        expect(result.conditionResults[1].met).toBe(true);
        break;
      }
    }
    expect(bothMet).toBe(true);
  });

  it('multi-timeframe: 15m condition only updates every 3rd candle', () => {
    // Create enough candles for RSI computation on 15m timeframe
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i * 0.1);
    const candles = prices.map((c, i) => makeCandle(c, i));

    // Aggregate to 15m
    const candles15m: OHLC[] = [];
    for (let i = 0; i < candles.length; i += 3) {
      const group = candles.slice(i, i + 3);
      if (group.length === 3) {
        candles15m.push({
          timestamp: group[0].timestamp,
          open: group[0].open,
          high: Math.max(...group.map(c => c.high)),
          low: Math.min(...group.map(c => c.low)),
          close: group[group.length - 1].close,
          volume: group.reduce((s, c) => s + c.volume, 0),
        });
      }
    }

    const conditions: IndicatorCondition[] = [{
      indicator: 'RSI',
      params: { length: 14 },
      condition: 'GREATER_THAN',
      signalValue: 50,
      timeframe: '15m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();
    aggregated.set('15m', candles15m);

    // Check that the condition result only changes at 3-candle boundaries
    const results: boolean[] = [];
    for (let i = 0; i < candles.length; i++) {
      const result = evaluator.evaluate(candles, i, aggregated);
      results.push(result.conditionResults[0].met);
    }

    // Before index 2 (first 15m boundary), condition shouldn't be met (no data yet to compute)
    // Values should only change at indices 2, 5, 8, 11, ... (every 3rd)
    // Verify that values between boundaries are the same
    for (let i = 3; i < results.length - 1; i++) {
      if ((i + 1) % 3 !== 0) {
        // Not a boundary — value should be same as previous
        expect(results[i]).toBe(results[i - 1]);
      }
    }
  });
});
