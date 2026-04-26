'use client';

import { useEffect } from 'react';

export interface ComboOverlayState {
  avwap: boolean;
  vwap: boolean;
  atrBands: boolean;
  bollingerBands: boolean;
  rsiPane: boolean;
  slLines: boolean;
  phaseMarkers: boolean;
  reopenMarkers: boolean;
  slMarkers: boolean;
  pauseShading: boolean;
  pnlOverlay: boolean;
}

export const DEFAULT_OVERLAY_STATE: ComboOverlayState = {
  avwap: true,
  vwap: false,
  atrBands: false,
  bollingerBands: false,
  rsiPane: false,
  slLines: true,
  phaseMarkers: true,
  reopenMarkers: true,
  slMarkers: true,
  pauseShading: true,
  pnlOverlay: true,
};

const STORAGE_KEY = 'gridbot.chartOverlays.v1';

export function loadOverlayState(): ComboOverlayState {
  if (typeof window === 'undefined') return DEFAULT_OVERLAY_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_OVERLAY_STATE;
    const parsed = JSON.parse(raw) as Partial<ComboOverlayState>;
    return { ...DEFAULT_OVERLAY_STATE, ...parsed };
  } catch { return DEFAULT_OVERLAY_STATE; }
}

function saveOverlayState(s: ComboOverlayState): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* noop */ }
}

type Style = 'solid' | 'dashed' | 'glow';

interface Item {
  key: keyof ComboOverlayState;
  label: string;
  hint?: string;
  accent: string;
  style?: Style;
}

interface Group { title: string; items: Item[]; }

const GROUPS: Group[] = [
  {
    title: 'Indicators',
    items: [
      { key: 'avwap',          label: 'Anchored VWAP',      accent: 'var(--grid-fill)',       style: 'dashed', hint: 'from ER>threshold anchor' },
      { key: 'vwap',           label: 'Session VWAP',       accent: 'var(--adaptive-accent)', style: 'solid' },
      { key: 'atrBands',       label: 'ATR bands',          accent: 'var(--text-secondary)',  style: 'solid',  hint: 'blended 4H/1H envelope' },
      { key: 'bollingerBands', label: 'Bollinger bands',    accent: 'var(--text-secondary)',  style: 'solid' },
      { key: 'rsiPane',        label: 'RSI sub-pane',       accent: 'var(--adaptive-accent)', style: 'solid' },
    ],
  },
  {
    title: 'Combo state',
    items: [
      { key: 'slLines',       label: 'Stop-loss lines',             accent: 'var(--grid-short)',      style: 'dashed' },
      { key: 'phaseMarkers',  label: 'Phase transitions',           accent: 'var(--phase-reopening)', style: 'solid' },
      { key: 'reopenMarkers', label: 'Reopen tier markers',         accent: 'var(--grid-fill)',       style: 'glow',    hint: 'T1 · T2 · T3' },
      { key: 'slMarkers',     label: 'SL-hit events',               accent: 'var(--grid-short)',      style: 'solid' },
      { key: 'pauseShading',  label: 'Cooldown / hibernation shading', accent: 'var(--phase-cooldown)', style: 'solid' },
    ],
  },
  {
    title: 'Performance',
    items: [
      { key: 'pnlOverlay', label: 'Equity overlay', accent: 'var(--supervisor)', style: 'solid' },
    ],
  },
];

interface Props {
  state: ComboOverlayState;
  onChange: (s: ComboOverlayState) => void;
}

export default function ComboOverlayPanel({ state, onChange }: Props) {
  useEffect(() => { saveOverlayState(state); }, [state]);

  const set = (key: keyof ComboOverlayState, v: boolean) => onChange({ ...state, [key]: v });
  const setAll = (group: Group, v: boolean) => {
    const next = { ...state };
    for (const i of group.items) next[i.key] = v;
    onChange(next);
  };
  const allOn = (group: Group) => group.items.every(i => state[i.key]);

  const totalActive = (Object.values(state) as boolean[]).filter(Boolean).length;
  const totalCount = Object.keys(state).length;

  return (
    <section className="rail-section">
      <header className="rail-head">
        <span className="combo-section-label">Chart overlays</span>
        <span className="count tabular-nums">{totalActive} / {totalCount}</span>
      </header>

      {GROUPS.map(group => (
        <div key={group.title} className="group">
          <div className="group-title">
            <span>{group.title}</span>
            <button
              type="button"
              className="all-toggle"
              onClick={() => setAll(group, !allOn(group))}
            >
              {allOn(group) ? 'none' : 'all'}
            </button>
          </div>

          {group.items.map(item => {
            const on = state[item.key];
            return (
              <label
                key={item.key}
                className={`row style-${item.style ?? 'solid'}`}
                data-on={on ? 'true' : 'false'}
                style={{ ['--accent' as string]: item.accent } as React.CSSProperties}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={e => set(item.key, e.target.checked)}
                  className="native-ck"
                  aria-label={item.label}
                />
                <span className="ck" />
                <span className="swatch" />
                <span className="label">
                  {item.label}
                  {item.hint && <span className="hint"> · {item.hint}</span>}
                </span>
              </label>
            );
          })}
        </div>
      ))}

      <style jsx>{`
        .rail-section {
          padding: 14px 16px;
          border-bottom: 1px solid var(--hairline);
          background: var(--card-bg);
        }
        .rail-head {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 12px;
        }
        .count {
          font-family: var(--f-data);
          font-size: 10px;
          color: var(--text-muted);
        }
        .group { margin-bottom: 14px; }
        .group:last-child { margin-bottom: 0; }
        .group-title {
          display: flex; align-items: center; justify-content: space-between;
          font-family: var(--f-display);
          font-size: 9.5px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--text-muted);
          margin-bottom: 6px;
        }
        .all-toggle {
          text-decoration: underline;
          cursor: pointer;
          color: var(--text-muted);
          font-size: 9px;
          background: transparent;
          border: 0;
          font-family: inherit;
          letter-spacing: inherit;
          text-transform: inherit;
        }
        .row {
          display: grid;
          grid-template-columns: 14px 14px 1fr;
          gap: 8px;
          align-items: center;
          padding: 5px 6px;
          border-radius: 2px;
          cursor: pointer;
          margin-left: -6px;
          font-family: var(--f-display);
          font-size: 11px;
          letter-spacing: 0.04em;
          color: var(--text-secondary);
          transition: background 0.12s ease, color 0.12s ease;
          position: relative;
        }
        .row:hover {
          background: var(--hover-bg);
          color: var(--text-primary);
        }
        .row[data-on='true'] { color: var(--text-primary); }
        .row[data-on='true']::before {
          content: '';
          position: absolute;
          left: -6px; top: 50%;
          width: 3px; height: 14px;
          margin-top: -7px;
          background: var(--accent);
        }
        .native-ck { display: none; }
        .ck {
          width: 14px; height: 14px;
          background: var(--input-bg);
          border: 1px solid var(--input-border);
          position: relative;
          transition: all 0.14s ease;
          flex-shrink: 0;
        }
        .row[data-on='true'] .ck {
          background: var(--accent);
          border-color: var(--accent);
        }
        .row[data-on='true'] .ck::after {
          content: '';
          position: absolute;
          left: 4px; top: 1px;
          width: 4px; height: 8px;
          border-right: 1.5px solid #0a0c14;
          border-bottom: 1.5px solid #0a0c14;
          transform: rotate(42deg);
        }
        .swatch {
          width: 14px; height: 2px;
          background: var(--accent);
          align-self: center;
        }
        .style-dashed .swatch {
          background: repeating-linear-gradient(to right, var(--accent) 0 3px, transparent 3px 6px);
        }
        .style-glow .swatch {
          background: var(--accent);
          box-shadow: 0 0 4px 1px var(--accent);
        }
        .label { font-weight: 500; }
        .hint {
          font-family: var(--f-body-tight);
          font-size: 10px;
          color: var(--text-muted);
          letter-spacing: 0;
          text-transform: none;
          font-weight: 400;
        }
      `}</style>
    </section>
  );
}
