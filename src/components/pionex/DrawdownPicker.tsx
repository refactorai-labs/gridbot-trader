'use client';

// Top N drawdown list → one click sets the test window (plan §6.2).
// The window starts `leadDays` before the hindsight-known peak and ends 7 days
// after the trough (capped at now). The label is mandatory: this is a
// hindsight-selected stress window, not a live entry strategy.

import { useEffect, useState } from 'react';
import { DrawdownEpisode } from '@/lib/pionex/drawdowns';

export interface PickedWindow {
  startMs: number;
  endMs: number;
  episode: DrawdownEpisode;
}

interface Props {
  symbol: string;
  leadDays: number;
  onLeadDaysChange: (d: number) => void;
  onPick: (w: PickedWindow) => void;
}

const DAY = 86_400_000;

export function windowFromEpisode(e: DrawdownEpisode, leadDays: number): { startMs: number; endMs: number } {
  const startMs = e.peakMs - leadDays * DAY;
  const endMs = Math.min(Date.now(), e.troughMs + 7 * DAY);
  return { startMs, endMs };
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function DrawdownPicker({ symbol, leadDays, onLeadDaysChange, onPick }: Props) {
  const [episodes, setEpisodes] = useState<DrawdownEpisode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Abort on symbol change/unmount so a late response for the previous symbol
  // can never overwrite the current list.
  useEffect(() => {
    const ctrl = new AbortController();
    setEpisodes(null);
    setError(null);
    fetch(`/api/pionex/drawdowns?symbol=${symbol}&n=10`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => {
        if (ctrl.signal.aborted) return;
        if (d.error) setError(d.error);
        else if (!d.complete) {
          // Incomplete 1h history could hide the deepest drops → no ranking.
          setError(`1h history incomplete (${d.gaps.length} gaps${d.historyError ? `; ${d.historyError}` : ''}) — no Top N ranking`);
        } else setEpisodes(d.episodes);
      })
      .catch(e => { if (!ctrl.signal.aborted) setError(e.message); });
    return () => ctrl.abort();
  }, [symbol]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="form-label !mb-0">Top drops · 30d lookback</span>
        <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          start
          <input
            type="number"
            min={0}
            max={30}
            value={leadDays}
            onChange={e => onLeadDaysChange(Math.max(0, Number(e.target.value)))}
            className="form-input !w-14 !px-2 !py-1 text-center"
          />
          d before peak
        </label>
      </div>
      {error && <div className="text-xs" style={{ color: 'var(--grid-short)' }}>{error}</div>}
      {!episodes && !error && (
        <div className="text-xs animate-pulse" style={{ color: 'var(--text-muted)' }}>loading 1h history…</div>
      )}
      {episodes && (
        <ul className="flex flex-col gap-1 max-h-56 overflow-y-auto pr-1">
          {episodes.map((e, i) => (
            <li key={e.troughMs}>
              <button
                onClick={() => onPick({ ...windowFromEpisode(e, leadDays), episode: e })}
                className="w-full flex items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-xs font-mono transition-colors"
                style={{ border: '1px solid var(--card-border)', background: 'var(--btn-secondary-bg)' }}
              >
                <span className="w-5 text-right" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                <span className="font-semibold w-14" style={{ color: 'var(--grid-short)' }}>
                  −{(e.depthPct * 100).toFixed(1)}%
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{fmt(e.peakMs)} → {fmt(e.troughMs)}</span>
                <span className="ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {e.recoveredMs ? 'recovered' : 'open'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
        Hindsight-selected stress window: knowing the peak is future information. The result is not the
        performance of a live entry strategy.
      </p>
    </div>
  );
}
