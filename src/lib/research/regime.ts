// Kaufman Efficiency Ratio regime filter with hysteresis, fed one CLOSED 30m
// bar at a time (incremental — O(1) per bar, so walk-forward stays cheap).
//
// Base state machine: 'range' ⇄ 'trend' with two thresholds (erLow < erHigh)
// and N-bar confirmation, so ER wobbling between the thresholds never flips
// the state. A volatility-expansion overlay (ATR vs its own moving average)
// reports 'volatile' regardless of the base state — the strategy treats both
// 'trend' and 'volatile' as no-trade conditions.

import { OHLC } from '../types';

export type Regime = 'warmup' | 'range' | 'trend' | 'volatile';

export interface RegimeConfig {
  erLookback: number;     // ER window in 30m bars
  erSmoothing: number;    // EMA length applied to raw ER
  erLow: number;          // ER must stay below this to confirm 'range'
  erHigh: number;         // ER must stay above this to confirm 'trend'
  confirmBars: number;    // consecutive bars beyond a threshold to flip state
  atrPeriod: number;      // Wilder ATR period (30m bars)
  volLookback: number;    // SMA window of ATR for the expansion baseline
  volExpandRatio: number; // ATR / SMA(ATR) above this → 'volatile'
}

export const DEFAULT_REGIME: RegimeConfig = {
  erLookback: 20,
  erSmoothing: 3,
  erLow: 0.25,
  erHigh: 0.45,
  confirmBars: 3,
  atrPeriod: 14,
  volLookback: 48,
  volExpandRatio: 1.75,
};

export interface RegimeState {
  regime: Regime;
  er: number;       // smoothed ER (NaN during warmup)
  atr: number;      // Wilder ATR (NaN during warmup)
  atrBase: number;  // SMA of ATR over volLookback (NaN during warmup)
  volExpanded: boolean;
}

export class RegimeFilter {
  private readonly cfg: RegimeConfig;
  private closes: number[] = [];
  private deltas: number[] = [];   // |close[i] - close[i-1]|, rolling erLookback window
  private deltaSum = 0;
  private erSmoothed = NaN;
  private prevBar: OHLC | null = null;
  private atr = NaN;
  private trSeed: number[] = [];   // first atrPeriod true ranges
  private atrWindow: number[] = []; // rolling volLookback ATR values
  private atrWindowSum = 0;
  private baseState: 'range' | 'trend' = 'trend'; // conservative default: prove range first
  private flipStreak = 0;

  constructor(cfg: RegimeConfig = DEFAULT_REGIME) {
    this.cfg = cfg;
  }

  update(bar: OHLC): RegimeState {
    const c = this.cfg;

    // --- ATR (Wilder) ---
    const tr = this.prevBar === null
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - this.prevBar.close), Math.abs(bar.low - this.prevBar.close));
    if (isNaN(this.atr)) {
      this.trSeed.push(tr);
      if (this.trSeed.length === c.atrPeriod) {
        this.atr = this.trSeed.reduce((s, v) => s + v, 0) / c.atrPeriod;
      }
    } else {
      this.atr = (this.atr * (c.atrPeriod - 1) + tr) / c.atrPeriod;
    }
    if (!isNaN(this.atr)) {
      this.atrWindow.push(this.atr);
      this.atrWindowSum += this.atr;
      if (this.atrWindow.length > c.volLookback) {
        this.atrWindowSum -= this.atrWindow.shift()!;
      }
    }
    const atrBase = this.atrWindow.length === c.volLookback ? this.atrWindowSum / c.volLookback : NaN;
    this.prevBar = bar;

    // --- ER (raw, then EMA-smoothed) ---
    const n = this.closes.length;
    if (n >= 1) {
      const d = Math.abs(bar.close - this.closes[n - 1]);
      this.deltas.push(d);
      this.deltaSum += d;
      if (this.deltas.length > c.erLookback) {
        this.deltaSum -= this.deltas.shift()!;
      }
    }
    this.closes.push(bar.close);
    let erRaw = NaN;
    if (this.deltas.length === c.erLookback) {
      const direction = Math.abs(bar.close - this.closes[this.closes.length - 1 - c.erLookback]);
      erRaw = this.deltaSum === 0 ? 0 : direction / this.deltaSum;
      const alpha = 2 / (c.erSmoothing + 1);
      this.erSmoothed = isNaN(this.erSmoothed) ? erRaw : this.erSmoothed + alpha * (erRaw - this.erSmoothed);
    }

    // --- hysteresis state machine ---
    const warmedUp = !isNaN(this.erSmoothed) && !isNaN(this.atr) && !isNaN(atrBase);
    if (!isNaN(this.erSmoothed)) {
      if (this.baseState === 'trend') {
        this.flipStreak = this.erSmoothed < c.erLow ? this.flipStreak + 1 : 0;
        if (this.flipStreak >= c.confirmBars) {
          this.baseState = 'range';
          this.flipStreak = 0;
        }
      } else {
        this.flipStreak = this.erSmoothed > c.erHigh ? this.flipStreak + 1 : 0;
        if (this.flipStreak >= c.confirmBars) {
          this.baseState = 'trend';
          this.flipStreak = 0;
        }
      }
    }

    const volExpanded = warmedUp && this.atr / atrBase > c.volExpandRatio;
    const regime: Regime = !warmedUp ? 'warmup' : volExpanded ? 'volatile' : this.baseState;
    return { regime, er: this.erSmoothed, atr: this.atr, atrBase, volExpanded };
  }
}
