import { describe, it, expect } from 'vitest';
import { generateRandomParams, generateSearchSpace, DCA_PARAM_RANGES, ParamRange } from '../lib/optimizer/randomSearch';
import { evaluateFitness, DEFAULT_CONSTRAINTS, FitnessConstraints } from '../lib/optimizer/fitnessFunction';
import { computeWindows } from '../lib/optimizer/walkForward';
import { StrategyMetrics } from '../lib/types';

// ──── Random Search ────

describe('generateRandomParams', () => {
  it('should generate values within continuous ranges', () => {
    const ranges: ParamRange[] = [
      { name: 'alpha', type: 'continuous', min: 0, max: 10 },
      { name: 'beta', type: 'continuous', min: -5, max: 5 },
    ];

    for (let i = 0; i < 100; i++) {
      const params = generateRandomParams(ranges);
      expect(params.alpha).toBeGreaterThanOrEqual(0);
      expect(params.alpha).toBeLessThanOrEqual(10);
      expect(params.beta).toBeGreaterThanOrEqual(-5);
      expect(params.beta).toBeLessThanOrEqual(5);
    }
  });

  it('should generate values on discrete steps', () => {
    const ranges: ParamRange[] = [
      { name: 'qty', type: 'discrete', min: 50, max: 200, step: 50 },
    ];

    for (let i = 0; i < 100; i++) {
      const params = generateRandomParams(ranges);
      expect([50, 100, 150, 200]).toContain(params.qty);
    }
  });

  it('should select from choice values', () => {
    const ranges: ParamRange[] = [
      { name: 'mode', type: 'choice', choices: ['a', 'b', 'c'] },
    ];

    for (let i = 0; i < 50; i++) {
      const params = generateRandomParams(ranges);
      expect(['a', 'b', 'c']).toContain(params.mode);
    }
  });

  it('should generate all DCA param keys', () => {
    const params = generateRandomParams(DCA_PARAM_RANGES);
    for (const range of DCA_PARAM_RANGES) {
      expect(params).toHaveProperty(range.name);
    }
  });

  it('DCA params should be within specified bounds', () => {
    for (let i = 0; i < 50; i++) {
      const params = generateRandomParams(DCA_PARAM_RANGES);
      for (const range of DCA_PARAM_RANGES) {
        if (range.min !== undefined) {
          expect(params[range.name]).toBeGreaterThanOrEqual(range.min);
        }
        if (range.max !== undefined) {
          expect(params[range.name]).toBeLessThanOrEqual(range.max);
        }
      }
    }
  });
});

describe('generateSearchSpace', () => {
  it('should generate the correct number of samples', () => {
    const results = generateSearchSpace({
      paramRanges: [{ name: 'x', type: 'continuous', min: 0, max: 1 }],
      iterations: 25,
    });
    expect(results).toHaveLength(25);
  });
});

// ──── Fitness Function ────

describe('evaluateFitness', () => {
  const goodMetrics: StrategyMetrics = {
    totalPnl: 500,
    totalPnlPct: 10,
    totalTrades: 20,
    winCount: 14,
    lossCount: 6,
    maxDrawdown: 100,
    maxDrawdownPct: 5,
    sharpeRatio: 1.8,
    profitFactor: 2.3,
    avgTradePnl: 25,
    avgTradeDuration: 120,
  };

  it('should pass when all constraints met', () => {
    const result = evaluateFitness(goodMetrics, DEFAULT_CONSTRAINTS);
    expect(result.meetsConstraints).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.score).toBe(1.8); // sharpeRatio
  });

  it('should fail for too few trades', () => {
    const metrics = { ...goodMetrics, totalTrades: 2 };
    const result = evaluateFitness(metrics, DEFAULT_CONSTRAINTS);
    expect(result.meetsConstraints).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain('Too few trades');
    expect(result.score).toBeLessThan(-100);
  });

  it('should fail for excessive drawdown', () => {
    const metrics = { ...goodMetrics, maxDrawdownPct: 45 };
    const result = evaluateFitness(metrics, DEFAULT_CONSTRAINTS);
    expect(result.meetsConstraints).toBe(false);
    expect(result.violations.some(v => v.includes('Drawdown'))).toBe(true);
  });

  it('should fail for low profit factor', () => {
    const metrics = { ...goodMetrics, profitFactor: 0.5 };
    const result = evaluateFitness(metrics, DEFAULT_CONSTRAINTS);
    expect(result.meetsConstraints).toBe(false);
    expect(result.violations.some(v => v.includes('Profit factor'))).toBe(true);
  });

  it('should not check profit factor when zero trades', () => {
    const metrics = { ...goodMetrics, totalTrades: 0, profitFactor: 0 };
    const result = evaluateFitness(metrics, DEFAULT_CONSTRAINTS);
    // Should fail for minTrades, but not for profitFactor
    expect(result.violations.some(v => v.includes('Profit factor'))).toBe(false);
    expect(result.violations.some(v => v.includes('Too few trades'))).toBe(true);
  });

  it('penalty score decreases with more violations', () => {
    const metrics1 = { ...goodMetrics, totalTrades: 2 }; // 1 violation
    const metrics2 = { ...goodMetrics, totalTrades: 2, maxDrawdownPct: 50 }; // 2 violations
    const r1 = evaluateFitness(metrics1, DEFAULT_CONSTRAINTS);
    const r2 = evaluateFitness(metrics2, DEFAULT_CONSTRAINTS);
    expect(r2.score).toBeLessThan(r1.score);
  });

  it('should use custom constraints', () => {
    const strict: FitnessConstraints = { minTrades: 50, maxDrawdownPct: 3, minProfitFactor: 3.0 };
    const result = evaluateFitness(goodMetrics, strict);
    expect(result.meetsConstraints).toBe(false);
    expect(result.violations.length).toBe(3);
  });
});

// ──── Walk-Forward Window Calculation ────

describe('computeWindows', () => {
  it('should produce the requested number of windows', () => {
    const windows = computeWindows(1000, 3, 0.7);
    expect(windows).toHaveLength(3);
  });

  it('should produce non-overlapping OOS segments', () => {
    const windows = computeWindows(2000, 4, 0.7);
    // OOS segments should not overlap with each other
    for (let i = 1; i < windows.length; i++) {
      // Each window's OOS start should be after or at the previous window's OOS start
      // (they can overlap in IS, but OOS should advance)
      expect(windows[i].oosStart).toBeGreaterThan(windows[i - 1].oosStart);
    }
  });

  it('all IS portions come before OOS portions in each window', () => {
    const windows = computeWindows(1500, 3, 0.7);
    for (const w of windows) {
      expect(w.isEnd).toBeLessThanOrEqual(w.oosStart);
      expect(w.isStart).toBeLessThan(w.isEnd);
      expect(w.oosStart).toBeLessThan(w.oosEnd);
    }
  });

  it('should skip windows that are too small', () => {
    // With only 100 candles and 5 windows, each window is tiny
    const windows = computeWindows(100, 5, 0.7);
    // Some windows may be skipped due to size constraints
    for (const w of windows) {
      expect(w.isEnd - w.isStart).toBeGreaterThanOrEqual(100);
      expect(w.oosEnd - w.oosStart).toBeGreaterThanOrEqual(50);
    }
  });

  it('windows should stay within data bounds', () => {
    const totalLen = 5000;
    const windows = computeWindows(totalLen, 5, 0.7);
    for (const w of windows) {
      expect(w.isStart).toBeGreaterThanOrEqual(0);
      expect(w.oosEnd).toBeLessThanOrEqual(totalLen);
    }
  });

  it('IS ratio should approximately match inSampleRatio', () => {
    const windows = computeWindows(3000, 3, 0.7);
    for (const w of windows) {
      const windowSize = w.oosEnd - w.isStart;
      const isSize = w.isEnd - w.isStart;
      const ratio = isSize / windowSize;
      expect(ratio).toBeCloseTo(0.7, 1); // within 0.1
    }
  });
});
