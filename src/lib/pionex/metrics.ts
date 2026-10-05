// Pionex backtester — metrics and verdict (plan §6.1).
// Metrics come from the full event stream (every event and segment end); the
// 5m thinning is for display only and keeps each bucket's minimum.

import { RunResult, Sample, Verdict } from './types';

const HOUR_MS = 3_600_000;

export interface RunMetrics {
  minLiqDistPct: number | null;
  minLiqDistAtMs: number | null;
  maxDrawdownPct: number; // MTM, of the running wealth peak
  maxDrawdownAtMs: number | null;
  underwaterMs: number;   // total time below the running peak
  longestUnderwaterMs: number;
  recovered: boolean;     // wealth regained the peak before the max drawdown by the end
}

export function computeMetrics(samples: Sample[]): RunMetrics {
  let minLiq: number | null = null;
  let minLiqAt: number | null = null;
  let peak = -Infinity;
  let maxDd = 0;
  let maxDdAt: number | null = null;
  let maxDdPeak = 0;
  let recovered = true;
  let underwater = 0;
  let longest = 0;
  let stretch = 0;

  samples.forEach((s, i) => {
    if (s.liqDistPct !== null && (minLiq === null || s.liqDistPct < minLiq)) {
      minLiq = s.liqDistPct;
      minLiqAt = s.timeMs;
    }
    if (s.wealth >= peak) {
      peak = s.wealth;
      stretch = 0;
    } else {
      const dt = i + 1 < samples.length ? samples[i + 1].timeMs - s.timeMs : 0;
      underwater += dt;
      stretch += dt;
      longest = Math.max(longest, stretch);
      const dd = (peak - s.wealth) / peak;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdAt = s.timeMs;
        maxDdPeak = peak;
        recovered = false;
      }
    }
    if (!recovered && s.wealth >= maxDdPeak) recovered = true;
  });

  return {
    minLiqDistPct: minLiq,
    minLiqDistAtMs: minLiqAt,
    maxDrawdownPct: maxDd,
    maxDrawdownAtMs: maxDdAt,
    underwaterMs: underwater,
    longestUnderwaterMs: longest,
    recovered,
  };
}

// Plan §3.4.2: the run is path-dependent when survival, the liquidation time
// (± 1 hour) or the cycle count differs between path A and path B.
export function pathsDiffer(a: RunResult, b: RunResult): boolean {
  const liqA = a.status === 'liquidated';
  const liqB = b.status === 'liquidated';
  if (liqA !== liqB) return true;
  if (liqA && liqB && Math.abs((a.liquidatedAtMs ?? 0) - (b.liquidatedAtMs ?? 0)) > HOUR_MS) return true;
  return a.cycles !== b.cycles;
}

// Plan §6.1 priority: data-incomplete → path-dependent → liquidated → borderline → survived.
// A run whose bot never started (start_rejected or no data) has no survival claim
// and is reported as not-started — after data-incomplete, which stays the primary label.
// Borderline: survives on both paths but the minimum liquidation distance is below
// the largest deviation measured on the fixtures (default 2 %).
export function decideVerdict(
  a: RunResult,
  b: RunResult,
  dataComplete: boolean,
  borderlinePct = 0.02
): Verdict {
  const started = (r: RunResult) => r.events.some(e => e.type === 'start');
  if (!dataComplete) return 'data_incomplete';
  if (!started(a) || !started(b)) return 'not_started';
  if (pathsDiffer(a, b)) return 'path_dependent';
  if (a.status === 'liquidated') return 'liquidated';
  const dists = [computeMetrics(a.samples).minLiqDistPct, computeMetrics(b.samples).minLiqDistPct]
    .filter((x): x is number => x !== null);
  if (dists.length && Math.min(...dists) < borderlinePct) return 'borderline';
  return 'survived';
}

// Display thinning: per bucket keep the minimum-wealth sample, the minimum
// liquidation-distance sample and the last one, in time order (plan §5).
export function thinSamples(samples: Sample[], bucketMs = 300_000): Sample[] {
  const out: Sample[] = [];
  let i = 0;
  while (i < samples.length) {
    const bucket = Math.floor(samples[i].timeMs / bucketMs);
    let j = i;
    let minWealth = i;
    let minLiq = -1;
    while (j < samples.length && Math.floor(samples[j].timeMs / bucketMs) === bucket) {
      if (samples[j].wealth < samples[minWealth].wealth) minWealth = j;
      const dist = samples[j].liqDistPct;
      if (dist !== null && (minLiq < 0 || dist < samples[minLiq].liqDistPct!)) minLiq = j;
      j++;
    }
    const keep = new Set([minWealth, j - 1]);
    if (minLiq >= 0) keep.add(minLiq);
    Array.from(keep).sort((x, y) => x - y).forEach(k => out.push(samples[k]));
    i = j;
  }
  return out;
}
