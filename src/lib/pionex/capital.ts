// Pionex backtester — fixed common capital shared by every bot and top-up (plan §3.7).
//
// State: freeCash, each bot's wallet (in its ledger) and the withdrawn profit (kivett).
// Invariant (checked after every event):
//   freeCash + Σ wallet + withdrawn = capitalTotal + Σ trade PnL − Σ fee − Σ funding − Σ liquidation loss

import { LedgerTotals } from './types';

export class Capital {
  freeCash: number;
  withdrawn = 0;
  readonly totals: LedgerTotals = { realizedTradePnl: 0, fees: 0, funding: 0, liquidationLoss: 0, topUps: 0 };

  constructor(readonly capitalTotal: number) {
    this.freeCash = capitalTotal;
  }

  // Takes `amount` out of freeCash. False = rejected (not enough free cash).
  allocate(amount: number): boolean {
    if (this.freeCash < amount) return false;
    this.freeCash -= amount;
    return true;
  }

  release(amount: number): void {
    this.freeCash += amount;
  }

  withdraw(amount: number): void {
    this.withdrawn += amount;
  }

  invariantError(sumWallets: number): number {
    const t = this.totals;
    return Math.abs(
      this.freeCash + sumWallets + this.withdrawn -
        (this.capitalTotal + t.realizedTradePnl - t.fees - t.funding - t.liquidationLoss)
    );
  }
}
