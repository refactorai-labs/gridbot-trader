'use client';

import { AdaptiveEventView } from './types';

interface Props {
  events: AdaptiveEventView[];
  rangeStart: number;
  rangeEnd: number;
  currentCandleIdx?: number;
}

const TYPE_META: Record<string, { tag: string; color: string }> = {
  breakout_entered:   { tag: 'BRK', color: 'var(--phase-breakout)' },
  position_opened:    { tag: 'OPN', color: 'var(--grid-long)' },
  sl_triggered:       { tag: 'SL',  color: 'var(--grid-short)' },
  cooldown_entered:   { tag: 'CD',  color: 'var(--phase-cooldown)' },
  tier1_reopen:       { tag: 'T1',  color: 'var(--phase-breakout)' },
  tier2_scale:        { tag: 'T2',  color: 'var(--phase-reopening)' },
  tier3_scale:        { tag: 'T3',  color: 'var(--supervisor)' },
  cycle_complete:     { tag: 'OK',  color: 'var(--grid-long)' },
  hibernation_entered:{ tag: 'HB',  color: 'var(--phase-hibernating)' },
  hibernation_exit:   { tag: 'HE',  color: 'var(--phase-idle)' },
  retry_incremented:  { tag: 'RT',  color: 'var(--grid-short)' },
};

function positionPct(idx: number, start: number, end: number): number {
  if (end <= start) return 0;
  return ((idx - start) / (end - start)) * 100;
}

export default function ComboEventTimeline({ events, rangeStart, rangeEnd, currentCandleIdx }: Props) {
  const visibleEvents = events.filter(e => e.candleIdx >= rangeStart && e.candleIdx <= rangeEnd);

  // Five ticks across the range
  const tickLabels: number[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    tickLabels.push(Math.round(rangeStart + (rangeEnd - rangeStart) * (i / steps)));
  }

  return (
    <section className="event-timeline">
      <div className="tl-head">
        <span className="combo-section-label">Event timeline</span>
        <span className="combo-coord">
          <span className="k">RANGE</span><span className="eq">=</span>
          <span className="v tabular-nums">idx {rangeStart} – {rangeEnd}</span>
        </span>
      </div>

      <div className="tl-ruler">
        <div className="tl-axis" />
        <div className="tl-ticks">
          {tickLabels.map((label, i) => (
            <span key={i} data-label={label.toLocaleString()} />
          ))}
        </div>

        {visibleEvents.map((ev, i) => {
          const meta = TYPE_META[ev.eventType] ?? { tag: '·', color: 'var(--text-muted)' };
          const left = positionPct(ev.candleIdx, rangeStart, rangeEnd);
          return (
            <div
              key={`${ev.candleIdx}-${ev.eventType}-${i}`}
              className="tl-event"
              style={{ left: `${left}%`, color: meta.color }}
              title={`${ev.eventType} @ idx ${ev.candleIdx}`}
            >
              <span className="tl-tag">{meta.tag}</span>
            </div>
          );
        })}

        {currentCandleIdx != null && currentCandleIdx >= rangeStart && currentCandleIdx <= rangeEnd && (
          <div
            className="tl-cursor"
            style={{ left: `${positionPct(currentCandleIdx, rangeStart, rangeEnd)}%` }}
          />
        )}
      </div>

      <style jsx>{`
        .event-timeline {
          border-top: 1px solid var(--hairline);
          border-bottom: 1px solid var(--hairline);
          background: linear-gradient(to bottom, rgba(0, 0, 0, 0.15), transparent 80%);
        }
        .tl-head {
          padding: 8px 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px dashed var(--hairline);
        }
        .tl-ruler {
          position: relative;
          height: 58px;
          padding: 0 14px;
        }
        .tl-axis {
          position: absolute;
          left: 14px; right: 14px; top: 38px;
          height: 1px;
          background: var(--hairline-strong);
        }
        .tl-ticks {
          position: absolute;
          left: 14px; right: 14px; top: 34px;
          height: 9px;
          display: flex;
          justify-content: space-between;
        }
        .tl-ticks span {
          width: 1px; height: 5px;
          background: var(--hairline);
          position: relative;
        }
        .tl-ticks span::after {
          content: attr(data-label);
          position: absolute;
          top: 12px; left: 50%;
          transform: translateX(-50%);
          white-space: nowrap;
          color: var(--text-muted);
          font-family: var(--f-data);
          font-size: 8.5px;
        }
        .tl-event {
          position: absolute;
          width: 1px;
          top: 8px;
          height: 30px;
          background: currentColor;
        }
        .tl-event::after {
          content: '';
          position: absolute;
          left: 50%; top: 0;
          transform: translateX(-50%);
          width: 10px; height: 10px;
          background: currentColor;
          border-radius: 50%;
          border: 2px solid var(--card-bg);
          box-shadow: 0 0 6px currentColor;
        }
        .tl-tag {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          top: 14px;
          font-family: var(--f-display);
          font-size: 8.5px;
          font-weight: 600;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          white-space: nowrap;
        }
        .tl-cursor {
          position: absolute;
          top: 0; bottom: 0;
          width: 1px;
          background: var(--supervisor);
          box-shadow: 0 0 4px var(--supervisor);
          pointer-events: none;
        }
      `}</style>
    </section>
  );
}
