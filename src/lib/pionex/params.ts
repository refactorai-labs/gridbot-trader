// Pionex backtester — UI parameters → run request (plan §6), the equal-capital trio
// (§6.3) and the phase-0 gate windows. Percent inputs are in % (e.g. 0.02 = 0.02 %).

import type { BandOffsets, PionexRunPayload, PionexRunRequest } from './runStore';
import type { PionexRunConfig } from './types';

export interface PionexParams {
  bandMode: 'offset' | 'absolute';
  lowerPct: number;  // band offsets from the start price, % (plan §2/7)
  upperPct: number;
  lower: number;     // absolute override
  upper: number;
  gridCount: number;
  mode: 'arithmetic' | 'geometric';
  investment: number;
  extraMargin: number;
  leverage: number;
  capitalTotal: number | null; // null = I + E
  makerFeePct: number;
  takerFeePct: number;
  mmrPct: number;
  fundingOverridePct: number | null;
  marginCheck: boolean;
  cycleOn: boolean;
  tpPct: number;
  reinvestPct: number;
  topUpOn: boolean;
  topUpTriggerPct: number;
  topUpAmount: number;
  bot2On: boolean;
  bot2OffsetPct: number;
  bot2Mult: number;
  closeOn: boolean;
  closePrice: number;
}

// Preset: Bot A (plan §4.1) — 2546.9–2839 around 2728.77, 60 grids, 134.68 / 103.59, 15x.
export const BOT_A_PARAMS: PionexParams = {
  bandMode: 'offset',
  lowerPct: -6.665,
  upperPct: 4.04,
  lower: 2546.9,
  upper: 2839,
  gridCount: 60,
  mode: 'arithmetic',
  investment: 134.68,
  extraMargin: 103.59,
  leverage: 15,
  capitalTotal: null,
  makerFeePct: 0.02,
  takerFeePct: 0.05,
  mmrPct: 0.5,
  fundingOverridePct: null,
  marginCheck: true,
  cycleOn: false,
  tpPct: 5,
  reinvestPct: 50,
  topUpOn: false,
  topUpTriggerPct: 5,
  topUpAmount: 50,
  bot2On: false,
  bot2OffsetPct: 1,
  bot2Mult: 1,
  closeOn: false,
  closePrice: 2400,
};

// Trio defaults when the panel's rule is switched off (decision 1, phase 3).
const TRIO_TOPUP = { triggerPct: 0.05, amount: 50 };
const TRIO_BOT2 = { triggerOffsetPct: 0.01, capitalMultiplier: 1 };

const pct = (x: number) => x / 100;

export function toRunRequest(p: PionexParams, symbol: string, startMs: number, endMs: number, name?: string): PionexRunRequest {
  const band: BandOffsets | null = p.bandMode === 'offset' ? { lowerPct: pct(p.lowerPct), upperPct: pct(p.upperPct) } : null;
  const config: PionexRunConfig = {
    bot: {
      lower: p.lower, upper: p.upper, gridCount: p.gridCount, mode: p.mode,
      investment: p.investment, extraMargin: p.extraMargin, leverage: p.leverage,
    },
    costs: {
      makerFee: pct(p.makerFeePct), takerFee: pct(p.takerFeePct), mmr: pct(p.mmrPct),
      fundingRateOverride: p.fundingOverridePct === null ? null : pct(p.fundingOverridePct),
    },
    marginCheck: p.marginCheck,
    capitalTotal: p.capitalTotal ?? undefined,
    cycle: p.cycleOn ? { takeProfitPct: pct(p.tpPct), reinvestPct: pct(p.reinvestPct) } : null,
    topUp: p.topUpOn ? { triggerPct: pct(p.topUpTriggerPct), amount: p.topUpAmount } : null,
    bot2: p.bot2On ? { triggerOffsetPct: pct(p.bot2OffsetPct), capitalMultiplier: p.bot2Mult } : null,
    bot1ClosePrice: p.closeOn ? p.closePrice : undefined,
  };
  return { name, symbol, startMs, endMs, band, config };
}

// Same window and settings as a saved run (re-run of a stale report). Rows saved
// before the absent-key contract stored a switched-off fixed close as null.
export function rerunRequest(run: PionexRunPayload): PionexRunRequest {
  const config: PionexRunConfig = { ...run.config, bot1ClosePrice: run.config.bot1ClosePrice ?? undefined };
  return { name: run.name, symbol: run.symbol, startMs: run.startMs, endMs: run.endMs, band: run.band, config };
}

// Plan §6.3: same capitalTotal and window — (1) one bot, all reserve up front as E;
// (2) one bot, the panel's E, the rest topped up from the reserve; (3) two staggered
// bots. Cycle and fixed-close settings are shared.
export function trioRequests(p: PionexParams, symbol: string, startMs: number, endMs: number): PionexRunRequest[] {
  const total = p.capitalTotal ?? p.investment + p.extraMargin;
  const base = toRunRequest({ ...p, capitalTotal: total }, symbol, startMs, endMs);
  const named = (label: string, patch: Partial<PionexRunConfig>): PionexRunRequest => ({
    ...base,
    name: `trio: ${label} · ${symbol}`,
    config: { ...base.config, topUp: null, bot2: null, ...patch },
  });
  return [
    named('1 · all E up front', { bot: { ...base.config.bot, extraMargin: Math.max(0, total - p.investment) } }),
    named('2 · top-ups', { topUp: base.config.topUp ?? TRIO_TOPUP }),
    named('3 · two bots', { bot2: base.config.bot2 ?? TRIO_BOT2 }),
  ];
}

// Phase-0 gate windows (tasks/todo.md, Review / Fázis 0): 2022-05, 2022-11 and the
// deepest 2025 drop per symbol.
const D = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
export const GATE_WINDOWS: Record<string, { label: string; startMs: number; endMs: number }[]> = Object.fromEntries(
  ([
    ['ETHUSDT', [D(2025, 1, 4), D(2025, 2, 10)]],
    ['SOLUSDT', [D(2025, 1, 24), D(2025, 3, 4)]],
    ['BTCUSDT', [D(2025, 10, 25), D(2025, 11, 28)]],
  ] as const).map(([symbol, [s25, e25]]) => [symbol, [
    { label: '2022-05', startMs: D(2022, 5, 4), endMs: D(2022, 5, 20) },
    { label: '2022-11', startMs: D(2022, 11, 6), endMs: D(2022, 11, 24) },
    { label: '2025', startMs: s25, endMs: e25 },
  ]])
);
