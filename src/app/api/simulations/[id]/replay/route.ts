import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getCachedCandles, getTimeframeMinutes } from '@/lib/data/candleCache';
import { aggregate5mTo } from '@/lib/data/aggregator';
import { SUPPORTED_PAIRS } from '@/lib/constants';
import { generateGridLevels } from '@/lib/simulation/gridGenerator';

// Cap chart candles to keep the replay payload + lightweight-charts canvas under
// the renderer's memory ceiling. Combo @ 5m × 4 months ≈ 37k candles, which OOMs
// Chrome before the chart finishes mounting. We aggregate to a coarser bucket on
// the wire and remap every persisted `candleIdx` so the frontend is unaware.
const MAX_CHART_CANDLES = 3000;
// Allowed bucket factors over 5m (→ 5m / 15m / 30m / 1h / 4h / 12h / 1d). Snapping
// the raw factor up to one of these keeps bucket boundaries on natural session
// edges (`computeSessionVWAP` resets at day boundaries).
const ALLOWED_BUCKET_FACTORS = [1, 3, 6, 12, 48, 144, 288];

function snapBucketFactor(rawFactor: number): number {
  for (const f of ALLOWED_BUCKET_FACTORS) {
    if (f >= rawFactor) return f;
  }
  return ALLOWED_BUCKET_FACTORS[ALLOWED_BUCKET_FACTORS.length - 1];
}

// Structural events drive the supervisor state machine and the visible markers /
// phase derivation. They ALL pass through replay verbatim (only their candleIdx is
// remapped). `reopen_check_failed` is a diagnostic-only event that fires on every
// post-expiry cooldown candle for tooltip coverage (stateMachine.ts:237). It is
// the dominant source of replay payload bloat (~99 % of rows on the failing sim)
// and gets compacted to "latest per (slicedCandleIdx, side) bucket" — which is
// also exactly the tooltip's effective rendered precision after chart aggregation.
const STRUCTURAL_EVENT_TYPES = new Set<string>([
  'breakout_entered',
  'position_opened',
  'sl_triggered',
  'cooldown_entered',
  'tier1_reopen',
  'tier2_scale',
  'tier3_scale',
  'cycle_complete',
  'hibernation_entered',
  'hibernation_exit',
  'retry_incremented',
]);

// GET: Fetch replay data for a simulation
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { searchParams } = new URL(request.url);
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');

    const simulation = await prisma.simulation.findUnique({
      where: { id: params.id },
      include: { gridConfigs: true, avwapAnchor: true },
    });

    if (!simulation) {
      return NextResponse.json({ error: 'Simulation not found' }, { status: 404 });
    }

    if (simulation.status !== 'completed') {
      return NextResponse.json({
        error: 'Simulation not completed',
        status: simulation.status,
      }, { status: 400 });
    }

    // Load 5m candles and aggregate to sim timeframe (matches engine behavior).
    // Combo simulations persist fillCandleIdx + AdaptiveEvent.candleIdx in 5m-index space
    // (supervisor loop runs over candles5m), so replay MUST return 5m candles for combo
    // regardless of the configured grid timeframe — otherwise indexes point past the array.
    const pairConfig = SUPPORTED_PAIRS.find(p => p.poolAddress === simulation.poolAddress);
    const binanceSymbol = pairConfig?.binanceSymbol || simulation.pair;
    const candles5m = await getCachedCandles(
      binanceSymbol, '5m',
      simulation.startTime, simulation.endTime
    );
    if (candles5m.length === 0) {
      return NextResponse.json({
        error: `No cached candles for ${binanceSymbol} between ${simulation.startTime.toISOString()} and ${simulation.endTime.toISOString()}. Use the Data Manager to download.`,
      }, { status: 404 });
    }
    const simTimeframeMins = simulation.comboBotEnabled ? 5 : getTimeframeMinutes(simulation.timeframe);
    const candles = simTimeframeMins === 5 ? candles5m : aggregate5mTo(candles5m, simTimeframeMins);

    // Chart aggregation: when the sim runs at 5m over a long range (combo, 4 months ≈
    // 37k candles), bucket the candles down for rendering and remap every persisted
    // `candleIdx` to bucket-index space. Grid timeframes (1h/4h) stay below the
    // threshold and pass through unchanged.
    let chartTimeframeMins = simTimeframeMins;
    let chartCandles = candles;
    let bucketFactor = 1;
    if (candles.length > MAX_CHART_CANDLES && simTimeframeMins === 5) {
      const rawFactor = Math.ceil(candles.length / MAX_CHART_CANDLES);
      bucketFactor = snapBucketFactor(rawFactor);
      chartTimeframeMins = simTimeframeMins * bucketFactor;
      chartCandles = aggregate5mTo(candles, chartTimeframeMins);
    }
    // from/to URL params are in DB (sim-timeframe) index space — they match
    // persisted candleIdx values on disk.
    const dbFrom = fromParam ? parseInt(fromParam) : 0;
    const dbTo = toParam ? parseInt(toParam) : candles.length - 1;

    // Two index spaces are in play after chart aggregation:
    //   • CHART  = bucket index in `chartCandles` (= floor(dbIdx / bucketFactor))
    //   • SLICED = position in the returned `slicedCandles` array (= chart - chartFrom)
    // The wire response ALWAYS uses SLICED indexes so the frontend can treat
    // `candleIdx` as a direct offset into the candles array it received.
    const toChartIdx = (dbIdx: number) => Math.floor(dbIdx / bucketFactor);
    const chartFrom = toChartIdx(dbFrom);
    const chartTo = toChartIdx(dbTo);
    const slicedCandles = chartCandles.slice(chartFrom, chartTo + 1);
    const slicedMax = slicedCandles.length - 1;
    const toSlicedIdx = (dbIdx: number) => toChartIdx(dbIdx) - chartFrom;
    const inSlicedRange = (slicedIdx: number) =>
      slicedIdx >= 0 && slicedIdx <= slicedMax;

    // Load grid orders (fills in this range) — use DB-space bounds.
    const gridOrders = await prisma.gridOrder.findMany({
      where: {
        simulationId: params.id,
        fillCandleIdx: { gte: dbFrom, lte: dbTo },
      },
      orderBy: { fillCandleIdx: 'asc' },
      select: {
        id: true,
        side: true,
        level: true,
        levelPrice: true,
        orderType: true,
        status: true,
        fillPrice: true,
        fillCandleIdx: true,
        pnl: true,
      },
    });

    // Load P&L snapshots
    const pnlSnapshots = await prisma.pnlSnapshot.findMany({
      where: {
        simulationId: params.id,
        candleIdx: { gte: dbFrom, lte: dbTo },
      },
      orderBy: { candleIdx: 'asc' },
    });

    // Load adaptive events
    const adaptiveEvents = await prisma.adaptiveEvent.findMany({
      where: {
        simulationId: params.id,
        candleIdx: { gte: dbFrom, lte: dbTo },
      },
      orderBy: { candleIdx: 'asc' },
    });

    // Generate grid levels for display.
    // Combo bot uses ATR-based dynamic grids (not the saved GridConfiguration bounds),
    // so return empty arrays — fills are the primary visual in combo mode.
    const longConfig = simulation.gridConfigs.find(c => c.side === 'long');
    const shortConfig = simulation.gridConfigs.find(c => c.side === 'short');

    const longLevels = !simulation.comboBotEnabled && longConfig
      ? generateGridLevels(
          longConfig.lowerBound, longConfig.upperBound,
          longConfig.gridLevels, 'long',
          longConfig.gridType as 'arithmetic' | 'geometric'
        )
      : [];

    const shortLevels = !simulation.comboBotEnabled && shortConfig
      ? generateGridLevels(
          shortConfig.lowerBound, shortConfig.upperBound,
          shortConfig.gridLevels, 'short',
          shortConfig.gridType as 'arithmetic' | 'geometric'
        )
      : [];

    // Dedupe snapshots that collapse into the same sliced bucket (last in DB ASC
    // order wins — the most recent equity inside the bucket). Without this, the
    // frontend's `currentSnapshot` reduce picks a non-deterministic snapshot among
    // collisions. Out-of-range rows are dropped.
    const mapSnapshot = (s: typeof pnlSnapshots[number], slicedCandleIdx: number) => ({
      candleIdx: slicedCandleIdx,
      timestamp: Math.floor(s.timestamp.getTime() / 1000),
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
    });
    const remappedSnapshots = new Map<number, ReturnType<typeof mapSnapshot>>();
    for (const s of pnlSnapshots) {
      const sliced = toSlicedIdx(s.candleIdx);
      if (!inSlicedRange(sliced)) continue;
      remappedSnapshots.set(sliced, mapSnapshot(s, sliced));
    }
    const dedupedSnapshots = Array.from(remappedSnapshots.values())
      .sort((a, b) => a.candleIdx - b.candleIdx);

    // Adaptive event compaction. Two passes over the DB rows (already sorted ASC
    // by original candleIdx, which we keep as a stable tiebreaker for ordering
    // within a bucket — matters for the SL forward-fill walk in ComboPane.tsx).
    //
    //   Structural events  → keep every row, remap to sliced index, drop OOR rows.
    //   reopen_check_failed → keep only the LATEST per (slicedIdx, side) bucket;
    //                         frontend tooltips read diagnostics from this event
    //                         and one per chart bucket is the rendered precision.
    type RemappedEvent = {
      candleIdx: number;
      timestamp: number;
      eventType: string;
      detailsJson: string;
      longMultiplier: number | null;
      shortMultiplier: number | null;
      _originalIdx: number;
    };
    const structuralEvents: RemappedEvent[] = [];
    const failedChecksByBucket = new Map<string, RemappedEvent>();
    let droppedFailedChecks = 0;
    let droppedOutOfRange = 0;
    for (const ae of adaptiveEvents) {
      const sliced = toSlicedIdx(ae.candleIdx);
      if (!inSlicedRange(sliced)) {
        droppedOutOfRange++;
        continue;
      }
      const ev: RemappedEvent = {
        candleIdx: sliced,
        timestamp: Math.floor(ae.timestamp.getTime() / 1000),
        eventType: ae.eventType,
        detailsJson: ae.detailsJson,
        longMultiplier: ae.longMultiplier,
        shortMultiplier: ae.shortMultiplier,
        _originalIdx: ae.candleIdx,
      };
      if (STRUCTURAL_EVENT_TYPES.has(ae.eventType)) {
        structuralEvents.push(ev);
      } else if (ae.eventType === 'reopen_check_failed') {
        // Parse the side once to scope the bucket. Untyped/unparsable rows fall
        // back to bucketing without a side suffix (rare; the supervisor always
        // emits with a side, so this is defensive).
        let side: string = '';
        try {
          const d = JSON.parse(ae.detailsJson) as { side?: string };
          if (d.side === 'long' || d.side === 'short') side = d.side;
        } catch { /* noop */ }
        const key = `${sliced}|${side}`;
        const existing = failedChecksByBucket.get(key);
        if (existing) droppedFailedChecks++;
        // DB returns ASC by original candleIdx, so the later row wins — that is
        // exactly "latest per bucket".
        failedChecksByBucket.set(key, ev);
      } else {
        // Unknown / future event types: pass through verbatim so we never silently
        // hide telemetry. Add to structuralEvents bucket.
        structuralEvents.push(ev);
      }
    }
    // Concatenate then stable-sort by (slicedCandleIdx, _originalIdx). JS Array.sort
    // is stable in modern engines (ES2019+), so equal-key entries keep their insert
    // order, but we encode the original idx tiebreaker explicitly so future engine
    // changes can't reintroduce flicker.
    const remappedEvents = [...structuralEvents, ...failedChecksByBucket.values()]
      .sort((a, b) => a.candleIdx - b.candleIdx || a._originalIdx - b._originalIdx)
      // Strip the internal tiebreaker before sending over the wire.
      .map(({ _originalIdx, ...rest }) => { void _originalIdx; return rest; });

    // Optional avwapAnchor: drop if its sliced index falls outside the returned
    // range — ComboPane.tsx feeds anchorCandleIdx straight into computeAVWAP() and
    // would index past the candles array with a negative or oversized value.
    let avwapAnchorOut: {
      candleIdx: number;
      timestamp: number;
      typicalPrice: number;
      volume: number;
    } | null = null;
    if (simulation.avwapAnchor) {
      const sliced = toSlicedIdx(simulation.avwapAnchor.anchorCandleIdx);
      if (inSlicedRange(sliced)) {
        avwapAnchorOut = {
          candleIdx: sliced,
          timestamp: Math.floor(simulation.avwapAnchor.anchorTimestamp.getTime() / 1000),
          typicalPrice: simulation.avwapAnchor.anchorTypicalPrice,
          volume: simulation.avwapAnchor.anchorVolume,
        };
      }
    }

    return NextResponse.json({
      candles: slicedCandles,
      pnlSnapshots: dedupedSnapshots,
      gridOrders: gridOrders.flatMap(o => {
        // Compute fill index in sliced space when present, drop OOR.
        let slicedFill: number | null = null;
        if (o.fillCandleIdx != null) {
          const sliced = toSlicedIdx(o.fillCandleIdx);
          if (!inSlicedRange(sliced)) return [];
          slicedFill = sliced;
        }
        return [{
          id: o.id,
          side: o.side,
          level: o.level,
          levelPrice: o.levelPrice,
          orderType: o.orderType,
          status: o.status,
          fillPrice: o.fillPrice,
          fillCandleIdx: slicedFill,
          pnl: o.pnl,
        }];
      }),
      adaptiveEvents: remappedEvents,
      longLevels,
      shortLevels,
      // Sliced-array length so the frontend can treat every emitted candleIdx as
      // a 0..totalCandles-1 offset into the returned candles array.
      totalCandles: slicedCandles.length,
      chartTimeframeMins,
      avwapAnchor: avwapAnchorOut,
      // Diagnostic counters surfaced for tests + future telemetry. Not consumed by
      // any UI today; remove if it bloats the response in profiled measurements.
      _compactionStats: {
        rawEventCount: adaptiveEvents.length,
        emittedEventCount: remappedEvents.length,
        droppedFailedChecks,
        droppedOutOfRange,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
