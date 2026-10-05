// Strategy B research engine — shared types.
//
// Conventions:
//   - All times are unix SECONDS (matching OHLC.timestamp).
//   - Quantities are in base asset (ETH), always positive; direction comes from the leg.
//   - Prices/notional/fees/P&L are in USDT.
//   - The account is a USDT-M perp ledger: entries move margin, not cash;
//     only fees and realized P&L touch cash. Equity = cash + unrealized.

export type LegSide = 'long' | 'short';

export interface FeeConfig {
  makerFee: number; // resting grid limit fills (Binance USDT-M default tier: 0.0002)
  takerFee: number; // stops + market (partial) closes (0.0005)
}

export const DEFAULT_PERP_FEES: FeeConfig = {
  makerFee: 0.0002,
  takerFee: 0.0005,
};

// One open position increment (a single grid-entry fill).
export interface Lot {
  id: string;
  qty: number;        // remaining base qty, > 0
  entryPrice: number;
  entryFee: number;   // USDT fee attributable to the REMAINING qty (reduced pro-rata on partial closes)
  entryTimeSec: number;
  levelIndex: number; // grid level that opened it; -1 if not grid-originated
}

export interface GridOrder {
  id: string;
  leg: LegSide;
  type: 'buy' | 'sell';
  price: number;
  qty: number;
  levelIndex: number;
  reduceOnly: boolean; // true = closes lots (the take-profit side of grid churn)
  lotId?: string;      // reduceOnly: preferred lot to close (falls back to FIFO)
}

// Grid definition for one leg. Levels are absolute prices, ascending.
// Opening orders rest on the entry side only (long: buys below price,
// short: sells above price); the take-profit side appears as auto-counter
// orders after entries fill — the "no initial position" grid variant.
export interface GridDef {
  levels: number[];
  qtyPerLevel: number; // base asset per level
  // Scale factor for the initial TP-side inventory opened at arm time
  // (1 = full Pionex-style inventory, 0 = entries-only grid). Default 1.
  initialFraction?: number;
}

export type ResearchEventType =
  | 'initialOpen'   // taker market open of a leg's initial grid inventory
  | 'gridFill'      // maker fill of a resting grid order (entry or TP counter)
  | 'partialClose'  // strategy-initiated taker close of a fraction of a leg
  | 'fullClose'     // strategy-initiated taker close of an entire leg
  | 'stop'          // hard stop-loss: leg flattened at stop price + slippage
  | 'funding';      // one 8h funding settlement applied to open notional

export interface ResearchEvent {
  type: ResearchEventType;
  timeSec: number;
  leg?: LegSide;
  orderType?: 'buy' | 'sell';
  price?: number;       // effective fill price (after slippage where applicable)
  qty?: number;         // base qty transacted
  fee?: number;         // USDT fee paid on this event
  realizedPnl?: number; // net of entry+exit fees, closes only
  fraction?: number;    // partialClose: fraction of the leg that was closed
  levelIndex?: number;
  reduceOnly?: boolean;
  fundingRate?: number;
  reason?: string;      // strategy-supplied tag (e.g. 'bankProfit', 'hedgeUnwind', 'derisk')
}

export interface EquityPoint {
  timeSec: number;   // 30m bar close time
  price: number;     // 30m close used as mark
  equity: number;    // cash + unrealized
  cash: number;
  unrealized: number;
  longQty: number;
  shortQty: number;
}

// Deferred taker action queued at a 30m signal, executed at the next 1m open.
export interface MarketAction {
  kind: 'closeFraction' | 'closeAll';
  leg: LegSide;
  fraction?: number; // closeFraction only, (0, 1]
  reason: string;
}
