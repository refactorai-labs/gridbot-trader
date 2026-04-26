'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  IChartApi,
  IChartApiBase,
  ISeriesApi,
  CandlestickData,
  LineData,
  SeriesMarker,
  LineStyle,
  Time,
  ColorType,
  ISeriesPrimitivePaneView,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitiveAxisView,
  SeriesAttachedParameter,
  SeriesType,
} from 'lightweight-charts';
import { CanvasRenderingTarget2D } from 'fancy-canvas';
import { OHLC, GridLevel, GridSide } from '@/lib/types';
import { getChartColors } from '@/lib/constants';

// ── Fill data for trade markers ──
export interface GridFill {
  candleIdx: number;
  price: number;
  type: 'buy' | 'sell';
}

// ── GridZone Background Primitive (zone fill + grid lines + boundary labels) ──
// zOrder: 'bottom' — renders behind candles. Used by both grid-bot and combo-bot
// chart paths to set the level/zone context.

interface GridZoneBackgroundConfig {
  levels: GridLevel[];
  side: GridSide;
  filledIndices: Set<number>;
  currentPrice: number;
}

class GridZoneBackgroundRenderer implements ISeriesPrimitivePaneRenderer {
  private _config: GridZoneBackgroundConfig;
  private _series: ISeriesApi<SeriesType, Time>;

  constructor(config: GridZoneBackgroundConfig, series: ISeriesApi<SeriesType, Time>) {
    this._config = config;
    this._series = series;
  }

  drawBackground(target: CanvasRenderingTarget2D) {
    const { levels, side, filledIndices } = this._config;
    if (levels.length === 0) return;

    const prices = levels.map(l => l.price);
    const upperPrice = Math.max(...prices);
    const lowerPrice = Math.min(...prices);

    const upperY = this._series.priceToCoordinate(upperPrice);
    const lowerY = this._series.priceToCoordinate(lowerPrice);
    if (upperY === null || lowerY === null) return;

    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const width = scope.bitmapSize.width;

      const colors = getChartColors();

      // Zone fill
      const fillColor = side === 'long' ? colors.longZoneFill : colors.shortZoneFill;
      const y1 = Math.round(upperY * vRatio);
      const y2 = Math.round(lowerY * vRatio);
      ctx.fillStyle = fillColor;
      ctx.fillRect(0, Math.min(y1, y2), width, Math.abs(y2 - y1));

      // Grid lines (filled = solid + bright; unfilled = dashed + dim)
      const lineColor = side === 'long' ? colors.longGridLine : colors.shortGridLine;
      const filledColor = side === 'long' ? colors.longGridFilled : colors.shortGridFilled;

      for (const level of levels) {
        const y = this._series.priceToCoordinate(level.price);
        if (y === null) continue;

        const isFilled = filledIndices.has(level.index);
        const py = Math.round(y * vRatio);

        ctx.beginPath();
        ctx.strokeStyle = isFilled ? filledColor : lineColor;
        ctx.lineWidth = isFilled ? 1.5 * ratio : 0.75 * ratio;
        if (!isFilled) ctx.setLineDash([4 * ratio, 4 * ratio]);
        else ctx.setLineDash([]);

        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
        ctx.stroke();
      }

      ctx.setLineDash([]);
    });
  }

  // No foreground draw — fill markers live in their own top-zOrder primitive.
  draw() {}
}

class GridZoneBackgroundPaneView implements ISeriesPrimitivePaneView {
  private _config: GridZoneBackgroundConfig;
  private _series: ISeriesApi<SeriesType, Time>;

  constructor(config: GridZoneBackgroundConfig, series: ISeriesApi<SeriesType, Time>) {
    this._config = config;
    this._series = series;
  }

  update(config: GridZoneBackgroundConfig) {
    this._config = config;
  }

  zOrder(): 'bottom' {
    return 'bottom';
  }

  renderer(): ISeriesPrimitivePaneRenderer | null {
    return new GridZoneBackgroundRenderer(this._config, this._series);
  }
}

// ── GridFillMarker Primitive (hollow buy/sell circles) ──
// zOrder: 'top' — renders ABOVE candles so fills are never obscured by bodies.

interface GridFillMarkerConfig {
  fills: { time: Time; price: number; type: 'buy' | 'sell' }[];
}

class GridFillMarkerRenderer implements ISeriesPrimitivePaneRenderer {
  private _config: GridFillMarkerConfig;
  private _series: ISeriesApi<SeriesType, Time>;
  private _chart: IChartApiBase<Time>;

  constructor(config: GridFillMarkerConfig, series: ISeriesApi<SeriesType, Time>, chart: IChartApiBase<Time>) {
    this._config = config;
    this._series = series;
    this._chart = chart;
  }

  drawBackground() {}

  draw(target: CanvasRenderingTarget2D) {
    const { fills } = this._config;
    if (!fills || fills.length === 0) return;

    const colors = getChartColors();
    const timeScale = this._chart.timeScale();

    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;

      for (const fill of fills) {
        const x = timeScale.timeToCoordinate(fill.time);
        const y = this._series.priceToCoordinate(fill.price);
        if (x === null || y === null) continue;

        const bx = Math.round(x * hRatio);
        const by = Math.round(y * vRatio);
        const radius = 5.5 * hRatio;
        const isBuy = fill.type === 'buy';
        const color = isBuy ? colors.buyMarker : colors.sellMarker;

        // Outer glow (low-opacity halo)
        ctx.beginPath();
        ctx.arc(bx, by, radius + 2.5 * hRatio, 0, Math.PI * 2);
        ctx.fillStyle = isBuy ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)';
        ctx.fill();

        // Interior fill (translucent)
        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.fillStyle = isBuy ? 'rgba(34,197,94,0.20)' : 'rgba(239,68,68,0.20)';
        ctx.fill();

        // Crisp ring stroke
        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * hRatio;
        ctx.stroke();
      }
    });
  }
}

class GridFillMarkerPaneView implements ISeriesPrimitivePaneView {
  private _config: GridFillMarkerConfig;
  private _series: ISeriesApi<SeriesType, Time>;
  private _chart: IChartApiBase<Time>;

  constructor(config: GridFillMarkerConfig, series: ISeriesApi<SeriesType, Time>, chart: IChartApiBase<Time>) {
    this._config = config;
    this._series = series;
    this._chart = chart;
  }

  update(config: GridFillMarkerConfig) {
    this._config = config;
  }

  zOrder(): 'top' {
    return 'top';
  }

  renderer(): ISeriesPrimitivePaneRenderer | null {
    return new GridFillMarkerRenderer(this._config, this._series, this._chart);
  }
}

// ── ComboEventTick Primitive (vertical comb at bottom of pane) ──
// zOrder: 'top' — thin vertical mark per state-machine event, anchored to the
// chart's time axis. Lets the user see event timing and density even when the
// label glyphs are too small or off-screen.

interface ComboEventTick {
  time: Time;
  color: string;
}

interface ComboEventTickConfig {
  ticks: ComboEventTick[];
}

class ComboEventTickRenderer implements ISeriesPrimitivePaneRenderer {
  private _config: ComboEventTickConfig;
  private _chart: IChartApiBase<Time>;

  constructor(config: ComboEventTickConfig, chart: IChartApiBase<Time>) {
    this._config = config;
    this._chart = chart;
  }

  drawBackground() {}

  draw(target: CanvasRenderingTarget2D) {
    const { ticks } = this._config;
    if (!ticks || ticks.length === 0) return;
    const timeScale = this._chart.timeScale();

    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const height = scope.bitmapSize.height;

      const tickHeight = 24 * vRatio;
      const tickBottom = height - 4 * vRatio;
      const tickTop = tickBottom - tickHeight;

      ctx.lineWidth = 1 * hRatio;
      ctx.globalAlpha = 0.35;

      for (const t of ticks) {
        const x = timeScale.timeToCoordinate(t.time);
        if (x === null) continue;
        const bx = Math.round(x * hRatio);
        ctx.beginPath();
        ctx.strokeStyle = t.color;
        ctx.moveTo(bx, tickTop);
        ctx.lineTo(bx, tickBottom);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }
}

class ComboEventTickPaneView implements ISeriesPrimitivePaneView {
  private _config: ComboEventTickConfig;
  private _chart: IChartApiBase<Time>;

  constructor(config: ComboEventTickConfig, chart: IChartApiBase<Time>) {
    this._config = config;
    this._chart = chart;
  }

  update(config: ComboEventTickConfig) {
    this._config = config;
  }

  zOrder(): 'top' {
    return 'top';
  }

  renderer(): ISeriesPrimitivePaneRenderer | null {
    return new ComboEventTickRenderer(this._config, this._chart);
  }
}

class BoundaryAxisView implements ISeriesPrimitiveAxisView {
  private _label: string;
  private _price: number;
  private _currentPrice: number;
  private _side: GridSide;
  private _series: ISeriesApi<SeriesType, Time>;

  constructor(
    label: string,
    price: number,
    currentPrice: number,
    side: GridSide,
    series: ISeriesApi<SeriesType, Time>,
  ) {
    this._label = label;
    this._price = price;
    this._currentPrice = currentPrice;
    this._side = side;
    this._series = series;
  }

  coordinate(): number {
    const y = this._series.priceToCoordinate(this._price);
    return y ?? -1000;
  }

  text(): string {
    const pct = ((this._price - this._currentPrice) / this._currentPrice * 100).toFixed(1);
    const sign = Number(pct) >= 0 ? '+' : '';
    return `${this._label} ${this._price.toFixed(2)} (${sign}${pct}%)`;
  }

  textColor(): string {
    return this._side === 'long' ? '#10b981' : '#ef4444';
  }

  backColor(): string {
    const colors = getChartColors();
    return this._side === 'long' ? colors.longBoundary : colors.shortBoundary;
  }

  visible(): boolean {
    return true;
  }

  tickVisible(): boolean {
    return false;
  }
}

class GridZoneBackgroundPrimitive {
  private _config: GridZoneBackgroundConfig;
  private _paneView: GridZoneBackgroundPaneView | null = null;
  private _axisViews: BoundaryAxisView[] = [];
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _requestUpdate: (() => void) | null = null;

  constructor(config: GridZoneBackgroundConfig) {
    this._config = config;
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    this._paneView = new GridZoneBackgroundPaneView(this._config, param.series);
    this._rebuildAxisViews();
  }

  detached() {
    this._series = null;
    this._requestUpdate = null;
    this._paneView = null;
    this._axisViews = [];
  }

  updateConfig(config: GridZoneBackgroundConfig) {
    this._config = config;
    if (this._paneView) this._paneView.update(config);
    this._rebuildAxisViews();
    this._requestUpdate?.();
  }

  updateAllViews() {}

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this._paneView ? [this._paneView] : [];
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this._axisViews;
  }

  private _rebuildAxisViews() {
    if (!this._series || this._config.levels.length === 0) {
      this._axisViews = [];
      return;
    }
    const prices = this._config.levels.map(l => l.price);
    const upperPrice = Math.max(...prices);
    const lowerPrice = Math.min(...prices);
    this._axisViews = [
      new BoundaryAxisView('High', upperPrice, this._config.currentPrice, this._config.side, this._series),
      new BoundaryAxisView('Low', lowerPrice, this._config.currentPrice, this._config.side, this._series),
    ];
  }
}

class GridFillMarkerPrimitive {
  private _config: GridFillMarkerConfig;
  private _paneView: GridFillMarkerPaneView | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;

  constructor(config: GridFillMarkerConfig) {
    this._config = config;
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._series = param.series;
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
    this._paneView = new GridFillMarkerPaneView(this._config, param.series, param.chart);
  }

  detached() {
    this._series = null;
    this._chart = null;
    this._requestUpdate = null;
    this._paneView = null;
  }

  updateConfig(config: GridFillMarkerConfig) {
    this._config = config;
    if (this._paneView) this._paneView.update(config);
    this._requestUpdate?.();
  }

  updateAllViews() {}

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this._paneView ? [this._paneView] : [];
  }
}

class ComboEventTickPrimitive {
  private _config: ComboEventTickConfig;
  private _paneView: ComboEventTickPaneView | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;

  constructor(config: ComboEventTickConfig) {
    this._config = config;
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
    this._paneView = new ComboEventTickPaneView(this._config, param.chart);
  }

  detached() {
    this._chart = null;
    this._requestUpdate = null;
    this._paneView = null;
  }

  updateConfig(config: ComboEventTickConfig) {
    this._config = config;
    if (this._paneView) this._paneView.update(config);
    this._requestUpdate?.();
  }

  updateAllViews() {}

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this._paneView ? [this._paneView] : [];
  }
}

// ── TradingChart Component ──

// ── Combo overlay data shape (optional) ─────────────────────────────────────
// Only consumed when `combo` prop is passed — keeps the existing grid/DCA chart
// calls unchanged.

export interface ComboOverlayVisibility {
  avwap: boolean;
  phaseMarkers: boolean;
  slMarkers: boolean;
  reopenMarkers: boolean;
  // Future extension points (rendering not yet implemented):
  slLines: boolean;
  pauseShading: boolean;
}

export interface ComboPhaseMarker {
  candleIdx: number;
  type: 'breakout_entered' | 'cooldown_entered' | 'hibernation_entered' | 'hibernation_exit' | 'cycle_complete';
  side: GridSide;
}

export interface ComboTierMarker {
  candleIdx: number;
  tier: 1 | 2 | 3;
  side: GridSide;
}

export interface ComboSLMarker {
  candleIdx: number;
  price: number;
  side: GridSide;
}

export interface ComboOverlayData {
  /** Point series for Anchored VWAP (one value per candle, NaN when unset). */
  avwapSeries?: number[];
  phaseMarkers?: ComboPhaseMarker[];
  tierMarkers?: ComboTierMarker[];
  slMarkers?: ComboSLMarker[];
  visibility?: Partial<ComboOverlayVisibility>;
}

interface TradingChartProps {
  candles: OHLC[];
  gridLevels: GridLevel[];
  side: GridSide;
  filledLevelIndices: Set<number>;
  fills?: GridFill[];
  visibleCandleCount?: number;
  fitAll?: boolean;
  currentCandleIdx?: number;
  supportLevel?: number;
  resistanceLevel?: number;
  height?: number;
  combo?: ComboOverlayData;
}

export default function TradingChart({
  candles,
  gridLevels,
  side,
  filledLevelIndices,
  fills,
  visibleCandleCount,
  fitAll,
  currentCandleIdx,
  height = 400,
  combo,
}: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const bgPrimitiveRef = useRef<GridZoneBackgroundPrimitive | null>(null);
  const fillMarkerPrimitiveRef = useRef<GridFillMarkerPrimitive | null>(null);
  const eventTickPrimitiveRef = useRef<ComboEventTickPrimitive | null>(null);
  const avwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Track theme changes
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    const el = document.documentElement;
    setTheme(el.getAttribute('data-theme') || 'dark');
    const observer = new MutationObserver(() => {
      setTheme(el.getAttribute('data-theme') || 'dark');
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    const colors = getChartColors();
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: colors.gridLines },
        horzLines: { color: colors.gridLines },
      },
      crosshair: {
        vertLine: { color: colors.crosshair, width: 1, style: 3 },
        horzLine: { color: colors.crosshair, width: 1, style: 3 },
      },
      rightPriceScale: {
        borderColor: colors.scaleBorder,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: colors.scaleBorder,
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height,
    });

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: colors.upCandle,
      downColor: colors.downCandle,
      borderUpColor: colors.upCandle,
      borderDownColor: colors.downCandle,
      wickUpColor: colors.upCandle,
      wickDownColor: colors.downCandle,
    });

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;

    // AVWAP line series (used only when `combo` prop is passed with overlay data)
    const avwapSeries = chart.addLineSeries({
      color: theme === 'light' ? '#a16207' : '#facc15',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    avwapSeriesRef.current = avwapSeries;

    // Background primitive (zone fill + grid lines + boundary axis labels), zOrder 'bottom'.
    const bgPrimitive = new GridZoneBackgroundPrimitive({
      levels: [],
      side,
      filledIndices: new Set(),
      currentPrice: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candlestickSeries.attachPrimitive(bgPrimitive as any);
    bgPrimitiveRef.current = bgPrimitive;

    // Fill-marker primitive (hollow buy/sell circles), zOrder 'top' — never obscured by candles.
    const fillMarkerPrimitive = new GridFillMarkerPrimitive({ fills: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candlestickSeries.attachPrimitive(fillMarkerPrimitive as any);
    fillMarkerPrimitiveRef.current = fillMarkerPrimitive;

    // Event-tick primitive (vertical comb at bottom of pane), zOrder 'top'.
    const eventTickPrimitive = new ComboEventTickPrimitive({ ticks: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candlestickSeries.attachPrimitive(eventTickPrimitive as any);
    eventTickPrimitiveRef.current = eventTickPrimitive;

    // Handle resize
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (bgPrimitiveRef.current) candlestickSeries.detachPrimitive(bgPrimitiveRef.current as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (fillMarkerPrimitiveRef.current) candlestickSeries.detachPrimitive(fillMarkerPrimitiveRef.current as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (eventTickPrimitiveRef.current) candlestickSeries.detachPrimitive(eventTickPrimitiveRef.current as any);
      bgPrimitiveRef.current = null;
      fillMarkerPrimitiveRef.current = null;
      eventTickPrimitiveRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      avwapSeriesRef.current = null;
    };
  }, [height, theme, side]);

  // Update candle data
  const updateCandles = useCallback(() => {
    if (!seriesRef.current || candles.length === 0) return;

    const endIdx = currentCandleIdx !== undefined
      ? Math.min(currentCandleIdx + 1, candles.length)
      : candles.length;

    const visibleCandles = candles.slice(0, endIdx);

    const chartData: CandlestickData[] = visibleCandles.map(c => ({
      time: c.timestamp as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    seriesRef.current.setData(chartData);

    // Auto-scroll to latest candle
    if (chartRef.current) {
      if (fitAll) {
        chartRef.current.timeScale().fitContent();
      } else if (visibleCandleCount) {
        chartRef.current.timeScale().setVisibleLogicalRange({
          from: Math.max(0, chartData.length - visibleCandleCount),
          to: chartData.length,
        });
      }
    }
  }, [candles, currentCandleIdx, visibleCandleCount, fitAll, theme]);

  useEffect(() => {
    updateCandles();
  }, [updateCandles]);

  // Reset Y-axis auto-scale when view mode changes
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.priceScale('right').applyOptions({ autoScale: true });
    }
  }, [fitAll]);

  // Update background + fill-marker primitives.
  useEffect(() => {
    const endIdx = currentCandleIdx !== undefined
      ? Math.min(currentCandleIdx, candles.length - 1)
      : candles.length - 1;
    const currentPrice = candles[endIdx]?.close ?? 0;

    bgPrimitiveRef.current?.updateConfig({
      levels: gridLevels,
      side,
      filledIndices: filledLevelIndices,
      currentPrice,
    });

    if (fillMarkerPrimitiveRef.current) {
      const visibleFills = (fills ?? [])
        .filter(f => f.candleIdx <= endIdx && f.candleIdx < candles.length)
        .map(f => ({
          time: candles[f.candleIdx].timestamp as Time,
          price: f.price,
          type: f.type,
        }));
      fillMarkerPrimitiveRef.current.updateConfig({ fills: visibleFills });
    }
  }, [gridLevels, filledLevelIndices, side, candles, currentCandleIdx, fills, theme]);

  // ── Combo overlays — AVWAP line + event markers (opt-in via `combo` prop) ──
  useEffect(() => {
    if (!avwapSeriesRef.current) return;
    const showAvwap = combo?.visibility?.avwap !== false;
    if (!combo || !showAvwap || !combo.avwapSeries || combo.avwapSeries.length === 0) {
      avwapSeriesRef.current.setData([]);
      return;
    }
    const endIdx = currentCandleIdx !== undefined
      ? Math.min(currentCandleIdx + 1, candles.length)
      : candles.length;
    const data: LineData[] = [];
    for (let i = 0; i < Math.min(endIdx, combo.avwapSeries.length); i++) {
      const v = combo.avwapSeries[i];
      if (isFinite(v)) {
        data.push({ time: candles[i].timestamp as Time, value: v });
      }
    }
    avwapSeriesRef.current.setData(data);
  }, [combo, currentCandleIdx, candles]);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (!combo) {
      seriesRef.current.setMarkers([]);
      eventTickPrimitiveRef.current?.updateConfig({ ticks: [] });
      return;
    }
    const endIdx = currentCandleIdx !== undefined
      ? Math.min(currentCandleIdx, candles.length - 1)
      : candles.length - 1;

    const visibility: ComboOverlayVisibility = {
      avwap: true,
      phaseMarkers: true,
      slMarkers: true,
      reopenMarkers: true,
      slLines: true,
      pauseShading: true,
      ...(combo.visibility ?? {}),
    };

    const markers: SeriesMarker<Time>[] = [];
    const pushIfVisible = (candleIdx: number, m: SeriesMarker<Time>) => {
      if (candleIdx > endIdx || candleIdx < 0 || candleIdx >= candles.length) return;
      markers.push({ ...m, time: candles[candleIdx].timestamp as Time });
    };

    if (visibility.phaseMarkers && combo.phaseMarkers) {
      for (const p of combo.phaseMarkers) {
        const color = p.type === 'breakout_entered'  ? '#f59e0b'
                    : p.type === 'cooldown_entered'  ? '#64748b'
                    : p.type === 'hibernation_entered' ? '#4a5563'
                    : p.type === 'hibernation_exit'  ? '#8a94a6'
                    : '#10b981'; // cycle_complete
        const text = p.type === 'breakout_entered' ? 'BRK'
                   : p.type === 'cooldown_entered' ? 'CD'
                   : p.type === 'hibernation_entered' ? 'HIB'
                   : p.type === 'hibernation_exit' ? 'HE'
                   : 'OK';
        pushIfVisible(p.candleIdx, {
          time: 0 as Time,
          position: p.side === 'long' ? 'belowBar' : 'aboveBar',
          color,
          shape: 'circle',
          text,
          size: 0.8,
        });
      }
    }

    if (visibility.slMarkers && combo.slMarkers) {
      for (const s of combo.slMarkers) {
        pushIfVisible(s.candleIdx, {
          time: 0 as Time,
          position: s.side === 'long' ? 'belowBar' : 'aboveBar',
          color: '#ef4444',
          shape: s.side === 'long' ? 'arrowDown' : 'arrowUp',
          text: 'SL',
          size: 1,
        });
      }
    }

    if (visibility.reopenMarkers && combo.tierMarkers) {
      for (const t of combo.tierMarkers) {
        const color = t.tier === 1 ? '#f59e0b' : t.tier === 2 ? '#d946ef' : '#22d3ee';
        pushIfVisible(t.candleIdx, {
          time: 0 as Time,
          position: t.side === 'long' ? 'belowBar' : 'aboveBar',
          color,
          shape: 'square',
          text: `T${t.tier}`,
          size: 0.8,
        });
      }
    }

    // lightweight-charts requires markers in ascending-time order.
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    seriesRef.current.setMarkers(markers);

    // Push event-tick comb (per-event vertical mark anchored to the time axis).
    if (eventTickPrimitiveRef.current) {
      const ticks: ComboEventTick[] = [];
      const pushTickIfVisible = (candleIdx: number, color: string) => {
        if (candleIdx > endIdx || candleIdx < 0 || candleIdx >= candles.length) return;
        ticks.push({ time: candles[candleIdx].timestamp as Time, color });
      };
      if (visibility.phaseMarkers && combo.phaseMarkers) {
        for (const p of combo.phaseMarkers) {
          const color = p.type === 'breakout_entered'  ? '#f59e0b'
                      : p.type === 'cooldown_entered'  ? '#64748b'
                      : p.type === 'hibernation_entered' ? '#4a5563'
                      : p.type === 'hibernation_exit'  ? '#8a94a6'
                      : '#10b981'; // cycle_complete
          pushTickIfVisible(p.candleIdx, color);
        }
      }
      if (visibility.slMarkers && combo.slMarkers) {
        for (const s of combo.slMarkers) pushTickIfVisible(s.candleIdx, '#ef4444');
      }
      if (visibility.reopenMarkers && combo.tierMarkers) {
        for (const t of combo.tierMarkers) {
          const color = t.tier === 1 ? '#f59e0b' : t.tier === 2 ? '#d946ef' : '#22d3ee';
          pushTickIfVisible(t.candleIdx, color);
        }
      }
      ticks.sort((a, b) => (a.time as number) - (b.time as number));
      eventTickPrimitiveRef.current.updateConfig({ ticks });
    }
  }, [combo, candles, currentCandleIdx]);

  return (
    <div className="relative">
      {/* Chart header */}
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--card-border)' }}>
        <div className="flex items-center gap-2">
          <span className={`badge ${side === 'long' ? 'badge-long' : 'badge-short'}`}>
            {side.toUpperCase()}
          </span>
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {gridLevels.length} levels
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            Filled: {filledLevelIndices.size}/{gridLevels.length}
          </span>
        </div>
      </div>
      {/* Chart container */}
      <div ref={containerRef} style={{ width: '100%', height: `${height}px` }} />
    </div>
  );
}
