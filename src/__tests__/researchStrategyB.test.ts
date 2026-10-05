import { describe, it, expect, beforeEach } from 'vitest';
import { OHLC } from '../lib/types';
import { resetResearchIds } from '../lib/research/account';
import { runFillSim } from '../lib/research/fillSim';
import { RegimeFilter, RegimeConfig, RegimeState } from '../lib/research/regime';
import { buildRange, AnchorConfig } from '../lib/research/rangeAnchor';
import { createStrategy, StrategyBConfig, StrategyMode } from '../lib/research/strategyB';
import { DEFAULT_PERP_FEES } from '../lib/research/types';

beforeEach(() => resetResearchIds());

function mkbar(timestamp: number, close: number, range = 1): OHLC {
  return { timestamp, open: close, high: close + range / 2, low: close - range / 2, close, volume: 1 };
}

const REGIME_CFG: RegimeConfig = {
  erLookback: 4,
  erSmoothing: 1,
  erLow: 0.35,
  erHigh: 0.65,
  confirmBars: 2,
  atrPeriod: 3,
  volLookback: 4,
  volExpandRatio: 1.5,
};

// ---------------------------------------------------------------------------
// RegimeFilter
// ---------------------------------------------------------------------------

describe('RegimeFilter', () => {
  function feed(filter: RegimeFilter, closes: number[], startSec = 0, range = 1): RegimeState[] {
    return closes.map((c, i) => filter.update(mkbar(startSec + i * 1800, c, range)));
  }

  const chop = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 100.5 : 99.5));

  it('reports warmup until ER, ATR and the ATR baseline are all defined', () => {
    const f = new RegimeFilter(REGIME_CFG);
    const states = feed(f, chop(4));
    for (const s of states) expect(s.regime).toBe('warmup');
  });

  it('chop produces ER ≈ 0 and flips the default trend state to range', () => {
    const f = new RegimeFilter(REGIME_CFG);
    const states = feed(f, chop(15));
    const last = states[states.length - 1];
    expect(last.regime).toBe('range');
    expect(last.er).toBeLessThan(0.35);
  });

  it('a strong ramp flips range back to trend after confirmation', () => {
    const f = new RegimeFilter(REGIME_CFG);
    feed(f, chop(15));
    const ramp = Array.from({ length: 8 }, (_, i) => 101 + i * 2);
    const states = feed(f, ramp, 15 * 1800);
    expect(states[states.length - 1].regime).toBe('trend');
  });

  it('hysteresis: ER between thresholds keeps the previous state', () => {
    const f = new RegimeFilter(REGIME_CFG);
    feed(f, chop(15)); // establish range
    // Pattern +1,+1,-1,+1 → |Δ4|=2, Σ|Δ|=4 → ER raw 0.5 ∈ (0.35, 0.65)
    const mid: number[] = [];
    let p = 100;
    const steps = [1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1, 1];
    for (const s of steps) { p += s; mid.push(p); }
    const states = feed(f, mid, 15 * 1800);
    for (const s of states.slice(4)) {
      expect(s.er).toBeGreaterThan(0.35);
      expect(s.er).toBeLessThan(0.65);
      expect(s.regime).toBe('range'); // held by hysteresis
    }
  });

  it('volatility expansion overrides the base state', () => {
    const f = new RegimeFilter(REGIME_CFG);
    feed(f, chop(15)); // bar range 1 → steady ATR
    const states = feed(f, chop(2), 15 * 1800, 6); // same chop, 6× wider bars
    expect(states[states.length - 1].regime).toBe('volatile');
    expect(states[states.length - 1].volExpanded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildRange
// ---------------------------------------------------------------------------

describe('buildRange', () => {
  const ANCHOR_CFG: AnchorConfig = {
    donchianLookback: 8,
    atrMult: 2,
    minHalfWidthPct: 0.01,
    maxHalfWidthPct: 0.05,
    invalidationAtrMult: 2,
    stopAtrMult: 3,
    gridLevels: 5,
    anchorMaxOffset: 0.6,
  };

  function donchianBars(n: number, hi: number, lo: number, lastClose: number): OHLC[] {
    const bars: OHLC[] = [];
    for (let i = 0; i < n; i++) {
      const mid = (hi + lo) / 2;
      bars.push({ timestamp: i * 1800, open: mid, high: i === 0 ? hi : mid + 1, low: i === 1 ? lo : mid - 1, close: i === n - 1 ? lastClose : mid, volume: 1 });
    }
    return bars;
  }

  it('returns null with insufficient history', () => {
    expect(buildRange(donchianBars(5, 110, 90, 100), 1, 0, ANCHOR_CFG)).toBeNull();
  });

  it('centers on the Donchian midpoint with ATR-proportional half-width and ordered zones', () => {
    const z = buildRange(donchianBars(8, 110, 90, 100), 1, 999, ANCHOR_CFG)!;
    expect(z).not.toBeNull();
    expect(z.center).toBeCloseTo(100, 10);
    expect(z.halfWidth).toBeCloseTo(2, 10); // 2 × ATR(1), within [1, 5] clamps
    expect(z.lower).toBeCloseTo(98, 10);
    expect(z.upper).toBeCloseTo(102, 10);
    expect(z.invalidLower).toBeCloseTo(96, 10);
    expect(z.invalidUpper).toBeCloseTo(104, 10);
    expect(z.stopLong).toBeCloseTo(95, 10);
    expect(z.stopShort).toBeCloseTo(105, 10);
    expect(z.levels).toEqual([98, 99, 100, 101, 102]);
    expect(z.anchoredAtSec).toBe(999);
  });

  it('clamps the half-width to the max percent band', () => {
    const z = buildRange(donchianBars(8, 110, 90, 100), 10, 0, ANCHOR_CFG)!;
    expect(z.halfWidth).toBeCloseTo(5, 10); // 2×10=20 → clamped to 5% of 100
  });

  it('refuses to anchor when price is too far from the center', () => {
    expect(buildRange(donchianBars(8, 110, 90, 108), 1, 0, ANCHOR_CFG)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Strategy B end-to-end on a synthetic range → spike → reversion path
// ---------------------------------------------------------------------------

// Each block is one 30m period rendered as 30 linear 1m bars from p0 to p1.
function blockBars(startSec: number, blocks: Array<[number, number]>): OHLC[] {
  const bars: OHLC[] = [];
  blocks.forEach(([p0, p1], b) => {
    for (let i = 0; i < 30; i++) {
      const o = p0 + ((p1 - p0) * i) / 30;
      const c = p0 + ((p1 - p0) * (i + 1)) / 30;
      bars.push({
        timestamp: startSec + b * 1800 + i * 60,
        open: o,
        high: Math.max(o, c) + 0.05,
        low: Math.min(o, c) - 0.05,
        close: c,
        volume: 1,
      });
    }
  });
  return bars;
}

function agg30(c1m: OHLC[]): OHLC[] {
  const out: OHLC[] = [];
  for (let i = 0; i + 30 <= c1m.length; i += 30) {
    const group = c1m.slice(i, i + 30);
    out.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map(g => g.high)),
      low: Math.min(...group.map(g => g.low)),
      close: group[group.length - 1].close,
      volume: 30,
    });
  }
  return out;
}

const PATH: Array<[number, number]> = [
  // 12 chop blocks around 100 — warmup, regime flips to range, anchor
  [100, 100.6], [100.6, 99.4], [99.4, 100.5], [100.5, 99.5],
  [99.5, 100.4], [100.4, 99.6], [99.6, 100.3], [100.3, 99.7],
  [99.7, 100.2], [100.2, 99.8], [99.8, 100.1], [100.1, 100.0],
  // strong up-move to the banking zone
  [100.0, 100.9], [100.9, 101.9],
  // reversion through the unwind level
  [101.9, 100.8], [100.8, 100.2],
  // one flat block so queued unwind closes execute
  [100.2, 100.2],
];

function strategyConfig(mode: StrategyMode): StrategyBConfig {
  return {
    mode,
    totalCapital: 10_000,
    regime: { ...REGIME_CFG, volExpandRatio: 99 }, // disable the vol overlay here
    anchor: {
      donchianLookback: 8,
      atrMult: 1,
      minHalfWidthPct: 0.02,
      maxHalfWidthPct: 0.02, // pin halfWidth to exactly 2% of center
      invalidationAtrMult: 2,
      stopAtrMult: 3,
      gridLevels: 5,
      anchorMaxOffset: 0.6,
    },
    bankAt: 0.8,
    partialFraction: 0.6,
    unwindAt: 0.25,
    deriskAfterBars: 99,
    cooldownBars: 2,
    deriskStyle: 'hard' as const,
    initialFraction: 1,
  };
}

function runMode(mode: StrategyMode) {
  const c1m = blockBars(0, PATH);
  const c30 = agg30(c1m);
  const strategy = createStrategy(strategyConfig(mode));
  const result = runFillSim({
    candles1m: c1m,
    candles30m: c30,
    fundingRates: [],
    config: { initialCapital: 10_000, fees: DEFAULT_PERP_FEES },
    hooks: strategy,
  });
  return { result, strategy };
}

describe('Strategy B end-to-end (synthetic cycle)', () => {
  it('mode B: anchors, banks a partial close, unwinds the hedge, ends flat with a consistent ledger', () => {
    const { result, strategy } = runMode('B');
    const d = strategy.diagnostics;

    expect(d.cyclesStarted).toBeGreaterThanOrEqual(1);
    expect(d.banks).toBe(1);
    expect(d.unwinds).toBe(1);

    const initials = result.events.filter(e => e.type === 'initialOpen');
    expect(initials.length).toBeGreaterThanOrEqual(2); // both legs at cycle start

    const pc = result.events.filter(e => e.type === 'partialClose');
    expect(pc).toHaveLength(1);
    expect(pc[0]).toMatchObject({ leg: 'long', reason: 'bankProfit' });
    expect(pc[0].fraction).toBeCloseTo(0.6, 10);

    const unwinds = result.events.filter(e => e.type === 'fullClose' && e.reason === 'hedgeUnwind');
    expect(unwinds.length).toBeGreaterThanOrEqual(1);
    expect(unwinds.some(e => e.leg === 'short')).toBe(true); // the losing leg closes at unwind

    // flat at the end of the cycle
    expect(result.account.legQty('long')).toBeCloseTo(0, 10);
    expect(result.account.legQty('short')).toBeCloseTo(0, 10);

    // ledger invariant: cash = capital + Σ realized (no funding in this test)
    const realized = result.account.legs.long.realizedPnl + result.account.legs.short.realizedPnl;
    expect(result.account.cash).toBeCloseTo(10_000 + realized, 8);

    // zones sanity
    const z = d.anchors[0];
    expect(Math.abs(z.center - 100)).toBeLessThan(0.5);
    expect(z.halfWidth).toBeCloseTo(0.02 * z.center, 10);
    expect(z.stopShort).toBeGreaterThan(z.invalidUpper - 1e-9);
  });

  it('mode fullClose: banks 100% of the favorable leg, no partial close', () => {
    const { result, strategy } = runMode('fullClose');
    expect(strategy.diagnostics.banks).toBe(1);
    expect(result.events.filter(e => e.type === 'partialClose')).toHaveLength(0);
    const bankCloses = result.events.filter(e => e.type === 'fullClose' && e.reason === 'bankProfit');
    expect(bankCloses).toHaveLength(1);
    expect(bankCloses[0].leg).toBe('long');
    expect(result.account.legQty('long')).toBeCloseTo(0, 10);
    expect(result.account.legQty('short')).toBeCloseTo(0, 10);
  });

  it('mode fullHold: banks nothing at the trigger; everything closes at the unwind', () => {
    const { result, strategy } = runMode('fullHold');
    expect(strategy.diagnostics.banks).toBe(1);
    expect(result.events.filter(e => e.reason === 'bankProfit')).toHaveLength(0);
    const unwinds = result.events.filter(e => e.type === 'fullClose' && e.reason === 'hedgeUnwind');
    expect(unwinds.some(e => e.leg === 'long')).toBe(true);
    expect(unwinds.some(e => e.leg === 'short')).toBe(true);
  });

  it('initialFraction scales the arm-time inventory and its TPs', () => {
    const { result: full } = runMode('B');
    resetResearchIds();
    const c1m = blockBars(0, PATH);
    const c30 = agg30(c1m);
    const half = runFillSim({
      candles1m: c1m,
      candles30m: c30,
      fundingRates: [],
      config: { initialCapital: 10_000, fees: DEFAULT_PERP_FEES },
      hooks: createStrategy({ ...strategyConfig('B'), initialFraction: 0.5 }),
    });
    const fullInit = full.events.find(e => e.type === 'initialOpen' && e.leg === 'long');
    const halfInit = half.events.find(e => e.type === 'initialOpen' && e.leg === 'long');
    expect(fullInit && halfInit).toBeTruthy();
    expect(halfInit!.qty!).toBeCloseTo(fullInit!.qty! * 0.5, 6);
  });

  it('soft derisk cancels entries but never market-dumps the inventory', () => {
    // chop (anchor) then a confirmed DOWN-trend → derisk triggers while the
    // long leg holds inventory. oneSided mode: no banking path interferes.
    const path: Array<[number, number]> = [
      [100, 100.6], [100.6, 99.4], [99.4, 100.5], [100.5, 99.5],
      [99.5, 100.4], [100.4, 99.6], [99.6, 100.3], [100.3, 99.7],
      [99.7, 100.2], [100.2, 99.8], [99.8, 100.1], [100.1, 100.0],
      [100.0, 99.0], [99.0, 98.0], [98.0, 97.0], [97.0, 96.2],
      [96.2, 96.2], [96.2, 96.2],
    ];
    const run = (style: 'hard' | 'soft') => {
      resetResearchIds();
      const c1m = blockBars(0, path);
      const strategy = createStrategy({
        ...strategyConfig('oneSided'),
        deriskAfterBars: 2,
        deriskStyle: style,
      });
      const result = runFillSim({
        candles1m: c1m,
        candles30m: agg30(c1m),
        fundingRates: [],
        config: { initialCapital: 10_000, fees: DEFAULT_PERP_FEES },
        hooks: strategy,
      });
      return { result, strategy };
    };

    const hard = run('hard');
    expect(hard.strategy.diagnostics.derisks).toBe(1);
    expect(hard.result.events.some(e => e.type === 'fullClose' && e.reason === 'derisk')).toBe(true);

    const soft = run('soft');
    expect(soft.strategy.diagnostics.derisks).toBe(1);
    expect(soft.result.events.some(e => e.type === 'fullClose' && e.reason === 'derisk')).toBe(false);
    expect(soft.strategy.diagnostics.regimeSeries.some(p => p.phase === 'windingDown')).toBe(true);
    // entries are gone; any remaining orders are reduceOnly TPs
    expect(soft.result.account.legs.long.orders.length).toBeGreaterThan(0);
    expect(soft.result.account.legs.long.orders.every(o => o.reduceOnly)).toBe(true);
  });

  it('mode oneSided: long leg only, never touches the short side, never banks', () => {
    const { result, strategy } = runMode('oneSided');
    expect(strategy.diagnostics.cyclesStarted).toBeGreaterThanOrEqual(1);
    expect(strategy.diagnostics.banks).toBe(0);
    expect(result.events.some(e => e.leg === 'short')).toBe(false);
    expect(result.account.legs.short.lots).toHaveLength(0);
    expect(result.account.legs.short.realizedPnl).toBe(0);
  });
});
