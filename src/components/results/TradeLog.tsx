'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';

interface TradeEntry {
  id: string;
  side: string;
  level: number;
  levelPrice: number;
  orderType: string;
  fillPrice?: number | null;
  fillCandleIdx?: number | null;
  pnl?: number | null;
  status: string;
}

interface TradeLogProps {
  trades: TradeEntry[];
}

export default function TradeLog({ trades }: TradeLogProps) {
  const [sideFilter, setSideFilter] = useState<'all' | 'long' | 'short'>('all');

  const filtered = sideFilter === 'all'
    ? trades
    : trades.filter(t => t.side === sideFilter);

  const exportCSV = () => {
    const headers = ['Side', 'Type', 'Level', 'Price', 'Fill Price', 'P&L', 'Status'];
    const rows = filtered.map(t => [
      t.side, t.orderType, t.level, t.levelPrice,
      t.fillPrice ?? '', t.pnl?.toFixed(4) ?? '', t.status,
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trade_log.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--hairline-strong)' }}
      >
        <div className="flex items-center gap-3">
          <span className="card-header text-xs">Trade Log</span>
          <span className="font-mono tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {filtered.length} trades
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Side filter */}
          <div
            className="flex items-center gap-0.5 rounded-md p-0.5"
            style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid var(--hairline)' }}
          >
            {(['all', 'long', 'short'] as const).map(s => (
              <button
                key={s}
                className={`speed-btn ${sideFilter === s ? 'active' : ''}`}
                onClick={() => setSideFilter(s)}
                style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            className="btn-secondary btn text-xs py-1 px-2 inline-flex items-center gap-1"
            onClick={exportCSV}
            title="Export CSV"
          >
            <Download size={12} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="max-h-72 overflow-y-auto">
        <table className="trade-log-table">
          <thead>
            <tr>
              <th>Side</th>
              <th>Type</th>
              <th>Lvl</th>
              <th>Price</th>
              <th style={{ textAlign: 'right' }}>P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
                  No trades to display
                </td>
              </tr>
            ) : (
              filtered.map((trade) => (
                <tr
                  key={trade.id}
                  className={trade.side === 'long' ? 'trade-row-long' : 'trade-row-short'}
                >
                  <td>
                    <span className={`badge ${trade.side === 'long' ? 'badge-long' : 'badge-short'}`}>
                      {trade.side}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {trade.orderType}
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>L{trade.level}</td>
                  <td style={{ color: 'var(--text-primary)' }}>
                    ${trade.fillPrice?.toFixed(2) ?? trade.levelPrice.toFixed(2)}
                  </td>
                  <td
                    className={trade.pnl == null ? '' : trade.pnl >= 0 ? 'text-profit' : 'text-loss'}
                    style={{ textAlign: 'right', fontWeight: 600 }}
                  >
                    {trade.pnl != null ? (trade.pnl >= 0 ? '+' : '') + trade.pnl.toFixed(4) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
