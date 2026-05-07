import { describe, expect, it } from 'vitest';
import { runComboAblation } from '../lib/optimizer/comboAblation';
import { computeFolds } from '../lib/optimizer/walkForwardCombo';
import { ComboBotConfig, OHLC } from '../lib/types';

function candle(ts: number, close: number): OHLC {
  return {
    timestamp: ts,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  };
}

function candles(count: number): OHLC[] {
  return Array.from({ length: count }, (_, i) => candle(1_700_000_000 + i * 300, 100 + Math.sin(i / 4)));
}

const BASE_CONFIG: ComboBotConfig = {
  enabled: true,
  mode: 'dual',
  leverage: 5,
  allocationLong: 0.6,
  avwapEnabled: true,
  reopenPolicy: 'full_v31',
  totalCapital: 10000,
  gridLevels: 10,
  longSide: {
    averagingDepth: 5,
    slBasePercent: 0.015,
    slAtrMultiplier: 1.0,
    slFloor: 0.02,
    slCap: 0.06,
    tier1Size: 0.25,
    tier2Size: 0.5,
    tier3Size: 1.0,
    cooldownCandles: 12,
    retryCap: 2,
    hibernationCandles: 288,
  },
  shortSide: {
    averagingDepth: 2,
    slBasePercent: 0.008,
    slAtrMultiplier: 0.7,
    slFloor: 0.015,
    slCap: 0.04,
    tier1Size: 0.25,
    tier2Size: 0.5,
    tier3Size: 1.0,
    cooldownCandles: 12,
    retryCap: 2,
    hibernationCandles: 288,
  },
  atrPeriod: 14,
  erLookback: 10,
  erSmoothingLength: 3,
  erRegimeThreshold: 0.6,
  rsiLongThreshold: 35,
  rsiShortThreshold: 65,
};

describe('combo ablation harness', () => {
  it('produces deterministic output for the same candle input', () => {
    const input = {
      candles5m: candles(120),
      baseConfig: BASE_CONFIG,
      totalCapital: 10000,
      feeRate: 0.001,
      policies: ['mvp_current' as const, 'full_v31' as const],
      avwapOptions: [true, false],
    };
    expect(runComboAblation(input)).toEqual(runComboAblation(input));
  });

  it('AVWAP-on/off runs differ only by the ablation config when no AVWAP signal is available', () => {
    const runs = runComboAblation({
      candles5m: candles(12),
      baseConfig: BASE_CONFIG,
      totalCapital: 10000,
      feeRate: 0.001,
      policies: ['mvp_current'],
      avwapOptions: [true, false],
    });
    expect(runs).toHaveLength(2);
    expect(runs[0].policy).toBe(runs[1].policy);
    expect(runs[0].avwapEnabled).toBe(true);
    expect(runs[1].avwapEnabled).toBe(false);
    expect({ ...runs[0], avwapEnabled: false }).toEqual(runs[1]);
  });

  it('fails clearly when cached candles are missing', () => {
    expect(() => runComboAblation({
      candles5m: [],
      baseConfig: BASE_CONFIG,
      totalCapital: 10000,
      feeRate: 0.001,
    })).toThrow('Combo ablation requires at least one cached 5m candle');
  });

  it('plumbs a finite slippageCost field for every ablation run', () => {
    const runs = runComboAblation({
      candles5m: candles(120),
      baseConfig: BASE_CONFIG,
      totalCapital: 10000,
      feeRate: 0.001,
      policies: ['mvp_current'],
      avwapOptions: [true, false],
    });
    for (const r of runs) {
      expect(Number.isFinite(r.long.slippageCost)).toBe(true);
      expect(Number.isFinite(r.short.slippageCost)).toBe(true);
      expect(r.long.slippageCost).toBeGreaterThanOrEqual(0);
      expect(r.short.slippageCost).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports nonzero slippage cost on a fixture engineered to guarantee fills', () => {
    // Engineered to guarantee fills: long warmup (>~10 4H candles), strong
    // sustained uptrend that crosses the ER threshold so breakout fires and
    // produces a market-entry fill. Each market-entry fill writes slippage via
    // applySlippage in the supervisor, so any non-zero fill count must produce
    // a strictly positive total slippage cost. The assertion is unconditional —
    // if a future change causes the fixture to stop producing fills, this test
    // fails loudly instead of silently passing.
    const start = 1_700_000_000;
    const candles5m: OHLC[] = [];
    let t = start;
    // 480 5m candles flat warmup (~10 4H candles, gives the adaptive engine
    // enough samples to settle ATR/ER even at default atrPeriod=14).
    for (let i = 0; i < 480; i++) {
      const p = 2000 + Math.sin(i * 0.05) * 0.5;
      candles5m.push({ timestamp: t, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 100 });
      t += 300;
    }
    // 720 5m candles strong uptrend (~15 more 4H candles). With +1.5 per candle,
    // ER over the trend window stays near 1.0 — well above the 0.6 threshold.
    let price = 2000;
    for (let i = 0; i < 720; i++) {
      const prev = price;
      price = price + 1.5;
      candles5m.push({ timestamp: t, open: prev, high: price + 0.5, low: prev - 0.5, close: price, volume: 100 });
      t += 300;
    }
    const runs = runComboAblation({
      candles5m,
      baseConfig: {
        ...BASE_CONFIG,
        mode: 'long',
        avwapEnabled: false,
        reopenPolicy: 'mvp_current',
        // Relax entry RSI gate: in a clean uptrend RSI sits high, so the default
        // long entry threshold of 35 (which requires an oversold dip) prevents
        // any breakout fill from happening. Setting it to 101 makes the RSI
        // condition always pass, leaving the trending+ER gate as the entry
        // trigger.
        rsiLongThreshold: 100,
        rsiShortThreshold: 0,
      },
      totalCapital: 10000,
      feeRate: 0,
      policies: ['mvp_current'],
      avwapOptions: [false],
    });
    const totalFills = runs[0].long.tradeCount + runs[0].short.tradeCount;
    expect(totalFills).toBeGreaterThan(0);
    expect(runs[0].long.slippageCost + runs[0].short.slippageCost).toBeGreaterThan(0);
  });

  it('keeps 12m train / 3m OOS / 3m step fold boundaries stable', () => {
    const train = 103_680;
    const oos = 25_920;
    const step = 25_920;
    const folds = computeFolds(311_040, train, oos, step);
    expect(folds[0]).toEqual({
      foldIndex: 0,
      trainStartIdx: 0,
      trainEndIdx: train,
      oosStartIdx: train,
      oosEndIdx: train + oos,
    });
    expect(folds[folds.length - 1]).toEqual({
      foldIndex: 7,
      trainStartIdx: 181_440,
      trainEndIdx: 285_120,
      oosStartIdx: 285_120,
      oosEndIdx: 311_040,
    });
  });
});

