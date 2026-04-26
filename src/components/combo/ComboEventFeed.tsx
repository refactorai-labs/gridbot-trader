'use client';

import { AdaptiveEventView } from './types';

const TYPE_LABEL: Record<string, { label: string; color: string }> = {
  breakout_entered:    { label: 'BREAKOUT · ENTER',   color: 'var(--phase-breakout)' },
  position_opened:     { label: 'POSITION · OPEN',    color: 'var(--grid-long)' },
  sl_triggered:        { label: 'SL · TRIG',          color: 'var(--grid-short)' },
  cooldown_entered:    { label: 'COOLDOWN · ENTER',   color: 'var(--phase-cooldown)' },
  tier1_reopen:        { label: 'TIER 1 · REOPEN',    color: 'var(--phase-breakout)' },
  tier2_scale:         { label: 'TIER 2 · SCALE',     color: 'var(--phase-reopening)' },
  tier3_scale:         { label: 'TIER 3 · SCALE',     color: 'var(--supervisor)' },
  cycle_complete:      { label: 'CYCLE · COMPLETE',   color: 'var(--grid-long)' },
  hibernation_entered: { label: 'HIBERNATION · ENTER',color: 'var(--phase-hibernating)' },
  hibernation_exit:    { label: 'HIBERNATION · EXIT', color: 'var(--phase-idle)' },
  retry_incremented:   { label: 'RETRY · INCREMENT',  color: 'var(--grid-short)' },
};

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toISOString().slice(11, 19);
}

interface Props {
  events: AdaptiveEventView[];
  currentCandleIdx?: number;
  limit?: number;
}

export default function ComboEventFeed({ events, currentCandleIdx, limit = 12 }: Props) {
  const visible = currentCandleIdx != null
    ? events.filter(e => e.candleIdx <= currentCandleIdx)
    : events;
  const latest = visible.slice(-limit).reverse();

  return (
    <section className="rail-section">
      <header className="rail-head">
        <span className="combo-section-label">Adaptive events</span>
        <span className="count tabular-nums">
          {visible.length} {currentCandleIdx != null && ` · idx ${currentCandleIdx}`}
        </span>
      </header>

      {latest.length === 0 && (
        <div className="empty">No events yet</div>
      )}

      {latest.map((ev, i) => {
        const meta = TYPE_LABEL[ev.eventType] ?? { label: ev.eventType.toUpperCase(), color: 'var(--text-secondary)' };
        let price: number | null = null;
        try {
          const d = JSON.parse(ev.detailsJson) as { snapshot?: { price?: number } };
          price = d.snapshot?.price ?? null;
        } catch { /* noop */ }
        return (
          <div className="feed-item" key={i}>
            <span className="feed-idx tabular-nums">{ev.candleIdx}</span>
            <span className="feed-marker" style={{ color: meta.color }}>
              <span className="dot" />
              {meta.label}
              {price != null && (
                <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>@{price.toFixed(2)}</span>
              )}
            </span>
            <span className="feed-time tabular-nums">{fmtTime(ev.timestamp)}</span>
          </div>
        );
      })}

      <style jsx>{`
        .rail-section {
          padding: 14px 16px;
          border-bottom: 1px solid var(--hairline);
          background: var(--card-bg);
        }
        .rail-head {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 8px;
        }
        .count {
          font-family: var(--f-data);
          font-size: 10px;
          color: var(--text-muted);
        }
        .empty {
          font-family: var(--f-body-tight);
          font-size: 11px;
          color: var(--text-muted);
          padding: 8px 0;
        }
        .feed-item {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 10px;
          align-items: center;
          padding: 7px 0;
          border-bottom: 1px dashed var(--hairline);
          font-family: var(--f-display);
          font-size: 10.5px;
          letter-spacing: 0.06em;
          color: var(--text-secondary);
        }
        .feed-item:last-child { border-bottom: 0; }
        .feed-idx {
          font-family: var(--f-data);
          font-size: 10px;
          color: var(--text-muted);
          min-width: 42px;
        }
        .feed-marker {
          display: inline-flex; align-items: center; gap: 6px;
        }
        .feed-marker .dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: currentColor;
          box-shadow: 0 0 4px currentColor;
        }
        .feed-time {
          font-family: var(--f-data);
          font-size: 9.5px;
          color: var(--text-muted);
          letter-spacing: 0;
        }
      `}</style>
    </section>
  );
}
