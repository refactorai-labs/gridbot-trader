import { describe, it, expect } from 'vitest';
import { OHLC, ComboBotConfig, ComboBotSideConfig } from '../lib/types';
import { runComboSimulationCore } from '../lib/combo/supervisor';
import { aggregate5mTo } from '../lib/data/aggregator';
import { FundingRateEntry } from '../lib/simulation/funding';

function candle(ts: number, o: number, h: number, l: number, c: number, v: number = 100): OHLC {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: v };
}

function primedTrendCandles(startTs: number): OHLC[] {
  return Array.from({ length: 30 }, (_, i) => {
    const close = 80 + i;
    return candle(startTs - (30 - i) * 14_400, close - 0.5, close + 2, close - 2, close, 100);
  });
}

const SIDE_CFG: ComboBotSideConfig = {
  averagingDepth: 5,
  slBasePercent: 0.015,
  slAtrMultiplier: 1.5,
  slFloor: 0.01,
  slCap: 0.04,
  tier1Size: 0.25,
  tier2Size: 0.5,
  tier3Size: 1.0,
  cooldownCandles: 6,
  retryCap: 3,
  hibernationCandles: 24,
};

const FAST_SIDE_CFG: ComboBotSideConfig = {
  ...SIDE_CFG,
  slBasePercent: 0.005,
  slAtrMultiplier: 0,
  slFloor: 0.01,
  slCap: 0.01,
};

const CFG: ComboBotConfig = {
  enabled: true,
  mode: 'dual',
  leverage: 5,
  allocationLong: 0.6,
  avwapEnabled: true,
  totalCapital: 10000,
  gridLevels: 10,
  longSide: SIDE_CFG,
  shortSide: SIDE_CFG,
  atrPeriod: 5,
  erLookback: 5,
  erSmoothingLength: 3,
  erRegimeThreshold: 0.4,
  // Relaxed thresholds so the MVP heuristics fire during a synthetic trend
  rsiLongThreshold: 100,
  rsiShortThreshold: 0,
};

const FAST_CFG: ComboBotConfig = {
  ...CFG,
  mode: 'long',
  leverage: 1,
  allocationLong: 1,
  avwapEnabled: false,
  gridLevels: 4,
  longSide: FAST_SIDE_CFG,
  shortSide: FAST_SIDE_CFG,
  atrPeriod: 3,
  erLookback: 3,
  erSmoothingLength: 2,
  erRegimeThreshold: 0.1,
  rsiLongThreshold: 101,
  rsiShortThreshold: 99,
};

describe('combo/supervisor integration', () => {
  it('runs a 1000+ candle ETH-style trending fixture, fires entry events and applies funding+slippage', () => {
    // Build 5m candles: warmup, strong uptrend long enough for 4H ER, drop, recovery
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    let price = 2000;

    // 480 flat (warmup, ~10 4H candles)
    for (let i = 0; i < 480; i++) {
      const p = 2000 + Math.sin(i * 0.05) * 0.5;
      candles5m.push(candle(t, p, p + 0.5, p - 0.5, p));
      t += 300;
    }
    // 720 strong uptrend (~15 4H candles — well above erLookback)
    price = 2000;
    for (let i = 0; i < 720; i++) {
      const prev = price;
      price = price + 1.5;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    // 240 sharp drop (SL trigger)
    for (let i = 0; i < 240; i++) {
      const prev = price;
      price = price - 5.0;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }
    // 240 recovery
    for (let i = 0; i < 240; i++) {
      const prev = price;
      price = price + 2.0;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }

    expect(candles5m.length).toBeGreaterThanOrEqual(1000);

    const candles1h = aggregate5mTo(candles5m, 60);
    const candles4h = aggregate5mTo(candles5m, 240);

    // Funding: 0.01% every 8 hours across the window — ensures the funding loop fires
    const startTs = candles5m[0].timestamp;
    const endTs = candles5m[candles5m.length - 1].timestamp;
    const fundingRates: FundingRateEntry[] = [];
    for (let ts = startTs; ts <= endTs; ts += 8 * 3600) {
      fundingRates.push({ fundingTimeSec: ts, fundingRate: 0.0001 });
    }

    const result = runComboSimulationCore({
      candles5m,
      candles1h,
      candles4h,
      cfg: CFG,
      totalCapital: 10000,
      fundingRates,
      feeRate: 0.001,
      snapshotInterval: 50,
    });

    // At minimum, IDLE → BREAKOUT transition should fire during the uptrend
    const eventTypes = result.events.map(e => e.type);
    expect(eventTypes).toContain('breakout_entered');

    // The synthetic market entry on breakout_entered produces a fill
    expect(result.fills.length).toBeGreaterThan(0);

    // Final anchor exists (ER crossed threshold during the uptrend)
    expect(result.finalAnchor).not.toBeNull();

    // Snapshots cover the run
    expect(result.snapshots.length).toBeGreaterThan(1);
    expect(result.snapshots[result.snapshots.length - 1].candleIdx).toBe(candles5m.length - 1);
  });

  it('does not seed combo grids with inventory-style reverse orders', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);

    const longCandles = [
      candle(start, 100, 100.2, 99.8, 100),
      // Would cross initial long-side sell levels if combo seeded implied inventory sells.
      candle(start + 300, 100, 106, 99.5, 104),
    ];
    const longResult = runComboSimulationCore({
      candles5m: longCandles,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });
    expect(longResult.fills.some(f => f.side === 'long' && f.type === 'sell' && !f.orderId.startsWith('sl_') && !f.positionId)).toBe(false);

    const shortCandles = [
      candle(start, 100, 100.2, 99.8, 100),
      // Would cross initial short-side buy levels if combo seeded implied inventory buys.
      candle(start + 300, 100, 100.5, 94, 96),
    ];
    const shortResult = runComboSimulationCore({
      candles5m: shortCandles,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'short' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });
    expect(shortResult.fills.some(f => f.side === 'short' && f.type === 'buy' && !f.orderId.startsWith('sl_') && !f.positionId)).toBe(false);
  });

  it('opens an explicit one-grid-unit position on monotone long breakout without waiting for pullback', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 101, 99.5, 100),
      candle(start + 300, 100, 104, 100.5, 103),
      candle(start + 600, 103, 107, 103.5, 106),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    const entryFill = result.fills.find(f => f.orderId.startsWith('entry_long_'));
    expect(entryFill).toBeDefined();
    expect(entryFill!.type).toBe('buy');
    expect(entryFill!.levelIndex).toBeLessThan(0);
    expect(result.events.map(e => e.type)).toContain('position_opened');
  });

  it('closes the explicit market entry through its paired take-profit order', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 101, 99.5, 100),
      candle(start + 300, 100, 104, 100.5, 103),
      candle(start + 600, 103, 108, 103.5, 107),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    const entryFill = result.fills.find(f => f.orderId.startsWith('entry_long_'));
    expect(entryFill?.positionId).toBeDefined();
    const tpFill = result.fills.find(f => f.positionId === entryFill!.positionId && f.type === 'sell');
    expect(tpFill).toBeDefined();
    expect(tpFill!.levelIndex).toBeGreaterThanOrEqual(0);
    expect(tpFill!.pnl).toBeGreaterThan(0);
    expect(result.pnlState.realizedPnl).toBeGreaterThan(0);
  });

  it('applies regular slippage to combo grid fills before P&L processing', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      candle(start + 300, 100, 100.2, 98.5, 99.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0.01,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    const buyFill = result.fills.find(f => f.side === 'long' && f.type === 'buy');
    expect(buyFill).toBeDefined();
    // The raw grid level is below 99; 1% buy slippage moves it above 99.
    expect(buyFill!.fillPrice).toBeGreaterThan(99);
  });

  it('forces same-candle SL when a newly filled grid order is stopped later in the candle path', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      // Bullish path is open -> low -> high -> close; the buy fills on the drop,
      // then the remaining drop crosses SL before the candle recovers.
      candle(start + 300, 100, 101, 90, 100.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });

    expect(result.fills.some(f => f.side === 'long' && f.type === 'buy')).toBe(true);
    expect(result.fills.some(f => f.orderId.startsWith('sl_long_'))).toBe(true);
    expect(result.pnlState.openPositions.filter(p => p.side === 'long')).toHaveLength(0);
    expect(result.events.map(e => e.type)).toEqual(expect.arrayContaining(['sl_triggered', 'cooldown_entered']));
  });

  it('forces same-candle SL for short fills stopped later in the candle path', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      // Bearish path is open -> high -> low -> close; the short sell fills on the
      // push up, then the remaining push crosses the short SL before the drop.
      candle(start + 300, 100, 110, 99, 99.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'short' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
    });

    expect(result.fills.some(f => f.side === 'short' && f.type === 'sell')).toBe(true);
    expect(result.fills.some(f => f.orderId.startsWith('sl_short_'))).toBe(true);
    expect(result.pnlState.openPositions.filter(p => p.side === 'short')).toHaveLength(0);
    expect(result.events.map(e => e.type)).toEqual(expect.arrayContaining(['sl_triggered', 'cooldown_entered']));
  });

  it('includes unrealized losses in max drawdown before a position closes', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const wideStopSide: ComboBotSideConfig = {
      ...FAST_SIDE_CFG,
      slBasePercent: 0.5,
      slFloor: 0.5,
      slCap: 0.5,
    };
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      candle(start + 300, 100, 100.2, 89.8, 90),
      candle(start + 600, 90, 91, 89, 90),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long', longSide: wideStopSide },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    expect(result.pnlState.realizedPnl).toBe(0);
    expect(result.pnlState.openPositions.filter(p => p.side === 'long').length).toBeGreaterThan(0);
    expect(result.pnlState.maxDrawdown).toBeGreaterThan(0);
    expect(result.pnlState.maxDrawdownPct).toBeGreaterThan(0);
  });

  it('updates max drawdown when funding is charged without a closing trade', () => {
    const start = 1_700_000_000;
    const trend = primedTrendCandles(start);
    const candles5m = [
      candle(start, 100, 100.2, 99.8, 100),
      candle(start + 300, 100, 100.2, 98.5, 99.5),
      candle(start + 600, 99.5, 100, 99, 99.5),
    ];
    const result = runComboSimulationCore({
      candles5m,
      candles1h: trend,
      candles4h: trend,
      cfg: { ...FAST_CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [{ fundingTimeSec: start + 600, fundingRate: 0.01 }],
      feeRate: 0,
      slippageCfg: {
        basisBp: 0,
        slSlippageCoefficient: 1,
        slSlippageFloor: 0.001,
        slSlippageCap: 0.01,
      },
    });

    expect(result.totalFundingCost).toBeGreaterThan(0);
    expect(result.longFundingCost).toBeGreaterThan(0);
    expect(result.shortFundingCost).toBe(0);
    expect(result.pnlState.maxDrawdown).toBeGreaterThanOrEqual(result.totalFundingCost);
    expect(result.pnlState.maxDrawdownPct).toBeGreaterThan(0);
  });

  it('long-only mode skips short-side state machine entirely', () => {
    const shortCandles: OHLC[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 600; i++) {
      const p = 2000 + i * 0.5;
      shortCandles.push(candle(t, p, p + 1, p - 1, p));
      t += 300;
    }
    const result = runComboSimulationCore({
      candles5m: shortCandles,
      candles1h: aggregate5mTo(shortCandles, 60),
      candles4h: aggregate5mTo(shortCandles, 240),
      cfg: { ...CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.001,
    });
    // No short-side events
    for (const e of result.events) {
      const details = JSON.parse(e.detailsJson) as { side: string };
      expect(details.side).toBe('long');
    }
  });

  it('P&L does NOT double-count leverage (regression — Phase 3c hotfix)', () => {
    // Build a deliberate loss cycle: breakout long at ~2000, price drops to SL, exit.
    // At leverage=5, allocation=100% long, $10K capital → $50K notional total.
    // Per-order notional = $50K / 10 levels = $5K. SL @ slCap=4% = $200 loss per filled level.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    // 240 flat warmup
    for (let i = 0; i < 240; i++) {
      candles5m.push(candle(t, 2000, 2001, 1999, 2000));
      t += 300;
    }
    // 500 strong uptrend to build ER regime
    let price = 2000;
    for (let i = 0; i < 500; i++) {
      const prev = price;
      price += 1.2;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    // Sharp drop to force SL
    for (let i = 0; i < 200; i++) {
      const prev = price;
      price -= 8;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }

    const result = runComboSimulationCore({
      candles5m,
      candles1h: aggregate5mTo(candles5m, 60),
      candles4h: aggregate5mTo(candles5m, 240),
      cfg: { ...CFG, mode: 'long', leverage: 5 },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.0004,
    });

    // With leverage baked into notional exactly once, total P&L is bounded by total notional.
    // Pre-fix (leverage² in fill.size) made losses 5× larger and could exceed -$20K easily.
    // Post-fix: bounded well within total notional — set tight: -$10K floor.
    expect(result.pnlState.realizedPnl).toBeGreaterThan(-10000);
    // Per-fill |pnl| capped by per-order notional × slCap (×2 to cover slippage+fees).
    const perOrderNotional = (10000 * 5) / 10; // 5K
    const maxPerFillLoss = perOrderNotional * 0.04 * 2; // 4% slCap × 2 (slippage+fee margin)
    for (const f of result.fills) {
      if (f.pnl != null && f.pnl < 0) {
        expect(Math.abs(f.pnl)).toBeLessThan(maxPerFillLoss);
      }
    }
  });

  it('slippage is applied on SL exit fills — fillPrice shifts away from slPrice in the trader-hurting direction', () => {
    // Drive a SL exit (long) and verify slippage was applied to the exit fill.
    const candles5m: OHLC[] = [];
    let t = 1_700_000_000;
    for (let i = 0; i < 240; i++) {
      candles5m.push(candle(t, 2000, 2001, 1999, 2000));
      t += 300;
    }
    let price = 2000;
    for (let i = 0; i < 500; i++) {
      const prev = price;
      price += 1.2;
      candles5m.push(candle(t, prev, price + 0.5, prev - 0.5, price));
      t += 300;
    }
    // Sharp drop to force SL
    for (let i = 0; i < 200; i++) {
      const prev = price;
      price -= 8;
      candles5m.push(candle(t, prev, prev + 0.5, price - 0.5, price));
      t += 300;
    }
    const result = runComboSimulationCore({
      candles5m,
      candles1h: aggregate5mTo(candles5m, 60),
      candles4h: aggregate5mTo(candles5m, 240),
      cfg: { ...CFG, mode: 'long' },
      totalCapital: 10000,
      fundingRates: [],
      feeRate: 0.001,
    });
    // SL exits use orderId pattern `sl_<side>_<candleIdx>_<levelIndex>`.
    const slFill = result.fills.find(f => f.orderId.startsWith('sl_long_'));
    // Hard assertion — silent skip masked the real bug previously.
    expect(slFill).toBeDefined();
    if (!slFill) return; // type narrow

    const slEvent = result.events.find(e => e.type === 'sl_triggered' && e.candleIdx === slFill.candleIdx);
    expect(slEvent).toBeDefined();
    const details = JSON.parse(slEvent!.detailsJson) as { snapshot: { slPrice: number } };
    // Long SL exit is a sell; trader-hurting slippage fills strictly below the raw SL price.
    expect(slFill.fillPrice).toBeLessThan(details.snapshot.slPrice);
  });
});
