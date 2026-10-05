'use client';

// Saved runs (plan §6): open, delete, pin (max 2; the pinned runs' cards are shown
// side by side by the page). Pins live in localStorage (decision 3, phase 3).

import { useEffect, useState } from 'react';
import { Pin, Trash2 } from 'lucide-react';
import type { PionexRunListItem } from '@/lib/pionex/runStore';
import { Verdict } from '@/lib/pionex/types';
import { fmtDay, fmtTime, VERDICT_LABEL } from './format';

interface Props {
  refreshKey: number;
  activeId: string | null;
  pinned: string[];
  onOpen: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDeleted: (id: string) => void;
}

export default function RunHistory({ refreshKey, activeId, pinned, onOpen, onTogglePin, onDeleted }: Props) {
  const [runs, setRuns] = useState<PionexRunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/pionex/runs', { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { if (!ctrl.signal.aborted) (d.error ? setError(d.error) : setRuns(d.runs)); })
      .catch(e => { if (!ctrl.signal.aborted) setError(e.message); });
    return () => ctrl.abort();
  }, [refreshKey]);

  const remove = async (id: string) => {
    const res = await fetch(`/api/pionex/runs?id=${id}`, { method: 'DELETE' });
    if (!res.ok) { setError((await res.json()).error ?? 'delete failed'); return; }
    setRuns(rs => rs?.filter(r => r.id !== id) ?? null);
    onDeleted(id);
  };

  return (
    <section className="card p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="card-header">Runs</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>pin up to 2 to compare</span>
      </div>
      {error && <div className="text-xs" style={{ color: 'var(--grid-short)' }}>{error}</div>}
      {runs && runs.length === 0 && <div className="text-xs" style={{ color: 'var(--text-muted)' }}>no saved runs yet</div>}
      {runs && runs.length > 0 && (
        <ul className="flex flex-col gap-1 max-h-72 overflow-y-auto">
          {runs.map(r => {
            const v = VERDICT_LABEL[r.verdict as Verdict];
            const isPinned = pinned.includes(r.id);
            return (
              <li
                key={r.id}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-mono"
                style={{ border: `1px solid ${r.id === activeId ? 'var(--grid-neutral)' : 'var(--card-border)'}`, background: 'var(--btn-secondary-bg)' }}
              >
                <button className="flex-1 min-w-0 text-left truncate" onClick={() => onOpen(r.id)} title={`saved ${fmtTime(Date.parse(r.createdAt))}`}>
                  <span style={{ color: 'var(--text-primary)' }}>{r.name}</span>
                  <span className="ml-2" style={{ color: 'var(--text-muted)' }}>{fmtDay(r.startMs)} → {fmtDay(r.endMs)}</span>
                </button>
                {v && <span className={`badge ${v.badge}`}>{v.text}</span>}
                <button
                  title={isPinned ? 'unpin' : 'pin'}
                  disabled={!isPinned && pinned.length >= 2}
                  onClick={() => onTogglePin(r.id)}
                  style={{ color: isPinned ? 'var(--grid-neutral)' : 'var(--text-muted)', opacity: !isPinned && pinned.length >= 2 ? 0.3 : 1 }}
                >
                  <Pin size={13} />
                </button>
                <button title="delete" onClick={() => remove(r.id)} style={{ color: 'var(--text-muted)' }}>
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
