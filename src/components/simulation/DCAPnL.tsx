'use client';

import { Direction, DCATradeRecord } from '@/lib/types';
import { DCATradeSnapshot } from '@/lib/strategies/dcaTypes';

interface DCAPnLProps {
  snapshots: DCATradeSnapshot[];
  trades: DCATradeRecord[];
  currentIdx: number;
  direction: Direction;
}

function formatPnl(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

export default function DCAPnL({ snapshots, trades, currentIdx, direction }: DCAPnLProps) {
  // Find closest snapshot at or before currentIdx
  const currentSnapshot = snapshots.reduce<DCATradeSnapshot | undefined>(
    (closest, s) => {
      if (s.candleIdx <= currentIdx && (!closest || s.candleIdx > closest.candleIdx)) {
        return s;
      }
      return closest;
    },
    undefined
  );

  // Trade summary: only count trades completed at or before currentIdx
  const completedTrades = trades.filter(t => t.closeTime <= (currentSnapshot?.timestamp ?? Infinity));
  const wins = completedTrades.filter(t => t.pnl > 0).length;
  const losses = completedTrades.filter(t => t.pnl < 0).length;
  const totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);

  const isLong = direction === 'LONG';
  const badgeClass = isLong ? 'badge-long' : 'badge-short';

  const stateBadge = (state: string) => {
    if (state === 'OPEN') return 'badge-long';
    if (state === 'CLOSING') return 'badge-fill';
    return 'badge-neutral';
  };

  return (
    <div className="card p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className={`badge ${badgeClass}`}>{direction}</span>
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          DCA Breakout
        </span>
      </div>

      {currentSnapshot ? (
        <>
          {/* State */}
          <div className="flex items-center gap-2">
            <span className={`badge ${stateBadge(currentSnapshot.state)}`}>
              {currentSnapshot.state}
            </span>
            {currentSnapshot.state === 'OPEN' && (
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                SO: {currentSnapshot.safetyOrdersFilled}
              </span>
            )}
          </div>

          {/* Open trade details */}
          {currentSnapshot.state === 'OPEN' && (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="stat-card" style={{ padding: '5px 8px' }}>
                <div className="stat-label" style={{ fontSize: 9 }}>Avg Entry</div>
                <div className="text-xs font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
                  ${currentSnapshot.avgEntryPrice.toFixed(2)}
                </div>
              </div>
              <div className="stat-card" style={{ padding: '5px 8px' }}>
                <div className="stat-label" style={{ fontSize: 9 }}>Invested</div>
                <div className="text-xs font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
                  ${currentSnapshot.totalInvested.toFixed(0)}
                </div>
              </div>
              {currentSnapshot.takeProfitPrice > 0 && (
                <div className="stat-card" style={{ padding: '5px 8px' }}>
                  <div className="stat-label" style={{ fontSize: 9 }}>TP</div>
                  <div className="text-xs font-mono font-bold" style={{ color: 'var(--grid-long)' }}>
                    ${currentSnapshot.takeProfitPrice.toFixed(2)}
                  </div>
                </div>
              )}
              {currentSnapshot.stopLossPrice > 0 && (
                <div className="stat-card" style={{ padding: '5px 8px' }}>
                  <div className="stat-label" style={{ fontSize: 9 }}>SL</div>
                  <div className="text-xs font-mono font-bold" style={{ color: 'var(--grid-short)' }}>
                    ${currentSnapshot.stopLossPrice.toFixed(2)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* P&L */}
          <div style={{ height: 1, background: 'var(--card-border)' }} />
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <div className="stat-label" style={{ fontSize: 9 }}>Unrealized</div>
              <div className={`text-xs font-mono font-bold ${currentSnapshot.unrealizedPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                {formatPnl(currentSnapshot.unrealizedPnl)}
              </div>
            </div>
            <div>
              <div className="stat-label" style={{ fontSize: 9 }}>Realized</div>
              <div className={`text-xs font-mono font-bold ${currentSnapshot.realizedPnlCumulative >= 0 ? 'text-profit' : 'text-loss'}`}>
                {formatPnl(currentSnapshot.realizedPnlCumulative)}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          No data yet
        </div>
      )}

      {/* Trade summary */}
      {completedTrades.length > 0 && (
        <>
          <div style={{ height: 1, background: 'var(--card-border)' }} />
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
              {completedTrades.length} trades
            </span>
            <span className="text-xs font-mono text-profit">{wins}W</span>
            <span className="text-xs font-mono text-loss">{losses}L</span>
            <span className={`text-xs font-mono font-bold ${totalPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
              {formatPnl(totalPnl)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
