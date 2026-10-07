'use client';

import { TrendingUp, TrendingDown, BarChart3, Target, Activity, AlertCircle } from 'lucide-react';
import { SimulationSummary } from '@/lib/types';

interface PerformanceSummaryProps {
  simulation: SimulationSummary;
}

const money = (v: number | null | undefined) => (v != null ? `$${v.toFixed(2)}` : '—');
const signColor = (v: number | null | undefined) => ((v ?? 0) >= 0 ? 'text-profit' : 'text-loss');

export default function PerformanceSummary({ simulation }: PerformanceSummaryProps) {
  // Classic engine v1 rows: win rate over all round-trips (break-even included), totalTrades = fills.
  const isClassicV1 = !simulation.comboBotEnabled && (simulation.engineVersion ?? 0) >= 1;
  const v1Trips = simulation.roundTrips ?? (simulation.winCount ?? 0) + (simulation.lossCount ?? 0);
  const winRate = isClassicV1
    ? (v1Trips > 0 ? ((simulation.winCount ?? 0) / v1Trips) * 100 : 0)
    : simulation.totalTrades && simulation.winCount != null
    ? ((simulation.winCount / (simulation.winCount + (simulation.lossCount || 0))) * 100)
    : 0;

  const totalPnl = simulation.totalPnl ?? 0;
  const totalPnlPct = simulation.totalPnlPct ?? 0;
  const totalPnlPositive = totalPnl >= 0;
  const winRateGood = winRate >= 50;
  const winLossSummary = isClassicV1
    ? `${simulation.winCount ?? 0}W / ${simulation.lossCount ?? 0}L · ${v1Trips} round-trips`
    : simulation.winCount != null
      ? `${simulation.winCount}W / ${simulation.lossCount ?? 0}L · ${simulation.totalTrades ?? 0} trades`
      : `${simulation.totalTrades ?? 0} trades`;
  const showWinRate = isClassicV1 ? v1Trips > 0 : winRate > 0;

  const maxDrawdownStat = {
    label: 'Max Drawdown',
    value: money(simulation.maxDrawdown),
    pct: simulation.maxDrawdownPct != null ? `${simulation.maxDrawdownPct.toFixed(2)}%` : '',
    color: 'text-loss',
    icon: Activity,
  };

  const secondary: { label: string; value: string; pct?: string; color: string; icon: typeof Activity }[] = isClassicV1 ? [
    { label: 'Realized (gross)', value: money(simulation.realizedPnl), color: signColor(simulation.realizedPnl), icon: BarChart3 },
    { label: 'Fees', value: money(simulation.totalFees), color: 'text-loss', icon: BarChart3 },
    { label: 'Unrealized', value: money(simulation.unrealizedPnl), color: signColor(simulation.unrealizedPnl), icon: BarChart3 },
    maxDrawdownStat,
    { label: 'Long P&L', value: money(simulation.longPnl), color: signColor(simulation.longPnl), icon: TrendingUp },
    { label: 'Short P&L', value: money(simulation.shortPnl), color: signColor(simulation.shortPnl), icon: TrendingDown },
    { label: 'Fills', value: simulation.totalTrades?.toString() ?? '—', color: '', icon: BarChart3 },
    { label: 'Skipped Entries', value: simulation.skippedEntries?.toString() ?? '—', color: '', icon: AlertCircle },
  ] : [
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
    maxDrawdownStat,
  ];

  return (
    <div className="card p-4">
      <span className="card-header text-xs block mb-3">Performance Summary</span>

      {/* Hero metrics */}
      <div className="perf-hero-grid">
        <div className={`perf-hero-card ${totalPnlPositive ? 'profit' : 'loss'}`}>
          <div className="perf-hero-label">{isClassicV1 ? 'Total P&L (net)' : 'Total P&L'}</div>
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
              {isClassicV1 ? 'Win Rate (round-trips)' : 'Win Rate'}
            </span>
          </div>
          <div className="perf-hero-value" style={{ color: winRateGood ? 'var(--grid-long)' : (showWinRate ? 'var(--grid-short)' : 'var(--text-primary)') }}>
            {showWinRate ? winRate.toFixed(1) : '—'}
            {showWinRate && <span className="suffix">%</span>}
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
