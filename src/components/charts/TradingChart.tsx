'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  IPriceLine,
  Time,
  ColorType,
} from 'lightweight-charts';
import { OHLC, GridLevel, GridSide } from '@/lib/types';
import { getChartColors } from '@/lib/constants';

interface TradingChartProps {
  candles: OHLC[];
  gridLevels: GridLevel[];
  side: GridSide;
  filledLevelIndices: Set<number>;
  visibleCandleCount?: number;
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
  visibleCandleCount,
  currentCandleIdx,
  supportLevel,
  resistanceLevel,
  height = 400,
}: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

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

    // Handle resize
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height, theme]);

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
    if (chartRef.current && visibleCandleCount) {
      chartRef.current.timeScale().setVisibleLogicalRange({
        from: Math.max(0, chartData.length - visibleCandleCount),
        to: chartData.length,
      });
    }
  }, [candles, currentCandleIdx, visibleCandleCount, theme]);

  useEffect(() => {
    updateCandles();
  }, [updateCandles]);

  // Update grid level price lines
  useEffect(() => {
    if (!seriesRef.current) return;

    // Remove old price lines
    for (const line of priceLinesRef.current) {
      seriesRef.current.removePriceLine(line);
    }
    priceLinesRef.current = [];

    const colors = getChartColors();
    const lineColor = side === 'long' ? colors.longGrid : colors.shortGrid;

    // Add grid level lines
    for (const level of gridLevels) {
      const isFilled = filledLevelIndices.has(level.index);
      const line = seriesRef.current.createPriceLine({
        price: level.price,
        color: isFilled ? colors.fillFlash : lineColor,
        lineWidth: isFilled ? 2 : 1,
        lineStyle: isFilled ? 0 : 2, // Solid if filled, dashed if pending
        axisLabelVisible: true,
        title: `L${level.index}`,
        lineVisible: true,
      });
      priceLinesRef.current.push(line);
    }

    // Add S/R zone lines
    if (supportLevel && side === 'long') {
      const line = seriesRef.current.createPriceLine({
        price: supportLevel,
        color: colors.longGrid,
        lineWidth: 2,
        lineStyle: 1,
        axisLabelVisible: true,
        title: 'Support',
      });
      priceLinesRef.current.push(line);
    }

    if (resistanceLevel && side === 'short') {
      const line = seriesRef.current.createPriceLine({
        price: resistanceLevel,
        color: colors.shortGrid,
        lineWidth: 2,
        lineStyle: 1,
        axisLabelVisible: true,
        title: 'Resistance',
      });
      priceLinesRef.current.push(line);
    }
  }, [gridLevels, filledLevelIndices, side, supportLevel, resistanceLevel, theme]);

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
