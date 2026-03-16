'use client';

import { TrendingUp, TrendingDown, Activity, Shield } from 'lucide-react';
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
}

function formatPnl(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatPct(value: number, base: number): string {
  if (base <= 0) return '0.00%';
  const pct = (value / base) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
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
}: CombinedPnLProps) {
  const totalPnl = realizedPnl + unrealizedPnl;
  const isProfit = totalPnl >= 0;
  const isGridProfit = realizedPnl >= 0;
  const longTotal = longRealizedPnl + longUnrealizedPnl;
  const shortTotal = shortRealizedPnl + shortUnrealizedPnl;

  return (
    <div className="card p-3 flex flex-col gap-2.5 min-w-[180px]">
      {/* Total P&L — hero metric */}
      <div>
        <div className="stat-label">Total P&L</div>
        <div className={`stat-value ${isProfit ? 'text-profit' : 'text-loss'}`}>
          {formatPnl(totalPnl)}
          <span className="text-xs ml-1 font-normal">
            {formatPct(totalPnl, initialCapital)}
          </span>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--card-border)' }} />

      {/* Grid Profit — realized only */}
      <div>
        <div className="stat-label flex items-center gap-1.5">
          <span>Grid Profit</span>
          <span className="badge badge-fill" style={{ fontSize: 9, padding: '1px 4px', lineHeight: '1.2' }}>
            realized
          </span>
        </div>
        <div className={`text-sm font-mono font-bold ${isGridProfit ? 'text-profit' : 'text-loss'}`}>
          {formatPnl(realizedPnl)}
          <span className="text-xs ml-1 font-normal">
            {formatPct(realizedPnl, initialCapital)}
          </span>
        </div>
      </div>

      {/* Per-side grid profit breakdown */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="stat-card" style={{ padding: '6px 8px' }}>
          <div className="flex items-center gap-1 mb-0.5">
            <TrendingUp size={9} className="text-grid-long" />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Long</span>
          </div>
          <div className={`font-mono font-bold ${longRealizedPnl >= 0 ? 'text-profit' : 'text-loss'}`} style={{ fontSize: 11 }}>
            {formatPnl(longRealizedPnl)}
          </div>
        </div>
        <div className="stat-card" style={{ padding: '6px 8px' }}>
          <div className="flex items-center gap-1 mb-0.5">
            <TrendingDown size={9} className="text-grid-short" />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Short</span>
          </div>
          <div className={`font-mono font-bold ${shortRealizedPnl >= 0 ? 'text-profit' : 'text-loss'}`} style={{ fontSize: 11 }}>
            {formatPnl(shortRealizedPnl)}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--card-border)' }} />

      {/* Unrealized + Equity row */}
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <div className="stat-label" style={{ fontSize: 9 }}>Unrealized</div>
          <div className={`text-xs font-mono font-bold ${unrealizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
            {formatPnl(unrealizedPnl)}
          </div>
        </div>
        <div>
          <div className="stat-label" style={{ fontSize: 9 }}>Equity</div>
          <div className="text-xs font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
            ${totalEquity.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Per-side total P&L (realized + unrealized) */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="stat-card" style={{ padding: '5px 8px' }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>Long total</div>
          <div className={`font-mono font-bold ${longTotal >= 0 ? 'text-profit' : 'text-loss'}`} style={{ fontSize: 11 }}>
            {formatPnl(longTotal)}
          </div>
          <div className="font-mono" style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>
            {(longMultiplier * 100).toFixed(0)}% active
          </div>
        </div>
        <div className="stat-card" style={{ padding: '5px 8px' }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>Short total</div>
          <div className={`font-mono font-bold ${shortTotal >= 0 ? 'text-profit' : 'text-loss'}`} style={{ fontSize: 11 }}>
            {formatPnl(shortTotal)}
          </div>
          <div className="font-mono" style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 1 }}>
            {(shortMultiplier * 100).toFixed(0)}% active
          </div>
        </div>
      </div>

      {/* Adaptive status */}
      <div className="stat-card" style={{ padding: '6px 8px' }}>
        <div className="flex items-center gap-1.5 mb-0.5">
          <Activity size={10} style={{ color: 'var(--adaptive-accent)' }} />
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Adaptive</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-mono font-bold trend-${trend}`}>
            {trend === 'bullish' ? '▲' : trend === 'bearish' ? '▼' : '◆'} {trend}
          </span>
        </div>
        {deRiskPhase !== 'none' && (
          <div className="flex items-center gap-1 mt-1">
            <Shield size={10} className="text-grid-fill" />
            <span className="text-xs font-mono text-grid-fill">
              De-risk: {deRiskPhase}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
