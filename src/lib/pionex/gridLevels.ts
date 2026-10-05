// Pionex backtester — grid levels and sizing (plan §3.1, §2/7).

import { BotState, GridMode, PionexBotConfig } from './types';

// n+1 ascending prices. Arithmetic: L + i·(U−L)/n; geometric: L·r^i, r = (U/L)^(1/n).
export function gridLevels(lower: number, upper: number, n: number, mode: GridMode): number[] {
  if (!(upper > lower) || lower <= 0 || n < 1) throw new Error('Invalid grid range');
  const r = Math.pow(upper / lower, 1 / n);
  return Array.from({ length: n + 1 }, (_, i) =>
    i === n ? upper : mode === 'arithmetic' ? lower + (i * (upper - lower)) / n : lower * Math.pow(r, i)
  );
}

// Notional per grid Q = I·lev/n (plan §3.1).
export const slotNotional = (bot: PionexBotConfig): number => (bot.investment * bot.leverage) / bot.gridCount;

// Band as % offsets from the start price (plan §2/7), e.g. (2728.77, -0.0667, 0.0404).
export function bandFromOffsets(startPrice: number, lowerPct: number, upperPct: number): { lower: number; upper: number } {
  return { lower: startPrice * (1 + lowerPct), upper: startPrice * (1 + upperPct) };
}

// Fresh grid state for a bot (or a new cycle): every slot waits as a limit buy.
export function newBotState(bot: PionexBotConfig): BotState {
  return {
    levels: gridLevels(bot.lower, bot.upper, bot.gridCount, bot.mode),
    slotQty: slotNotional(bot),
    held: Array(bot.gridCount).fill(null),
    wallet: 0,
    qty: 0,
    avgEntry: 0,
    status: 'active',
    rounds: 0,
    gridProfit: 0,
  };
}
