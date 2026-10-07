// Replay payload builder for classic grid engine v1 rows (plan v4, Contract D).
// Pure: the replay route loads rows from Prisma and hands them in here.
// Every persisted row is mapped to a chart bucket by its TIMESTAMP (clock-aligned
// buckets from aggregateAligned), so the final 5m candle, fill and snapshot land
// in the final bucket even when the first/last bucket is partial.

import type { AdaptiveEvent, GridConfiguration, GridOrder, PnlSnapshot } from '@prisma/client';
import type { OHLC } from '../types';
import { aggregateAligned, makeBucketLookup, AlignedCandle } from '../data/alignedAggregator';
import { generateGridLevels } from './gridGenerator';
import { MAX_REPLAY_EVENTS } from './classicGridTypes';

// Mirrors MAX_CHART_CANDLES / ALLOWED_BUCKET_FACTORS in the replay route (v0 path)
// and MAX_CHART_CANDLES in page.tsx.
export const MAX_CHART_CANDLES = 3000;
const ALLOWED_BUCKET_FACTORS = [1, 3, 6, 12, 48, 144, 288];

// Smallest allowed factor whose actual aligned bucket count fits the cap. Partial
// first/last buckets can add one bucket over ceil(n / factor), so the count is
// measured, not estimated. A bucket never holds more than `factor` 5m candles, so
// ceil(n / factor) is a lower bound and lets us skip factors that cannot fit.
export function pickChartBuckets(
  candles5m: OHLC[],
  simTimeframeMins: number,
): { chartMins: number; buckets: AlignedCandle[] } {
  let chartMins = 0;
  let buckets: AlignedCandle[] = [];
  for (const factor of ALLOWED_BUCKET_FACTORS) {
    chartMins = Math.max(simTimeframeMins, 5 * factor);
    if (Math.ceil(candles5m.length / (chartMins / 5)) > MAX_CHART_CANDLES) continue;
    buckets = aggregateAligned(candles5m, chartMins);
    if (buckets.length <= MAX_CHART_CANDLES) return { chartMins, buckets };
  }
  return { chartMins, buckets: aggregateAligned(candles5m, chartMins) };
}

export type ClassicOrderRow = Pick<GridOrder,
  'id' | 'side' | 'level' | 'levelPrice' | 'orderType' | 'status' | 'fillPrice' |
  'fillTime' | 'fillCandleIdx' | 'pnl' | 'quantity' | 'positionId' | 'role' | 'fillSeq' | 'fees'>;
export type ClassicSnapshotRow = Omit<PnlSnapshot, 'id' | 'simulationId'>;
export type ClassicEventRow = Pick<AdaptiveEvent,
  'candleIdx' | 'timestamp' | 'eventType' | 'detailsJson' | 'longMultiplier' | 'shortMultiplier'>;
export type ClassicConfigRow = Pick<GridConfiguration,
  'side' | 'enabled' | 'lowerBound' | 'upperBound' | 'gridLevels' | 'gridType'>;

export interface ClassicReplayInput {
  candles5m: OHLC[];              // effective 5m candles (optionally sliced by from/to)
  simTimeframeMins: number;
  orders: ClassicOrderRow[];      // ordered by fillSeq ascending
  snapshots: ClassicSnapshotRow[]; // ordered by candleIdx ascending
  stateEvents: ClassicEventRow[]; // state events only, ordered by (candleIdx, id)
  diagnosticEventCount: number;
  gridConfigs: ClassicConfigRow[];
  engineVersion: number;
  effectiveStart: number;         // seconds
  effectiveEnd: number;           // seconds, exclusive
}

const toSec = (d: Date) => Math.floor(d.getTime() / 1000);

export function buildClassicReplay(input: ClassicReplayInput) {
  const { chartMins, buckets } = pickChartBuckets(input.candles5m, input.simTimeframeMins);
  const bucketOf = makeBucketLookup(buckets, chartMins);
  let droppedOutOfRange = 0;

  // Fills: never compacted; fillSeq order preserved from the query.
  const gridOrders = input.orders.flatMap(o => {
    const idx = o.fillTime ? bucketOf(toSec(o.fillTime)) : -1;
    if (idx < 0) { droppedOutOfRange++; return []; }
    return [{
      id: o.id,
      side: o.side,
      level: o.level,
      levelPrice: o.levelPrice,
      orderType: o.orderType,
      status: o.status,
      fillPrice: o.fillPrice,
      fillCandleIdx: idx,
      pnl: o.pnl,
      quantity: o.quantity,
      positionId: o.positionId,
      role: o.role,
      fillSeq: o.fillSeq,
      fillTime: o.fillTime ? toSec(o.fillTime) : null,
      fees: o.fees,
    }];
  });

  // Snapshots collapsing into one bucket: last wins.
  const snapshotsByBucket = new Map<number, ReturnType<typeof mapSnapshot>>();
  for (const s of input.snapshots) {
    const idx = bucketOf(toSec(s.timestamp));
    if (idx < 0) { droppedOutOfRange++; continue; }
    snapshotsByBucket.set(idx, mapSnapshot(s, idx));
  }
  const pnlSnapshots = Array.from(snapshotsByBucket.values()).sort((a, b) => a.candleIdx - b.candleIdx);

  // State events: verbatim when ≤ MAX_REPLAY_EVENTS, else latest per chart bucket
  // (lossless at chart resolution: each state event carries both sides' state).
  const remapped = input.stateEvents.flatMap(e => {
    const idx = bucketOf(toSec(e.timestamp));
    if (idx < 0) { droppedOutOfRange++; return []; }
    return [{
      candleIdx: idx,
      timestamp: toSec(e.timestamp),
      eventType: e.eventType,
      detailsJson: e.detailsJson,
      longMultiplier: e.longMultiplier,
      shortMultiplier: e.shortMultiplier,
    }];
  });
  let adaptiveEvents = remapped;
  if (remapped.length > MAX_REPLAY_EVENTS) {
    const latest = new Map<number, (typeof remapped)[number]>();
    for (const e of remapped) latest.set(e.candleIdx, e);
    adaptiveEvents = Array.from(latest.values()).sort((a, b) => a.candleIdx - b.candleIdx);
  }

  const levelsFor = (side: 'long' | 'short') => {
    const c = input.gridConfigs.find(g => g.side === side);
    if (!c || c.enabled === false) return [];
    return generateGridLevels(c.lowerBound, c.upperBound, c.gridLevels, side, c.gridType as 'arithmetic' | 'geometric');
  };

  return {
    candles: buckets,
    pnlSnapshots,
    gridOrders,
    adaptiveEvents,
    longLevels: levelsFor('long'),
    shortLevels: levelsFor('short'),
    totalCandles: buckets.length,
    chartTimeframeMins: chartMins,
    avwapAnchor: null,
    engineVersion: input.engineVersion,
    effectiveStart: input.effectiveStart,
    effectiveEnd: input.effectiveEnd,
    diagnosticEventCount: input.diagnosticEventCount,
    _compactionStats: {
      rawEventCount: input.stateEvents.length,
      emittedEventCount: adaptiveEvents.length,
      droppedOutOfRange,
      compactedStateEvents: remapped.length - adaptiveEvents.length,
    },
  };
}

function mapSnapshot(s: ClassicSnapshotRow, candleIdx: number) {
  return {
    candleIdx,
    timestamp: toSec(s.timestamp),
    price: s.price,
    equity: s.equity,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    longRealizedPnl: s.longRealizedPnl,
    shortRealizedPnl: s.shortRealizedPnl,
    longUnrealizedPnl: s.longUnrealizedPnl,
    shortUnrealizedPnl: s.shortUnrealizedPnl,
    longEquity: s.longEquity,
    shortEquity: s.shortEquity,
    longOrdersActive: s.longOrdersActive,
    shortOrdersActive: s.shortOrdersActive,
    longFillCount: s.longFillCount,
    shortFillCount: s.shortFillCount,
  };
}
