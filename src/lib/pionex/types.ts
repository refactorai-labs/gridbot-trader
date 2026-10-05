// Pionex long futures grid backtester — shared types (plan §3).

export type GridMode = 'arithmetic' | 'geometric';
export type PathId = 'A' | 'B'; // A = O→L→H→C, B = O→H→L→C (plan §3.4.2)

export interface PionexBotConfig {
  lower: number;
  upper: number;
  gridCount: number;
  mode: GridMode;
  investment: number;  // I — fixed, sizes the grid (plan §3.1)
  extraMargin: number; // E — extra isolated margin
  leverage: number;
}

export interface PionexCosts {
  makerFee: number; // grid limit fills
  takerFee: number; // initial market buy and every intervention close
  mmr: number;      // maintenance margin rate (single input, plan §3.9)
  fundingRateOverride?: number | null; // constant rate at every real settlement
}

export interface ScheduledTopUp {
  atMs: number; // 1m open the top-up executes on
  amount: number;
}

export interface PionexRunConfig {
  bot: PionexBotConfig;
  costs: PionexCosts;
  marginCheck: boolean;   // plan §3.5 (default on)
  capitalTotal?: number;  // fixed common capital; default I + E (plan §3.7)
  // Phase 1 test hook: a hard-coded top-up event instead of the top-up rule (plan §4.3).
  scheduledTopUps?: ScheduledTopUp[];
}

export type BotStatus = 'active' | 'liquidated' | 'stopped';

export interface Lot {
  slot: number;     // grid slot i: bought at/for level i, sells at level i+1
  qty: number;
  buyPrice: number;
  buyFee: number;
}

export interface BotState {
  levels: number[];  // n+1 prices, ascending
  slotQty: number;   // Q = I·lev/n notional per grid (USDT)
  held: (Lot | null)[]; // per slot 0..n-1: open lot (sell order at level i+1) or null (buy order at level i)
  wallet: number;
  qty: number;
  avgEntry: number;
  status: BotStatus;
  rounds: number;
  gridProfit: number; // display only (plan §3.2)
}

export interface LedgerTotals {
  realizedTradePnl: number;
  fees: number;
  funding: number; // positive = paid by the bot
  liquidationLoss: number;
  topUps: number;
}

export type LedgerEventType =
  | 'start'
  | 'start_rejected'
  | 'buy'
  | 'sell'
  | 'buy_skipped'
  | 'funding'
  | 'topup'
  | 'topup_rejected'
  | 'topup_cancelled'
  | 'liquidation';

export interface LedgerEvent {
  type: LedgerEventType;
  timeMs: number;   // original 1m open time
  price?: number;   // last price
  mark?: number;    // (model) mark price at the event
  qty?: number;
  amount?: number;  // fee, funding, top-up or lost wallet (USDT)
  slot?: number;
  reason?: string;
}

export interface Sample {
  timeMs: number;
  wealth: number;       // freeCash + equity(mark)
  liqDistPct: number | null; // (mark − P_liq) / mark; null when flat
  qty: number;
}

export interface RunResult {
  path: PathId;
  status: BotStatus;
  liquidatedAtMs: number | null;
  startPrice: number | null;
  initialQty: number;
  startLiq: { current: number | null; fullGrid: number | null }; // right after start (plan §3.4.4)
  rounds: number;
  cycles: number;
  gridProfit: number;
  finalWallet: number;
  finalWealth: number;
  freeCash: number;
  totals: LedgerTotals;
  events: LedgerEvent[];
  samples: Sample[];        // full event stream (metrics are computed on this)
  maxInvariantError: number;
  skippedMinutes: number;   // minutes missing in last or mark
}

export type Verdict = 'not_started' | 'data_incomplete' | 'path_dependent' | 'liquidated' | 'borderline' | 'survived';
