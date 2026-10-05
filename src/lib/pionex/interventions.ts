// Pionex backtester — intervention rules and their fixed execution order (plan §3.6–§3.8).
//
// Rules are evaluated on a closed 5m candle (the 1m candle with (t + 60s) % 300s == 0)
// and executed on the next 1m open at the last open price (taker), in this order (§3.8):
//   1. closes: fixed close price (permanent stop) first, otherwise the TP close (cycle)
//   2. top-ups of still-open bots (a closing bot's top-up is cancelled)
//   3. restart after a TP, from the bot's own returned money (never from freeCash)
//   4. start of bot 2 from the remaining freeCash (one attempt)
// After every step: liquidation check with the model mark open (plan §3.4 / 3.).

import { OHLC } from '../types';
import { newBotState } from './gridLevels';
import { PionexLedger } from './ledger';
import { currentLiqPrice, fullGridLiqPrice } from './liquidation';
import { StepContext } from './segments';
import { LiqLevels, PionexBotConfig, PionexRunConfig } from './types';

const FIVE_MIN_MS = 300_000;

export interface BotRun {
  ledger: PionexLedger;
  cfg: PionexBotConfig;  // band of the current cycle; extraMargin = E_start of the cycle
  cycleTopUps: number;   // Σ top-ups in the current cycle (stay with the bot, plan §3.6)
  startPrice: number | null; // first start
  cycles: number;
  liquidatedAtMs: number | null;
  startLiq: LiqLevels | null; // right after the first start (plan §3.4.4)
}

export interface Pending {
  dueMs: number | null; // the 1m open the interventions must run on (null = nothing due)
  fixedClose: boolean;
  tpClose: boolean;
  topUps: { bot: number; amount: number }[];
  bot2: boolean;
}

export const emptyPending = (): Pending => ({ dueMs: null, fixedClose: false, tpClose: false, topUps: [], bot2: false });

export const describePending = (p: Pending): string =>
  [p.fixedClose && 'fixed close', p.tpClose && 'TP close', ...p.topUps.map(t => `top-up bot ${t.bot + 1}`), p.bot2 && 'bot 2 start']
    .filter(Boolean).join(', ');

export const closesFiveMinute = (openMs: number): boolean => (openMs + 60_000) % FIVE_MIN_MS === 0;

// Plan §3.6: cycle settlement after the TP close. basis = I + E_start + Σ cycle top-ups.
//   profit > 0: E_next = E_start + top-ups + reinvest·profit; withdraw (1 − reinvest)·profit
//   profit ≤ 0: E_next = E_start + top-ups + profit (the loss comes out of E); no withdrawal
// The restart budget I + E_next is the bot's own returned money minus the withdrawal.
export function settleCycle(investment: number, eStart: number, cycleTopUps: number, wallet: number, reinvestPct: number) {
  const profit = wallet - (investment + eStart + cycleTopUps);
  const withdraw = profit > 0 ? (1 - reinvestPct) * profit : 0;
  const eNext = eStart + cycleTopUps + (profit > 0 ? reinvestPct * profit : profit);
  return { profit, eNext, withdraw, canRestart: eNext >= 0 }; // I + E_next ≥ I
}

// Current position and full-grid P_liq of a bot (plan §3.4.4).
export const liqLevels = (l: PionexLedger, config: PionexRunConfig): LiqLevels => ({
  current: currentLiqPrice(l.bot, config.costs.mmr),
  fullGrid: fullGridLiqPrice(l.bot, config.costs.mmr, config.costs.makerFee),
});

// Plan §3.3: buy levels at/above the price at market (taker) — the bot's wallet is
// already funded. Emits `start` (or `restart`).
export function startBot(ctx: StepContext, l: PionexLedger, price: number, takerFee: number, type: 'start' | 'restart'): void {
  const bot = l.bot;
  let fees = 0;
  let k = 0;
  for (let i = 0; i < bot.held.length; i++) {
    if (bot.levels[i] < price) continue;
    fees += l.buy(i, bot.slotQty / price, price, takerFee);
    k++;
  }
  ctx.emit({ type, bot: ctx.ledgers.indexOf(l), timeMs: ctx.timeMs, price, qty: bot.qty, amount: fees, reason: `${k} grids bought at market` });
}

// Rules on a closed 5m candle (last close, actual mark close).
export function evaluateRules(runs: BotRun[], config: PionexRunConfig, last: OHLC, mark: OHLC, bot2Attempted: boolean, dueMs: number): Pending {
  const p = emptyPending();
  const bot1 = runs[0];
  const active = (r: BotRun) => r.ledger.bot.status === 'active';
  if (!bot1 || bot1.startPrice === null) return p;
  const takerFee = config.costs.takerFee;

  if (active(bot1)) {
    // §3.8 fixed close price: permanent stop of bot 1.
    if (config.bot1ClosePrice != null && last.close <= config.bot1ClosePrice) p.fixedClose = true;
    // §3.6 TP: netIfClosed = equity(last close) − qty·close·taker − (I + E_start + Σ cycle top-ups).
    if (config.cycle) {
      const b = bot1.ledger.bot;
      const net = bot1.ledger.equity(last.close) - b.qty * last.close * takerFee -
        (bot1.cfg.investment + bot1.cfg.extraMargin + bot1.cycleTopUps);
      if (net >= config.cycle.takeProfitPct * bot1.cfg.investment) p.tpClose = true;
    }
  }

  // §3.7 top-up: (markClose − P_liq) / markClose < triggerPct, every open bot.
  if (config.topUp) {
    runs.forEach((r, i) => {
      if (!active(r)) return;
      const pLiq = currentLiqPrice(r.ledger.bot, config.costs.mmr);
      if (pLiq !== null && (mark.close - pLiq) / mark.close < config.topUp!.triggerPct) {
        p.topUps.push({ bot: i, amount: config.topUp!.amount });
      }
    });
  }

  // §3.8 bot 2: close < L1 · (1 − offset), L1 = bot 1's current lower bound; one attempt,
  // independent of bot 1's status.
  if (config.bot2 && !bot2Attempted && last.close < bot1.ledger.bot.levels[0] * (1 - config.bot2.triggerOffsetPct)) {
    p.bot2 = true;
  }
  if (describePending(p)) p.dueMs = dueMs; // only an actually pending intervention has a due minute
  return p;
}

// Executes the due interventions at the last open in the §3.8 order. `check` runs the
// liquidation check (and the sample) after every step. Returns bot 2's run if it started.
export function executePending(
  ctx: StepContext,
  runs: BotRun[],
  pending: Pending,
  config: PionexRunConfig,
  price: number,
  mark: number,
  check: () => void
): BotRun | null {
  const takerFee = config.costs.takerFee;
  const bot1 = runs[0];
  const closing = new Set<number>();
  let restart: ReturnType<typeof settleCycle> | null = null;

  // 1. Closes. The fixed close wins over a TP due at the same open (it is permanent).
  if ((pending.fixedClose || pending.tpClose) && bot1.ledger.bot.status === 'active') {
    const l = bot1.ledger;
    const fee = l.close(price, takerFee);
    closing.add(0);
    if (pending.fixedClose) {
      ctx.emit({ type: 'close', bot: 0, timeMs: ctx.timeMs, price, mark, amount: fee, reason: 'fixed close price' });
      l.bot.status = 'stopped';
      l.release();
    } else {
      ctx.emit({ type: 'close', bot: 0, timeMs: ctx.timeMs, price, mark, amount: fee, reason: 'take profit' });
      restart = settleCycle(bot1.cfg.investment, bot1.cfg.extraMargin, bot1.cycleTopUps, l.bot.wallet, config.cycle!.reinvestPct);
      l.capital.withdraw(restart.withdraw);
      l.bot.wallet -= restart.withdraw;
      bot1.cycles++;
      ctx.emit({
        type: 'cycle', bot: 0, timeMs: ctx.timeMs, amount: restart.profit,
        reason: `cycle ${bot1.cycles}: E_next ${restart.eNext}, withdrawn ${restart.withdraw}`,
      });
    }
    check();
  }

  // 2. Top-ups of still-open bots (protect existing positions before new exposure).
  for (const t of pending.topUps) {
    const r = runs[t.bot];
    const l = r.ledger;
    if (l.bot.status === 'liquidated') {
      ctx.emit({ type: 'topup_cancelled', bot: t.bot, timeMs: ctx.timeMs, amount: t.amount, reason: 'already liquidated' });
    } else if (closing.has(t.bot) || l.bot.status !== 'active') {
      ctx.emit({ type: 'topup_cancelled', bot: t.bot, timeMs: ctx.timeMs, amount: t.amount, reason: 'bot closing' });
    } else if (l.freeCash <= 0) {
      ctx.emit({ type: 'topup_rejected', bot: t.bot, timeMs: ctx.timeMs, amount: t.amount, reason: 'no free cash' });
    } else {
      const moved = l.topUp(t.amount);
      r.cycleTopUps += moved;
      ctx.emit({ type: 'topup', bot: t.bot, timeMs: ctx.timeMs, price, mark, amount: moved });
      check();
    }
  }

  // 3. Restart after the TP, from the bot's own money (I + E_next), same 1m open.
  if (restart) {
    const l = bot1.ledger;
    if (!restart.canRestart) {
      ctx.emit({ type: 'restart_rejected', bot: 0, timeMs: ctx.timeMs, price, amount: l.bot.wallet, reason: 'returned money below I' });
      l.bot.status = 'stopped';
      l.release();
    } else {
      // Decision 1 (Phase 2): the new cycle re-centres the band with the initial % offsets.
      const ratio = price / bot1.startPrice!;
      const first = config.bot;
      bot1.cfg = { ...bot1.cfg, lower: first.lower * ratio, upper: first.upper * ratio, extraMargin: restart.eNext };
      bot1.cycleTopUps = 0;
      const fresh = newBotState(bot1.cfg);
      Object.assign(l.bot, { levels: fresh.levels, slotQty: fresh.slotQty, held: fresh.held });
      startBot(ctx, l, price, takerFee, 'restart');
    }
    check();
  }

  // 4. Bot 2 from the remaining freeCash: band [L1 − (U1 − L1), L1], I2 = I1·m, E2 = E1·m.
  if (pending.bot2) {
    const m = config.bot2!.capitalMultiplier;
    const levels1 = bot1.ledger.bot.levels;
    const l1 = levels1[0];
    const width = levels1[levels1.length - 1] - l1;
    const cfg2: PionexBotConfig = {
      ...config.bot, lower: l1 - width, upper: l1,
      investment: config.bot.investment * m, extraMargin: config.bot.extraMargin * m,
    };
    const need = cfg2.investment + cfg2.extraMargin;
    if (cfg2.lower <= 0) {
      ctx.emit({ type: 'bot2_rejected', bot: 1, timeMs: ctx.timeMs, price, amount: need, reason: 'band below zero' });
      return null;
    }
    const l = new PionexLedger(bot1.ledger.capital, newBotState(cfg2));
    if (!l.fund(need)) {
      ctx.emit({ type: 'bot2_rejected', bot: 1, timeMs: ctx.timeMs, price, amount: need, reason: 'free cash below I2 + E2' });
      return null;
    }
    ctx.ledgers.push(l);
    const run: BotRun = { ledger: l, cfg: cfg2, cycleTopUps: 0, startPrice: price, cycles: 0, liquidatedAtMs: null, startLiq: null };
    runs.push(run);
    startBot(ctx, l, price, takerFee, 'start');
    run.startLiq = liqLevels(l, config);
    check();
    return run;
  }
  return null;
}
