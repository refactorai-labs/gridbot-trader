// Pionex backtester — single long futures grid bot, 1m event engine (plan §3.3, §3.4).
//
// Pure function: (last1m, mark1m, funding, config, path) → RunResult.
// Fixed order for every 1m candle (plan §3.4):
//   1. opening-gap segment: previous last close → last open; check with mark open
//   2. funding, if a settlement falls in this minute bucket (paid at the actual
//      mark open); check with the model mark open
//   3. due interventions at the last open (start; Phase 1: hard-coded top-ups);
//      check with the model mark open after each
//   4. intra-candle segments along path A (O→L→H→C) or B (O→H→L→C); every segment
//      start is checked with the model mark (last + d), and every end also with the
//      candle's actual mark at that point (supplementary, plan §3.4.1)
// Samples (distance, MTM) always use the model mark last + d, so liquidation and
// the metrics follow the same modelled event stream.
//   5. on a 5m close: intervention rules (Phase 2 — none yet)
// A minute missing from either series is skipped, never filled in (plan §3.10).

import { OHLC } from '../types';
import { bucketFunding, fundingBucket, FundingRecord } from './funding';
import { gridLevels, slotNotional } from './gridLevels';
import { PionexLedger } from './ledger';
import { currentLiqPrice, fullGridLiqPrice, liqDistancePct } from './liquidation';
import { checkLiquidation, markLastOffset, runSegment, StepContext } from './segments';
import { BotState, LedgerEvent, PathId, PionexRunConfig, RunResult, Sample } from './types';

const MINUTE_MS = 60_000;

const PATH_POINTS: Record<PathId, (keyof Pick<OHLC, 'open' | 'high' | 'low' | 'close'>)[]> = {
  A: ['open', 'low', 'high', 'close'],
  B: ['open', 'high', 'low', 'close'],
};

export function runPionex(
  last1m: OHLC[],
  mark1m: OHLC[],
  funding: FundingRecord[],
  config: PionexRunConfig,
  path: PathId
): RunResult {
  const { bot: cfg, costs } = config;
  const levels = gridLevels(cfg.lower, cfg.upper, cfg.gridCount, cfg.mode);
  const bot: BotState = {
    levels,
    slotQty: slotNotional(cfg),
    held: Array(cfg.gridCount).fill(null),
    wallet: 0,
    qty: 0,
    avgEntry: 0,
    status: 'active',
    rounds: 0,
    gridProfit: 0,
  };
  const ledger = new PionexLedger(config.capitalTotal ?? cfg.investment + cfg.extraMargin, bot);
  const markByTs = new Map(mark1m.map(c => [c.timestamp, c]));
  const fundingByBucket = bucketFunding(funding);
  const topUps = config.scheduledTopUps ?? [];

  const events: LedgerEvent[] = [];
  const samples: Sample[] = [];
  let maxInvariantError = 0;
  let now = 0;

  const ctx: StepContext = {
    ledger,
    costs,
    leverage: cfg.leverage,
    marginCheck: config.marginCheck,
    timeMs: 0,
    emit: e => {
      events.push(e);
      maxInvariantError = Math.max(maxInvariantError, ledger.invariantError());
    },
    // Metrics use the full stream: every event and every segment end (plan §6.1).
    sample: mark => {
      samples.push({
        timeMs: now,
        wealth: ledger.freeCash + ledger.equity(mark),
        liqDistPct: liqDistancePct(mark, currentLiqPrice(bot, costs.mmr)),
        qty: bot.qty,
      });
    },
  };

  let startPrice: number | null = null;
  let initialQty = 0;
  let startLiq: RunResult['startLiq'] = { current: null, fullGrid: null };
  let prevClose: number | null = null;
  let liquidatedAtMs: number | null = null;
  let skippedMinutes = 0;
  let lastModelClose: number | null = null;

  for (const last of last1m) {
    const mark = markByTs.get(last.timestamp);
    if (!mark) { skippedMinutes++; continue; }
    now = ctx.timeMs = last.timestamp * 1000;
    const d = markLastOffset(last, mark);
    // Model mark at the open. d ≤ markO − lastO, so checking against it also covers
    // the actual mark open (plan §3.4), and the check and the sample use one price.
    const modelOpen = last.open + d;

    // 1. Opening-gap segment.
    if (prevClose !== null && !runSegment(ctx, prevClose, last.open, d, true)) {
      checkLiquidation(ctx, last.open, mark.open);
    }

    // 2. Funding (plan §3.4.3): bucket floor(fundingTime / 60s), mark open price.
    const settlement = fundingByBucket.get(fundingBucket(now));
    if (settlement && bot.status === 'active' && bot.qty > 0) {
      const rate = costs.fundingRateOverride ?? settlement.rate;
      const paid = ledger.funding(rate, mark.open);
      ctx.emit({ type: 'funding', timeMs: now, price: last.open, mark: mark.open, amount: paid, reason: `rate ${rate}` });
      if (!checkLiquidation(ctx, last.open, modelOpen)) ctx.sample(modelOpen);
    }

    // 3. Interventions at the last open (taker).
    if (startPrice === null) {
      startPrice = last.open;
      ctx.sample(modelOpen); // baseline: full capital before the start fees
      if (!startBot(ctx, last.open, config)) break;
      initialQty = bot.qty;
      startLiq = { current: currentLiqPrice(bot, costs.mmr), fullGrid: fullGridLiqPrice(bot, costs.mmr, costs.makerFee) };
      if (!checkLiquidation(ctx, last.open, modelOpen)) ctx.sample(modelOpen);
    }
    for (const t of topUps) {
      if (fundingBucket(t.atMs) !== fundingBucket(now)) continue;
      if (bot.status === 'liquidated') {
        ctx.emit({ type: 'topup_cancelled', timeMs: now, amount: t.amount, reason: 'already liquidated' });
      } else if (ledger.freeCash <= 0) {
        ctx.emit({ type: 'topup_rejected', timeMs: now, amount: t.amount, reason: 'no free cash' });
      } else {
        const moved = ledger.topUp(t.amount);
        ctx.emit({ type: 'topup', timeMs: now, price: last.open, mark: mark.open, amount: moved });
        if (!checkLiquidation(ctx, last.open, modelOpen)) ctx.sample(modelOpen);
      }
    }

    // 4. Intra-candle segments along the chosen path.
    const points = PATH_POINTS[path];
    for (let k = 1; k < points.length && bot.status === 'active'; k++) {
      if (runSegment(ctx, last[points[k - 1]], last[points[k]], d)) break;
      checkLiquidation(ctx, last[points[k]], mark[points[k]]);
    }

    // 5. 5m-close intervention rules: Phase 2.

    if (bot.status === 'liquidated') { liquidatedAtMs = now; break; }
    prevClose = last.close;
    lastModelClose = last.close + d;
  }

  // Closing sample at the end of the data so durations run to the window end.
  const lastBar = last1m[last1m.length - 1];
  if (lastBar) {
    now = lastBar.timestamp * 1000 + MINUTE_MS;
    if (bot.status === 'liquidated' || lastModelClose === null) {
      samples.push({ timeMs: now, wealth: ledger.freeCash + bot.wallet, liqDistPct: null, qty: 0 });
    } else {
      ctx.sample(lastModelClose);
    }
  }

  return {
    path,
    status: bot.status,
    liquidatedAtMs,
    startPrice,
    initialQty,
    startLiq,
    rounds: bot.rounds,
    cycles: 0,
    gridProfit: bot.gridProfit,
    finalWallet: bot.wallet,
    finalWealth: samples.length ? samples[samples.length - 1].wealth : ledger.freeCash,
    freeCash: ledger.freeCash,
    totals: { ...ledger.totals },
    events,
    samples,
    maxInvariantError,
    skippedMinutes,
  };
}

// Plan §3.3: I + E from the common capital; buy levels at/above the start price
// are bought at market (taker) at the start price, the rest wait as limit buys.
function startBot(ctx: StepContext, price: number, config: PionexRunConfig): boolean {
  const { ledger } = ctx;
  const bot = ledger.bot;
  const need = config.bot.investment + config.bot.extraMargin;
  if (!ledger.fund(need)) {
    bot.status = 'stopped';
    ctx.emit({ type: 'start_rejected', timeMs: ctx.timeMs, price, amount: need, reason: 'common capital below I + E' });
    return false;
  }
  let fees = 0;
  let k = 0;
  for (let i = 0; i < bot.held.length; i++) {
    if (bot.levels[i] < price) continue;
    fees += ledger.buy(i, bot.slotQty / price, price, config.costs.takerFee);
    k++;
  }
  ctx.emit({ type: 'start', timeMs: ctx.timeMs, price, qty: bot.qty, amount: fees, reason: `${k} grids bought at market` });
  return true;
}
