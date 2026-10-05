import { describe, it, expect } from 'vitest';
import {
  annualizedSharpe,
  blockBootstrap,
  cvar5,
  maxDrawdown,
  mulberry32,
  percentile,
  resampleDaily,
  returnsOf,
  stitchEquity,
} from '../lib/research/metrics';
import { perturbParams, sampleParams, ParamSpace } from '../lib/research/paramSpace';
import { EquityPoint } from '../lib/research/types';

const DAY = 86_400;

function eq(timeSec: number, equity: number): EquityPoint {
  return { timeSec, equity, price: 100, cash: equity, unrealized: 0, longQty: 0, shortQty: 0 };
}

describe('research metrics', () => {
  it('resampleDaily keeps the last observation of each day', () => {
    const pts = [
      { timeSec: 0, equity: 100 },
      { timeSec: 1800, equity: 101 },
      { timeSec: DAY - 1800, equity: 102 }, // last of day 0
      { timeSec: DAY + 1800, equity: 103 }, // day 1
    ];
    expect(resampleDaily(pts)).toEqual([102, 103]);
  });

  it('sharpe: steady positive returns → large positive, alternating → near zero', () => {
    const steady = Array.from({ length: 100 }, () => 0.001);
    // near-zero variance → enormous Sharpe (fp residue keeps it finite)
    expect(annualizedSharpe(steady)).toBeGreaterThan(100);
    const noisy = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    expect(Math.abs(annualizedSharpe(noisy))).toBeLessThan(0.2);
  });

  it('maxDrawdown finds the deepest peak-to-trough', () => {
    expect(maxDrawdown([100, 120, 90, 110, 80, 130])).toBeCloseTo((120 - 80) / 120, 10);
  });

  it('cvar5 averages the worst tail', () => {
    const rets = Array.from({ length: 100 }, (_, i) => (i === 0 ? -0.5 : i === 1 ? -0.3 : 0.01));
    // worst 5% of 100 returns = 5 values: -0.5, -0.3, 0.01×3
    expect(cvar5(rets)).toBeCloseTo((-0.5 - 0.3 + 0.03) / 5, 10);
  });

  it('stitchEquity compounds segments continuously', () => {
    const segA = [eq(0, 10_000), eq(DAY, 11_000)];         // +10%
    const segB = [eq(2 * DAY, 5_000), eq(3 * DAY, 4_500)]; // -10%
    const curve = stitchEquity([segA, segB], 10_000);
    expect(curve[0].equity).toBeCloseTo(10_000, 10);
    expect(curve[1].equity).toBeCloseTo(11_000, 10);
    expect(curve[2].equity).toBeCloseTo(11_000, 10); // segment B re-based to segment A's end
    expect(curve[3].equity).toBeCloseTo(9_900, 10);  // 11000 × 0.9
    expect(returnsOf(curve.map(p => p.equity)).length).toBe(3);
  });

  it('mulberry32 is deterministic and uniform-ish', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('research robustness (monte-carlo primitives)', () => {
  const rets = Array.from({ length: 90 }, (_, i) => Math.sin(i) * 0.01 + 0.0005);

  it('blockBootstrap is deterministic for a given seed and varies across seeds', () => {
    const a = blockBootstrap(rets, mulberry32(7), 50, 7);
    const b = blockBootstrap(rets, mulberry32(7), 50, 7);
    const c = blockBootstrap(rets, mulberry32(8), 50, 7);
    expect(a.sharpes).toEqual(b.sharpes);
    expect(a.maxDDs).toEqual(b.maxDDs);
    expect(a.sharpes.length).toBe(50);
    expect(a.maxDDs.length).toBe(50);
    expect(a.sharpes).not.toEqual(c.sharpes);
  });

  it('blockBootstrap returns empty distributions when the series is too short', () => {
    const out = blockBootstrap([0.01, -0.01, 0.02], mulberry32(1), 100, 7);
    expect(out.sharpes).toEqual([]);
    expect(out.maxDDs).toEqual([]);
  });

  it('blockBootstrap maxDDs are all in [0, 1]', () => {
    const { maxDDs } = blockBootstrap(rets, mulberry32(3), 200, 7);
    for (const dd of maxDDs) {
      expect(dd).toBeGreaterThanOrEqual(0);
      expect(dd).toBeLessThanOrEqual(1);
    }
  });

  it('percentile picks the right rank at the edges and middle', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 1)).toBe(5);
    expect(percentile(sorted, 0.5)).toBe(3);
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('perturbParams preserves every ordering/clamp invariant across spaces and seeds', () => {
    const spaces: ParamSpace[] = ['full', 'core', 'lowChurn', 'noInit'];
    for (const space of spaces) {
      const gen = mulberry32(100);
      const pert = mulberry32(200);
      for (let i = 0; i < 40; i++) {
        const base = sampleParams(gen, space);
        const p = perturbParams(base, pert, 0.15);
        // unwind strictly below bank; stop strictly beyond invalidation
        expect(p.unwindAt).toBeLessThan(p.bankAt);
        expect(p.stopAtrMult).toBeGreaterThanOrEqual(p.invalidationAtrMult);
        expect(p.erHigh).toBeGreaterThan(p.erLow);
        // hard clamps
        expect(p.anchorMaxOffset).toBeGreaterThanOrEqual(0.2);
        expect(p.anchorMaxOffset).toBeLessThanOrEqual(0.7);
        expect(p.initialFraction).toBeGreaterThanOrEqual(0);
        expect(p.initialFraction).toBeLessThanOrEqual(1);
        expect(p.gridLevels).toBeGreaterThanOrEqual(7);
        // structural switch is carried through, never jittered
        expect(p.deriskSoft).toBe(base.deriskSoft);
      }
    }
  });

  it('noInit space keeps zero arm-time inventory through perturbation', () => {
    const gen = mulberry32(11);
    const pert = mulberry32(22);
    for (let i = 0; i < 20; i++) {
      const base = sampleParams(gen, 'noInit');
      expect(base.initialFraction).toBe(0);
      // j(0) === 0 → clamp keeps it at 0, never re-introduces inventory
      expect(perturbParams(base, pert, 0.15).initialFraction).toBe(0);
    }
  });
});
