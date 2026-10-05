import { describe, it, expect } from 'vitest';
import { OHLC } from '../lib/types';
import { runPionex } from '../lib/pionex/engine';
import { slotNotional } from '../lib/pionex/gridLevels';
import { PionexBotConfig } from '../lib/pionex/types';

// Plan §4.1 fixtures (two live Pionex bots). Phase 1 gate (plan §4.3):
// profit/round ±3 %, initial quantity ±2 %. The full-grid P_liq vs Pionex Est. Liq.
// is only reported until §4.2 confirms what Est. Liq. means — the P_liq checks
// below are regressions against the plan's model values, not a Pionex gate.

const T0 = Date.UTC(2026, 8, 29);
// Flat 1m bars: every move happens in the opening-gap segment, so no intra-candle path ambiguity.
const flats = (prices: number[]): OHLC[] =>
  prices.map((p, i) => ({ timestamp: (T0 + i * 60_000) / 1000, open: p, high: p, low: p, close: p, volume: 0 }));
const costs = { makerFee: 0.0002, takerFee: 0.0005, mmr: 0.005 };

interface Fixture {
  bot: PionexBotConfig;
  start: number;
  openGrids: number;
  pionexProfitPerRound: number;
  pionexEstLiq: number;
  modelLiqStart: number;
  modelLiqFull: number;
}

const FIXTURES: Record<'A' | 'B', Fixture> = {
  A: {
    bot: { lower: 2546.9, upper: 2839, gridCount: 60, mode: 'arithmetic', investment: 134.68, extraMargin: 103.59, leverage: 15 },
    start: 2728.77,
    openGrids: 22,
    pionexProfitPerRound: 8.93 / 192,
    pionexEstLiq: 2334.74,
    modelLiqStart: 1862,
    modelLiqFull: 2366.7,
  },
  B: {
    // E is estimated from the calculator's 1.75 ratio — to be confirmed (plan §4.1).
    bot: { lower: 2509.51, upper: 2868.01, gridCount: 60, mode: 'arithmetic', investment: 11.11, extraMargin: 11.11 * 1.75, leverage: 15 },
    start: 2689.29,
    openGrids: 29,
    pionexProfitPerRound: 0.117 / 23,
    pionexEstLiq: 2135.67,
    modelLiqStart: 1679,
    modelLiqFull: 2168.6,
  },
};

const run = (f: Fixture, prices: number[], extraMargin = f.bot.extraMargin, marginCheck = true) => {
  const bars = flats(prices);
  return runPionex(bars, bars, [], { bot: { ...f.bot, extraMargin }, costs, marginCheck }, 'A');
};

describe.each(Object.entries(FIXTURES))('pionex fixture Bot %s (plan §4.1)', (_, f) => {
  // Internal consistency only: the expected qty uses the engine's own k·Q/start
  // formula. External validation needs the Pionex position quantity (plan §4.2).
  it('opens the documented number of grids at start; initial qty is consistent with k·Q / start', () => {
    const r = run(f, [f.start]);
    expect(r.events[0].reason).toBe(`${f.openGrids} grids bought at market`);
    const expected = (f.openGrids * slotNotional(f.bot)) / f.start;
    expect(Math.abs(r.initialQty / expected - 1)).toBeLessThan(0.02);
  });

  it('average profit per round (maker–maker) is within 3 % of Pionex', () => {
    // From the top of the band down to the bottom and back: every slot does one round.
    // Margin check off: this measures profit only (with it on, Bot A's bottom level is
    // skipped when the whole grid fills at its own levels — E barely misses).
    const r = run(f, [f.bot.upper, f.bot.lower, f.bot.upper], f.bot.extraMargin, false);
    expect(r.rounds).toBe(60);
    const perRound = r.gridProfit / r.rounds;
    expect(Math.abs(perRound / f.pionexProfitPerRound - 1)).toBeLessThan(0.03);
  });

  it('P_liq of the start position and of the full grid match the plan model values', () => {
    const r = run(f, [f.start]);
    expect(Math.abs(r.startLiq.current! / f.modelLiqStart - 1)).toBeLessThan(0.005);
    expect(Math.abs(r.startLiq.fullGrid! / f.modelLiqFull - 1)).toBeLessThan(0.005);
    // Reported only (not a gate until §4.2): full-grid P_liq sits above Pionex Est. Liq.
    expect(r.startLiq.fullGrid!).toBeGreaterThan(f.pionexEstLiq);
  });

  it('margin check does not bind inside the band with the live E; it does with E = 0 (plan §3.5)', () => {
    const live = run(f, [f.start, f.bot.lower]);
    expect(live.status).toBe('active');
    expect(live.events.some(e => e.type === 'buy_skipped')).toBe(false);
    const noExtra = run(f, [f.start, f.bot.lower], 0);
    const skipped = noExtra.events.filter(e => e.type === 'buy_skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every(e => e.price! >= f.bot.lower && e.price! < f.start)).toBe(true);
  });
});
