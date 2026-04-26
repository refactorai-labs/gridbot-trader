import { describe, it, expect } from 'vitest';
import { slPercent, slPrice, allocateCapital, tierSize, atrScaledGridStep } from '../lib/combo/sizing';
import { AdaptiveEngine, DEFAULT_ADAPTIVE_CONFIG } from '../lib/combo/adaptiveEngine';
import { ComboBotStateMachine, PositionSnapshot, TickInputs } from '../lib/combo/stateMachine';
import { AdaptiveSignals } from '../lib/combo/adaptiveEngine';
import { ComboBotSideConfig, OHLC } from '../lib/types';

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

  it('REOPENING auto-advances tier1 → tier2 → tier3 → cycle_complete (back to IDLE)', () => {
    const sm = new ComboBotStateMachine('long', SIDE_CFG);
    // Shortcut: directly push to REOPENING through the full flow
    sm.tick(mkTick(0, 100, noPos(100), true, false));
    sm.tick(mkTick(1, 100, withPos(100, 100), false, false));
    sm.tick(mkTick(2, 95, withPos(100, 95), false, false)); // → COOLDOWN
    sm.tick(mkTick(3, 95, noPos(95), false, true));
    sm.tick(mkTick(4, 95, noPos(95), false, true));
    sm.tick(mkTick(5, 95, noPos(95), false, true)); // → REOPENING tier 1

    // Tier 1 → Tier 2 after 2 candles with position
    const collectedEventTypes: string[] = [];
    for (let i = 6; i < 20; i++) {
      const r = sm.tick(mkTick(i, 97, withPos(96, 97), false, false));
      for (const e of r.events) collectedEventTypes.push(e.type);
      if (sm.getState().phase === 'IDLE') break;
    }
    expect(collectedEventTypes).toEqual(expect.arrayContaining(['tier2_scale', 'tier3_scale', 'cycle_complete']));
    expect(sm.getState().phase).toBe('IDLE');
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

  it('full cycle integration: IDLE → BREAKOUT → RUNNING → COOLDOWN → REOPENING → IDLE', () => {
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
    // Tiers advance through to cycle_complete → IDLE
    for (let i = 6; i < 20 && sm.getState().phase !== 'IDLE'; i++) {
      sm.tick(mkTick(i, 98, withPos(96, 98), false, false));
    }
    visitedPhases.add(sm.getState().phase);

    expect(visitedPhases).toEqual(new Set(['IDLE', 'BREAKOUT', 'RUNNING', 'COOLDOWN', 'REOPENING']));
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
});
