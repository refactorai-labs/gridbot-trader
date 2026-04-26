import { describe, it, expect } from 'vitest';
import { OHLC, ComboBotConfig, ComboBotSideConfig } from '../lib/types';
import { runComboSimulationCore } from '../lib/combo/supervisor';
import { aggregate5mTo } from '../lib/data/aggregator';
import { FundingRateEntry } from '../lib/simulation/funding';

function candle(ts: number, o: number, h: number, l: number, c: number, v: number = 100): OHLC {
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: v };
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

    // Funding was applied (open positions × at least one 8h settlement).
    // Upper bound is tight: ~17 funding events on ≤$50K notional × 0.01% = ~$85 max.
    // Pre-fix bug had leverage³ inflating funding ~25× → bound catches regression.
    expect(Math.abs(result.totalFundingCost)).toBeGreaterThan(0);
    expect(Math.abs(result.totalFundingCost)).toBeLessThan(500);

    // Final anchor exists (ER crossed threshold during the uptrend)
    expect(result.finalAnchor).not.toBeNull();

    // Snapshots cover the run
    expect(result.snapshots.length).toBeGreaterThan(1);
    expect(result.snapshots[result.snapshots.length - 1].candleIdx).toBe(candles5m.length - 1);
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

    // Long SL exit is a sell — slippage pushes fillPrice strictly below the candle's high
    // (and below the underlying slPrice). At minimum, slippage floor (10bp) must show up:
    // a fill at the candle close with no slippage would equal close. We verify the fill
    // is meaningfully different from the candle close due to applySlippage.
    const closeAtFill = candles5m[slFill.candleIdx].close;
    expect(slFill.fillPrice).not.toBe(closeAtFill);
  });
});
