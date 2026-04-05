'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  IChartApi,
  IChartApiBase,
  ISeriesApi,
  CandlestickData,
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

// ── GridZone Primitive (zone fill + grid lines + boundary labels) ──

interface GridZoneConfig {
  levels: GridLevel[];
  side: GridSide;
  filledIndices: Set<number>;
  currentPrice: number;
  fills: { time: Time; price: number; type: 'buy' | 'sell' }[];
}

class GridZoneRenderer implements ISeriesPrimitivePaneRenderer {
  private _config: GridZoneConfig;
  private _series: ISeriesApi<SeriesType, Time>;
  private _chart: IChartApiBase<Time>;

  constructor(config: GridZoneConfig, series: ISeriesApi<SeriesType, Time>, chart: IChartApiBase<Time>) {
    this._config = config;
    this._series = series;
    this._chart = chart;
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

      // Draw zone fill
      const fillColor = side === 'long' ? colors.longZoneFill : colors.shortZoneFill;
      const y1 = Math.round(upperY * vRatio);
      const y2 = Math.round(lowerY * vRatio);
      ctx.fillStyle = fillColor;
      ctx.fillRect(0, Math.min(y1, y2), width, Math.abs(y2 - y1));

      // Draw grid lines
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

        if (!isFilled) {
          ctx.setLineDash([4 * ratio, 4 * ratio]);
        } else {
          ctx.setLineDash([]);
        }

        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
        ctx.stroke();
      }

      ctx.setLineDash([]);
    });
  }

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
        const radius = 4.5 * hRatio;
        const isBuy = fill.type === 'buy';
        const color = isBuy ? colors.buyMarker : colors.sellMarker;

        // Outer glow
        ctx.beginPath();
        ctx.arc(bx, by, radius + 2 * hRatio, 0, Math.PI * 2);
        ctx.fillStyle = isBuy ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
        ctx.fill();

        // Subtle interior fill
        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.fillStyle = isBuy ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)';
        ctx.fill();

        // Crisp ring stroke
        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * hRatio;
        ctx.stroke();
      }
    });
  }
}

class GridZonePaneView implements ISeriesPrimitivePaneView {
  private _config: GridZoneConfig;
  private _series: ISeriesApi<SeriesType, Time>;
  private _chart: IChartApiBase<Time>;

  constructor(config: GridZoneConfig, series: ISeriesApi<SeriesType, Time>, chart: IChartApiBase<Time>) {
    this._config = config;
    this._series = series;
    this._chart = chart;
  }

  update(config: GridZoneConfig) {
    this._config = config;
  }

  zOrder(): 'bottom' {
    return 'bottom';
  }

  renderer(): ISeriesPrimitivePaneRenderer | null {
    return new GridZoneRenderer(this._config, this._series, this._chart);
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

class GridZonePrimitive {
  private _config: GridZoneConfig;
  private _paneView: GridZonePaneView | null = null;
  private _axisViews: BoundaryAxisView[] = [];
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _requestUpdate: (() => void) | null = null;

  constructor(config: GridZoneConfig) {
    this._config = config;
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>) {
    this._series = param.series;
    this._chart = param.chart;
    this._requestUpdate = param.requestUpdate;
    this._paneView = new GridZonePaneView(this._config, param.series, param.chart);
    this._rebuildAxisViews();
  }

  detached() {
    this._series = null;
    this._chart = null;
    this._requestUpdate = null;
    this._paneView = null;
    this._axisViews = [];
  }

  updateConfig(config: GridZoneConfig) {
    this._config = config;
    if (this._paneView) {
      this._paneView.update(config);
    }
    this._rebuildAxisViews();
    this._requestUpdate?.();
  }

  updateAllViews() {
    // called by lightweight-charts on viewport change
  }

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

// ── TradingChart Component ──

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
}: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const primitiveRef = useRef<GridZonePrimitive | null>(null);

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

    // Create and attach zone primitive
    const primitive = new GridZonePrimitive({
      levels: [],
      side,
      filledIndices: new Set(),
      currentPrice: 0,
      fills: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candlestickSeries.attachPrimitive(primitive as any);
    primitiveRef.current = primitive;

    // Handle resize
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      if (primitiveRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candlestickSeries.detachPrimitive(primitiveRef.current as any);
        primitiveRef.current = null;
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
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

  // Update grid zone primitive
  useEffect(() => {
    if (!primitiveRef.current) return;

    const endIdx = currentCandleIdx !== undefined
      ? Math.min(currentCandleIdx, candles.length - 1)
      : candles.length - 1;
    const currentPrice = candles[endIdx]?.close ?? 0;

    // Build fills array filtered by playback position
    const visibleFills = (fills ?? [])
      .filter(f => f.candleIdx <= endIdx && f.candleIdx < candles.length)
      .map(f => ({
        time: candles[f.candleIdx].timestamp as Time,
        price: f.price,
        type: f.type,
      }));

    primitiveRef.current.updateConfig({
      levels: gridLevels,
      side,
      filledIndices: filledLevelIndices,
      currentPrice,
      fills: visibleFills,
    });
  }, [gridLevels, filledLevelIndices, side, candles, currentCandleIdx, fills, theme]);

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
      <div ref={containerRef} />
    </div>
  );
}
