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

  const totalPnl = simulation.totalPnl ?? 0;
  const totalPnlPct = simulation.totalPnlPct ?? 0;
  const totalPnlPositive = totalPnl >= 0;
  const winRateGood = winRate >= 50;
  const winLossSummary =
    simulation.winCount != null
      ? `${simulation.winCount}W / ${simulation.lossCount ?? 0}L · ${simulation.totalTrades ?? 0} trades`
      : `${simulation.totalTrades ?? 0} trades`;

  const secondary = [
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

      {/* Hero metrics */}
      <div className="perf-hero-grid">
        <div className={`perf-hero-card ${totalPnlPositive ? 'profit' : 'loss'}`}>
          <div className="perf-hero-label">Total P&amp;L</div>
          <div className="perf-hero-value">
            {simulation.totalPnl != null
              ? `${totalPnl >= 0 ? '+' : '-'}$${Math.abs(totalPnl).toFixed(2)}`
              : '—'}
          </div>
          <div className="perf-hero-sub">
            {simulation.totalPnlPct != null && (
              <>
                {totalPnlPct >= 0 ? '+' : ''}{totalPnlPct.toFixed(2)}%
              </>
            )}
          </div>
        </div>
        <div className="perf-hero-card">
          <div className="perf-hero-label">
            <span className="inline-flex items-center gap-1.5">
              <Target size={10} style={{ color: 'var(--text-muted)' }} />
              Win Rate
            </span>
          </div>
          <div className="perf-hero-value" style={{ color: winRateGood ? 'var(--grid-long)' : (winRate > 0 ? 'var(--grid-short)' : 'var(--text-primary)') }}>
            {winRate > 0 ? winRate.toFixed(1) : '—'}
            {winRate > 0 && <span className="suffix">%</span>}
          </div>
          <div className="perf-hero-sub">{winLossSummary}</div>
        </div>
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {secondary.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="stat-card" style={{ padding: '10px 12px' }}>
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={11} style={{ color: 'var(--text-muted)' }} />
                <span className="stat-label" style={{ marginBottom: 0 }}>{stat.label}</span>
              </div>
              <div className={`stat-value ${stat.color}`} style={{ fontSize: 14 }}>
                {stat.value}
                {stat.pct && (
                  <span className="text-xs ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>
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
