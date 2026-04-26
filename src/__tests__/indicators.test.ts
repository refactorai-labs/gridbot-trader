import { describe, it, expect } from 'vitest';
import { computeBB, computeBBAtIndex } from '../lib/indicators/bollingerBandsB';
import { computeRSI, computeRSIAtIndex } from '../lib/indicators/rsi';
import { computeMACD, computeMACDAtIndex } from '../lib/indicators/macd';
import { computeATR, computeATRAtIndex, blendedATR } from '../lib/indicators/atr';
import { computeER, computeERAtIndex } from '../lib/indicators/efficiencyRatio';
import { computeAVWAP, computeAVWAPAtIndex } from '../lib/indicators/avwap';
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

// ──── BB Population Stddev ────

describe('BB population stddev (÷ n, not ÷ n-1)', () => {
  it('should use population stddev that differs from sample stddev', () => {
    // Textbook dataset where pop vs sample stddev differ meaningfully
    // Dataset: [2, 4, 4, 4, 5, 5, 7, 9]  (n=8)
    // Mean = 5.0
    // Population variance = 32/8 = 4.0   → stddev = 2.0
    // Sample variance     = 32/7 ≈ 4.571 → stddev ≈ 2.138
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    const result = computeBB(data, 8, 1);

    const mean = 5.0;
    const popStddev = 2.0;

    expect(result.middle[7]).toBeCloseTo(mean, 6);
    expect(result.upper[7]).toBeCloseTo(mean + popStddev, 4);
    expect(result.lower[7]).toBeCloseTo(mean - popStddev, 4);

    // Verify it's NOT using sample stddev (≈2.138)
    const sampleStddev = Math.sqrt(32 / 7);
    expect(result.upper[7]).not.toBeCloseTo(mean + sampleStddev, 2);
  });
});

// ──── RSI Wilder Smoothing ────

describe('RSI Wilder smoothing', () => {
  it('should use exact (prev*(n-1) + val) / n formula at warmup boundary', () => {
    // 15 prices → 14 changes → first RSI at index 14, second at index 15
    const prices = [
      44.34, 44.09, 44.15, 43.61, 44.33,
      44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28,
      46.00,
    ];
    const n = 14;
    const result = computeRSI(prices, n);

    // Manually compute first avgGain/avgLoss from changes 1..14
    const changes: number[] = [];
    for (let i = 1; i <= n; i++) changes.push(prices[i] - prices[i - 1]);

    const avgGain0 = changes.filter(c => c > 0).reduce((s, c) => s + c, 0) / n;
    const avgLoss0 = changes.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / n;

    // Wilder smoothing for index 15 (change = 46.00 - 46.28 = -0.28)
    const change15 = prices[15] - prices[14]; // -0.28
    const gain15 = change15 > 0 ? change15 : 0;
    const loss15 = change15 < 0 ? Math.abs(change15) : 0;
    const avgGain1 = (avgGain0 * (n - 1) + gain15) / n;
    const avgLoss1 = (avgLoss0 * (n - 1) + loss15) / n;
    const expectedRSI = 100 - 100 / (1 + avgGain1 / avgLoss1);

    expect(result.values[15]).toBeCloseTo(expectedRSI, 10);
  });

  it('should retain memory after a price shock', () => {
    // Alternating prices (gains and losses) then sudden big spike
    // Wilder smoothing should damp the spike — RSI should NOT jump to 100
    const prices = [
      100, 101, 100, 101, 100, 101, 100, 101,
      100, 101, 100, 101, 100, 101, 100, // 15 prices, RSI starts at index 14
      101, 100, 101, 100, 101,            // 5 more alternating
      110,                                 // big spike
    ];
    const result = computeRSI(prices, 14);
    const lastRSI = result.values[result.values.length - 1];

    // avgLoss is nonzero from alternating, so spike shouldn't produce RSI=100
    expect(lastRSI).toBeGreaterThan(50);
    expect(lastRSI).toBeLessThan(100);
  });
});

// ──── BB%B Breakout Conditions ────

describe('BB%B breakout conditions', () => {
  it('price above upper band → %B > 1.0', () => {
    // Create data where last price is well above upper band
    const stable = Array.from({ length: 19 }, () => 100);
    const closes = [...stable, 120]; // spike above band
    const result = computeBB(closes, 20, 2);
    expect(result.percentB[19]).toBeGreaterThan(1.0);
  });

  it('price below lower band → %B < 0.0', () => {
    const stable = Array.from({ length: 19 }, () => 100);
    const closes = [...stable, 80]; // crash below band
    const result = computeBB(closes, 20, 2);
    expect(result.percentB[19]).toBeLessThan(0.0);
  });

  it('price at SMA → %B = 0.5', () => {
    // Symmetric alternating data: mean=100, stddev=1
    // Last price = 100 (the mean) → %B = (100 - lower) / (upper - lower) = 0.5
    const closes = [
      99, 101, 99, 101, 99, 101, 99, 101, 99, 101,
      99, 101, 99, 101, 99, 101, 99, 101, 99, 101, 100,
    ];
    const result = computeBB(closes, 20, 2);
    // Window is indices 1-20: ten 101s, nine 99s, one 100
    // Mean = (10*101 + 9*99 + 100) / 20 = 2001/20 = 100.05
    // Price 100 is very close to mean → %B ≈ 0.5
    expect(result.percentB[20]).toBeCloseTo(0.5, 1);
  });
});

// ──── ATR ────

describe('ATR (Wilder)', () => {
  function c(high: number, low: number, close: number): OHLC {
    return { timestamp: 0, open: close, high, low, close, volume: 100 };
  }

  it('returns NaN for indices before warmup', () => {
    const candles = Array.from({ length: 20 }, () => c(10, 9, 9.5));
    const result = computeATR(candles, 14);
    for (let i = 0; i < 13; i++) expect(result.values[i]).toBeNaN();
    expect(result.values[13]).not.toBeNaN();
  });

  it('ATR of constant-range candles equals that range', () => {
    const candles = Array.from({ length: 30 }, () => c(105, 100, 102));
    const result = computeATR(candles, 14);
    expect(result.values[29]).toBeCloseTo(5, 6);
  });

  it('Wilder smoothing: ATR_new = (ATR_prev*(n-1) + TR) / n', () => {
    const candles: OHLC[] = [];
    for (let i = 0; i < 15; i++) candles.push(c(101, 99, 100));
    candles.push(c(110, 90, 100)); // big TR at index 15: max(20, |110-100|, |90-100|) = 20

    const result = computeATR(candles, 14);
    const atr14 = result.values[13];
    const expected15 = (atr14 * 13 + 20) / 14;
    expect(result.values[15]).toBeCloseTo(expected15, 8);
  });

  it('computeATRAtIndex matches series', () => {
    const candles: OHLC[] = Array.from({ length: 20 }, (_, i) => c(100 + i, 100 + i - 2, 100 + i - 1));
    const series = computeATR(candles, 14);
    const point = computeATRAtIndex(candles, 19, 14);
    expect(point.value).toBeCloseTo(series.values[19], 10);
  });

  it('blendedATR takes max of atr4h and atr1h * factor', () => {
    expect(blendedATR(5, 3, 1.4)).toBeCloseTo(5, 10);     // 5 > 3 * 1.4 = 4.2
    expect(blendedATR(5, 4, 1.4)).toBeCloseTo(5.6, 10);    // 4 * 1.4 = 5.6 > 5
    expect(blendedATR(NaN, 4, 1.4)).toBeNaN();
  });
});

// ──── Efficiency Ratio ────

describe('Efficiency Ratio (Kaufman)', () => {
  it('trending series: ER ≈ 0.56 on constructed fixture', () => {
    // Direction = 5.4, Volatility = 9.6, ratio = 0.5625 (≈ 0.56 per spec §2.2)
    const closes = [100, 101.5, 101, 102.5, 102, 103.5, 103, 104.5, 104, 105.5, 105.4];
    const { value } = computeERAtIndex(closes, 10, 10);
    expect(value).toBeCloseTo(0.5625, 6);
  });

  it('choppy series: ER = 0.20 on constructed fixture', () => {
    // Direction = 2, Volatility = 10, ratio = 0.20 (≈ 0.20 per spec §2.2)
    const closes = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 102];
    const { value } = computeERAtIndex(closes, 10, 10);
    expect(value).toBeCloseTo(0.2, 6);
  });

  it('flat series: ER = 0 (zero volatility handled)', () => {
    const closes = Array.from({ length: 15 }, () => 100);
    const { value } = computeERAtIndex(closes, 14, 10);
    expect(value).toBe(0);
  });

  it('perfect trend: ER = 1.0', () => {
    const closes = Array.from({ length: 15 }, (_, i) => 100 + i);
    const { value } = computeERAtIndex(closes, 14, 10);
    expect(value).toBeCloseTo(1.0, 10);
  });

  it('series: raw and smoothed returned; smoothed is EMA of valid tail', () => {
    const closes = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 102, 103, 104, 105];
    const { raw, smoothed } = computeER(closes, 10, 3);
    expect(raw.length).toBe(closes.length);
    expect(smoothed.length).toBe(closes.length);
    for (let i = 0; i < 10; i++) {
      expect(raw[i]).toBeNaN();
      expect(smoothed[i]).toBeNaN();
    }
    // First valid smoothed equals first valid raw
    expect(smoothed[10]).toBeCloseTo(raw[10], 10);
  });

  it('computeERAtIndex matches series raw values', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i * 0.4) * 3);
    const series = computeER(closes, 10);
    for (let i = 10; i < closes.length; i++) {
      const point = computeERAtIndex(closes, i, 10);
      expect(point.value).toBeCloseTo(series.raw[i], 10);
    }
  });
});

// ──── Anchored VWAP ────

describe('Anchored VWAP (fixed anchor)', () => {
  function c(h: number, l: number, cl: number, v: number): OHLC {
    return { timestamp: 0, open: cl, high: h, low: l, close: cl, volume: v };
  }

  it('NaN before the anchor; first value at anchor equals typical price', () => {
    const candles = [
      c(10, 8, 9, 100),
      c(11, 9, 10, 100),
      c(12, 10, 11, 100),
    ];
    const { values } = computeAVWAP(candles, 1);
    expect(values[0]).toBeNaN();
    // At anchor, AVWAP = typical = (11+9+10)/3 = 10
    expect(values[1]).toBeCloseTo(10, 10);
  });

  it('equal volumes: AVWAP equals mean of typical prices from anchor forward', () => {
    const candles = [
      c(10, 8, 9, 100),
      c(11, 9, 10, 100),  // typical = 10
      c(13, 11, 12, 100), // typical = 12
      c(16, 14, 15, 100), // typical = 15
    ];
    const { values } = computeAVWAP(candles, 1);
    expect(values[1]).toBeCloseTo(10, 10);
    expect(values[2]).toBeCloseTo(11, 10);       // (10+12)/2
    expect(values[3]).toBeCloseTo(12.333333, 4); // (10+12+15)/3
  });

  it('volume-weighted: heavier volume pulls AVWAP toward that candle', () => {
    const candles = [
      c(10, 10, 10, 100), // typical 10, vol 100
      c(20, 20, 20, 900), // typical 20, vol 900
    ];
    const { values } = computeAVWAP(candles, 0);
    // AVWAP = (10*100 + 20*900) / 1000 = 19
    expect(values[1]).toBeCloseTo(19, 10);
  });

  it('computeAVWAPAtIndex matches series', () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      c(100 + i + 2, 100 + i - 2, 100 + i, 50 + i * 10)
    );
    const series = computeAVWAP(candles, 3);
    for (let i = 3; i < 10; i++) {
      const point = computeAVWAPAtIndex(candles, 3, i);
      expect(point.value).toBeCloseTo(series.values[i], 10);
    }
  });

  it('returns NaN for out-of-range anchor or index before anchor', () => {
    const candles = [c(10, 8, 9, 100), c(11, 9, 10, 100)];
    expect(computeAVWAPAtIndex(candles, 5, 1).value).toBeNaN();
    expect(computeAVWAPAtIndex(candles, 1, 0).value).toBeNaN();
  });
});

// ──── ConditionEvaluator stateful operators (Phase 2) ────

describe('ConditionEvaluator — stateful operators', () => {
  function mk(close: number, i: number): OHLC {
    return { timestamp: 1000000 + i * 300000, open: close, high: close + 1, low: close - 1, close, volume: 100 };
  }

  it('DECLINING_N fires only after n consecutive strictly-decreasing RSI values', () => {
    // Build prices that produce rising-then-declining RSI
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i * 2);     // RSI climbs to ~100
    const falling = Array.from({ length: 10 }, (_, i) => 138 - i * 1.5);  // RSI declines
    const allCloses = [...rising, ...falling];
    const candles = allCloses.map((c, i) => mk(c, i));

    const conditions: IndicatorCondition[] = [{
      indicator: 'RSI',
      params: { length: 14 },
      condition: 'DECLINING_N',
      signalValue: 3,
      timeframe: '5m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();

    let firstFireIdx = -1;
    for (let i = 0; i < candles.length; i++) {
      const result = evaluator.evaluate(candles, i, aggregated);
      if (result.allConditionsMet) { firstFireIdx = i; break; }
    }
    // Must fire only after 3 consecutive declines, so strictly after the first falling candle
    expect(firstFireIdx).toBeGreaterThan(rising.length);
  });

  it('DECLINING_N does NOT fire on monotonically rising values', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const candles = rising.map((c, i) => mk(c, i));

    const conditions: IndicatorCondition[] = [{
      indicator: 'RSI',
      params: { length: 14 },
      condition: 'DECLINING_N',
      signalValue: 3,
      timeframe: '5m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();

    let anyFire = false;
    for (let i = 0; i < candles.length; i++) {
      const r = evaluator.evaluate(candles, i, aggregated);
      if (r.allConditionsMet) { anyFire = true; break; }
    }
    expect(anyFire).toBe(false);
  });

  it('RATIO_BELOW fires when current value drops below a fraction of recent peak', () => {
    // ATR history rises then collapses; ratio of current / max-prior history < 0.5 should fire
    // Build candles: high volatility segment, then quiet segment
    const candles: OHLC[] = [];
    // 20 wide-range candles (TR ≈ 10)
    for (let i = 0; i < 20; i++) candles.push({ timestamp: i, open: 100, high: 105, low: 95, close: 100, volume: 100 });
    // 20 quiet candles (TR ≈ 1)
    for (let i = 20; i < 40; i++) candles.push({ timestamp: i, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100 });

    const conditions: IndicatorCondition[] = [{
      indicator: 'ATR',
      params: { period: 14 },
      condition: 'RATIO_BELOW',
      signalValue: 0.5,
      timeframe: '5m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();

    let fired = false;
    for (let i = 0; i < candles.length; i++) {
      const r = evaluator.evaluate(candles, i, aggregated);
      if (r.allConditionsMet) { fired = true; break; }
    }
    expect(fired).toBe(true);
  });

  it('TOUCHED_AND_REJECTED requires both touch (above signal) and rejection (below signal)', () => {
    // Sequence: values below, then cross above (arm), then drop back below (fire)
    const prices = [
      ...Array.from({ length: 20 }, () => 100),       // flat: RSI ≈ neutral, below 70
      ...Array.from({ length: 10 }, (_, i) => 100 + i * 3), // rally: RSI climbs above 70 → touched
      ...Array.from({ length: 10 }, (_, i) => 130 - i * 2), // drop: RSI falls below 70 → rejected
    ];
    const candles = prices.map((c, i) => mk(c, i));

    const conditions: IndicatorCondition[] = [{
      indicator: 'RSI',
      params: { length: 14 },
      condition: 'TOUCHED_AND_REJECTED',
      signalValue: 70,
      timeframe: '5m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();

    let fired = false;
    let firedIdx = -1;
    for (let i = 0; i < candles.length; i++) {
      const r = evaluator.evaluate(candles, i, aggregated);
      if (r.allConditionsMet) { fired = true; firedIdx = i; break; }
    }
    expect(fired).toBe(true);
    // Must fire during the drop phase (after index 30), not during the rally
    expect(firedIdx).toBeGreaterThan(30);
  });

  it('TOUCHED_AND_REJECTED does NOT fire without prior touch', () => {
    // Values always below signal — never touched, so rejection has no meaning
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i * 0.3));
    const candles = prices.map((c, i) => mk(c, i));

    const conditions: IndicatorCondition[] = [{
      indicator: 'RSI',
      params: { length: 14 },
      condition: 'TOUCHED_AND_REJECTED',
      signalValue: 90,
      timeframe: '5m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();

    let fired = false;
    for (let i = 0; i < candles.length; i++) {
      const r = evaluator.evaluate(candles, i, aggregated);
      if (r.allConditionsMet) { fired = true; break; }
    }
    expect(fired).toBe(false);
  });

  it('ring buffer caps history at CONDITION_HISTORY_LIMIT (20)', () => {
    // Feed 50 candles; verify internal history does not exceed 20.
    const prices = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.2));
    const candles = prices.map((c, i) => mk(c, i));

    const conditions: IndicatorCondition[] = [{
      indicator: 'RSI',
      params: { length: 14 },
      condition: 'LESS_THAN',
      signalValue: 100,
      timeframe: '5m',
    }];

    const evaluator = new ConditionEvaluator(conditions);
    const aggregated = new Map<string, OHLC[]>();
    for (let i = 0; i < candles.length; i++) evaluator.evaluate(candles, i, aggregated);

    // Access internal state via type cast for the test (only way to verify the ring buffer)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = (evaluator as any).state as Map<string, { history: number[] }>;
    for (const st of internal.values()) {
      expect(st.history.length).toBeLessThanOrEqual(20);
    }
  });
});
