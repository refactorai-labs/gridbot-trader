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
  LineData,
  SeriesMarker,
} from 'lightweight-charts';
import { OHLC, Direction, DCATradeRecord } from '@/lib/types';
import { DCATradeSnapshot } from '@/lib/strategies/dcaTypes';
import { getChartColors } from '@/lib/constants';
import { computeBB } from '@/lib/indicators/bollingerBandsB';

interface DCAChartProps {
  candles: OHLC[];
  side: Direction;
  snapshots: DCATradeSnapshot[];
  trades: DCATradeRecord[];
  currentCandleIdx: number;
  visibleCandleCount?: number;
  fitAll?: boolean;
  height?: number;
}

export default function DCAChart({
  candles,
  side,
  snapshots,
  trades,
  currentCandleIdx,
  visibleCandleCount = 80,
  fitAll,
  height = 400,
}: DCAChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const [theme, setTheme] = useState('dark');

  // Track theme changes
  useEffect(() => {
    const el = document.documentElement;
    setTheme(el.getAttribute('data-theme') || 'dark');
    const observer = new MutationObserver(() => {
      setTheme(el.getAttribute('data-theme') || 'dark');
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Find current snapshot
  const currentSnapshot = snapshots.reduce<DCATradeSnapshot | undefined>(
    (closest, s) => {
      if (s.candleIdx <= currentCandleIdx && (!closest || s.candleIdx > closest.candleIdx)) {
        return s;
      }
      return closest;
    },
    undefined
  );

  // Count completed trades up to current index
  const completedTradeCount = trades.filter(t => {
    // A trade is completed if its closeTime corresponds to a candle at or before currentCandleIdx
    const closeCandle = candles.findIndex(c => c.timestamp >= t.closeTime);
    return closeCandle !== -1 && closeCandle <= currentCandleIdx;
  }).length;

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

    // Bollinger Bands lines
    const bbColor = 'rgba(99, 102, 241, 0.4)';
    const bbUpper = chart.addLineSeries({
      color: bbColor,
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const bbLower = chart.addLineSeries({
      color: bbColor,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candlestickSeries;
    bbUpperRef.current = bbUpper;
    bbLowerRef.current = bbLower;

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
      candleSeriesRef.current = null;
      bbUpperRef.current = null;
      bbLowerRef.current = null;
    };
  }, [height, theme]);

  // Update candle data, BB, and markers
  const updateChart = useCallback(() => {
    if (!candleSeriesRef.current || candles.length === 0) return;

    const endIdx = Math.min(currentCandleIdx + 1, candles.length);
    const visibleCandles = candles.slice(0, endIdx);

    // Candle data
    const chartData: CandlestickData[] = visibleCandles.map(c => ({
      time: c.timestamp as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeriesRef.current.setData(chartData);

    // Bollinger Bands (period 20, deviation 2)
    if (bbUpperRef.current && bbLowerRef.current) {
      const closes = visibleCandles.map(c => c.close);
      const bb = computeBB(closes, 20, 2);

      const upperData: LineData[] = [];
      const lowerData: LineData[] = [];
      for (let i = 0; i < visibleCandles.length; i++) {
        if (!isNaN(bb.upper[i])) {
          upperData.push({ time: visibleCandles[i].timestamp as Time, value: bb.upper[i] });
          lowerData.push({ time: visibleCandles[i].timestamp as Time, value: bb.lower[i] });
        }
      }
      bbUpperRef.current.setData(upperData);
      bbLowerRef.current.setData(lowerData);
    }

    // Markers for entries and safety orders
    const markers: SeriesMarker<Time>[] = [];

    for (const trade of trades) {
      // Base order entry marker
      const entryCandle = candles.findIndex(c => c.timestamp >= trade.openTime);
      if (entryCandle !== -1 && entryCandle <= currentCandleIdx) {
        markers.push({
          time: candles[entryCandle].timestamp as Time,
          position: side === 'LONG' ? 'belowBar' : 'aboveBar',
          color: '#10b981',
          shape: side === 'LONG' ? 'arrowUp' : 'arrowDown',
          text: `Entry #${trade.tradeNumber}`,
        });
      }

      // Close marker
      const closeCandle = candles.findIndex(c => c.timestamp >= trade.closeTime);
      if (closeCandle !== -1 && closeCandle <= currentCandleIdx) {
        const isProfit = trade.pnl >= 0;
        markers.push({
          time: candles[closeCandle].timestamp as Time,
          position: side === 'LONG' ? 'aboveBar' : 'belowBar',
          color: isProfit ? '#10b981' : '#ef4444',
          shape: side === 'LONG' ? 'arrowDown' : 'arrowUp',
          text: `${trade.closeReason.replace('_', ' ')} ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}`,
        });
      }
    }

    // Sort markers by time (required by lightweight-charts)
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candleSeriesRef.current.setMarkers(markers);

    // Auto-scroll
    if (chartRef.current) {
      if (fitAll) {
        chartRef.current.timeScale().fitContent();
      } else {
        chartRef.current.timeScale().setVisibleLogicalRange({
          from: Math.max(0, chartData.length - visibleCandleCount),
          to: chartData.length,
        });
      }
    }
  }, [candles, currentCandleIdx, trades, side, theme, visibleCandleCount, fitAll]);

  useEffect(() => {
    updateChart();
  }, [updateChart]);

  // Reset Y-axis auto-scale when view mode changes
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.priceScale('right').applyOptions({ autoScale: true });
    }
  }, [fitAll]);

  // Update price lines (TP, SL, avg entry)
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Remove old price lines
    for (const line of priceLinesRef.current) {
      candleSeriesRef.current.removePriceLine(line);
    }
    priceLinesRef.current = [];

    if (!currentSnapshot || currentSnapshot.state !== 'OPEN') return;

    const colors = getChartColors();

    // Take profit line
    if (currentSnapshot.takeProfitPrice > 0) {
      const tpLine = candleSeriesRef.current.createPriceLine({
        price: currentSnapshot.takeProfitPrice,
        color: colors.longGrid,
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: 'TP',
      });
      priceLinesRef.current.push(tpLine);
    }

    // Stop loss line
    if (currentSnapshot.stopLossPrice > 0) {
      const slLine = candleSeriesRef.current.createPriceLine({
        price: currentSnapshot.stopLossPrice,
        color: colors.shortGrid,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'SL',
      });
      priceLinesRef.current.push(slLine);
    }

    // Average entry line
    if (currentSnapshot.avgEntryPrice > 0) {
      const avgLine = candleSeriesRef.current.createPriceLine({
        price: currentSnapshot.avgEntryPrice,
        color: colors.fillFlash,
        lineWidth: 1,
        lineStyle: 0, // solid
        axisLabelVisible: true,
        title: 'Avg',
      });
      priceLinesRef.current.push(avgLine);
    }
  }, [currentSnapshot, theme]);

  const isLong = side === 'LONG';
  const badgeClass = isLong ? 'badge-long' : 'badge-short';

  return (
    <div className="relative">
      {/* Chart header */}
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--card-border)' }}>
        <div className="flex items-center gap-2">
          <span className={`badge ${badgeClass}`}>{side}</span>
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            DCA Breakout
          </span>
        </div>
        <div className="flex items-center gap-2">
          {currentSnapshot && (
            <span className={`badge ${currentSnapshot.state === 'OPEN' ? 'badge-long' : 'badge-neutral'}`}>
              {currentSnapshot.state}
            </span>
          )}
          <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {completedTradeCount} trades
          </span>
        </div>
      </div>
      {/* Chart container */}
      <div ref={containerRef} />
    </div>
  );
}
