'use client';

import { useMemo } from 'react';
import { Activity, Shield } from 'lucide-react';
import { TrendDirection } from '@/lib/types';

interface CombinedPnLProps {
  totalEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  longRealizedPnl: number;
  shortRealizedPnl: number;
  longUnrealizedPnl: number;
  shortUnrealizedPnl: number;
  longMultiplier: number;
  shortMultiplier: number;
  trend: TrendDirection;
  deRiskPhase: string;
  initialCapital: number;
  // DCA strategy (optional — backward compatible)
  dcaLongPnl?: number;
  dcaShortPnl?: number;
  dcaLongTrades?: number;
  dcaShortTrades?: number;
  // Equity history for sparkline (optional — falls back to no sparkline)
  equityHistory?: number[];
}

function formatPnl(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatPct(value: number, base: number): string {
  if (base <= 0) return '0.00%';
  const pct = (value / base) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

const SPARK_W = 240;
const SPARK_H = 56;
const SPARK_MAX_POINTS = 120;

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const stride = values.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(values[Math.floor(i * stride)]);
  }
  // ensure we always include the latest point so the sparkline ends on current
  if (out[out.length - 1] !== values[values.length - 1]) {
    out[out.length - 1] = values[values.length - 1];
  }
  return out;
}

interface SparkProps { points: number[]; baseline: number; }

function EquitySparkline({ points, baseline }: SparkProps) {
  if (points.length < 2) return null;
  const min = Math.min(...points, baseline);
  const max = Math.max(...points, baseline);
  const range = max - min || 1;
  const last = points[points.length - 1];
  const isProfit = last >= baseline;
  const colorClass = isProfit ? 'long' : 'short';
  const gradId = isProfit ? 'equity-spark-long-grad' : 'equity-spark-short-grad';

  const xStep = SPARK_W / (points.length - 1);
  const ys = points.map(v => SPARK_H - 4 - ((v - min) / range) * (SPARK_H - 8));
  const xs = points.map((_, i) => i * xStep);

  const linePts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const areaPath =
    `M${xs[0].toFixed(1)},${SPARK_H - 4} ` +
    xs.map((x, i) => `L${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ') +
    ` L${xs[xs.length - 1].toFixed(1)},${SPARK_H - 4} Z`;

  const baselineY = SPARK_H - 4 - ((baseline - min) / range) * (SPARK_H - 8);

  return (
    <svg className="equity-sparkline" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="equity-spark-long-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--grid-long)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--grid-long)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="equity-spark-short-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--grid-short)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--grid-short)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line className="spark-zero" x1="0" y1={baselineY} x2={SPARK_W} y2={baselineY} />
      <path className={`spark-area-${colorClass}`} d={areaPath} fill={`url(#${gradId})`} />
      <polyline className={`spark-line spark-line-${colorClass}`} points={linePts} />
      <circle
        className={`spark-dot spark-dot-${colorClass}`}
        cx={xs[xs.length - 1]}
        cy={ys[ys.length - 1]}
        r={3}
      />
    </svg>
  );
}

export default function CombinedPnL({
  totalEquity,
  realizedPnl,
  unrealizedPnl,
  longRealizedPnl,
  shortRealizedPnl,
  longUnrealizedPnl,
  shortUnrealizedPnl,
  longMultiplier,
  shortMultiplier,
  trend,
  deRiskPhase,
  initialCapital,
  dcaLongPnl,
  dcaShortPnl,
  dcaLongTrades,
  dcaShortTrades,
  equityHistory,
}: CombinedPnLProps) {
  const hasDCA = dcaLongPnl !== undefined || dcaShortPnl !== undefined;
  const dcaTotalPnl = (dcaLongPnl ?? 0) + (dcaShortPnl ?? 0);
  const totalPnl = realizedPnl + unrealizedPnl + (hasDCA ? dcaTotalPnl : 0);
  const isProfit = totalPnl >= 0;
  const longTotal = longRealizedPnl + longUnrealizedPnl;
  const shortTotal = shortRealizedPnl + shortUnrealizedPnl;

  const sparkPoints = useMemo(
    () => (equityHistory && equityHistory.length > 1 ? downsample(equityHistory, SPARK_MAX_POINTS) : []),
    [equityHistory],
  );

  return (
    <div className="card p-4 flex flex-col gap-3 min-w-[200px]">
      {/* Hero equity */}
      <div>
        <div className="stat-label" style={{ marginBottom: 4 }}>Equity</div>
        <div className="cpnl-hero">${totalEquity.toFixed(2)}</div>
        <div className="flex items-baseline gap-2 mt-1.5">
          <span
            className="font-mono font-bold tabular-nums"
            style={{
              fontSize: 13,
              color: isProfit ? 'var(--grid-long)' : 'var(--grid-short)',
            }}
          >
            {formatPnl(totalPnl)}
          </span>
          <span className={`cpnl-delta-chip ${isProfit ? '' : 'loss'}`}>
            {formatPct(totalPnl, initialCapital)}
          </span>
        </div>
      </div>

      {/* 2x2 breakdown */}
      <div
        className="grid grid-cols-2 gap-1.5 p-2.5 rounded-md"
        style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--hairline)' }}
      >
        <div>
          <div className="stat-label" style={{ fontSize: 9, marginBottom: 2 }}>Realized</div>
          <div
            className="font-mono font-bold tabular-nums"
            style={{ fontSize: 12, color: realizedPnl >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}
          >
            {formatPnl(realizedPnl)}
          </div>
        </div>
        <div>
          <div className="stat-label" style={{ fontSize: 9, marginBottom: 2 }}>Unrealized</div>
          <div
            className="font-mono font-bold tabular-nums"
            style={{ fontSize: 12, color: unrealizedPnl >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}
          >
            {formatPnl(unrealizedPnl)}
          </div>
        </div>
        <div>
          <div className="stat-label" style={{ fontSize: 9, marginBottom: 2 }}>Long total</div>
          <div
            className="font-mono font-bold tabular-nums"
            style={{ fontSize: 12, color: longTotal >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}
          >
            {formatPnl(longTotal)}
          </div>
        </div>
        <div>
          <div className="stat-label" style={{ fontSize: 9, marginBottom: 2 }}>Short total</div>
          <div
            className="font-mono font-bold tabular-nums"
            style={{ fontSize: 12, color: shortTotal >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}
          >
            {formatPnl(shortTotal)}
          </div>
        </div>
      </div>

      {/* DCA section — only when DCA data present */}
      {hasDCA && (
        <div className="grid grid-cols-2 gap-1.5">
          {dcaLongPnl !== undefined && (
            <div className="stat-card" style={{ padding: '6px 8px' }}>
              <div className="stat-label" style={{ fontSize: 9, marginBottom: 2 }}>DCA Long</div>
              <div
                className="font-mono font-bold tabular-nums"
                style={{ fontSize: 11, color: dcaLongPnl >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}
              >
                {formatPnl(dcaLongPnl)}
              </div>
              {dcaLongTrades !== undefined && (
                <div className="font-mono mt-0.5" style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                  {dcaLongTrades} trades
                </div>
              )}
            </div>
          )}
          {dcaShortPnl !== undefined && (
            <div className="stat-card" style={{ padding: '6px 8px' }}>
              <div className="stat-label" style={{ fontSize: 9, marginBottom: 2 }}>DCA Short</div>
              <div
                className="font-mono font-bold tabular-nums"
                style={{ fontSize: 11, color: dcaShortPnl >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}
              >
                {formatPnl(dcaShortPnl)}
              </div>
              {dcaShortTrades !== undefined && (
                <div className="font-mono mt-0.5" style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                  {dcaShortTrades} trades
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Per-side multiplier indicator (compact) */}
      {(longMultiplier !== 1 || shortMultiplier !== 1) && (
        <div className="grid grid-cols-2 gap-1.5">
          <div className="font-mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            L: <span style={{ color: 'var(--text-secondary)' }}>{(longMultiplier * 100).toFixed(0)}% active</span>
          </div>
          <div className="font-mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            S: <span style={{ color: 'var(--text-secondary)' }}>{(shortMultiplier * 100).toFixed(0)}% active</span>
          </div>
        </div>
      )}

      {/* Adaptive status — compact */}
      {(trend !== 'neutral' || deRiskPhase !== 'none') && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid var(--hairline)' }}>
          <Activity size={11} style={{ color: 'var(--adaptive-accent)' }} />
          <span className={`text-xs font-mono font-bold trend-${trend}`}>
            {trend === 'bullish' ? '▲' : trend === 'bearish' ? '▼' : '◆'} {trend}
          </span>
          {deRiskPhase !== 'none' && (
            <span className="ml-auto flex items-center gap-1">
              <Shield size={10} className="text-grid-fill" />
              <span className="text-xs font-mono text-grid-fill">{deRiskPhase}</span>
            </span>
          )}
        </div>
      )}

      {/* Sparkline */}
      {sparkPoints.length > 1 && (
        <div className="pt-2.5" style={{ borderTop: '1px solid var(--hairline)' }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="stat-label" style={{ fontSize: 9 }}>Equity Curve</span>
            <span className="font-mono tabular-nums" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
              {initialCapital.toFixed(0)} → {totalEquity.toFixed(0)}
            </span>
          </div>
          <EquitySparkline points={sparkPoints} baseline={initialCapital} />
        </div>
      )}
    </div>
  );
}
