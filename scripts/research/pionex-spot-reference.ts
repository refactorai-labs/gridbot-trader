// Research-only unborrowed cash/inventory reference, not a Pionex spot clone.
import assert from 'node:assert/strict';
import { gridLevels } from '../../src/lib/pionex/gridLevels';
import type { OHLC } from '../../src/lib/types';
import type { PionexRunConfig, PathId } from '../../src/lib/pionex/types';

type Lot = { qty: number; price: number; fee: number };
type Bot = { cash: number; basis: number; qty: number; cost: number; levels: number[]; lots: (Lot | null)[]; cycles: number; rounds: number; status: string; startTime: number };

export function runSpotReference(candles: OHLC[], config: PionexRunConfig, path: PathId) {
  const I = config.bot.investment;
  const fee = config.costs.makerFee;
  const total = config.capitalTotal ?? I * 2.02;
  let freeCash = total, withdrawn = 0, fees = 0, realized = 0, gridProfit = 0;
  let peak = total, maxDrawdownPct = 0, maxDrawdownUSDT = 0, minWealth = total;
  let maxInvariantError = 0, skippedBuys = 0, rejected = 0, peakQty = 0, peakNotional = 0;
  const bots: Bot[] = [];
  let pending: { cycle: boolean; bot2: boolean } | null = null;
  let attempted = false;
  const qty = (b: Bot) => b.qty;
  const value = (b: Bot, p: number) => b.cash + qty(b) * p;
  const sample = (p: number) => {
    const wealth = freeCash + withdrawn + bots.reduce((s, b) => s + value(b, p), 0);
    peak = Math.max(peak, wealth);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peak - wealth) / peak);
    maxDrawdownUSDT = Math.max(maxDrawdownUSDT, peak - wealth);
    minWealth = Math.min(minWealth, wealth);
    peakQty = Math.max(peakQty, bots.reduce((s, b) => s + qty(b), 0));
    peakNotional = Math.max(peakNotional, bots.reduce((s, b) => s + qty(b) * p, 0));
    const cost = bots.reduce((s, b) => s + b.cost, 0);
    const book = freeCash + withdrawn + bots.reduce((s, b) => s + b.cash, 0) + cost;
    maxInvariantError = Math.max(maxInvariantError, Math.abs(book - (total + realized - fees)));
    assert(bots.every(b => b.cash >= -1e-8), 'negative spot cash');
  };
  const buy = (b: Bot, slot: number, p: number) => {
    const n = I * (bots.indexOf(b) === 1 ? config.bot2?.capitalMultiplier ?? 1 : 1) / config.bot.gridCount;
    const f = n * fee;
    if (b.cash + 1e-10 < n + f) { skippedBuys++; return; }
    assert(!b.lots[slot], 'duplicate lot');
    b.cash -= n + f; fees += f;
    b.lots[slot] = { qty: n / p, price: p, fee: f };
    b.qty += n / p; b.cost += n;
    sample(p);
  };
  const sell = (b: Bot, slot: number, p: number, grid: boolean) => {
    const l = b.lots[slot];
    assert(l, 'sale without inventory');
    const proceeds = l.qty * p, f = proceeds * fee;
    b.cash += proceeds - f; fees += f; realized += l.qty * (p - l.price);
    b.qty -= l.qty; b.cost -= l.qty * l.price;
    if (Math.abs(b.qty) < 1e-12) { b.qty = 0; b.cost = 0; }
    if (grid) { b.rounds++; gridProfit += l.qty * (p - l.price) - l.fee - f; }
    b.lots[slot] = null; sample(p);
  };
  const seed = (b: Bot, p: number, lower: number, upper: number) => {
    b.levels = gridLevels(lower, upper, config.bot.gridCount, config.bot.mode);
    b.lots = Array(config.bot.gridCount).fill(null);
    for (let i = 0; i < b.lots.length; i++) if (b.levels[i] >= p) buy(b, i, p);
  };
  const start = (p: number, time: number, second: boolean) => {
    const mult = second ? config.bot2?.capitalMultiplier ?? 1 : 1;
    const amount = I * mult * 1.01; // separate 1% fee buffer; never borrowed
    if (freeCash + 1e-10 < amount) { rejected++; return; }
    freeCash -= amount;
    const b: Bot = { cash: amount, basis: amount, qty: 0, cost: 0, levels: [], lots: [], cycles: 0, rounds: 0, status: 'active', startTime: time };
    bots.push(b);
    if (!second) seed(b, p, config.bot.lower, config.bot.upper);
    else {
      const first = bots[0];
      const width = first.levels.at(-1)! - first.levels[0];
      seed(b, p, first.levels[0] - width, first.levels[0]);
    }
  };
  const segment = (from: number, to: number) => {
    sample(from);
    const orders: { b: Bot; slot: number; p: number }[] = [];
    for (const b of bots) {
      if (b.status !== 'active') continue;
      b.lots.forEach((l, i) => {
        const p = to >= from ? b.levels[i + 1] : b.levels[i];
        if (to >= from ? !!l && p > from && p <= to : !l && p < from && p >= to) orders.push({ b, slot: i, p });
      });
    }
    orders.sort((a, b) => to >= from ? a.p - b.p : b.p - a.p);
    for (const o of orders) to >= from ? sell(o.b, o.slot, o.p, true) : buy(o.b, o.slot, o.p);
    sample(to);
  };
  let previous: number | null = null;
  for (const c of candles) {
    if (previous !== null) segment(previous, c.open);
    if (!bots.length) start(c.open, c.timestamp * 1000, false);
    if (pending) {
      const b = bots[0];
      if (pending.cycle && b) {
        const lowerRatio = b.levels[0] / b.levels.at(-1)!;
        const upperRatio = config.bot.upper / candles[0].open;
        for (let i = 0; i < b.lots.length; i++) if (b.lots[i]) sell(b, i, c.open, false);
        const profit = b.cash - b.basis;
        const w = profit > 0 ? profit * (1 - config.cycle!.reinvestPct) : 0;
        b.cash -= w; withdrawn += w; b.basis = b.cash; b.cycles++;
        seed(b, c.open, c.open * upperRatio * lowerRatio, c.open * upperRatio);
      }
      if (pending.bot2) { attempted = true; start(c.open, c.timestamp * 1000, true); }
      pending = null; sample(c.open);
    }
    const points = path === 'A' ? [c.open, c.low, c.high, c.close] : [c.open, c.high, c.low, c.close];
    for (let i = 1; i < points.length; i++) segment(points[i - 1], points[i]);
    if ((c.timestamp + 60) % 300 === 0 && bots[0]) {
      const b = bots[0];
      const cycle = !!config.cycle && value(b, c.close) - qty(b) * c.close * fee - b.basis >= config.cycle.takeProfitPct * I;
      const bot2 = !!config.bot2 && !attempted && c.close < b.levels[0] * (1 - config.bot2.triggerOffsetPct);
      if (cycle || bot2) pending = { cycle, bot2 };
    }
    previous = c.close;
  }
  const end = candles.at(-1)?.close ?? 0;
  const finalWealth = freeCash + withdrawn + bots.reduce((s, b) => s + value(b, end), 0);
  const unrealized = bots.reduce((s, b) => s + b.lots.reduce((n, l) => n + (l ? l.qty * (end - l.price) : 0), 0), 0);
  return { finalWealth, returnPct: (finalWealth / total - 1) * 100, maxDrawdownPct, maxDrawdownUSDT, minWealth, fees, funding: 0, realized, unrealized, gridProfit, freeCash, withdrawn, peakQty, peakNotional, skippedBuys, rejected, maxInvariantError, bots: bots.map(b => ({ status: b.status, startTime: b.startTime, cash: b.cash, qty: qty(b), cycles: b.cycles, rounds: b.rounds })), rounds: bots.reduce((s, b) => s + b.rounds, 0), cycles: bots[0]?.cycles ?? 0, bothActive: bots.length === 2 && bots.every(b => b.status === 'active') };
}

export function validateSpotReference() {
  const c: OHLC = { timestamp: 0, open: 100, high: 110, low: 90, close: 110, volume: 0 };
  const cfg: PionexRunConfig = { bot: { lower: 90, upper: 110, gridCount: 2, mode: 'arithmetic', investment: 100, extraMargin: 0, leverage: 1 }, costs: { makerFee: 0.001, takerFee: 0.001, mmr: 0 }, marginCheck: true, capitalTotal: 200 };
  const r = runSpotReference([c], cfg, 'A');
  // Initial 50 at 100, limit 50 at 90, both sell at 110 and 100.
  const gross = 5 + 50 * (100 / 90 - 1);
  const expectedFees = 0.1 + 55 * 0.001 + (50 * 100 / 90) * 0.001;
  assert(Math.abs(r.finalWealth - (200 + gross - expectedFees)) < 1e-8);
  assert(Math.abs(r.fees - expectedFees) < 1e-8);
  assert(r.bots[0].qty === 0 && r.maxInvariantError < 1e-8);
  const shortCash = runSpotReference([c], { ...cfg, costs: { ...cfg.costs, makerFee: 0.02 } }, 'A');
  assert(shortCash.skippedBuys === 1 && shortCash.bots[0].cash >= 0 && shortCash.maxInvariantError < 1e-8);
  const cycle = runSpotReference([{ ...c, timestamp: 240, close: 110 }, { ...c, timestamp: 300, open: 110, low: 110, high: 110, close: 110 }], { ...cfg, cycle: { takeProfitPct: 0.01, reinvestPct: 0.2 } }, 'A');
  assert(cycle.cycles === 1 && cycle.withdrawn > 0 && cycle.maxInvariantError < 1e-8);
  console.log('Spot cash, round-trip fees, inventory and cycle invariant checks passed');
}
