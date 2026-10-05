// Pionex backtester — price segments, mark–last offset, liquidation as an event (plan §3.4.1).
//
// Mark–last rule: one offset per 1m candle, d = min(markO−lastO, markH−lastH,
// markL−lastL, markC−lastC); inside the candle the model mark is last + d. Grid
// fills happen at the last price; the mark at a fill is p + d. The liquidation
// threshold in last-price terms is T = P_liq − d. This rule is reproducible but
// NOT guaranteed conservative (plan §3.4.1).
//
// Fill convention: a downward segment X → Y fills buy levels in [Y, X); an upward
// segment fills sell levels in (X, Y]. Each segment starts where the previous one
// ended (inclusive), so a level touched exactly is filled once.

import { OHLC } from '../types';
import { PionexLedger } from './ledger';
import { currentLiqPrice } from './liquidation';
import { LedgerEvent, PionexCosts } from './types';

export interface StepContext {
  ledger: PionexLedger;
  costs: PionexCosts;
  leverage: number;
  marginCheck: boolean;
  timeMs: number;
  emit: (e: LedgerEvent) => void;
  sample: (mark: number) => void;
}

export const markLastOffset = (last: OHLC, mark: OHLC): number =>
  Math.min(mark.open - last.open, mark.high - last.high, mark.low - last.low, mark.close - last.close);

function liquidate(ctx: StepContext, price: number, mark: number): void {
  ctx.sample(mark); // the position at the liquidation point: distance ≤ 0 enters the metrics
  const lost = ctx.ledger.liquidate();
  ctx.emit({ type: 'liquidation', timeMs: ctx.timeMs, price, mark, amount: lost });
  ctx.sample(mark);
}

// Liquidation check with an actual mark price (segment ends, after funding and
// after every intervention — plan §3.4). Returns true when liquidated.
export function checkLiquidation(ctx: StepContext, lastPrice: number, mark: number): boolean {
  const bot = ctx.ledger.bot;
  if (bot.status !== 'active') return bot.status === 'liquidated';
  const pLiq = currentLiqPrice(bot, ctx.costs.mmr);
  if (pLiq !== null && mark <= pLiq) {
    liquidate(ctx, lastPrice, mark);
    return true;
  }
  return false;
}

// Plan §3.5: a buy fills only if equity(mark) − qty·avgEntry/lev ≥ Q/lev + fee,
// with qty/avgEntry of the open position only (closed lots and open limit orders
// reserve nothing). Approximation — Pionex's exact rule is unknown.
function marginShortfall(ctx: StepContext, mark: number): number {
  const { ledger, leverage, costs } = ctx;
  const bot = ledger.bot;
  const free = ledger.equity(mark) - (bot.qty * bot.avgEntry) / leverage;
  const need = bot.slotQty / leverage + bot.slotQty * costs.makerFee;
  return need - free;
}

// One straight price move from `from` to `to` (last prices) with offset d.
// Liquidation, distance and MTM all follow the model mark (last + d): the segment
// start is checked against it before any fill (the gap segment's start carries the
// new candle's d), and the segment end is sampled with it. `sampleStart` is only
// needed when the start point was not the previous segment's end under the same d.
// Returns true when the bot was liquidated inside the segment.
export function runSegment(ctx: StepContext, from: number, to: number, d: number, sampleStart = false): boolean {
  const bot = ctx.ledger.bot;
  if (bot.status !== 'active') return false;
  const startLiq = currentLiqPrice(bot, ctx.costs.mmr);
  if (startLiq !== null && from + d <= startLiq) {
    liquidate(ctx, from, from + d);
    return true;
  }
  if (sampleStart) ctx.sample(from + d);

  if (to >= from) {
    // Upward (or flat): sells in ascending order. Position shrinks while price
    // rises, so after the start check no liquidation can occur here (plan §3.4.1).
    for (let i = 0; i < bot.held.length; i++) {
      const sellPrice = bot.levels[i + 1];
      if (!bot.held[i] || sellPrice <= from || sellPrice > to) continue;
      const lot = ctx.ledger.sell(i, sellPrice, ctx.costs.makerFee);
      ctx.emit({ type: 'sell', timeMs: ctx.timeMs, price: sellPrice, mark: sellPrice + d, qty: lot.qty, slot: i });
      ctx.sample(sellPrice + d);
    }
    ctx.sample(to + d);
    return false;
  }

  // Downward: next event is the higher of the next buy level and T = P_liq − d.
  let cursor = from;
  for (;;) {
    let slot = -1;
    for (let i = bot.held.length - 1; i >= 0; i--) {
      const p = bot.levels[i];
      if (!bot.held[i] && p < cursor && p >= to) { slot = i; break; }
    }
    const pLiq = currentLiqPrice(bot, ctx.costs.mmr);
    const T = pLiq === null ? -Infinity : pLiq - d;
    const nextPrice = slot >= 0 ? bot.levels[slot] : to;
    if (T >= nextPrice) {
      const at = Math.min(T, cursor);
      liquidate(ctx, at, at + d);
      return true;
    }
    if (slot < 0) {
      ctx.sample(to + d);
      return false;
    }

    const p = bot.levels[slot];
    cursor = p;
    const shortfall = ctx.marginCheck ? marginShortfall(ctx, p + d) : 0;
    if (shortfall > 0) {
      ctx.emit({ type: 'buy_skipped', timeMs: ctx.timeMs, price: p, mark: p + d, slot, amount: shortfall, reason: 'insufficient margin' });
      continue;
    }
    const qty = bot.slotQty / p;
    const fee = ctx.ledger.buy(slot, qty, p, ctx.costs.makerFee);
    ctx.emit({ type: 'buy', timeMs: ctx.timeMs, price: p, mark: p + d, qty, slot, amount: fee });
    ctx.sample(p + d);
  }
}
