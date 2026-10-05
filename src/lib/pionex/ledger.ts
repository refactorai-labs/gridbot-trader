// Pionex backtester — single financial ledger (plan §3.2).
//
// Exchange-style average-price accounting per bot:
//   buy  (limit or market): wallet −= fee; qty and avgEntry update; a lot opens
//   sell (grid):            wallet += q·(p − avgEntry) − fee; qty shrinks; the lot closes
//   funding:                wallet −= qty · mark · rate (long pays when rate > 0)
//   top-up:                 wallet += x, freeCash −= x (cash movement, not profit)
//   liquidation:            wallet and position are lost; no further events
// Lots are only used to pair fills for the grid-profit display; survival depends
// on equity and qty alone (plan §3.2).

import { BotState, LedgerTotals, Lot } from './types';

export class PionexLedger {
  freeCash: number;
  readonly capitalTotal: number;
  readonly totals: LedgerTotals = { realizedTradePnl: 0, fees: 0, funding: 0, liquidationLoss: 0, topUps: 0 };

  constructor(capitalTotal: number, readonly bot: BotState) {
    this.capitalTotal = capitalTotal;
    this.freeCash = capitalTotal;
  }

  // Moves I + E from the common capital into the bot's isolated wallet. False = start_rejected.
  fund(amount: number): boolean {
    if (this.freeCash < amount) return false;
    this.freeCash -= amount;
    this.bot.wallet += amount;
    return true;
  }

  equity(price: number): number {
    return this.bot.wallet + this.bot.qty * (price - this.bot.avgEntry);
  }

  buy(slot: number, qty: number, price: number, feeRate: number): number {
    const b = this.bot;
    const fee = qty * price * feeRate;
    b.wallet -= fee;
    this.totals.fees += fee;
    b.avgEntry = (b.qty * b.avgEntry + qty * price) / (b.qty + qty);
    b.qty += qty;
    b.held[slot] = { slot, qty, buyPrice: price, buyFee: fee };
    return fee;
  }

  // Grid sell of the lot in `slot` at level slot+1.
  sell(slot: number, price: number, feeRate: number): Lot {
    const b = this.bot;
    const lot = b.held[slot];
    if (!lot) throw new Error(`No lot in slot ${slot}`);
    const fee = lot.qty * price * feeRate;
    const pnl = lot.qty * (price - b.avgEntry);
    b.wallet += pnl - fee;
    this.totals.realizedTradePnl += pnl;
    this.totals.fees += fee;
    b.held[slot] = null;
    b.qty -= lot.qty;
    if (b.held.every(l => l === null)) {
      b.qty = 0; // no float residue once every lot is closed
      b.avgEntry = 0;
    }
    b.rounds++;
    b.gridProfit += lot.qty * (price - lot.buyPrice) - lot.buyFee - fee;
    return lot;
  }

  // Returns the amount paid (negative = received).
  funding(rate: number, mark: number): number {
    const paid = this.bot.qty * mark * rate;
    this.bot.wallet -= paid;
    this.totals.funding += paid;
    return paid;
  }

  // Returns the amount actually moved (capped at freeCash).
  topUp(amount: number): number {
    const x = Math.min(amount, this.freeCash);
    this.freeCash -= x;
    this.bot.wallet += x;
    this.totals.topUps += x;
    return x;
  }

  // Returns the wallet lost.
  liquidate(): number {
    const b = this.bot;
    const lost = b.wallet;
    this.totals.liquidationLoss += lost;
    b.wallet = 0;
    b.qty = 0;
    b.avgEntry = 0;
    b.held = b.held.map(() => null);
    b.status = 'liquidated';
    return lost;
  }

  // Plan §3.7 invariant, one bot: freeCash + wallet = capitalTotal + Σ trade PnL − Σ fee − Σ funding − Σ liquidation loss.
  invariantError(): number {
    const t = this.totals;
    return Math.abs(
      this.freeCash + this.bot.wallet - (this.capitalTotal + t.realizedTradePnl - t.fees - t.funding - t.liquidationLoss)
    );
  }
}
