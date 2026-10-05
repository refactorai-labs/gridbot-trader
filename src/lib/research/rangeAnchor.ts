// Range anchoring for Strategy B: rolling Donchian midpoint ± k·ATR.
//
// The range center is the midpoint of the highest high / lowest low over the
// lookback window of CLOSED 30m bars; the half-width is ATR-proportional,
// clamped to a percent band of price so grids neither collapse in quiet tape
// nor balloon in violent tape. Invalidation zones extend w·ATR beyond each
// range edge (losing leg may recover inside them); hard stops sit s·ATR
// beyond the edge with s ≥ w.

import { OHLC } from '../types';

export interface AnchorConfig {
  donchianLookback: number;  // bars in the Donchian window (336 = 7d of 30m)
  atrMult: number;           // k — half-width = k · ATR before clamping
  minHalfWidthPct: number;   // clamp floor as fraction of center price
  maxHalfWidthPct: number;   // clamp cap as fraction of center price
  invalidationAtrMult: number; // w — recovery zone depth beyond the range edge
  stopAtrMult: number;         // s — hard stop distance beyond the range edge (s ≥ w)
  gridLevels: number;          // levels spanning [lower, upper], shared by both legs
  anchorMaxOffset: number;     // only anchor when |price-center| ≤ this fraction of half-width
}

export const DEFAULT_ANCHOR: AnchorConfig = {
  donchianLookback: 336,
  atrMult: 8,
  minHalfWidthPct: 0.02,
  maxHalfWidthPct: 0.08,
  invalidationAtrMult: 2,
  stopAtrMult: 3,
  gridLevels: 21,
  anchorMaxOffset: 0.6,
};

export interface RangeZones {
  anchoredAtSec: number;
  center: number;
  halfWidth: number;
  lower: number;
  upper: number;
  invalidLower: number; // outer edge of the lower invalidation zone
  invalidUpper: number;
  stopLong: number;     // hard stop for the long leg (below the range)
  stopShort: number;    // hard stop for the short leg (above the range)
  levels: number[];     // ascending, gridLevels entries across [lower, upper]
}

// Build zones from closed 30m bars. Returns null when there is not enough
// history or the current price sits too far from the prospective center
// (anchoring there would produce a one-sided, degenerate cycle).
export function buildRange(closed: OHLC[], atr: number, nowSec: number, cfg: AnchorConfig): RangeZones | null {
  if (closed.length < cfg.donchianLookback || !isFinite(atr) || atr <= 0) return null;

  const window = closed.slice(-cfg.donchianLookback);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of window) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  const center = (hi + lo) / 2;
  const halfWidth = Math.min(
    cfg.maxHalfWidthPct * center,
    Math.max(cfg.minHalfWidthPct * center, cfg.atrMult * atr)
  );

  const price = closed[closed.length - 1].close;
  if (Math.abs(price - center) > cfg.anchorMaxOffset * halfWidth) return null;

  const lower = center - halfWidth;
  const upper = center + halfWidth;
  const levels: number[] = [];
  const step = (upper - lower) / (cfg.gridLevels - 1);
  for (let i = 0; i < cfg.gridLevels; i++) levels.push(lower + i * step);

  return {
    anchoredAtSec: nowSec,
    center,
    halfWidth,
    lower,
    upper,
    invalidLower: lower - cfg.invalidationAtrMult * atr,
    invalidUpper: upper + cfg.invalidationAtrMult * atr,
    stopLong: lower - cfg.stopAtrMult * atr,
    stopShort: upper + cfg.stopAtrMult * atr,
    levels,
  };
}
