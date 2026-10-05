// Strategy B research engine — USDT-M perp account ledger.
//
// Cash ledger semantics (isolated-margin perp, unlevered by default):
//   - Opening a lot moves no cash except the entry fee.
//   - Closing qty q of a lot credits cash with gross P&L minus the exit fee.
//   - realizedPnl reported per close is NET of the pro-rata entry fee too,
//     so cash ≡ initialCapital + Σ realizedPnl − Σ funding at all times.
//   - Funding settlements debit/credit cash directly against open notional.

import {
  FeeConfig,
  GridOrder,
  Lot,
  LegSide,
  ResearchEvent,
} from './types';

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${++idCounter}`;
}
export function resetResearchIds(): void {
  idCounter = 0;
}

export interface LegState {
  side: LegSide;
  lots: Lot[];
  orders: GridOrder[];
  stopPrice: number | null;
  active: boolean;        // false after a stop until the strategy re-arms the leg
  realizedPnl: number;    // net of all fees
  feesPaid: number;
  fundingPaid: number;    // positive = outflow
  stopCount: number;
}

export interface CloseResult {
  qty: number;
  realizedPnl: number; // net of entry-share + exit fees
  fee: number;         // exit fee paid
}

function emptyLeg(side: LegSide): LegState {
  return {
    side,
    lots: [],
    orders: [],
    stopPrice: null,
    active: true,
    realizedPnl: 0,
    feesPaid: 0,
    fundingPaid: 0,
    stopCount: 0,
  };
}

export class PerpAccount {
  cash: number;
  readonly initialCapital: number;
  readonly fees: FeeConfig;
  readonly legs: Record<LegSide, LegState>;

  constructor(initialCapital: number, fees: FeeConfig) {
    this.cash = initialCapital;
    this.initialCapital = initialCapital;
    this.fees = fees;
    this.legs = { long: emptyLeg('long'), short: emptyLeg('short') };
  }

  legQty(side: LegSide): number {
    return this.legs[side].lots.reduce((s, l) => s + l.qty, 0);
  }

  legNotional(side: LegSide, markPrice: number): number {
    return this.legQty(side) * markPrice;
  }

  // Signed unrealized P&L across both legs at a mark price.
  unrealized(markPrice: number): number {
    let total = 0;
    for (const side of ['long', 'short'] as LegSide[]) {
      const dir = side === 'long' ? 1 : -1;
      for (const lot of this.legs[side].lots) {
        total += dir * (markPrice - lot.entryPrice) * lot.qty;
      }
    }
    return total;
  }

  equity(markPrice: number): number {
    return this.cash + this.unrealized(markPrice);
  }

  placeOrder(order: Omit<GridOrder, 'id'>): GridOrder {
    const full: GridOrder = { ...order, id: nextId('ord') };
    this.legs[order.leg].orders.push(full);
    return full;
  }

  cancelAllOrders(side: LegSide): void {
    this.legs[side].orders = [];
  }

  removeOrder(side: LegSide, orderId: string): void {
    const leg = this.legs[side];
    leg.orders = leg.orders.filter(o => o.id !== orderId);
  }

  // Open a new lot at `price` (fee rate chosen by caller: maker for grid fills).
  openLot(
    side: LegSide,
    qty: number,
    price: number,
    feeRate: number,
    timeSec: number,
    levelIndex: number
  ): Lot {
    const fee = qty * price * feeRate;
    this.cash -= fee;
    this.legs[side].feesPaid += fee;
    const lot: Lot = {
      id: nextId('lot'),
      qty,
      entryPrice: price,
      entryFee: fee,
      entryTimeSec: timeSec,
      levelIndex,
    };
    this.legs[side].lots.push(lot);
    return lot;
  }

  // Close up to `qty` from a specific lot (or FIFO when lotId is undefined).
  closeQty(
    side: LegSide,
    qty: number,
    price: number,
    feeRate: number,
    lotId?: string
  ): CloseResult {
    const leg = this.legs[side];
    const dir = side === 'long' ? 1 : -1;
    let remaining = qty;
    let realized = 0;
    let feeTotal = 0;
    let closedQty = 0;

    const ordered = lotId
      ? [...leg.lots.filter(l => l.id === lotId), ...leg.lots.filter(l => l.id !== lotId)]
      : leg.lots;

    for (const lot of ordered) {
      if (remaining <= 0) break;
      const q = Math.min(lot.qty, remaining);
      if (q <= 0) continue;
      const gross = dir * (price - lot.entryPrice) * q;
      const exitFee = q * price * feeRate;
      const entryFeeShare = lot.entryFee * (q / lot.qty);

      this.cash += gross - exitFee;
      leg.feesPaid += exitFee;
      realized += gross - exitFee - entryFeeShare;
      feeTotal += exitFee;
      closedQty += q;

      lot.entryFee -= entryFeeShare;
      lot.qty -= q;
      remaining -= q;
    }

    leg.lots = leg.lots.filter(l => l.qty > 1e-12);
    leg.realizedPnl += realized;
    return { qty: closedQty, realizedPnl: realized, fee: feeTotal };
  }

  // Close `fraction` of every open lot proportionally (taker market close).
  closeFraction(side: LegSide, fraction: number, price: number, feeRate: number): CloseResult {
    const leg = this.legs[side];
    const dir = side === 'long' ? 1 : -1;
    const f = Math.min(1, Math.max(0, fraction));
    let realized = 0;
    let feeTotal = 0;
    let closedQty = 0;

    for (const lot of leg.lots) {
      const q = lot.qty * f;
      if (q <= 0) continue;
      const gross = dir * (price - lot.entryPrice) * q;
      const exitFee = q * price * feeRate;
      const entryFeeShare = lot.entryFee * f;

      this.cash += gross - exitFee;
      leg.feesPaid += exitFee;
      realized += gross - exitFee - entryFeeShare;
      feeTotal += exitFee;
      closedQty += q;

      lot.entryFee -= entryFeeShare;
      lot.qty -= q;
    }

    if (f >= 1) leg.lots = [];
    else leg.lots = leg.lots.filter(l => l.qty > 1e-12);
    leg.realizedPnl += realized;
    return { qty: closedQty, realizedPnl: realized, fee: feeTotal };
  }

  // Apply one funding settlement against current open notional.
  // Long pays when rate > 0, short receives (and vice versa). Returns the event.
  applyFunding(rate: number, markPrice: number, timeSec: number): ResearchEvent {
    let totalCost = 0;
    for (const side of ['long', 'short'] as LegSide[]) {
      const notional = this.legNotional(side, markPrice);
      if (notional <= 0) continue;
      const cost = side === 'long' ? notional * rate : -notional * rate;
      this.cash -= cost;
      this.legs[side].fundingPaid += cost;
      totalCost += cost;
    }
    return { type: 'funding', timeSec, fee: totalCost, fundingRate: rate, price: markPrice };
  }
}
