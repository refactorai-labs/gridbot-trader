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

export interface CycleRule {
  takeProfitPct: number; // TP when netIfClosed ≥ takeProfitPct · I (plan §3.6)
  reinvestPct: number;   // share of a positive cycle profit added to E_next; the rest is withdrawn
}

export interface TopUpRule {
  triggerPct: number; // (markClose − P_liq) / markClose below this → top-up (plan §3.7)
  amount: number;
}

export interface Bot2Rule {
  triggerOffsetPct: number;  // 5m close < L1 · (1 − offset) (plan §3.8)
  capitalMultiplier: number; // I2 = I1 · m, E2 = E1 · m
}

export interface PionexRunConfig {
  bot: PionexBotConfig;
  costs: PionexCosts;
  marginCheck: boolean;   // plan §3.5 (default on)
  capitalTotal?: number;  // fixed common capital; default I + E (plan §3.7)
  cycle?: CycleRule | null;       // bot 1 only (plan §3.6)
  topUp?: TopUpRule | null;       // every open bot (plan §3.7)
  bot2?: Bot2Rule | null;         // staggered second bot (plan §3.8)
  bot1ClosePrice?: number;        // permanent stop of bot 1 (plan §3.8); absent = off
  // Test hook: hard-coded top-ups on bot 1, executed with the due top-ups (plan §4.3).
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
  | 'close'
  | 'cycle'
  | 'restart'
  | 'restart_rejected'
  | 'bot2_rejected'
  | 'intervention_missed'
  | 'liquidation';

export interface LedgerEvent {
  type: LedgerEventType;
  bot?: number;     // 0 = bot 1, 1 = bot 2
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
  wealth: number;       // freeCash + withdrawn + Σ equity(mark)
  liqDistPct: number | null; // min over bots of (mark − P_liq) / mark; null when all flat
  qty: number;          // total over bots
  liqPrices: (number | null)[]; // current P_liq per bot (null when flat), chart lines
}

export interface LiqLevels { current: number | null; fullGrid: number | null } // plan §3.4.4

export interface BotSummary {
  status: BotStatus;
  liquidatedAtMs: number | null;
  startPrice: number | null; // first start
  lower: number;             // current (last) band
  upper: number;
  rounds: number;
  gridProfit: number;
  cycles: number;
  wallet: number;
  startLiq: LiqLevels | null; // right after the bot's first start
  endLiq: LiqLevels | null;   // at the end of the window; null unless still active
}

// Top-level fields describe the run: status/liquidatedAtMs = the first liquidation of
// any bot (otherwise bot 1's status); rounds, gridProfit, finalWallet = sums over bots;
// cycles, startPrice, initialQty, startLiq = bot 1. Per-bot details in `bots`.
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
  withdrawn: number;
  bots: BotSummary[];
  totals: LedgerTotals;
  events: LedgerEvent[];
  samples: Sample[];        // full event stream (metrics are computed on this)
  maxInvariantError: number;
  skippedMinutes: number;   // minutes missing in last or mark
}

export type Verdict = 'not_started' | 'data_incomplete' | 'path_dependent' | 'liquidated' | 'borderline' | 'survived';
