import { GridSide } from '../types';

export interface FundingRateEntry {
  fundingTimeSec: number; // unix seconds
  fundingRate: number;    // signed; positive means longs pay shorts
}

export interface NotionalPosition {
  side: GridSide;
  notional: number; // position notional in USDT (size * entryPrice * leverage already applied)
}

export interface FundingApplyResult {
  totalCost: number;  // sum of funding across all positions for this settlement
  longCost: number;
  shortCost: number;
  appliedCount: number;
}

/**
 * Apply all funding settlements that lie in `(prevTimeSec, nowSec]`.
 *
 * For each settlement, each open position pays (or receives) `notional * fundingRate`.
 *   Long pays if fundingRate > 0, receives if fundingRate < 0.
 *   Short is mirrored.
 *
 * `costs` are returned as positive-outflow values (funding paid) — i.e. subtract from P&L.
 */
export function applyFundingBetween(
  prevTimeSec: number,
  nowSec: number,
  positions: NotionalPosition[],
  rates: FundingRateEntry[]
): FundingApplyResult {
  let totalCost = 0;
  let longCost = 0;
  let shortCost = 0;
  let appliedCount = 0;

  for (const entry of rates) {
    if (entry.fundingTimeSec <= prevTimeSec || entry.fundingTimeSec > nowSec) continue;
    appliedCount++;

    for (const pos of positions) {
      // Long pays +rate, short pays -rate. Positive cost = outflow.
      const cost = pos.side === 'long' ? pos.notional * entry.fundingRate : -pos.notional * entry.fundingRate;
      totalCost += cost;
      if (pos.side === 'long') longCost += cost;
      else shortCost += cost;
    }
  }

  return { totalCost, longCost, shortCost, appliedCount };
}

/**
 * Given a sorted ascending list of fundingTimes in seconds, find entries within (prev, now].
 * Utility for unit testing without a full rate list.
 */
export function settlementsBetween(
  prevTimeSec: number,
  nowSec: number,
  rates: FundingRateEntry[]
): FundingRateEntry[] {
  return rates.filter(r => r.fundingTimeSec > prevTimeSec && r.fundingTimeSec <= nowSec);
}
