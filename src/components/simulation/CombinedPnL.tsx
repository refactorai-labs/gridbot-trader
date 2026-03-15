'use client';

import { TrendingUp, TrendingDown, Activity, Shield } from 'lucide-react';
import { TrendDirection } from '@/lib/types';

interface CombinedPnLProps {
  totalEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  longPnl: number;
  shortPnl: number;
  longMultiplier: number;
  shortMultiplier: number;
  trend: TrendDirection;
  deRiskPhase: string;
  initialCapital: number;
}

export default function CombinedPnL({
  totalEquity,
  realizedPnl,
  unrealizedPnl,
  longPnl,
  shortPnl,
  longMultiplier,
  shortMultiplier,
  trend,
  deRiskPhase,
  initialCapital,
}: CombinedPnLProps) {
  const totalPnl = realizedPnl + unrealizedPnl;
  const pnlPct = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;
  const isProfit = totalPnl >= 0;

  return (
    <div className="card p-3 flex flex-col gap-3 min-w-[180px]">
      {/* Total P&L */}
      <div>
        <div className="stat-label">Total P&L</div>
        <div className={`stat-value ${isProfit ? 'text-profit' : 'text-loss'}`}>
          {isProfit ? '+' : ''}{totalPnl.toFixed(2)}
          <span className="text-xs ml-1">
            ({isProfit ? '+' : ''}{pnlPct.toFixed(2)}%)
          </span>
        </div>
      </div>

      {/* Equity */}
      <div>
        <div className="stat-label">Equity</div>
        <div className="stat-value text-sm">${totalEquity.toFixed(2)}</div>
      </div>

      {/* Long/Short breakdown */}
      <div className="grid grid-cols-2 gap-2">
        <div className="stat-card">
          <div className="flex items-center gap-1 mb-1">
            <TrendingUp size={10} className="text-grid-long" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Long</span>
          </div>
          <div className={`text-xs font-mono font-bold ${longPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
            {longPnl >= 0 ? '+' : ''}{longPnl.toFixed(2)}
          </div>
          <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {(longMultiplier * 100).toFixed(0)}% active
          </div>
        </div>
        <div className="stat-card">
          <div className="flex items-center gap-1 mb-1">
            <TrendingDown size={10} className="text-grid-short" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Short</span>
          </div>
          <div className={`text-xs font-mono font-bold ${shortPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
            {shortPnl >= 0 ? '+' : ''}{shortPnl.toFixed(2)}
          </div>
          <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {(shortMultiplier * 100).toFixed(0)}% active
          </div>
        </div>
      </div>

      {/* Adaptive status */}
      <div className="stat-card">
        <div className="flex items-center gap-1.5 mb-1">
          <Activity size={10} style={{ color: 'var(--adaptive-accent)' }} />
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Adaptive</span>
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
