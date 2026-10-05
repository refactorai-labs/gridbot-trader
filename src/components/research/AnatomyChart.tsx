'use client';

// Strategy anatomy chart — 30m candles with three custom canvas layers:
//   1. RegimeBandsPrimitive (bottom): trend/volatile background tint + a
//      bottom ER ribbon with hysteresis threshold guides. Clear tape = the
//      'range' regime the system trades in.
//   2. CycleZonesPrimitive (bottom): per-cycle range box, invalidation zones,
//      hard-stop rails and grid level hairlines, time-bounded to the cycle.
//   3. EventLayerPrimitive (top): grid-fill dots plus structural glyphs —
//      initial opens ◆, partial closes ▼ (% closed), unwinds ●, stops ✕.

import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  IChartApiBase,
  ISeriesApi,
  ISeriesPrimitivePaneView,
  ISeriesPrimitivePaneRenderer,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
  ColorType,
} from 'lightweight-charts';
import { CanvasRenderingTarget2D } from 'fancy-canvas';
import { ArtifactCandle, ArtifactCycle, ArtifactEvent, ArtifactRegimePoint } from './types';

export interface LayerVisibility {
  regime: boolean;
  zones: boolean;
  fills: boolean;
  structural: boolean;
}

const C = {
  bg: '#07090f',
  up: '#10b981',
  down: '#ef4444',
  trendBand: 'rgba(99, 102, 241, 0.10)',
  volatileBand: 'rgba(245, 158, 11, 0.10)',
  warmupBand: 'rgba(148, 163, 184, 0.05)',
  erLine: 'rgba(226, 232, 240, 0.85)',
  erGuide: 'rgba(148, 163, 184, 0.35)',
  rangeFill: 'rgba(20, 184, 166, 0.07)',
  invalidFill: 'rgba(239, 68, 68, 0.07)',
  levelLine: 'rgba(94, 234, 212, 0.16)',
  centerLine: 'rgba(94, 234, 212, 0.38)',
  stopRail: 'rgba(239, 68, 68, 0.55)',
  edgeLine: 'rgba(20, 184, 166, 0.45)',
  buyDot: 'rgba(34, 197, 94, 0.85)',
  sellDot: 'rgba(248, 113, 113, 0.85)',
  initial: '#5eead4',
  bank: '#f59e0b',
  unwind: '#22d3ee',
  derisk: '#94a3b8',
  stop: '#ef4444',
} as const;

const ER_STRIP_PX = 46;

// ── coordinate helper: clamp an out-of-view time to a canvas edge ──
function xOrEdge(
  chart: IChartApiBase<Time>,
  timeSec: number,
  mediaWidth: number,
  firstSec: number,
  lastSec: number
): number | null {
  const x = chart.timeScale().timeToCoordinate(timeSec as UTCTimestamp);
  if (x !== null) return x;
  const vr = chart.timeScale().getVisibleRange();
  if (!vr) return null;
  if (timeSec <= (vr.from as number)) return timeSec < firstSec ? 0 : 0;
  if (timeSec >= (vr.to as number)) return timeSec > lastSec ? mediaWidth : mediaWidth;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Regime bands + ER ribbon
// ─────────────────────────────────────────────────────────────────────────────

interface RegimeConfig {
  points: ArtifactRegimePoint[];
  firstSec: number;
  lastSec: number;
  visible: boolean;
}

class RegimeBandsRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private cfg: RegimeConfig, private chart: IChartApiBase<Time>) {}

  drawBackground(target: CanvasRenderingTarget2D) {
    const { points, visible, firstSec, lastSec } = this.cfg;
    if (!visible || points.length === 0) return;

    target.useMediaCoordinateSpace(scope => {
      const ctx = scope.context;
      const w = scope.mediaSize.width;
      const h = scope.mediaSize.height;

      // contiguous segments of identical regime
      let segStart = points[0].timeSec - 1800;
      let segRegime = points[0].regime;
      const flush = (endSec: number) => {
        if (segRegime === 'range') return;
        const x0 = xOrEdge(this.chart, segStart, w, firstSec, lastSec);
        const x1 = xOrEdge(this.chart, endSec, w, firstSec, lastSec);
        if (x0 === null || x1 === null || x1 <= x0) return;
        ctx.fillStyle =
          segRegime === 'trend' ? C.trendBand : segRegime === 'volatile' ? C.volatileBand : C.warmupBand;
        ctx.fillRect(x0, 0, x1 - x0, h - ER_STRIP_PX);
      };
      for (let i = 1; i < points.length; i++) {
        if (points[i].regime !== segRegime) {
          flush(points[i].timeSec - 1800);
          segStart = points[i].timeSec - 1800;
          segRegime = points[i].regime;
        }
      }
      flush(points[points.length - 1].timeSec);

      // ER ribbon
      const stripTop = h - ER_STRIP_PX;
      ctx.fillStyle = 'rgba(2, 6, 12, 0.55)';
      ctx.fillRect(0, stripTop, w, ER_STRIP_PX);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-1, stripTop + 0.5, w + 2, ER_STRIP_PX);

      const erY = (er: number) => stripTop + (1 - Math.min(1, Math.max(0, er))) * (ER_STRIP_PX - 8) + 4;
      // hysteresis guides (0.25 / 0.45 defaults drawn from data percentile-free)
      for (const guide of [0.25, 0.45]) {
        ctx.strokeStyle = C.erGuide;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(0, erY(guide));
        ctx.lineTo(w, erY(guide));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = C.erLine;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (const p of points) {
        if (isNaN(p.er)) continue;
        const x = this.chart.timeScale().timeToCoordinate(p.timeSec as UTCTimestamp);
        if (x === null) continue;
        const y = erY(p.er);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
      ctx.fillText('KAUFMAN ER', 8, stripTop + 12);
    });
  }

  draw() {}
}

class RegimePaneView implements ISeriesPrimitivePaneView {
  constructor(private cfg: RegimeConfig, private chart: IChartApiBase<Time>) {}
  update(cfg: RegimeConfig) { this.cfg = cfg; }
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): ISeriesPrimitivePaneRenderer { return new RegimeBandsRenderer(this.cfg, this.chart); }
}

class RegimeBandsPrimitive {
  private paneView: RegimePaneView | null = null;
  private requestUpdate: (() => void) | null = null;
  constructor(private cfg: RegimeConfig) {}
  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.requestUpdate = param.requestUpdate;
    this.paneView = new RegimePaneView(this.cfg, param.chart);
  }
  detached() { this.paneView = null; this.requestUpdate = null; }
  updateConfig(cfg: RegimeConfig) { this.cfg = cfg; this.paneView?.update(cfg); this.requestUpdate?.(); }
  updateAllViews() {}
  paneViews(): readonly ISeriesPrimitivePaneView[] { return this.paneView ? [this.paneView] : []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle zones (range box, invalidation, stops, grid levels)
// ─────────────────────────────────────────────────────────────────────────────

interface ZonesConfig {
  cycles: ArtifactCycle[];
  selectedIdx: number | null;
  firstSec: number;
  lastSec: number;
  visible: boolean;
}

class CycleZonesRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(
    private cfg: ZonesConfig,
    private series: ISeriesApi<SeriesType, Time>,
    private chart: IChartApiBase<Time>
  ) {}

  drawBackground(target: CanvasRenderingTarget2D) {
    const { cycles, visible, selectedIdx, firstSec, lastSec } = this.cfg;
    if (!visible || cycles.length === 0) return;

    target.useMediaCoordinateSpace(scope => {
      const ctx = scope.context;
      const w = scope.mediaSize.width;

      cycles.forEach((cycle, idx) => {
        const endSec = cycle.endSec ?? lastSec;
        if (endSec < firstSec || cycle.startSec > lastSec) return;
        const x0 = xOrEdge(this.chart, Math.max(cycle.startSec, firstSec), w, firstSec, lastSec);
        const x1 = xOrEdge(this.chart, Math.min(endSec, lastSec), w, firstSec, lastSec);
        if (x0 === null || x1 === null || x1 <= x0) return;

        const z = cycle.zones;
        const y = (p: number) => this.series.priceToCoordinate(p);
        const yU = y(z.upper); const yL = y(z.lower);
        const yIU = y(z.invalidUpper); const yIL = y(z.invalidLower);
        const ySS = y(z.stopShort); const ySL = y(z.stopLong);
        if (yU === null || yL === null) return;
        const dim = selectedIdx !== null && selectedIdx !== idx;
        ctx.globalAlpha = dim ? 0.35 : 1;

        // range box
        ctx.fillStyle = C.rangeFill;
        ctx.fillRect(x0, yU, x1 - x0, yL - yU);
        ctx.strokeStyle = C.edgeLine;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, yU + 0.5, x1 - x0 - 1, yL - yU - 1);

        // invalidation zones (edge → invalidation boundary)
        if (yIU !== null) { ctx.fillStyle = C.invalidFill; ctx.fillRect(x0, yIU, x1 - x0, yU - yIU); }
        if (yIL !== null) { ctx.fillStyle = C.invalidFill; ctx.fillRect(x0, yL, x1 - x0, yIL - yL); }

        // grid level hairlines + center emphasis
        for (const lvl of z.levels) {
          const ly = y(lvl);
          if (ly === null) continue;
          const isCenter = Math.abs(lvl - z.center) < 1e-9;
          ctx.strokeStyle = isCenter ? C.centerLine : C.levelLine;
          ctx.setLineDash(isCenter ? [] : [2, 5]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, ly);
          ctx.lineTo(x1, ly);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // hard stop rails
        for (const sy of [ySS, ySL]) {
          if (sy === null) continue;
          ctx.strokeStyle = C.stopRail;
          ctx.setLineDash([7, 4]);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x0, sy);
          ctx.lineTo(x1, sy);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // cycle index tag
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(94, 234, 212, 0.75)';
        ctx.fillText(`C${idx + 1}`, x0 + 5, yU + 13);
        ctx.globalAlpha = 1;
      });
    });
  }

  draw() {}
}

class ZonesPaneView implements ISeriesPrimitivePaneView {
  constructor(private cfg: ZonesConfig, private series: ISeriesApi<SeriesType, Time>, private chart: IChartApiBase<Time>) {}
  update(cfg: ZonesConfig) { this.cfg = cfg; }
  zOrder(): 'bottom' { return 'bottom'; }
  renderer(): ISeriesPrimitivePaneRenderer { return new CycleZonesRenderer(this.cfg, this.series, this.chart); }
}

class CycleZonesPrimitive {
  private paneView: ZonesPaneView | null = null;
  private requestUpdate: (() => void) | null = null;
  constructor(private cfg: ZonesConfig) {}
  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.requestUpdate = param.requestUpdate;
    this.paneView = new ZonesPaneView(this.cfg, param.series, param.chart);
  }
  detached() { this.paneView = null; this.requestUpdate = null; }
  updateConfig(cfg: ZonesConfig) { this.cfg = cfg; this.paneView?.update(cfg); this.requestUpdate?.(); }
  updateAllViews() {}
  paneViews(): readonly ISeriesPrimitivePaneView[] { return this.paneView ? [this.paneView] : []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event layer (fill dots + structural glyphs)
// ─────────────────────────────────────────────────────────────────────────────

interface EventsConfig {
  events: ArtifactEvent[];
  showFills: boolean;
  showStructural: boolean;
}

function snap30(sec: number): number {
  return Math.floor(sec / 1800) * 1800;
}

class EventLayerRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(
    private cfg: EventsConfig,
    private series: ISeriesApi<SeriesType, Time>,
    private chart: IChartApiBase<Time>
  ) {}

  drawBackground() {}

  draw(target: CanvasRenderingTarget2D) {
    const { events, showFills, showStructural } = this.cfg;
    if (events.length === 0) return;

    target.useMediaCoordinateSpace(scope => {
      const ctx = scope.context;
      const ts = this.chart.timeScale();

      for (const e of events) {
        if (e.type === 'funding' || e.price === undefined) continue;
        const isFill = e.type === 'gridFill';
        if (isFill && !showFills) continue;
        if (!isFill && !showStructural) continue;

        const x = ts.timeToCoordinate(snap30(e.timeSec) as UTCTimestamp);
        const y = this.series.priceToCoordinate(e.price);
        if (x === null || y === null) continue;

        if (isFill) {
          ctx.beginPath();
          ctx.arc(x, y, 2.2, 0, Math.PI * 2);
          ctx.fillStyle = e.orderType === 'buy' ? C.buyDot : C.sellDot;
          ctx.fill();
          if (e.reduceOnly) {
            ctx.beginPath();
            ctx.arc(x, y, 3.8, 0, Math.PI * 2);
            ctx.strokeStyle = e.orderType === 'buy' ? C.buyDot : C.sellDot;
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
          continue;
        }

        switch (e.type) {
          case 'initialOpen': {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(Math.PI / 4);
            ctx.fillStyle = 'rgba(94, 234, 212, 0.25)';
            ctx.strokeStyle = C.initial;
            ctx.lineWidth = 1.5;
            ctx.fillRect(-4.5, -4.5, 9, 9);
            ctx.strokeRect(-4.5, -4.5, 9, 9);
            ctx.restore();
            break;
          }
          case 'partialClose': {
            this.halo(ctx, x, y, C.bank);
            ctx.beginPath();
            ctx.moveTo(x - 6, y - 5);
            ctx.lineTo(x + 6, y - 5);
            ctx.lineTo(x, y + 6);
            ctx.closePath();
            ctx.fillStyle = C.bank;
            ctx.fill();
            ctx.font = 'bold 10px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`-${Math.round((e.fraction ?? 0) * 100)}%`, x, y - 10);
            ctx.textAlign = 'left';
            break;
          }
          case 'fullClose': {
            const color = e.reason === 'hedgeUnwind' ? C.unwind : e.reason === 'bankProfit' ? C.bank : C.derisk;
            this.halo(ctx, x, y, color);
            ctx.beginPath();
            ctx.arc(x, y, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, y, 4.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.7)';
            ctx.lineWidth = 1;
            ctx.stroke();
            break;
          }
          case 'stop': {
            this.halo(ctx, x, y, C.stop);
            ctx.strokeStyle = C.stop;
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(x - 5.5, y - 5.5); ctx.lineTo(x + 5.5, y + 5.5);
            ctx.moveTo(x + 5.5, y - 5.5); ctx.lineTo(x - 5.5, y + 5.5);
            ctx.stroke();
            break;
          }
        }
      }
    });
  }

  private halo(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = color.startsWith('#') ? `${color}22` : color;
    ctx.fill();
  }
}

class EventsPaneView implements ISeriesPrimitivePaneView {
  constructor(private cfg: EventsConfig, private series: ISeriesApi<SeriesType, Time>, private chart: IChartApiBase<Time>) {}
  update(cfg: EventsConfig) { this.cfg = cfg; }
  zOrder(): 'top' { return 'top'; }
  renderer(): ISeriesPrimitivePaneRenderer { return new EventLayerRenderer(this.cfg, this.series, this.chart); }
}

class EventLayerPrimitive {
  private paneView: EventsPaneView | null = null;
  private requestUpdate: (() => void) | null = null;
  constructor(private cfg: EventsConfig) {}
  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this.requestUpdate = param.requestUpdate;
    this.paneView = new EventsPaneView(this.cfg, param.series, param.chart);
  }
  detached() { this.paneView = null; this.requestUpdate = null; }
  updateConfig(cfg: EventsConfig) { this.cfg = cfg; this.paneView?.update(cfg); this.requestUpdate?.(); }
  updateAllViews() {}
  paneViews(): readonly ISeriesPrimitivePaneView[] { return this.paneView ? [this.paneView] : []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// React component
// ─────────────────────────────────────────────────────────────────────────────

export interface AnatomyChartProps {
  candles: ArtifactCandle[];
  events: ArtifactEvent[];
  cycles: ArtifactCycle[];
  regimeSeries: ArtifactRegimePoint[];
  selectedCycle: number | null;
  layers: LayerVisibility;
  height?: number;
  onChartReady?: (chart: IChartApi) => void;
}

export default function AnatomyChart({
  candles,
  events,
  cycles,
  regimeSeries,
  selectedCycle,
  layers,
  height = 560,
  onChartReady,
}: AnatomyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const regimePrimRef = useRef<RegimeBandsPrimitive | null>(null);
  const zonesPrimRef = useRef<CycleZonesPrimitive | null>(null);
  const eventsPrimRef = useRef<EventLayerPrimitive | null>(null);

  // create once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(226, 232, 240, 0.55)',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.025)' },
        horzLines: { color: 'rgba(255,255,255,0.025)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(94, 234, 212, 0.35)', labelBackgroundColor: '#134e4a' },
        horzLine: { color: 'rgba(94, 234, 212, 0.35)', labelBackgroundColor: '#134e4a' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.07)',
        scaleMargins: { top: 0.06, bottom: 0.16 }, // bottom margin clears the ER ribbon
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.07)',
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height,
    });
    const series = chart.addCandlestickSeries({
      upColor: 'rgba(16, 185, 129, 0.85)',
      downColor: 'rgba(239, 68, 68, 0.8)',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: 'rgba(16, 185, 129, 0.6)',
      wickDownColor: 'rgba(239, 68, 68, 0.6)',
    });

    const regimePrim = new RegimeBandsPrimitive({ points: [], firstSec: 0, lastSec: 0, visible: true });
    const zonesPrim = new CycleZonesPrimitive({ cycles: [], selectedIdx: null, firstSec: 0, lastSec: 0, visible: true });
    const eventsPrim = new EventLayerPrimitive({ events: [], showFills: true, showStructural: true });
    series.attachPrimitive(regimePrim);
    series.attachPrimitive(zonesPrim);
    series.attachPrimitive(eventsPrim);

    chartRef.current = chart;
    seriesRef.current = series;
    regimePrimRef.current = regimePrim;
    zonesPrimRef.current = zonesPrim;
    eventsPrimRef.current = eventsPrim;
    onChartReady?.(chart);

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // data updates
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    seriesRef.current.setData(
      candles.map(c => ({
        time: c.timestamp as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    if (candles.length === 0) return;
    const firstSec = candles[0].timestamp;
    const lastSec = candles[candles.length - 1].timestamp + 1800;
    regimePrimRef.current?.updateConfig({ points: regimeSeries, firstSec, lastSec, visible: layers.regime });
    zonesPrimRef.current?.updateConfig({ cycles, selectedIdx: selectedCycle, firstSec, lastSec, visible: layers.zones });
    eventsPrimRef.current?.updateConfig({ events, showFills: layers.fills, showStructural: layers.structural });
  }, [candles, events, cycles, regimeSeries, selectedCycle, layers]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
