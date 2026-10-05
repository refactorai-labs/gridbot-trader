// Pionex backtester — long futures grid bots, 1m event engine (plan §3.3, §3.4, §3.6–§3.8).
//
// Pure function: (last1m, mark1m, funding, config, path) → RunResult.
// Fixed order for every 1m candle (plan §3.4):
//   1. opening-gap segment: previous last close → last open; check with mark open
//   2. funding, if a settlement falls in this minute bucket (paid at the actual
//      mark open); check with the model mark open
//   3. due interventions at the last open: the start, then the §3.8 order (closes →
//      top-ups → restart → bot 2); check with the model mark open after each
//   4. intra-candle segments along path A (O→L→H→C) or B (O→H→L→C); every segment
//      start is checked with the model mark (last + d), and every end also with the
//      candle's actual mark at that point (supplementary, plan §3.4.1)
//   5. on a 5m close: intervention rules (§3.6–§3.8), executed at the next 1m open
// Samples (distance, MTM) always use the model mark last + d, so liquidation and
// the metrics follow the same modelled event stream. All bots share the price path
// and the common capital; their events inside a segment run merged in price order.
// A minute missing from either series is skipped, never filled in (plan §3.10).

import { OHLC } from '../types';
import { Capital } from './capital';
import { bucketFunding, fundingBucket, FundingRecord } from './funding';
import { newBotState } from './gridLevels';
import { BotRun, closesFiveMinute, describePending, emptyPending, evaluateRules, executePending, Pending, startBot } from './interventions';
import { PionexLedger } from './ledger';
import { currentLiqPrice, fullGridLiqPrice, liqDistancePct } from './liquidation';
import { checkLiquidation, markLastOffset, runSegment, StepContext } from './segments';
import { LedgerEvent, PathId, PionexRunConfig, RunResult, Sample } from './types';

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
  const capital = new Capital(config.capitalTotal ?? cfg.investment + cfg.extraMargin);
  const bot1: BotRun = {
    ledger: new PionexLedger(capital, newBotState(cfg)),
    cfg,
    cycleTopUps: 0,
    startPrice: null,
    cycles: 0,
    liquidatedAtMs: null,
  };
  const runs: BotRun[] = [bot1];
  const markByTs = new Map(mark1m.map(c => [c.timestamp, c]));
  const fundingByBucket = bucketFunding(funding);
  const topUps = config.scheduledTopUps ?? [];

  const events: LedgerEvent[] = [];
  const samples: Sample[] = [];
  let maxInvariantError = 0;
  let now = 0;
  const sumWallets = () => runs.reduce((s, r) => s + r.ledger.bot.wallet, 0);

  const ctx: StepContext = {
    ledgers: [bot1.ledger],
    costs,
    leverage: cfg.leverage,
    marginCheck: config.marginCheck,
    timeMs: 0,
    emit: e => {
      events.push(e);
      maxInvariantError = Math.max(maxInvariantError, capital.invariantError(sumWallets()));
    },
    // Metrics use the full stream: every event and every segment end (plan §6.1).
    sample: mark => {
      let wealth = capital.freeCash + capital.withdrawn;
      let liqDistPct: number | null = null;
      let qty = 0;
      for (const r of runs) {
        const b = r.ledger.bot;
        wealth += r.ledger.equity(mark);
        qty += b.qty;
        const dist = liqDistancePct(mark, currentLiqPrice(b, costs.mmr));
        if (dist !== null && (liqDistPct === null || dist < liqDistPct)) liqDistPct = dist;
      }
      samples.push({ timeMs: now, wealth, liqDistPct, qty });
    },
  };
  const anyActive = () => runs.some(r => r.ledger.bot.status === 'active');
  // Liquidation check after a step, then a sample of the new state — also when no bot
  // is left open (a final close returns money). Skipped only when this check itself
  // liquidated, as the liquidation has already sampled its point (plan §6.1).
  const liquidations = () => runs.filter(r => r.ledger.bot.status === 'liquidated').length;
  const checkAndSample = (price: number, modelMark: number) => {
    const before = liquidations();
    checkLiquidation(ctx, price, modelMark);
    if (liquidations() === before) ctx.sample(modelMark);
  };

  let initialQty = 0;
  let startLiq: RunResult['startLiq'] = { current: null, fullGrid: null };
  let prevClose: number | null = null;
  let skippedMinutes = 0;
  let lastModelClose: number | null = null;
  let pending: Pending = emptyPending();
  let bot2Attempted = false;

  for (const last of last1m) {
    const mark = markByTs.get(last.timestamp);
    if (!mark) { skippedMinutes++; continue; }
    now = ctx.timeMs = last.timestamp * 1000;
    const d = markLastOffset(last, mark);
    // Model mark at the open. d ≤ markO − lastO, so checking against it also covers
    // the actual mark open (plan §3.4), and the check and the sample use one price.
    const modelOpen = last.open + d;

    // 1. Opening-gap segment.
    if (prevClose !== null) {
      runSegment(ctx, prevClose, last.open, d, true);
      checkLiquidation(ctx, last.open, mark.open);
    }

    // 2. Funding (plan §3.4.3): bucket floor(fundingTime / 60s), mark open price.
    const settlement = fundingByBucket.get(fundingBucket(now));
    if (settlement) {
      const rate = costs.fundingRateOverride ?? settlement.rate;
      let paidAny = false;
      runs.forEach((r, i) => {
        const l = r.ledger;
        if (l.bot.status !== 'active' || l.bot.qty <= 0) return;
        const paid = l.funding(rate, mark.open);
        ctx.emit({ type: 'funding', bot: i, timeMs: now, price: last.open, mark: mark.open, amount: paid, reason: `rate ${rate}` });
        paidAny = true;
      });
      if (paidAny) checkAndSample(last.open, modelOpen);
    }

    // 3. Interventions at the last open (taker).
    if (bot1.startPrice === null) {
      bot1.startPrice = last.open;
      ctx.sample(modelOpen); // baseline: full capital before the start fees
      const need = cfg.investment + cfg.extraMargin;
      if (!bot1.ledger.fund(need)) {
        bot1.ledger.bot.status = 'stopped';
        ctx.emit({ type: 'start_rejected', bot: 0, timeMs: now, price: last.open, amount: need, reason: 'common capital below I + E' });
        break;
      }
      startBot(ctx, bot1.ledger, last.open, costs.takerFee, 'start');
      initialQty = bot1.ledger.bot.qty;
      startLiq = {
        current: currentLiqPrice(bot1.ledger.bot, costs.mmr),
        fullGrid: fullGridLiqPrice(bot1.ledger.bot, costs.mmr, costs.makerFee),
      };
      checkAndSample(last.open, modelOpen);
    }
    // Plan §3.4/§3.8: interventions run on the 1m open right after the 5m close. If that
    // minute is missing, they are dropped with an event (never run on another minute);
    // the rules are evaluated again on the next 5m close.
    if (pending.dueMs !== null && pending.dueMs !== now) {
      ctx.emit({ type: 'intervention_missed', bot: 0, timeMs: now, reason: `execution minute ${new Date(pending.dueMs).toISOString()} missing: ${describePending(pending)}` });
      pending = emptyPending();
    }
    for (const t of topUps) {
      if (fundingBucket(t.atMs) === fundingBucket(now)) pending.topUps.push({ bot: 0, amount: t.amount });
    }
    if (pending.bot2) bot2Attempted = true;
    executePending(ctx, runs, pending, config, last.open, mark.open, () => checkAndSample(last.open, modelOpen));
    pending = emptyPending();

    // 4. Intra-candle segments along the chosen path.
    const points = PATH_POINTS[path];
    for (let k = 1; k < points.length && anyActive(); k++) {
      runSegment(ctx, last[points[k - 1]], last[points[k]], d);
      checkLiquidation(ctx, last[points[k]], mark[points[k]]);
    }

    for (const r of runs) {
      if (r.ledger.bot.status === 'liquidated' && r.liquidatedAtMs === null) r.liquidatedAtMs = now;
    }

    // 5. 5m-close intervention rules, executed at the next 1m open.
    if (closesFiveMinute(now)) pending = evaluateRules(runs, config, last, mark, bot2Attempted, now + MINUTE_MS);

    // Stop once no bot is open and none can start any more.
    const bot2Possible = !!config.bot2 && !bot2Attempted;
    if (!anyActive() && !bot2Possible) break;
    prevClose = last.close;
    lastModelClose = last.close + d;
  }

  // Closing sample at the end of the data so durations run to the window end.
  const lastBar = last1m[last1m.length - 1];
  if (lastBar) {
    now = lastBar.timestamp * 1000 + MINUTE_MS;
    if (!anyActive() || lastModelClose === null) {
      samples.push({ timeMs: now, wealth: capital.freeCash + capital.withdrawn + sumWallets(), liqDistPct: null, qty: 0 });
    } else {
      ctx.sample(lastModelClose);
    }
  }

  const liqTimes = runs.map(r => r.liquidatedAtMs).filter((t): t is number => t !== null);
  const sum = (f: (r: BotRun) => number) => runs.reduce((s, r) => s + f(r), 0);
  return {
    path,
    status: liqTimes.length ? 'liquidated' : bot1.ledger.bot.status,
    liquidatedAtMs: liqTimes.length ? Math.min(...liqTimes) : null,
    startPrice: bot1.startPrice,
    initialQty,
    startLiq,
    rounds: sum(r => r.ledger.bot.rounds),
    cycles: bot1.cycles,
    gridProfit: sum(r => r.ledger.bot.gridProfit),
    finalWallet: sumWallets(),
    finalWealth: samples.length ? samples[samples.length - 1].wealth : capital.freeCash,
    freeCash: capital.freeCash,
    withdrawn: capital.withdrawn,
    bots: runs.map(r => ({
      status: r.ledger.bot.status,
      liquidatedAtMs: r.liquidatedAtMs,
      startPrice: r.startPrice,
      lower: r.ledger.bot.levels[0],
      upper: r.ledger.bot.levels[r.ledger.bot.levels.length - 1],
      rounds: r.ledger.bot.rounds,
      gridProfit: r.ledger.bot.gridProfit,
      cycles: r.cycles,
      wallet: r.ledger.bot.wallet,
    })),
    totals: { ...capital.totals },
    events,
    samples,
    maxInvariantError,
    skippedMinutes,
  };
}
