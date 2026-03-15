'use client';

import { Activity, TrendingUp, TrendingDown, AlertTriangle, RefreshCw } from 'lucide-react';

interface AdaptiveEvent {
  candleIdx: number;
  timestamp: number;
  eventType: string;
  detailsJson: string;
  longMultiplier?: number | null;
  shortMultiplier?: number | null;
}

interface AdaptiveStatusProps {
  events: AdaptiveEvent[];
  currentCandleIdx: number;
}

export default function AdaptiveStatus({ events, currentCandleIdx }: AdaptiveStatusProps) {
  // Show only events up to current playback position
  const visibleEvents = events
    .filter(e => e.candleIdx <= currentCandleIdx)
    .slice(-5); // Show last 5 events

  if (visibleEvents.length === 0) {
    return (
      <div className="card p-3">
        <div className="flex items-center gap-2 mb-2">
          <Activity size={14} style={{ color: 'var(--adaptive-accent)' }} />
          <span className="card-header text-xs">Adaptive Events</span>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No events yet</p>
      </div>
    );
  }

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <Activity size={14} style={{ color: 'var(--adaptive-accent)' }} />
        <span className="card-header text-xs">Adaptive Events</span>
      </div>
      <div className="flex flex-col gap-1.5 max-h-32 overflow-y-auto">
        {visibleEvents.map((event, i) => {
          const details = JSON.parse(event.detailsJson);
          return (
            <div
              key={i}
              className="flex items-center gap-2 px-2 py-1.5 rounded text-xs"
              style={{ background: 'var(--btn-secondary-bg)' }}
            >
              {event.eventType === 'trend_change' && (
                <>
                  {details.to === 'bullish' ? (
                    <TrendingUp size={12} className="text-grid-long flex-shrink-0" />
                  ) : details.to === 'bearish' ? (
                    <TrendingDown size={12} className="text-grid-short flex-shrink-0" />
                  ) : (
                    <Activity size={12} style={{ color: 'var(--text-muted)' }} className="flex-shrink-0" />
                  )}
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                    Trend: {details.from} → {details.to}
                  </span>
                </>
              )}
              {event.eventType === 'breakout_detected' && (
                <>
                  <AlertTriangle size={12} className="text-grid-fill flex-shrink-0" />
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                    Breakout {details.direction}
                  </span>
                </>
              )}
              {event.eventType === 'de_risk' && (
                <>
                  <AlertTriangle size={12} className="text-grid-short flex-shrink-0" />
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                    De-risk {details.side} → {(details.multiplier * 100).toFixed(0)}%
                  </span>
                </>
              )}
              {event.eventType === 're_entry' && (
                <>
                  <RefreshCw size={12} className="text-grid-long flex-shrink-0" />
                  <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                    Re-entry {details.side} → {(details.newMultiplier * 100).toFixed(0)}%
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
