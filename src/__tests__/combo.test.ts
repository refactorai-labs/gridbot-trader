import { describe, it, expect } from 'vitest';
import { slPercent, slPrice, allocateCapital, tierSize, atrScaledGridStep } from '../lib/combo/sizing';
import { AdaptiveEngine, DEFAULT_ADAPTIVE_CONFIG } from '../lib/combo/adaptiveEngine';
import { ComboBotStateMachine, PositionSnapshot, TickInputs } from '../lib/combo/stateMachine';
import { AdaptiveSignals } from '../lib/combo/adaptiveEngine';
import { ComboBotSideConfig, OHLC } from '../lib/types';
import { evaluateReopenPolicy, ReopenPolicyInput } from '../lib/combo/reopenPolicy';

const SIDE_CFG: ComboBotSideConfig = {
  averagingDepth: 5,
  slBasePercent: 0.015,
  slAtrMultiplier: 1.5,
  slFloor: 0.01,
  slCap: 0.04,
  tier1Size: 0.25,
  tier2Size: 0.5,
  tier3Size: 1.0,
  cooldownCandles: 3,
  retryCap: 2,
  hibernationCandles: 5,
};

function noPos(price: number): PositionSnapshot {
  return { hasPosition: false, avgEntry: 0, currentPrice: price, unrealizedPnlPct: 0 };
}

function withPos(entry: number, currentPrice: number): PositionSnapshot {
  const pnlPct = (currentPrice - entry) / entry;
  return { hasPosition: true, avgEntry: entry, currentPrice, unrealizedPnlPct: pnlPct };
}

function sig(overrides: Partial<AdaptiveSignals> = {}): AdaptiveSignals {
  return {
    atr: 5,
    blendedAtr: 5,
    erRaw: 0.3,
    erSmooth: 0.3,
    rsi: 50,
    avwap: null,
    regime: 'ranging',
    anchorJustArmed: false,
    ...overrides,
  };
}

function mkTick(
  candleIdx: number,
  price: number,
  position: PositionSnapshot,
  entryConditionMet: boolean,
  reopenConditionsMet: boolean,
  signals: AdaptiveSignals = sig()
): TickInputs {
  return {
    candleIdx,
    timestamp: 1000000 + candleIdx * 300000,
    price,
    // Default high/low to close so existing close-based SL tests still trigger.
    candleHigh: price,
    candleLow: price,
    signals,
    position,
    entryConditionMet,
    reopenConditionsMet,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Sizing
// ──────────────────────────────────────────────────────────────────────────

describe('combo/sizing', () => {
  it('slPercent clamps to slFloor when ATR component is tiny', () => {
    const pct = slPercent({ ...SIDE_CFG, slBasePercent: 0.001 }, 0.01, 100);
    expect(pct).toBeCloseTo(SIDE_CFG.slFloor, 10);
  });

  it('slPercent clamps to slCap when ATR component is huge', () => {
    const pct = slPercent({ ...SIDE_CFG, slBasePercent: 0.02 }, 100, 100);
    expect(pct).toBe(SIDE_CFG.slCap);
  });

  it('slPrice: long vs short are mirror reflections of entry', () => {
    const entry = 100;
    const atr = 2;
    const long = slPrice(SIDE_CFG, 'long', entry, atr);
    const short = slPrice(SIDE_CFG, 'short', entry, atr);
    expect(long).toBeLessThan(entry);
    expect(short).toBeGreaterThan(entry);
    // Symmetric distance
    expect(entry - long).toBeCloseTo(short - entry, 10);
  });

  it('allocateCapital in dual mode splits by allocationLong, clamped to [0.5, 0.75]', () => {
    expect(allocateCapital(1000, 'dual', 0.6)).toEqual({ longCapital: 600, shortCapital: 400 });
    expect(allocateCapital(1000, 'dual', 0.4)).toEqual({ longCapital: 500, shortCapital: 500 });
    expect(allocateCapital(1000, 'dual', 0.9)).toEqual({ longCapital: 750, shortCapital: 250 });
  });

  it('allocateCapital in long/short mode uses all capital on the active side', () => {
    expect(allocateCapital(1000, 'long', 0.6)).toEqual({ longCapital: 1000, shortCapital: 0 });
    expect(allocateCapital(1000, 'short', 0.6)).toEqual({ longCapital: 0, shortCapital: 1000 });
  });

  it('tierSize matches spec 25/50/100 defaults', () => {
    expect(tierSize(0, SIDE_CFG)).toBe(0);
    expect(tierSize(1, SIDE_CFG)).toBe(0.25);
    expect(tierSize(2, SIDE_CFG)).toBe(0.5);
    expect(tierSize(3, SIDE_CFG)).toBe(1.0);
  });

  it('atrScaledGridStep scales with density', () => {
    expect(atrScaledGridStep(10, 1)).toBe(10);
    expect(atrScaledGridStep(10, 2)).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Reopen policy
// ──────────────────────────────────────────────────────────────────────────

describe('combo/reopenPolicy', () => {
  function policyInput(overrides: Partial<ReopenPolicyInput> = {}): ReopenPolicyInput {
    return {
      side: 'long',
      price: 101,
      previousPrice: 99,
      atr: 5.9,
      atrAtBreakout: 10,
      atrHistory: [8, 7, 5.9],
      rsi: 36,
      previousRsi: 34,
      avwap: 100,
      previousAvwap: 100,
      regime: 'trending',
      config: {
        policy: 'full_v31',
        avwapEnabled: true,
        atrRatioThreshold: 0.6,
        atrDecliningCandles: 3,
        rsiLongCross: 35,
        rsiShortCross: 65,
      },
      ...overrides,
    };
  }

  it('ATR ratio passes only below breakout ATR threshold', () => {
    expect(evaluateReopenPolicy(policyInput({ atr: 5.9 })).diagnostics.atrRatioOk).toBe(true);
    expect(evaluateReopenPolicy(policyInput({ atr: 6.0 })).diagnostics.atrRatioOk).toBe(false);
  });

  it('ATR declining requires strictly declining recent values', () => {
    expect(evaluateReopenPolicy(policyInput({ atrHistory: [8, 7, 6] })).diagnostics.atrDecliningOk).toBe(true);
    expect(evaluateReopenPolicy(policyInput({ atrHistory: [8, 7, 7] })).diagnostics.atrDecliningOk).toBe(false);
    expect(evaluateReopenPolicy(policyInput({ atrHistory: [8, 7] })).diagnostics.atrDecliningOk).toBe(false);
  });

  it('long reopen requires RSI crossing up through 35', () => {
    expect(evaluateReopenPolicy(policyInput({ side: 'long', previousRsi: 35, rsi: 35.1 })).diagnostics.rsiCrossOk).toBe(true);
    expect(evaluateReopenPolicy(policyInput({ side: 'long', previousRsi: 36, rsi: 37 })).diagnostics.rsiCrossOk).toBe(false);
  });

  it('short reopen requires RSI crossing down through 65', () => {
    expect(evaluateReopenPolicy(policyInput({
      side: 'short',
      previousPrice: 101,
      price: 99,
      previousRsi: 65,
      rsi: 64.9,
    })).diagnostics.rsiCrossOk).toBe(true);
    expect(evaluateReopenPolicy(policyInput({
      side: 'short',
      previousPrice: 101,
      price: 99,
      previousRsi: 64,
      rsi: 63,
    })).diagnostics.rsiCrossOk).toBe(false);
  });

  it('long AVWAP requires reclaim from below', () => {
    expect(evaluateReopenPolicy(policyInput({
      side: 'long',
      previousPrice: 99,
      price: 101,
      previousAvwap: 100,
      avwap: 100,
    })).diagnostics.avwapOk).toBe(true);
    expect(evaluateReopenPolicy(policyInput({
      side: 'long',
      previousPrice: 101,
      price: 102,
      previousAvwap: 100,
      avwap: 100,
    })).diagnostics.avwapOk).toBe(false);
  });

  it('short AVWAP requires rejection from above', () => {
    expect(evaluateReopenPolicy(policyInput({
      side: 'short',
      previousPrice: 101,
      price: 99,
      previousAvwap: 100,
      avwap: 100,
      previousRsi: 66,
      rsi: 64,
    })).diagnostics.avwapOk).toBe(true);
    expect(evaluateReopenPolicy(policyInput({
      side: 'short',
      previousPrice: 99,
      price: 98,
      previousAvwap: 100,
      avwap: 100,
      previousRsi: 66,
      rsi: 64,
    })).diagnostics.avwapOk).toBe(false);
  });

  it('avwapEnabled=false leaves the AVWAP diagnostic honest but skips it from `allowed`', () => {
    // No reclaim (previousPrice > previousAvwap), so avwapOk must be FALSE — even when
    // AVWAP is disabled — so AVWAP-off ablation diagnostics stay comparable to AVWAP-on.
    const result = evaluateReopenPolicy(policyInput({
      previousPrice: 101,
      price: 102,
      config: { policy: 'full_v31', avwapEnabled: false },
    }));
    expect(result.diagnostics.avwapOk).toBe(false);
    expect(result.diagnostics.avwapRequired).toBe(false);
    expect(result.diagnostics.atrRatioOk).toBe(true);
    expect(result.diagnostics.atrDecliningOk).toBe(true);
    expect(result.diagnostics.rsiCrossOk).toBe(true);
    // allowed=true because avwapRequired=false drops avwapOk from the gate.
    expect(result.allowed).toBe(true);
  });

  it('avwapEnabled=false still reports avwapOk=true when an actual reclaim occurred', () => {
    const result = evaluateReopenPolicy(policyInput({
      side: 'long',
      previousPrice: 99,
      price: 101,
      previousAvwap: 100,
      avwap: 100,
      config: { policy: 'full_v31', avwapEnabled: false },
    }));
    expect(result.diagnostics.avwapOk).toBe(true);
    expect(result.diagnostics.avwapRequired).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it('avwapEnabled=true with no reclaim blocks `allowed` and exposes avwapOk=false', () => {
    const result = evaluateReopenPolicy(policyInput({
      previousPrice: 101,
      price: 102,
      config: { policy: 'full_v31', avwapEnabled: true },
    }));
    expect(result.diagnostics.avwapOk).toBe(false);
    expect(result.diagnostics.avwapRequired).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('mvp_current still computes the four exact diagnostics independently', () => {
    // Inputs where exact diagnostics produce a known mix: ATR ratio passes (5.9/10 < 0.6),
    // ATR declining passes (8>7>5.9), RSI cross fails (no cross), AVWAP fails (no reclaim).
    const result = evaluateReopenPolicy(policyInput({
      side: 'long',
      previousPrice: 102,
      price: 101,
      previousAvwap: 100,
      avwap: 100,
      previousRsi: 36,
      rsi: 36,
      config: { policy: 'mvp_current', avwapEnabled: true },
    }));
    // Diagnostics must be the exact four-condition booleans, NOT one boolean replicated.
    expect(result.diagnostics.atrRatioOk).toBe(true);
    expect(result.diagnostics.atrDecliningOk).toBe(true);
    expect(result.diagnostics.rsiCrossOk).toBe(false);
    expect(result.diagnostics.avwapOk).toBe(false);
    // mvp_current never consumes avwapOk for `allowed`; report that honestly.
    expect(result.diagnostics.avwapRequired).toBe(false);
    // mvp_current's allow logic is the legacy heuristic (trending + coiled RSI 40-60 +
    // AVWAP tolerance), not the exact AND of the diagnostics above.
    expect(result.allowed).toBe(false);
  });

  it('mvp_current allow remains legacy-compatible when trending+coiled RSI+AVWAP-tolerance hold', () => {
    const result = evaluateReopenPolicy(policyInput({
      regime: 'trending',
      rsi: 50,
      previousRsi: 50,
      avwap: 100,
      price: 100.4,
      previousPrice: 100,
      config: { policy: 'mvp_current', avwapEnabled: true },
    }));
    expect(result.allowed).toBe(true);
  });

  it('atr_rsi policy does not require AVWAP while atr_rsi_avwap does', () => {
    const withoutAvwap = policyInput({
      previousPrice: 101,
      price: 102,
      config: { policy: 'atr_rsi', avwapEnabled: true },
    });
    expect(evaluateReopenPolicy(withoutAvwap).allowed).toBe(true);
    expect(evaluateReopenPolicy({
      ...withoutAvwap,
      config: { policy: 'atr_rsi_avwap', avwapEnabled: true },
    }).allowed).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// AdaptiveEngine
// ──────────────────────────────────────────────────────────────────────────

describe('combo/adaptiveEngine', () => {
  function mk(h: number, l: number, c: number, v: number = 100): OHLC {
    return { timestamp: 0, open: c, high: h, low: l, close: c, volume: v };
  }

  it('arms AVWAP anchor when ER_smooth crosses erRegimeThreshold', () => {
    // Build 4H candles: ranging first, then strongly trending
    const ranging: OHLC[] = Array.from({ length: 20 }, () => mk(101, 99, 100));
    const trending: OHLC[] = Array.from({ length: 15 }, (_, i) => mk(101 + i, 99 + i, 100 + i));
    const candles4h = [...ranging, ...trending];
    const candles1h = candles4h; // close enough for this test
    // Build 5m candles: 48 5m per 4h
    const candles5m: OHLC[] = [];
    for (const c of candles4h) {
      for (let k = 0; k < 48; k++) candles5m.push(c);
    }

    const engine = new AdaptiveEngine({ ...DEFAULT_ADAPTIVE_CONFIG, erRegimeThreshold: 0.5 });
    let armedAtIdx = -1;
    // Update once per 4H boundary (mirrors supervisor cadence)
    for (let i = 0; i < candles4h.length; i++) {
      const s = engine.update(candles5m, (i + 1) * 48 - 1, candles1h, i + 1, candles4h, i + 1);
      if (s.anchorJustArmed) { armedAtIdx = i; break; }
    }
    expect(armedAtIdx).toBeGreaterThanOrEqual(ranging.length);
    expect(engine.getAnchor()).not.toBeNull();
  });

  it('anchor persists across subsequent trending ticks (not re-armed every tick)', () => {
    const candles4h: OHLC[] = Array.from({ length: 30 }, (_, i) => mk(101 + i, 99 + i, 100 + i));
    const candles1h = candles4h;
    const candles5m: OHLC[] = [];
    for (const c of candles4h) for (let k = 0; k < 48; k++) candles5m.push(c);

    const engine = new AdaptiveEngine({ ...DEFAULT_ADAPTIVE_CONFIG, erRegimeThreshold: 0.5 });
    const armings: number[] = [];
    for (let i = 0; i < candles4h.length; i++) {
      const s = engine.update(candles5m, (i + 1) * 48 - 1, candles1h, i + 1, candles4h, i + 1);
      if (s.anchorJustArmed) armings.push(i);
    }
    // Anchor should arm at most once for sustained trend
    expect(armings.length).toBeLessThanOrEqual(1);
  });

  it('getAnchor / setAnchor round-trips for persistence', () => {
    const engine = new AdaptiveEngine();
    engine.setAnchor({ candleIdx: 42, timestamp: 999, typicalPrice: 100.5, volume: 1000 });
    const a = engine.getAnchor();
    expect(a).toEqual({ candleIdx: 42, timestamp: 999, typicalPrice: 100.5, volume: 1000 });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// StateMachine transitions
// ──────────────────────────────────────────────────────────────────────────

describe('combo/stateMachine transitions', () => {
  it('IDLE → BREAKOUT when entry condition is met', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    const r = sm.tick(mkTick(0, 100, noPos(100), true, false));
    expect(sm.getState().phase).toBe('BREAKOUT');
    expect(r.events.map(e => e.type)).toContain('breakout_entered');
    expect(r.instruction.allowNewOrders).toBe(true);
  });

  it('IDLE stays IDLE when entry condition is not met', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), false, false));
    expect(sm.getState().phase).toBe('IDLE');
  });

  it('BREAKOUT → RUNNING when position opens', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));  // → BREAKOUT
    const r = sm.tick(mkTick(1, 101, withPos(100, 101), false, false));
    expect(sm.getState().phase).toBe('RUNNING');
    expect(r.events.map(e => e.type)).toContain('position_opened');
  });

  it('RUNNING → COOLDOWN when SL hits (long: price < SL)', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    // ATR=5, multiplier=1.5 → atrComponent=7.5/100=0.075, base=0.015, raw=0.09 → clamped to slCap 0.04
    // SL long = 100 * (1 - 0.04) = 96
    const r = sm.tick(mkTick(2, 95, withPos(100, 95), false, false));
    expect(sm.getState().phase).toBe('COOLDOWN');
    expect(r.instruction.slHit).toBe(true);
    expect(r.instruction.closePosition).toBe(true);
    expect(r.events.map(e => e.type)).toEqual(expect.arrayContaining(['sl_triggered', 'cooldown_entered']));
  });

  it('RUNNING → COOLDOWN when long SL is pierced by wick but close recovers', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    const wickTick = {
      ...mkTick(2, 100, withPos(100, 100), false, false),
      candleLow: 95,
      candleHigh: 101,
    };
    const r = sm.tick(wickTick);
    expect(sm.getState().phase).toBe('COOLDOWN');
    expect(r.instruction.slHit).toBe(true);
  });

  it('SL transition captures ATR at the SL into atrAtLastSL', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false, sig({ atr: 10, blendedAtr: 10 })));
    expect(sm.getState().atrAtPhaseEntry).toBe(10);
    expect(sm.getState().atrAtLastSL).toBeNull();
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false, sig({ atr: 10, blendedAtr: 10 })));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false, sig({ atr: 4, blendedAtr: 4 })));
    expect(sm.getState().phase).toBe('COOLDOWN');
    expect(sm.getState().atrAtLastSL).toBe(4);
    expect(sm.getState().atrAtPhaseEntry).toBe(10);
  });

  it('atrAtLastSL clears on hibernation_exit so next breakout starts clean', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    // First SL: long entry=100, atr=4 → SL≈96. Wick down to 95.
    sm.tick(mkTick(0, 100, noPos(100), true, false, sig({ atr: 10, blendedAtr: 10 })));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false, sig({ atr: 4, blendedAtr: 4 })));
    expect(sm.getState().atrAtLastSL).toBe(4);
    // Cooldown elapses → tier1 reopen at retryCount=1.
    sm.tick(mkTick(3, 95, noPos(95), false, true, sig({ atr: 4, blendedAtr: 4 })));
    sm.tick(mkTick(4, 95, noPos(95), false, true, sig({ atr: 4, blendedAtr: 4 })));
    sm.tick(mkTick(5, 95, noPos(95), false, true, sig({ atr: 4, blendedAtr: 4 })));
    sm.tick(mkTick(6, 95, noPos(95), false, true, sig({ atr: 4, blendedAtr: 4 })));
    expect(sm.getState().phase).toBe('REOPENING');
    // Open the reopen position then SL it.
    sm.tick(mkTick(7, 95, withPos(95, 95), false, false, sig({ atr: 4, blendedAtr: 4 })));
    sm.tick(mkTick(8, 90, withPos(95, 90), false, false, sig({ atr: 4, blendedAtr: 4 })));
    expect(sm.getState().phase).toBe('COOLDOWN');
    // Cooldown elapses → retryCount hits cap → HIBERNATING.
    sm.tick(mkTick(9, 90, noPos(90), false, true, sig({ atr: 4, blendedAtr: 4 })));
    sm.tick(mkTick(10, 90, noPos(90), false, true, sig({ atr: 4, blendedAtr: 4 })));
    sm.tick(mkTick(11, 90, noPos(90), false, true, sig({ atr: 4, blendedAtr: 4 })));
    sm.tick(mkTick(12, 90, noPos(90), false, true, sig({ atr: 4, blendedAtr: 4 })));
    expect(sm.getState().phase).toBe('HIBERNATING');
    // Drive ER below threshold for hibernationCandles ticks to exit.
    for (let i = 13; i < 13 + SIDE_CFG.hibernationCandles; i++) {
      sm.tick(mkTick(i, 90, noPos(90), false, false, sig({ atr: 4, blendedAtr: 4, erSmooth: 0.1 })));
    }
    expect(sm.getState().phase).toBe('IDLE');
    expect(sm.getState().atrAtLastSL).toBeNull();
  });

  it('COOLDOWN waits cooldownCandles before considering reopen', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false)); // → COOLDOWN, cooldownCandlesRemaining=3

    // cooldown_candles = 3; conditions always met, but should only advance after timer elapses
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    expect(sm.getState().phase).toBe('COOLDOWN');
    const r = sm.tick(mkTick(5, 95, noPos(95), false, true)); // after 3 ticks, remaining hits 0
    expect(sm.getState().phase).toBe('REOPENING');
    expect(r.events.map(e => e.type)).toContain('tier1_reopen');
    expect(r.instruction.sizeMultiplier).toBe(SIDE_CFG.tier1Size);
  });

  it('REOPENING does not auto-advance after two candles', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false)); // → COOLDOWN
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true)); // → REOPENING tier 1

    sm.tick(mkTick(6, 97, withPos(96, 97), false, false));
    const r = sm.tick(mkTick(7, 97, withPos(96, 97), false, false));
    expect(r.events.map(e => e.type)).not.toContain('tier2_scale');
    expect(sm.getState().phase).toBe('REOPENING');
    expect(sm.getState().currentTier).toBe(1);
  });

  it('REOPENING tier2 requires 80% containment over 24 closes', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false));
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true));

    const eventTypes: string[] = [];
    for (let i = 0; i < 23; i++) {
      const price = i < 4 ? 104 : 97; // 19/23 so far, with early closes outside frozen 90..100 band
      const r = sm.tick(mkTick(6 + i, price, withPos(96, price), false, false));
      eventTypes.push(...r.events.map(e => e.type));
    }
    expect(eventTypes).not.toContain('tier2_scale');

    const r = sm.tick(mkTick(29, 104, withPos(96, 104), false, false)); // 19/24 contained
    expect(r.events.map(e => e.type)).not.toContain('tier2_scale');
    const r2 = sm.tick(mkTick(30, 97, withPos(96, 97), false, false)); // oldest miss drops, 20/24 contained
    expect(r2.events.map(e => e.type)).toContain('tier2_scale');
    expect(sm.getState().currentTier).toBe(2);
  });

  it('REOPENING tier3 requires 12 additional valid containment candles', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false));
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true));

    for (let i = 0; i < 24; i++) {
      sm.tick(mkTick(6 + i, 97, withPos(96, 97), false, false));
    }
    expect(sm.getState().currentTier).toBe(2);

    for (let i = 0; i < 11; i++) {
      const r = sm.tick(mkTick(30 + i, 97, withPos(96, 97), false, false));
      expect(r.events.map(e => e.type)).not.toContain('tier3_scale');
    }
    const r = sm.tick(mkTick(41, 97, withPos(96, 97), false, false));
    expect(r.events.map(e => e.type)).toContain('tier3_scale');
    expect(sm.getState().phase).toBe('RUNNING');
  });

  it('2 consecutive SLs → HIBERNATING', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    // First SL
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false));
    // Cooldown
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true)); // → REOPENING tier 1, retryCount=1

    // Second SL in REOPENING
    sm.tick(mkTick(6, 88, withPos(95, 88), false, false)); // → COOLDOWN again
    expect(sm.getState().phase).toBe('COOLDOWN');
    sm.tick(mkTick(7, 88, noPos(88), false, true));
    sm.tick(mkTick(8, 88, noPos(88), false, true));
    const r = sm.tick(mkTick(9, 88, noPos(88), false, true));
    // retryCount becomes 2 == retryCap → HIBERNATING
    expect(sm.getState().phase).toBe('HIBERNATING');
    expect(r.events.map(e => e.type)).toContain('hibernation_entered');
  });

  it('HIBERNATING → IDLE after erSmooth < 0.3 for hibernationCandles', () => {
    const sm = new ComboBotStateMachine('long', { ...SIDE_CFG, hibernationCandles: 3 });
    // Drive to HIBERNATING the short way by asserting internal flow via public API
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false));
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true)); // REOPENING
    sm.tick(mkTick(6, 88, withPos(95, 88), false, false)); // COOLDOWN
    sm.tick(mkTick(7, 93, noPos(93), false, true));
    sm.tick(mkTick(8, 93, noPos(93), false, true));
    sm.tick(mkTick(9, 93, noPos(93), false, true)); // HIBERNATING
    expect(sm.getState().phase).toBe('HIBERNATING');

    // Feed 3 ticks with erSmooth=0.2 → exit
    sm.tick(mkTick(10, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    sm.tick(mkTick(11, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    const r = sm.tick(mkTick(12, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    expect(sm.getState().phase).toBe('IDLE');
    expect(r.events.map(e => e.type)).toContain('hibernation_exit');
  });

  it('HIBERNATING counter resets on erSmooth ≥ 0.3 (must be consecutive)', () => {
    const sm = new ComboBotStateMachine('long', { ...SIDE_CFG, hibernationCandles: 3 });
    // Push to HIBERNATING
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false));
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true)); // REOPENING
    sm.tick(mkTick(6, 88, withPos(95, 88), false, false)); // COOLDOWN
    sm.tick(mkTick(7, 93, noPos(93), false, true));
    sm.tick(mkTick(8, 93, noPos(93), false, true));
    sm.tick(mkTick(9, 93, noPos(93), false, true)); // HIBERNATING

    // 2 low ER, 1 high, 2 low → should NOT exit yet
    sm.tick(mkTick(10, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    sm.tick(mkTick(11, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    sm.tick(mkTick(12, 93, noPos(93), false, false, sig({ erSmooth: 0.5 })));
    sm.tick(mkTick(13, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    expect(sm.getState().phase).toBe('HIBERNATING');
    sm.tick(mkTick(14, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    sm.tick(mkTick(15, 93, noPos(93), false, false, sig({ erSmooth: 0.2 })));
    expect(sm.getState().phase).toBe('IDLE');
  });

  it('full cycle integration: IDLE → BREAKOUT → RUNNING → COOLDOWN → REOPENING → RUNNING', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    const visitedPhases = new Set<string>();
    visitedPhases.add(sm.getState().phase);

    // Entry → BREAKOUT
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    visitedPhases.add(sm.getState().phase);
    // Fill → RUNNING
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    visitedPhases.add(sm.getState().phase);
    // SL → COOLDOWN
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false));
    visitedPhases.add(sm.getState().phase);
    // Cooldown elapses + reopen conditions → REOPENING
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true));
    visitedPhases.add(sm.getState().phase);
    // Tiers advance through containment back to full RUNNING.
    for (let i = 6; i < 80 && !(sm.getState().phase === 'RUNNING' && sm.getState().retryCount === 0); i++) {
      sm.tick(mkTick(i, 98, withPos(96, 98), false, false));
    }
    visitedPhases.add(sm.getState().phase);

    expect(visitedPhases).toEqual(new Set(['IDLE', 'BREAKOUT', 'RUNNING', 'COOLDOWN', 'REOPENING']));
    expect(sm.getState().phase).toBe('RUNNING');
  });

  it('short side: SL fires on price ABOVE entry (mirror of long)', () => {
    const sm = new ComboBotStateMachine('short', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    // For short, SL above entry. slCap=0.04 → SL at 104.
    const r = sm.tick(mkTick(2, 105, withPos(100, 105), false, false));
    expect(r.instruction.slHit).toBe(true);
    expect(sm.getState().phase).toBe('COOLDOWN');
  });

  it('short side: SL fires when wick pierces above SL but close recovers', () => {
    const sm = new ComboBotStateMachine('short', SIDE_CFG);
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    const wickTick = {
      ...mkTick(2, 100, withPos(100, 100), false, false),
      candleHigh: 105,
      candleLow: 99,
    };
    const r = sm.tick(wickTick);
    expect(r.instruction.slHit).toBe(true);
    expect(sm.getState().phase).toBe('COOLDOWN');
  });
});
