import { describe, it, expect } from 'vitest';
import { sharpe, psr, stitchedFitness, TRADE_THRESHOLD, DD_PENALTY_LAMBDA } from '../lib/optimizer/stitchedFitness';
import { computeFolds } from '../lib/optimizer/walkForwardCombo';

describe('stitchedFitness — Sharpe', () => {
  it('constant returns produce sharpe = 0 (sd = 0 guard)', () => {
    expect(sharpe([0.01, 0.01, 0.01, 0.01], 1)).toBe(0);
  });

  it('rising + falling returns with positive mean produce positive sharpe', () => {
    const returns = [0.01, 0.02, -0.005, 0.015, 0.005, 0.01];
    const s = sharpe(returns, 1);
    expect(s).toBeGreaterThan(0);
  });

  it('zero-length returns produce zero', () => {
    expect(sharpe([], 1)).toBe(0);
  });
});

describe('stitchedFitness — PSR', () => {
  it('returns ~0.5 when observed SR equals reference SR', () => {
    // Symmetric returns around mean → observed SR near 0 → PSR(ref=0) ≈ 0.5
    const returns = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
    const p = psr(returns, 0);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.7);
  });

  it('returns high probability when SR is strongly positive', () => {
    // 100 small positive returns with tiny variance → high SR → PSR close to 1
    const returns = Array.from({ length: 100 }, (_, i) => 0.001 + (i % 3) * 0.0001);
    const p = psr(returns, 0);
    expect(p).toBeGreaterThan(0.9);
  });
});

describe('stitchedFitness — aggregation', () => {
  it('empty folds → zero fitness', () => {
    const r = stitchedFitness([]);
    expect(r.fitness).toBe(0);
    expect(r.nTradesTotal).toBe(0);
  });

  it('uses PSR when stitched trades >= TRADE_THRESHOLD', () => {
    const folds = [
      { returns: [0.001, 0.002, 0.0015, 0.0012], nTrades: 20, maxDrawdownPct: 0.05 },
      { returns: [0.0008, 0.0012, 0.0009], nTrades: 15, maxDrawdownPct: 0.03 },
    ];
    expect(folds.reduce((s, f) => s + f.nTrades, 0)).toBeGreaterThanOrEqual(TRADE_THRESHOLD);
    const r = stitchedFitness(folds);
    expect(r.usedPSR).toBe(true);
  });

  it('falls back to Sharpe when stitched trades < TRADE_THRESHOLD', () => {
    const folds = [
      { returns: [0.001, 0.002, 0.0015, 0.0012], nTrades: 5, maxDrawdownPct: 0.05 },
      { returns: [0.0008, 0.0012, 0.0009], nTrades: 5, maxDrawdownPct: 0.03 },
    ];
    const r = stitchedFitness(folds);
    expect(r.usedPSR).toBe(false);
  });

  it('drawdown penalty: fitness decreases as worst-fold DD increases', () => {
    const mkFold = (dd: number) => ({ returns: [0.001, 0.002, 0.0015], nTrades: 50, maxDrawdownPct: dd });
    const lo = stitchedFitness([mkFold(0.05), mkFold(0.05), mkFold(0.05)]);
    const hi = stitchedFitness([mkFold(0.05), mkFold(0.05), mkFold(0.25)]);
    expect(lo.fitness - hi.fitness).toBeCloseTo(DD_PENALTY_LAMBDA * (0.25 - 0.05), 8);
  });

  it('stability drops when fold sharpes diverge', () => {
    // Three identical-sharpe folds → stability = 1
    const identical = [
      { returns: [0.001, 0.001, 0.001], nTrades: 5, maxDrawdownPct: 0.05 },
      { returns: [0.001, 0.001, 0.001], nTrades: 5, maxDrawdownPct: 0.05 },
      { returns: [0.001, 0.001, 0.001], nTrades: 5, maxDrawdownPct: 0.05 },
    ];
    const rIden = stitchedFitness(identical);
    // Fold sharpes are all 0 (zero variance in returns) so stability should be 1 (0/0 → mean=0, sd=0 → 1)
    expect(rIden.stability).toBe(1);

    // Wide-variance fold sharpes
    const varied = [
      { returns: [0.01, -0.005, 0.008, -0.002], nTrades: 5, maxDrawdownPct: 0.05 },
      { returns: [-0.01, 0.005, -0.008, 0.002], nTrades: 5, maxDrawdownPct: 0.05 },
      { returns: [0.02, -0.01, 0.02, -0.01], nTrades: 5, maxDrawdownPct: 0.05 },
    ];
    const rVar = stitchedFitness(varied);
    expect(rVar.stability).toBeLessThan(rIden.stability);
  });
});

describe('walkForwardCombo — computeFolds', () => {
  it('produces no folds when total length is shorter than train+oos', () => {
    expect(computeFolds(100, 200, 50, 50)).toEqual([]);
  });

  it('produces correct overlapping 12m/3m/step-3m folds', () => {
    // 5m candles: 12m train = 103680, 3m OOS = 25920, step 3m = 25920
    // Over 3 years ≈ 311040 candles → expected folds ≈ floor((311040-103680-25920)/25920)+1 = 8
    const folds = computeFolds(311040, 103680, 25920, 25920);
    expect(folds.length).toBe(8);
    // First fold
    expect(folds[0]).toEqual({
      foldIndex: 0,
      trainStartIdx: 0,
      trainEndIdx: 103680,
      oosStartIdx: 103680,
      oosEndIdx: 129600,
    });
    // Each subsequent fold advances by stepCandles
    for (let i = 1; i < folds.length; i++) {
      expect(folds[i].trainStartIdx - folds[i - 1].trainStartIdx).toBe(25920);
    }
  });
});
