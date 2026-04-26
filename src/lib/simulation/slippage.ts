import { GridSide, OrderType } from '../types';

export interface SlippageConfig {
  // Base slippage fraction applied to every non-SL fill (e.g. 0.0001 = 1 bp).
  basisBp: number;
  // Additional slippage on stop-loss fills, scaled by ATR fraction of price.
  slSlippageCoefficient: number;
  // Floor so SL slippage is at least this much (fraction, e.g. 0.001 = 10 bp).
  slSlippageFloor: number;
  // Cap so SL slippage never exceeds this fraction.
  slSlippageCap: number;
}

export const DEFAULT_SLIPPAGE: SlippageConfig = {
  basisBp: 0.0001,
  slSlippageCoefficient: 1.0,
  slSlippageFloor: 0.001,
  slSlippageCap: 0.01,
};

/**
 * Return a fill price adjusted for slippage.
 *
 * - For non-SL fills: multiplicative drift equal to `basisBp`. A buy pays up, a sell receives less.
 * - For SL fills: `slSlippageCoefficient * (ATR / price)`, clamped to [floor, cap], applied in the
 *   direction that hurts the trader (e.g. a long SL fills below its limit, a short SL fills above).
 */
export function applySlippage(
  fillPrice: number,
  orderType: OrderType,
  side: GridSide,
  atrFractionOfPrice: number,
  isSL: boolean,
  cfg: SlippageConfig = DEFAULT_SLIPPAGE
): number {
  if (fillPrice <= 0) return fillPrice;

  let slip: number;
  if (isSL) {
    const raw = cfg.slSlippageCoefficient * Math.max(0, atrFractionOfPrice);
    slip = Math.min(cfg.slSlippageCap, Math.max(cfg.slSlippageFloor, raw));
  } else {
    slip = cfg.basisBp;
  }

  // Direction: buys shift up; sells shift down. (Both cost the trader.)
  // For SL close on a long, we exit via a sell — price shifts down (worse).
  // For SL close on a short, we exit via a buy — price shifts up (worse).
  void side;
  if (orderType === 'buy') return fillPrice * (1 + slip);
  return fillPrice * (1 - slip);
}

export function atrFractionOfPrice(atr: number, price: number): number {
  if (price <= 0 || !isFinite(atr)) return 0;
  return atr / price;
}
