'use client';

import { TrendingUp, TrendingDown, BarChart3, Target, Activity } from 'lucide-react';
import { SimulationSummary } from '@/lib/types';

interface PerformanceSummaryProps {
  simulation: SimulationSummary;
}

export default function PerformanceSummary({ simulation }: PerformanceSummaryProps) {
  const winRate = simulation.totalTrades && simulation.winCount != null
    ? ((simulation.winCount / (simulation.winCount + (simulation.lossCount || 0))) * 100)
    : 0;

  const stats = [
    {
      label: 'Total P&L',
      value: simulation.totalPnl != null ? `$${simulation.totalPnl.toFixed(2)}` : '—',
      pct: simulation.totalPnlPct != null ? `${simulation.totalPnlPct.toFixed(2)}%` : '',
      color: (simulation.totalPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss',
      icon: (simulation.totalPnl ?? 0) >= 0 ? TrendingUp : TrendingDown,
    },
    {
      label: 'Long P&L',
      value: simulation.longPnl != null ? `$${simulation.longPnl.toFixed(2)}` : '—',
      color: (simulation.longPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss',
      icon: TrendingUp,
    },
    {
      label: 'Short P&L',
      value: simulation.shortPnl != null ? `$${simulation.shortPnl.toFixed(2)}` : '—',
      color: (simulation.shortPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss',
      icon: TrendingDown,
    },
    {
      label: 'Total Trades',
      value: simulation.totalTrades?.toString() ?? '—',
      color: '',
      icon: BarChart3,
    },
    {
      label: 'Win Rate',
      value: winRate > 0 ? `${winRate.toFixed(1)}%` : '—',
      color: winRate >= 50 ? 'text-profit' : winRate > 0 ? 'text-loss' : '',
      icon: Target,
    },
    {
      label: 'Max Drawdown',
      value: simulation.maxDrawdown != null ? `$${simulation.maxDrawdown.toFixed(2)}` : '—',
      pct: simulation.maxDrawdownPct != null ? `${simulation.maxDrawdownPct.toFixed(2)}%` : '',
      color: 'text-loss',
      icon: Activity,
    },
  ];

  return (
    <div className="card p-4">
      <span className="card-header text-xs block mb-3">Performance Summary</span>
      <div className="grid grid-cols-3 gap-3">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="stat-card">
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={12} style={{ color: 'var(--text-muted)' }} />
                <span className="stat-label">{stat.label}</span>
              </div>
              <div className={`stat-value text-base ${stat.color}`}>
                {stat.value}
                {stat.pct && (
                  <span className="text-xs ml-1" style={{ color: 'var(--text-muted)' }}>
                    ({stat.pct})
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
