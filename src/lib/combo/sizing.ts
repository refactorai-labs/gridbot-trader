import { ComboBotSideConfig, ComboMode, GridSide } from '../types';

/**
 * Combined SL percent: slBasePercent + (ATR * slAtrMultiplier / entry), clamped to [slFloor, slCap].
 */
export function slPercent(cfg: ComboBotSideConfig, atr: number, entry: number): number {
  if (entry <= 0 || !isFinite(atr)) return cfg.slBasePercent;
  const atrComponent = (atr * cfg.slAtrMultiplier) / entry;
  const raw = cfg.slBasePercent + atrComponent;
  return Math.min(cfg.slCap, Math.max(cfg.slFloor, raw));
}

export function slPrice(cfg: ComboBotSideConfig, side: GridSide, entry: number, atr: number): number {
  const pct = slPercent(cfg, atr, entry);
  return side === 'long' ? entry * (1 - pct) : entry * (1 + pct);
}

/**
 * Grid spacing scaled by ATR. `density` is a config knob (higher density → tighter grid).
 */
export function atrScaledGridStep(atr: number, density: number = 1.0): number {
  return Math.max(0, atr / Math.max(density, 0.01));
}

export interface AllocationSplit {
  longCapital: number;
  shortCapital: number;
}

export function allocateCapital(
  totalCapital: number,
  mode: ComboMode,
  allocationLong: number
): AllocationSplit {
  if (mode === 'long') return { longCapital: totalCapital, shortCapital: 0 };
  if (mode === 'short') return { longCapital: 0, shortCapital: totalCapital };
  // dual
  const clamped = Math.min(0.75, Math.max(0.5, allocationLong));
  return {
    longCapital: totalCapital * clamped,
    shortCapital: totalCapital * (1 - clamped),
  };
}

export function tierSize(tier: 0 | 1 | 2 | 3, cfg: ComboBotSideConfig): number {
  switch (tier) {
    case 0: return 0;
    case 1: return cfg.tier1Size;
    case 2: return cfg.tier2Size;
    case 3: return cfg.tier3Size;
  }
}
