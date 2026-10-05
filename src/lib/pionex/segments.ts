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
//
// Several bots (plan §3.8) share one price path: inside a segment their events run
// merged in price order, so every sample sees all bots at the same price. Each bot
// has its own isolated margin; one bot's liquidation does not stop the others.

import { OHLC } from '../types';
import { PionexLedger } from './ledger';
import { currentLiqPrice } from './liquidation';
import { LedgerEvent, PionexCosts } from './types';

export interface StepContext {
  ledgers: PionexLedger[]; // index = bot id (0 = bot 1, 1 = bot 2)
  costs: PionexCosts;
  leverage: number;
  marginCheck: boolean;
  timeMs: number;
  emit: (e: LedgerEvent) => void;
  sample: (mark: number) => void;
}

export const markLastOffset = (last: OHLC, mark: OHLC): number =>
  Math.min(mark.open - last.open, mark.high - last.high, mark.low - last.low, mark.close - last.close);

const isActive = (l: PionexLedger) => l.bot.status === 'active';

function liquidate(ctx: StepContext, l: PionexLedger, price: number, mark: number): void {
  ctx.sample(mark); // the position at the liquidation point: distance ≤ 0 enters the metrics
  const lost = l.liquidate();
  ctx.emit({ type: 'liquidation', bot: ctx.ledgers.indexOf(l), timeMs: ctx.timeMs, price, mark, amount: lost });
  ctx.sample(mark);
}

// Liquidation check of every active bot with an actual mark price (segment ends,
// after funding and after every intervention — plan §3.4).
export function checkLiquidation(ctx: StepContext, lastPrice: number, mark: number): void {
  for (const l of ctx.ledgers) {
    if (!isActive(l)) continue;
    const pLiq = currentLiqPrice(l.bot, ctx.costs.mmr);
    if (pLiq !== null && mark <= pLiq) liquidate(ctx, l, lastPrice, mark);
  }
}

// Plan §3.5: a buy fills only if equity(mark) − qty·avgEntry/lev ≥ Q/lev + fee,
// with qty/avgEntry of the open position only (closed lots and open limit orders
// reserve nothing). Approximation — Pionex's exact rule is unknown.
function marginShortfall(ctx: StepContext, l: PionexLedger, mark: number): number {
  const { leverage, costs } = ctx;
  const bot = l.bot;
  const free = l.equity(mark) - (bot.qty * bot.avgEntry) / leverage;
  const need = bot.slotQty / leverage + bot.slotQty * costs.makerFee;
  return need - free;
}

// One straight price move from `from` to `to` (last prices) with offset d, for every
// active bot. Liquidation, distance and MTM all follow the model mark (last + d): the
// segment start is checked against it before any fill (the gap segment's start carries
// the new candle's d), and the segment end is sampled with it. `sampleStart` is only
// needed when the start point was not the previous segment's end under the same d.
export function runSegment(ctx: StepContext, from: number, to: number, d: number, sampleStart = false): void {
  for (const l of ctx.ledgers) {
    if (!isActive(l)) continue;
    const startLiq = currentLiqPrice(l.bot, ctx.costs.mmr);
    if (startLiq !== null && from + d <= startLiq) liquidate(ctx, l, from, from + d);
  }
  if (!ctx.ledgers.some(isActive)) return;
  if (sampleStart) ctx.sample(from + d);

  if (to >= from) {
    // Upward (or flat): sells in ascending price order across bots. Positions shrink
    // while price rises, so after the start check no liquidation can occur here (plan §3.4.1).
    const sells: { l: PionexLedger; slot: number; price: number }[] = [];
    for (const l of ctx.ledgers) {
      if (!isActive(l)) continue;
      l.bot.held.forEach((lot, i) => {
        const price = l.bot.levels[i + 1];
        if (lot && price > from && price <= to) sells.push({ l, slot: i, price });
      });
    }
    sells.sort((a, b) => a.price - b.price); // stable: equal prices keep bot order
    for (const { l, slot, price } of sells) {
      const lot = l.sell(slot, price, ctx.costs.makerFee);
      ctx.emit({ type: 'sell', bot: ctx.ledgers.indexOf(l), timeMs: ctx.timeMs, price, mark: price + d, qty: lot.qty, slot });
      ctx.sample(price + d);
    }
    ctx.sample(to + d);
    return;
  }

  // Downward: per bot, the next event is the higher of its next buy level and
  // T = P_liq − d (liquidation when T ≥ that level, or ≥ `to` without one). Across
  // bots the highest event runs first; on a tie liquidation goes first. Each bot keeps
  // its own cursor, so a level shared by two bots fills for both.
  const cursors = ctx.ledgers.map(() => from);
  for (;;) {
    let next: { l: PionexLedger; slot: number; price: number; liq: boolean } | null = null;
    for (let id = 0; id < ctx.ledgers.length; id++) {
      const l = ctx.ledgers[id];
      if (!isActive(l)) continue;
      const bot = l.bot;
      const cursor = cursors[id];
      let slot = -1;
      for (let i = bot.held.length - 1; i >= 0; i--) {
        const p = bot.levels[i];
        if (!bot.held[i] && p < cursor && p >= to) { slot = i; break; }
      }
      const pLiq = currentLiqPrice(bot, ctx.costs.mmr);
      const T = pLiq === null ? -Infinity : pLiq - d;
      const level = slot >= 0 ? bot.levels[slot] : to;
      const ev = T >= level
        ? { l, slot: -1, price: Math.min(T, cursor), liq: true }
        : slot >= 0 ? { l, slot, price: level, liq: false } : null;
      if (ev && (!next || ev.price > next.price || (ev.price === next.price && ev.liq && !next.liq))) next = ev;
    }
    if (!next) break;

    const { l, slot, price: p } = next;
    if (next.liq) {
      liquidate(ctx, l, p, p + d);
      if (!ctx.ledgers.some(isActive)) return;
      continue;
    }
    const id = ctx.ledgers.indexOf(l);
    cursors[id] = p;
    const shortfall = ctx.marginCheck ? marginShortfall(ctx, l, p + d) : 0;
    if (shortfall > 0) {
      ctx.emit({ type: 'buy_skipped', bot: id, timeMs: ctx.timeMs, price: p, mark: p + d, slot, amount: shortfall, reason: 'insufficient margin' });
      continue;
    }
    const qty = l.bot.slotQty / p;
    const fee = l.buy(slot, qty, p, ctx.costs.makerFee);
    ctx.emit({ type: 'buy', bot: id, timeMs: ctx.timeMs, price: p, mark: p + d, qty, slot, amount: fee });
    ctx.sample(p + d);
  }
  ctx.sample(to + d);
}
