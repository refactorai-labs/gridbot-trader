'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

// Per-order diagnostics of a classic v1 run (entry_skipped streaks, restoration
// entries). They never enter the replay payload; this log pages through them via
// GET /api/simulations/[id]/events. Candle indexes are 5m execution indexes.

const PAGE_SIZE = 200;
const TYPES = 'entry_skipped,restoration_entry';

interface DiagnosticEvent {
  id: string | number;
  candleIdx: number;
  timestamp: number;
  eventType: string;
  details: Record<string, unknown> | string | null;
}

interface EventLogProps {
  simulationId: string;
  total: number; // diagnosticEventCount from the replay payload
}

function parseDetails(details: DiagnosticEvent['details']): Record<string, unknown> {
  if (details == null) return {};
  if (typeof details !== 'string') return details;
  try { return JSON.parse(details); } catch { return {}; }
}

const show = (v: unknown) => (v == null ? '—' : String(v));
const num = (v: unknown, digits: number) => (typeof v === 'number' ? v.toFixed(digits) : '—');

export default function EventLog({ simulationId, total: initialTotal }: EventLogProps) {
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ types: TYPES, offset: String(offset), limit: String(PAGE_SIZE) });
      const res = await fetch(`/api/simulations/${simulationId}/events?${params}`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error || `HTTP ${res.status}`);
      setEvents(prev => (offset === 0 ? data.events : [...prev, ...data.events]));
      setTotal(data.total);
    } catch (err) {
      setError(`Failed to load diagnostics: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  }, [simulationId]);

  useEffect(() => { loadPage(0); }, [loadPage]);

  return (
    <div className="card overflow-hidden mt-3">
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--hairline-strong)' }}
      >
        <div className="flex items-center gap-3">
          <span className="card-header text-xs">Order Diagnostics</span>
          <span className="font-mono tabular-nums" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {events.length.toLocaleString()} / {total.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto">
        <table className="trade-log-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Side</th>
              <th>Slot</th>
              <th>First 5m</th>
              <th>Last 5m</th>
              <th>Skipped</th>
              <th style={{ textAlign: 'right' }}>Shortfall / Price × Qty</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const d = parseDetails(e.details);
              const isSkip = e.eventType === 'entry_skipped';
              return (
                <tr key={e.id} className={d.side === 'short' ? 'trade-row-short' : 'trade-row-long'}>
                  <td style={{ color: 'var(--text-muted)', fontSize: 10.5 }}>
                    {isSkip ? 'entry skipped' : e.eventType === 'restoration_entry' ? 'restoration' : e.eventType}
                  </td>
                  <td>{show(d.side)}</td>
                  <td>{show(d.slotIndex)}</td>
                  <td>{isSkip ? show(d.firstCandleIdx) : show(e.candleIdx)}</td>
                  <td>{isSkip ? show(d.lastCandleIdx) : '—'}</td>
                  <td>{isSkip ? show(d.skippedCandles) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {isSkip ? `$${num(d.shortfall, 2)}` : `$${num(d.price, 2)} × ${num(d.quantity, 6)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 px-4 py-2">
        {loading && <Loader2 size={12} className="animate-spin" style={{ color: 'var(--grid-neutral)' }} />}
        {error && <span className="text-xs text-loss">{error}</span>}
        {!loading && events.length < total && (
          <button className="btn-secondary btn text-xs py-1 px-2" onClick={() => loadPage(events.length)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
