// Shared contract for the classic grid engine v1 (plan v4, Contracts A–D).
// Frozen interface between the pure core (classicGridCore.ts), the engine
// wrapper (engine.ts), the API routes and the UI. Pure types + constants only.

import type { OHLC, GridSide, GridType, SnapshotData, TrendDirection } from '../types';

// ---------- Core input ----------

export interface ClassicSideInput {
  lowerBound: number;
  upperBound: number;
  gridLevels: number;          // N price lines → N−1 slots
  gridType: GridType;
  orderSize: number;           // quote notional per entry (q = orderSize / fillPrice)
  totalCapital: number;        // starting cash of this side
  profitMode: 'next_level' | 'custom';  // 'custom' arrives in checkpoint 2
  customProfitDistance?: number;
}

export interface ClassicGridInput {
  candles: OHLC[];             // effective 5m execution candles, ascending, gap-free
  feeRate: number;             // fraction, e.g. 0.0008
  long: ClassicSideInput | null;   // null = side disabled
  short: ClassicSideInput | null;
}

// ---------- Core output ----------

export type FillRole = 'initial' | 'entry' | 'exit' | 'reduce' | 'exhaust';

export interface ClassicFill {
  fillSeq: number;             // global 0-based execution order
  side: GridSide;
  role: FillRole;
  orderType: 'buy' | 'sell';
  slotIndex: number;
  positionId: string;          // `${side}-${slotIndex}-${cycle}`
  level: number;               // grid line index the order was anchored to (Contract C)
  levelPrice: number;          // limit price, or market price for market fills
  fillPrice: number;
  quantity: number;
  notional: number;            // fillPrice × quantity (→ GridOrder.orderSize)
  fees: number;
  pnl: number | null;          // closing legs: leg realized − leg fee; null for entries
  pairedFillSeq: number | null; // closing legs: fillSeq of the position's entry fill
  candleIdx: number;           // index into ClassicGridInput.candles (5m)
  timestamp: number;           // open of that 5m candle, seconds
}

export type RiskPhase = 'none' | 'phase1' | 'phase2' | 'closed' | 'restoring';

export interface SideSignalState {
  trend: TrendDirection;
  riskPhase: RiskPhase;
  risk: number;                // risk multiplier (1 without adaptation; 0 once a side is stopped)
}

export interface ClassicEvent {
  candleIdx: number;           // 5m index
  timestamp: number;           // seconds (open of that 5m candle)
  eventType: ClassicEventType;
  details: Record<string, unknown>;
  // State events: effective entry-size multiplier (risk × trend) per side, for BOTH
  // sides; null for a disabled side and for diagnostics.
  longMultiplier: number | null;
  shortMultiplier: number | null;
}

export interface ClassicSideResult {
  totalCapital: number;
  cash: number;
  finalEquity: number;         // cash + Σ basis + unrealized at final close
  realizedGross: number;
  fees: number;
  unrealized: number;
  fills: number;
  roundTrips: number;
  winCount: number;
  lossCount: number;
  skippedEntries: number;
  exhausted: boolean;
  openPositions: number;
  pendingOrders: number;
}

export interface ClassicGridResult {
  fills: ClassicFill[];
  snapshots: SnapshotData[];   // realized fields NET of fees; candleIdx = 5m index
  events: ClassicEvent[];
  long: ClassicSideResult | null;
  short: ClassicSideResult | null;
  startingCapital: number;     // Σ totalCapital over enabled sides
  finalEquity: number;
  totalPnl: number;            // finalEquity − startingCapital
  totalPnlPct: number;
  realizedGross: number;
  totalFees: number;
  unrealized: number;
  roundTrips: number;
  winCount: number;
  lossCount: number;
  maxDrawdown: number;         // from full equity at every fill and path point
  maxDrawdownPct: number;      // vs running peak equity
  skippedEntries: number;
  totalCandles: number;
}

// ---------- Events (Contract C) ----------

// State events: at most one row per side per transition; each carries both sides'
// full post-transition state in details.state = { long: SideSignalState | null, short: … }.
export const STATE_EVENT_TYPES = [
  'trend_change', 'breakout_detected', 'de_risk', 're_entry',
  'reduction', 'capital_exhausted', 'warmup_in_window',
] as const;

// Per-order diagnostics: unbounded count, stored in full, never in the replay payload.
export const DIAGNOSTIC_EVENT_TYPES = ['entry_skipped', 'restoration_entry'] as const;

export type ClassicEventType =
  | (typeof STATE_EVENT_TYPES)[number]
  | (typeof DIAGNOSTIC_EVENT_TYPES)[number];

// entry_skipped streak details. A streak is a maximal run of consecutive 5m candles
// in each of which the order was attempted and starved at least once; it is
// finalized when the order fills, is removed, a candle passes without a starved
// attempt, or the data ends. skippedCandles = lastCandleIdx − firstCandleIdx + 1.
export interface EntrySkippedDetails {
  side: GridSide;
  slotIndex: number;
  firstCandleIdx: number;
  lastCandleIdx: number;
  skippedCandles: number;
  shortfall: number;           // required − cash at the last starved attempt (quote)
}

// ---------- Replay / API constants (Contract D) ----------

export const CLASSIC_ENGINE_VERSION = 1;
export const MAX_REPLAY_EVENTS = 5000;   // equals the page's MAX_EVENTS_HINT
export const EVENTS_PAGE_DEFAULT = 200;
export const EVENTS_PAGE_MAX = 500;
