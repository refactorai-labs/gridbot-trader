import { describe, it, expect } from 'vitest';
import {
  computeSafetyOrderLevels,
  computeAvgEntryPrice,
  computeTakeProfitPrice,
  computeStopLossPrice,
  checkTrailingTP,
} from '../lib/strategies/dcaOrderManager';
import { DCABreakoutConfig } from '../lib/types';

// Helper to create a minimal config for testing
function makeConfig(overrides: Partial<DCABreakoutConfig> = {}): DCABreakoutConfig {
  return {
    direction: 'LONG',
    baseOrderSize: 100,
    leverageType: 'isolated',
    leverageValue: 1,
    startConditions: [],
    deviationFirstOrder: 1,
    deviationStepMultiplier: 1.5,
    averagingOrderSize: 50,
    orderSizeMultiplier: 1.2,
    maxAveragingOrders: 3,
    takeProfitPercent: 2,
    trailingEnabled: false,
    trailingPercent: 0.5,
    reinvestProfit: 0,
    stopLossEnabled: false,
    stopLossPercent: 5,
    stopLossAction: 'CLOSE_TRADE',
    ...overrides,
  };
}

// ──── Safety Order Levels ────

describe('computeSafetyOrderLevels', () => {
  it('should compute correct deviation % and sizes for LONG', () => {
    const config = makeConfig({
      direction: 'LONG',
      deviationFirstOrder: 1,
      deviationStepMultiplier: 1.5,
      averagingOrderSize: 50,
      orderSizeMultiplier: 1.2,
      maxAveragingOrders: 3,
    });

    const levels = computeSafetyOrderLevels(config, 100);

    // SO1: deviation=1%, price=99, size=50
    expect(levels[0].orderNumber).toBe(1);
    expect(levels[0].deviation).toBeCloseTo(1, 10);
    expect(levels[0].triggerPrice).toBeCloseTo(99, 10);
    expect(levels[0].size).toBeCloseTo(50, 10);

    // SO2: deviation=1*1.5=1.5%, price=98.5, size=50*1.2=60
    expect(levels[1].orderNumber).toBe(2);
    expect(levels[1].deviation).toBeCloseTo(1.5, 10);
    expect(levels[1].triggerPrice).toBeCloseTo(98.5, 10);
    expect(levels[1].size).toBeCloseTo(60, 10);

    // SO3: deviation=1*1.5^2=2.25%, price=97.75, size=50*1.2^2=72
    expect(levels[2].orderNumber).toBe(3);
    expect(levels[2].deviation).toBeCloseTo(2.25, 10);
    expect(levels[2].triggerPrice).toBeCloseTo(97.75, 10);
    expect(levels[2].size).toBeCloseTo(72, 10);
  });

  it('should compute correct trigger prices for SHORT', () => {
    const config = makeConfig({
      direction: 'SHORT',
      deviationFirstOrder: 1,
      deviationStepMultiplier: 1.5,
      averagingOrderSize: 50,
      orderSizeMultiplier: 1.2,
      maxAveragingOrders: 3,
    });

    const levels = computeSafetyOrderLevels(config, 100);

    // SHORT: triggerPrice = baseOrderPrice * (1 + deviation/100)
    expect(levels[0].triggerPrice).toBeCloseTo(101, 10);     // 100 * 1.01
    expect(levels[1].triggerPrice).toBeCloseTo(101.5, 10);   // 100 * 1.015
    expect(levels[2].triggerPrice).toBeCloseTo(102.25, 10);  // 100 * 1.0225
  });

  it('should return empty array when maxAveragingOrders is 0', () => {
    const config = makeConfig({ maxAveragingOrders: 0 });
    const levels = computeSafetyOrderLevels(config, 100);
    expect(levels).toHaveLength(0);
  });
});

// ──── Average Entry Price ────

describe('computeAvgEntryPrice', () => {
  it('should return base price when no SOs filled', () => {
    const avg = computeAvgEntryPrice(100, 100, []);
    expect(avg).toBe(100);
  });

  it('should compute weighted average with filled SOs', () => {
    // Base: price=100, size=100
    // SO1: price=99, size=50
    // Weighted avg = (100*100 + 99*50) / (100+50) = (10000+4950)/150 = 99.6667
    const filledSOs = [{ orderNumber: 1, deviation: 1, size: 50, triggerPrice: 99 }];
    const avg = computeAvgEntryPrice(100, 100, filledSOs);
    expect(avg).toBeCloseTo(14950 / 150, 10);
  });

  it('should compute weighted average with multiple SOs', () => {
    const filledSOs = [
      { orderNumber: 1, deviation: 1, size: 50, triggerPrice: 99 },
      { orderNumber: 2, deviation: 1.5, size: 60, triggerPrice: 98.5 },
    ];
    // Weighted avg = (100*100 + 99*50 + 98.5*60) / (100+50+60)
    // = (10000 + 4950 + 5910) / 210 = 20860 / 210
    const avg = computeAvgEntryPrice(100, 100, filledSOs);
    expect(avg).toBeCloseTo(20860 / 210, 10);
  });
});

// ──── Take Profit Price ────

describe('computeTakeProfitPrice', () => {
  it('should compute TP for LONG', () => {
    // LONG: avgPrice * (1 + tpPercent/100) = 100 * 1.02 = 102
    const tp = computeTakeProfitPrice(100, 2, 'LONG');
    expect(tp).toBeCloseTo(102, 10);
  });

  it('should compute TP for SHORT', () => {
    // SHORT: avgPrice * (1 - tpPercent/100) = 100 * 0.98 = 98
    const tp = computeTakeProfitPrice(100, 2, 'SHORT');
    expect(tp).toBeCloseTo(98, 10);
  });

  it('should handle fractional percents', () => {
    const tp = computeTakeProfitPrice(50000, 0.5, 'LONG');
    expect(tp).toBeCloseTo(50250, 10);
  });
});

// ──── Stop Loss Price ────

describe('computeStopLossPrice', () => {
  it('should compute SL for LONG', () => {
    // LONG: baseOrderPrice * (1 - slPercent/100) = 100 * 0.95 = 95
    const sl = computeStopLossPrice(100, 5, 'LONG');
    expect(sl).toBeCloseTo(95, 10);
  });

  it('should compute SL for SHORT', () => {
    // SHORT: baseOrderPrice * (1 + slPercent/100) = 100 * 1.05 = 105
    const sl = computeStopLossPrice(100, 5, 'SHORT');
    expect(sl).toBeCloseTo(105, 10);
  });

  it('should handle small percent', () => {
    const sl = computeStopLossPrice(50000, 1, 'LONG');
    expect(sl).toBeCloseTo(49500, 10);
  });
});

// ──── Trailing TP ────

describe('checkTrailingTP', () => {
  describe('LONG direction', () => {
    it('should update high watermark when price rises', () => {
      const result = checkTrailingTP(110, 105, 1, 'LONG');
      expect(result.newHigh).toBe(110);
      expect(result.triggered).toBe(false);
    });

    it('should not trigger if pullback is within threshold', () => {
      // High is 110, 1% pullback threshold = 108.9
      // Current price 109.5 > 108.9, not triggered
      const result = checkTrailingTP(109.5, 110, 1, 'LONG');
      expect(result.newHigh).toBe(110);
      expect(result.triggered).toBe(false);
    });

    it('should trigger when pullback exceeds threshold', () => {
      // High is 110, 1% pullback threshold = 108.9
      // Current price 108 < 108.9, triggered
      const result = checkTrailingTP(108, 110, 1, 'LONG');
      expect(result.newHigh).toBe(110);
      expect(result.triggered).toBe(true);
    });

    it('should trigger exactly at threshold', () => {
      // High is 100, 1% threshold = 99. Price at 99 should trigger (<=)
      const result = checkTrailingTP(99, 100, 1, 'LONG');
      expect(result.triggered).toBe(true);
    });
  });

  describe('SHORT direction', () => {
    it('should update low watermark when price drops', () => {
      const result = checkTrailingTP(90, 95, 1, 'SHORT');
      expect(result.newHigh).toBe(90);
      expect(result.triggered).toBe(false);
    });

    it('should not trigger if bounce is within threshold', () => {
      // Low is 90, 1% bounce threshold = 90.9
      // Current price 90.5 < 90.9, not triggered
      const result = checkTrailingTP(90.5, 90, 1, 'SHORT');
      expect(result.newHigh).toBe(90);
      expect(result.triggered).toBe(false);
    });

    it('should trigger when bounce exceeds threshold', () => {
      // Low is 90, 1% bounce threshold = 90.9
      // Current price 91.5 > 90.9, triggered
      const result = checkTrailingTP(91.5, 90, 1, 'SHORT');
      expect(result.newHigh).toBe(90);
      expect(result.triggered).toBe(true);
    });

    it('should trigger exactly at threshold', () => {
      // Low is 100, 1% threshold = 101. Price at 101 should trigger (>=)
      const result = checkTrailingTP(101, 100, 1, 'SHORT');
      expect(result.triggered).toBe(true);
    });
  });
});
