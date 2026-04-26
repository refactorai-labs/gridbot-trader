'use client';

import { useState, useMemo, useCallback } from 'react';
import TradingChart, {
  GridFill,
  ComboOverlayData,
  ComboPhaseMarker,
  ComboTierMarker,
  ComboSLMarker,
} from '@/components/charts/TradingChart';
import ComboStatusStrip from './ComboStatusStrip';
import ComboOverlayPanel, { ComboOverlayState, loadOverlayState, DEFAULT_OVERLAY_STATE } from './ComboOverlayPanel';
import ComboBotDeck from './ComboBotDeck';
import ComboEventTimeline from './ComboEventTimeline';
import ComboEventFeed from './ComboEventFeed';
import ComboWalkForwardPanel from './ComboWalkForwardPanel';
import { OHLC, GridLevel, GridSide } from '@/lib/types';
import { SessionView, BotPhaseView, PnLView, AdaptiveEventView, WalkForwardView, AVWAPAnchorData } from './types';
import { computeAVWAP } from '@/lib/indicators/avwap';

interface Props {
  session: SessionView;
  candles: OHLC[];
  longLevels: GridLevel[];
  shortLevels: GridLevel[];
  filledLongIndices: Set<number>;
  filledShortIndices: Set<number>;
  longFills?: GridFill[];
  shortFills?: GridFill[];
  longBot?: BotPhaseView | null;
  shortBot?: BotPhaseView | null;
  pnl?: PnLView | null;
  events?: AdaptiveEventView[];
  walkForward?: WalkForwardView | null;
  avwapAnchor?: AVWAPAnchorData | null;
  onRun?: () => void;
  isRunning?: boolean;
}

export default function ComboPane({
  session,
  candles,
  longLevels,
  shortLevels,
  filledLongIndices,
  filledShortIndices,
  longFills,
  shortFills,
  longBot,
  shortBot,
  pnl,
  events = [],
  walkForward,
  avwapAnchor,
  onRun,
  isRunning,
}: Props) {
  const [overlay, setOverlay] = useState<ComboOverlayState>(() => loadOverlayState());

  const comboOverlayData: ComboOverlayData = useMemo(() => {
    // AVWAP series from persisted anchor (spec §10.4 — deterministic recomputation)
    const avwapSeries = avwapAnchor && avwapAnchor.candleIdx < candles.length
      ? computeAVWAP(candles, avwapAnchor.candleIdx).values
      : undefined;

    const phaseMarkers: ComboPhaseMarker[] = [];
    const tierMarkers: ComboTierMarker[] = [];
    const slMarkers: ComboSLMarker[] = [];

    for (const e of events) {
      let side: GridSide = 'long';
      let price: number | undefined;
      try {
        const d = JSON.parse(e.detailsJson) as { side?: GridSide; snapshot?: { price?: number } };
        if (d.side === 'long' || d.side === 'short') side = d.side;
        price = d.snapshot?.price;
      } catch { /* noop */ }

      switch (e.eventType) {
        case 'breakout_entered':
        case 'cooldown_entered':
        case 'hibernation_entered':
        case 'hibernation_exit':
        case 'cycle_complete':
          phaseMarkers.push({ candleIdx: e.candleIdx, type: e.eventType, side });
          break;
        case 'sl_triggered':
          slMarkers.push({ candleIdx: e.candleIdx, price: price ?? 0, side });
          break;
        case 'tier1_reopen':
          tierMarkers.push({ candleIdx: e.candleIdx, tier: 1, side });
          break;
        case 'tier2_scale':
          tierMarkers.push({ candleIdx: e.candleIdx, tier: 2, side });
          break;
        case 'tier3_scale':
          tierMarkers.push({ candleIdx: e.candleIdx, tier: 3, side });
          break;
      }
    }

    return {
      avwapSeries,
      phaseMarkers,
      tierMarkers,
      slMarkers,
      visibility: {
        avwap: overlay.avwap,
        phaseMarkers: overlay.phaseMarkers,
        slMarkers: overlay.slMarkers,
        reopenMarkers: overlay.reopenMarkers,
        slLines: overlay.slLines,
        pauseShading: overlay.pauseShading,
      },
    };
  }, [avwapAnchor, candles, events, overlay]);

  const rangeStart = 0;
  const rangeEnd = Math.max(1, session.totalCandles - 1);

  const isDual = session.mode === 'dual';

  // Per-side overlay views: each chart shows only its own side's phase / SL / tier
  // markers. AVWAP and visibility flags are global so they pass through unchanged.
  const longOverlay = useMemo<ComboOverlayData>(() => ({
    ...comboOverlayData,
    phaseMarkers: comboOverlayData.phaseMarkers?.filter(m => m.side === 'long'),
    tierMarkers: comboOverlayData.tierMarkers?.filter(m => m.side === 'long'),
    slMarkers: comboOverlayData.slMarkers?.filter(m => m.side === 'long'),
  }), [comboOverlayData]);
  const shortOverlay = useMemo<ComboOverlayData>(() => ({
    ...comboOverlayData,
    phaseMarkers: comboOverlayData.phaseMarkers?.filter(m => m.side === 'short'),
    tierMarkers: comboOverlayData.tierMarkers?.filter(m => m.side === 'short'),
    slMarkers: comboOverlayData.slMarkers?.filter(m => m.side === 'short'),
  }), [comboOverlayData]);

  const singleSide: GridSide = session.mode === 'short' ? 'short' : 'long';
  const singleLevels = singleSide === 'long' ? longLevels : shortLevels;
  const singleFilled = singleSide === 'long' ? filledLongIndices : filledShortIndices;
  const singleFills = singleSide === 'long' ? longFills : shortFills;
  const singleOverlay = singleSide === 'long' ? longOverlay : shortOverlay;

  const reset = useCallback(() => setOverlay(DEFAULT_OVERLAY_STATE), []);
  void reset;

  return (
    <div className="combo-pane">
      <ComboStatusStrip
        session={session}
        longPhase={longBot?.phase}
        shortPhase={shortBot?.phase}
        onRun={onRun}
        isRunning={isRunning}
      />

      <section className={`chart-zone${isDual ? ' chart-zone--dual' : ''}`}>
        <div className="chart-main">
          <div className={`chart-slot${isDual ? ' chart-slot--dual' : ''}`}>
            {isDual ? (
              <>
                <div className="chart-frame chart-frame--long">
                  <TradingChart
                    candles={candles}
                    gridLevels={longLevels}
                    side="long"
                    filledLevelIndices={filledLongIndices}
                    fills={longFills}
                    currentCandleIdx={session.currentCandleIdx}
                    fitAll
                    height={300}
                    combo={longOverlay}
                  />
                </div>
                <div className="chart-frame chart-frame--short">
                  <TradingChart
                    candles={candles}
                    gridLevels={shortLevels}
                    side="short"
                    filledLevelIndices={filledShortIndices}
                    fills={shortFills}
                    currentCandleIdx={session.currentCandleIdx}
                    fitAll
                    height={300}
                    combo={shortOverlay}
                  />
                </div>
              </>
            ) : (
              <div className={`chart-frame chart-frame--${singleSide}`}>
                <TradingChart
                  candles={candles}
                  gridLevels={singleLevels}
                  side={singleSide}
                  filledLevelIndices={singleFilled}
                  fills={singleFills}
                  currentCandleIdx={session.currentCandleIdx}
                  fitAll
                  height={480}
                  combo={singleOverlay}
                />
              </div>
            )}
          </div>
        </div>

        <aside className="right-rail">
          <ComboOverlayPanel state={overlay} onChange={setOverlay} />
          <ComboEventFeed events={events} currentCandleIdx={session.currentCandleIdx} />
        </aside>
      </section>

      <ComboEventTimeline
        events={events}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        currentCandleIdx={session.currentCandleIdx}
      />

      <ComboBotDeck
        long={longBot}
        short={shortBot}
        pnl={pnl}
        mode={session.mode}
      />

      {walkForward && <ComboWalkForwardPanel result={walkForward} />}

      <style jsx>{`
        .combo-pane { display: flex; flex-direction: column; width: 100%; }
        .chart-zone {
          display: grid;
          grid-template-columns: 1fr 312px;
          min-height: 540px;
        }
        .chart-zone--dual { min-height: 720px; }
        .chart-main {
          position: relative;
          background: var(--chart-bg);
          display: flex; flex-direction: column;
        }
        .chart-slot {
          flex: 1;
          position: relative;
          min-height: 480px;
          display: flex;
          flex-direction: column;
        }
        .chart-slot--dual { min-height: 700px; }
        /* Each chart sits inside a frame. The left edge carries a 2px side rail
           (long = green, short = red) — a quiet instrument-tape cue, no badges. */
        .chart-frame {
          position: relative;
          flex: 1 1 0;
          min-height: 0;
        }
        .chart-frame::before {
          content: '';
          position: absolute;
          inset: 0 auto 0 0;
          width: 2px;
          z-index: 2;
          pointer-events: none;
        }
        .chart-frame--long::before { background: var(--grid-long); }
        .chart-frame--short::before { background: var(--grid-short); }
        /* Hairline between stacked charts in dual mode. */
        .chart-slot--dual .chart-frame + .chart-frame {
          border-top: 1px solid var(--hairline-strong, var(--hairline));
        }
        .right-rail {
          border-left: 1px solid var(--hairline);
          display: flex; flex-direction: column;
          background: var(--card-bg);
          min-width: 0;
          overflow-y: auto;
          max-height: 740px;
        }
        .chart-zone--dual .right-rail { max-height: 920px; }
        @media (max-width: 1280px) {
          .chart-zone { grid-template-columns: 1fr 280px; }
        }
        @media (max-width: 900px) {
          .chart-zone { grid-template-columns: 1fr; }
          .right-rail { border-left: 0; border-top: 1px solid var(--hairline); max-height: none; }
        }
      `}</style>
    </div>
  );
}
