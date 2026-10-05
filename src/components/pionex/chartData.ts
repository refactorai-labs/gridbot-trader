// Main chart overlays for one path (plan §6.4). 1m events snap to their 5m candle;
// the original minute is kept in the marker text and in the event list.
// Grid fills use the existing fill primitive (cheap at thousands of fills); only
// interventions become series markers.

import type { SeriesMarker, Time } from 'lightweight-charts';
import type { ChartLineSeries, ChartVerticalMarker, GridFill } from '@/components/charts/TradingChart';
import type { PionexRunPayload } from '@/lib/pionex/runStore';
import { fiveMinuteBucketSec } from '@/lib/pionex/aggregate';
import { gridLevels } from '@/lib/pionex/gridLevels';
import { LedgerEvent, PathId } from '@/lib/pionex/types';
import { GridLevel } from '@/lib/types';
import { BOT_COLORS } from './format';

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

function markerOf(e: LedgerEvent): Omit<SeriesMarker<Time>, 'time'> | null {
  const bot = `B${(e.bot ?? 0) + 1}`;
  const at = hhmm(e.timeMs);
  switch (e.type) {
    case 'start':
    case 'restart':
      return { position: 'belowBar', shape: 'arrowUp', color: '#22d3ee', text: `${bot} ${e.type} ${at}` };
    case 'close':
      return { position: 'aboveBar', shape: 'arrowDown', color: e.reason === 'take profit' ? '#10b981' : '#f59e0b', text: `${bot} ${e.reason === 'take profit' ? 'TP' : 'STOP'} ${at}` };
    case 'topup':
      return { position: 'belowBar', shape: 'circle', color: '#818cf8', text: `${bot} +${(e.amount ?? 0).toFixed(0)} ${at}` };
    case 'liquidation':
      return { position: 'belowBar', shape: 'square', color: '#ef4444', text: `${bot} LIQ ${at}` };
    case 'start_rejected':
    case 'topup_rejected':
    case 'topup_cancelled':
    case 'restart_rejected':
    case 'bot2_rejected':
    case 'intervention_missed':
      return { position: 'aboveBar', shape: 'circle', color: '#64748b', text: `${bot} ${e.type} ${at}` };
    default:
      return null;
  }
}

const HOVER_MAX = 12;

// One tooltip line per event: original minute, bot, type, price / amount, reason.
export function eventLine(e: LedgerEvent): string {
  const parts = [hhmm(e.timeMs), `B${(e.bot ?? 0) + 1}`, e.type];
  if (e.price !== undefined) parts.push(`@ ${e.price.toFixed(2)}`);
  if (e.amount !== undefined && e.type !== 'buy' && e.type !== 'sell') parts.push(`${e.amount.toFixed(4)}`);
  if (e.reason) parts.push(`· ${e.reason}`);
  return parts.join(' ');
}

export interface PionexChartData {
  hoverLines: (timeSec: number) => string[] | null; // events of a 5m candle, original minute + bot
  levels: GridLevel[];
  fills: GridFill[];
  markers: SeriesMarker<Time>[];
  lineSeries: ChartLineSeries[];
  verticalMarkers: ChartVerticalMarker[];
}

export function buildChartData(run: PionexRunPayload, path: PathId): PionexChartData {
  const candles = run.candles5m;
  const idxByTs = new Map(candles.map((c, i) => [c.timestamp, i]));
  const lastT = candles.length ? candles[candles.length - 1].timestamp : 0;
  const events = run.report.events[path];
  const { bot } = run.config;

  // Bot 1's initial band (decision 6, phase 3); a restart's new band shows as a cycle tick.
  const levels: GridLevel[] = gridLevels(bot.lower, bot.upper, bot.gridCount, bot.mode)
    .map((price, index) => ({ index, price, side: 'long' }));

  const fills: GridFill[] = [];
  const markers: SeriesMarker<Time>[] = [];
  const verticalMarkers: ChartVerticalMarker[] = [];
  const linesByBucket = new Map<number, string[]>();
  for (const e of events) {
    const t = fiveMinuteBucketSec(e.timeMs);
    const idx = idxByTs.get(t);
    if (idx === undefined) continue;
    const lines = linesByBucket.get(t) ?? [];
    if (!linesByBucket.has(t)) linesByBucket.set(t, lines);
    lines.push(eventLine(e));
    if ((e.type === 'buy' || e.type === 'sell') && e.price !== undefined) {
      fills.push({ candleIdx: idx, price: e.price, type: e.type });
      continue;
    }
    if (e.type === 'cycle') verticalMarkers.push({ time: t as Time, color: '#10b981' });
    const m = markerOf(e);
    if (m) markers.push({ ...m, time: t as Time });
  }

  // Current P_liq per bot: the highest (most dangerous) value of each 5m bucket.
  // Flat stretches and P_liq ≤ 0 (no positive liquidation price: wallet covers the
  // whole position) are whitespace, so the line breaks instead of plunging below 0.
  const nBots = run.report.paths[path].summary.bots.length;
  const lineSeries: ChartLineSeries[] = [];
  for (let b = 0; b < nBots; b++) {
    const byBucket = new Map<number, number | null>();
    for (const pt of run.report.liqSeries[path]) {
      const t = fiveMinuteBucketSec(pt.timeMs);
      if (t > lastT) continue;
      const raw = pt.liqPrices[b] ?? null;
      const v = raw !== null && raw > 0 ? raw : null;
      const prev = byBucket.get(t);
      byBucket.set(t, prev == null ? v : v == null ? prev : Math.max(prev, v));
    }
    const data = Array.from(byBucket, ([t, v]) => (v == null ? { time: t as Time } : { time: t as Time, value: v }));
    lineSeries.push({ id: `liq${b}`, color: BOT_COLORS[b], data });
  }

  // Bot 2's band: two dashed lines from its start to the end of the window.
  const bot2 = run.report.paths[path].summary.bots[1];
  const bot2Start = events.find(e => e.type === 'start' && e.bot === 1);
  if (bot2 && bot2Start) {
    const t0 = fiveMinuteBucketSec(bot2Start.timeMs);
    if (t0 < lastT) {
      for (const [id, value] of [['bot2L', bot2.lower], ['bot2U', bot2.upper]] as const) {
        lineSeries.push({ id, color: BOT_COLORS[1], dashed: true, data: [{ time: t0 as Time, value }, { time: lastT as Time, value }] });
      }
    }
  }

  const hoverLines = (timeSec: number) => {
    const lines = linesByBucket.get(timeSec);
    if (!lines) return null;
    return lines.length <= HOVER_MAX ? lines : [...lines.slice(0, HOVER_MAX), `… ${lines.length - HOVER_MAX} more (Events tab)`];
  };

  return { hoverLines, levels, fills, markers, lineSeries, verticalMarkers };
}
