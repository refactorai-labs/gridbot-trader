// Pionex backtester — what a run stores and shows (plan §5, §6). Pure function of the
// two path results: verdict (§6.1), metrics from the full sample stream, display
// series thinned to 5m (bucket minima kept), and the full event stream.

import { computeMetrics, decideVerdict, RunMetrics, thinSamples } from './metrics';
import { LedgerEvent, PathId, RunResult, Sample, Verdict } from './types';

export type RunSummary = Omit<RunResult, 'events' | 'samples'>;

export interface PathReport {
  summary: RunSummary;
  metrics: RunMetrics;
  skippedBuys: number;
  rejected: number; // start / top-up / restart / bot 2 rejections, cancellations, missed interventions
}

export interface EquityPoint { timeMs: number; wealth: number; liqDistPct: number | null; qty: number }
export interface LiqPoint { timeMs: number; liqPrices: (number | null)[] } // timeMs = 5m bucket start

export type ByPath<T> = Record<PathId, T>;

export interface PionexReport {
  verdict: Verdict;
  paths: ByPath<PathReport>;
  equity: ByPath<EquityPoint[]>;
  liqSeries: ByPath<LiqPoint[]>;
  events: ByPath<LedgerEvent[]>;
}

const REJECTED = new Set(['start_rejected', 'topup_rejected', 'topup_cancelled', 'restart_rejected', 'bot2_rejected', 'intervention_missed']);

function pathReport(r: RunResult): PathReport {
  const { events, samples, ...summary } = r;
  return {
    summary,
    metrics: computeMetrics(samples),
    skippedBuys: events.filter(e => e.type === 'buy_skipped').length,
    rejected: events.filter(e => REJECTED.has(e.type)).length,
  };
}

// Per-bot liquidation line from the FULL sample stream: for every 5m bucket, each
// bot's highest (most dangerous) P_liq. Built separately from the wealth thinning,
// which selects samples by total wealth / common distance and would drop a single
// bot's extremes (plan §5: the bucket extreme is kept).
export function liqSeriesByBucket(samples: Sample[], bucketMs = 300_000): LiqPoint[] {
  const out: LiqPoint[] = [];
  for (const s of samples) {
    const t = Math.floor(s.timeMs / bucketMs) * bucketMs;
    let cur = out[out.length - 1];
    if (!cur || cur.timeMs !== t) {
      cur = { timeMs: t, liqPrices: [] };
      out.push(cur);
    }
    s.liqPrices.forEach((p, b) => {
      const prev = cur.liqPrices[b] ?? null;
      cur.liqPrices[b] = p === null ? prev : prev === null ? p : Math.max(prev, p);
    });
  }
  return out;
}

export function buildReport(a: RunResult, b: RunResult, dataComplete: boolean): PionexReport {
  const thinA = thinSamples(a.samples);
  const thinB = thinSamples(b.samples);
  const equity = (s: typeof thinA) => s.map(({ timeMs, wealth, liqDistPct, qty }) => ({ timeMs, wealth, liqDistPct, qty }));
  return {
    verdict: decideVerdict(a, b, dataComplete),
    paths: { A: pathReport(a), B: pathReport(b) },
    equity: { A: equity(thinA), B: equity(thinB) },
    liqSeries: { A: liqSeriesByBucket(a.samples), B: liqSeriesByBucket(b.samples) },
    events: { A: a.events, B: b.events },
  };
}
