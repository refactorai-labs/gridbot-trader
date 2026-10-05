// Pionex backtester — liquidation prices (plan §3.4.4).
//
// Liquidation when equity(mark) ≤ qty · mark · mmr, i.e. mark ≤ P_liq with
//   P_liq = (qty·avgEntry − wallet) / (qty·(1 − mmr)).
// No correction factor (plan §3.9).

import { BotState } from './types';

// null when flat (a flat bot cannot be liquidated).
export function liqPrice(qty: number, avgEntry: number, wallet: number, mmr: number): number | null {
  if (qty <= 0) return null;
  return (qty * avgEntry - wallet) / (qty * (1 - mmr));
}

export const currentLiqPrice = (bot: BotState, mmr: number): number | null =>
  liqPrice(bot.qty, bot.avgEntry, bot.wallet, mmr);

// Full-grid P_liq (card value, compared with Pionex Est. Liq.): every still-open
// buy order fills at its own level with the maker fee.
export function fullGridLiqPrice(bot: BotState, mmr: number, makerFee: number): number | null {
  let qty = bot.qty;
  let cost = bot.qty * bot.avgEntry;
  let wallet = bot.wallet;
  bot.held.forEach((lot, i) => {
    if (lot) return;
    const p = bot.levels[i];
    qty += bot.slotQty / p;
    cost += bot.slotQty;
    wallet -= bot.slotQty * makerFee;
  });
  return qty > 0 ? liqPrice(qty, cost / qty, wallet, mmr) : null;
}

// (mark − P_liq) / mark; null when flat.
export const liqDistancePct = (mark: number, pLiq: number | null): number | null =>
  pLiq === null ? null : (mark - pLiq) / mark;
