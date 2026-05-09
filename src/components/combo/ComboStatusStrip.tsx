'use client';

import { Play, Loader2 } from 'lucide-react';
import { SessionView } from './types';
import { BotPhase } from '@/lib/types';

interface Props {
  session: SessionView;
  longPhase?: BotPhase;
  shortPhase?: BotPhase;
  onRun?: () => void;
  isRunning?: boolean;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(2, 10).replace(/-/g, '-');
}

export default function ComboStatusStrip({ session, onRun, isRunning }: Props) {
  const allocLong = Math.round(session.allocationLong * 100);
  const allocShort = 100 - allocLong;
  return (
    <header className="combo-strip">
      <div className="strip-brand">
        <div className="brand-mark">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M2 8 L14 8 M8 2 L8 14" strokeDasharray="1.5 1.2" />
          </svg>
        </div>
        <span className="brand-text">COMBO <em>∙ SUPER∙</em> V3.1</span>
        <span className="mode-pill">{session.mode}</span>
      </div>

      <div className="strip-session">
        <span className="combo-coord"><span className="k">PAIR</span><span className="eq">=</span><span className="v">{session.pair.replace('/', '')}</span></span>
        <span className="combo-coord"><span className="k">TF</span><span className="eq">=</span><span className="v">{session.timeframe}</span></span>
        <span className="combo-coord"><span className="k">WND</span><span className="eq">=</span><span className="v">{fmtDate(session.startTime)}→{fmtDate(session.endTime)}</span></span>
        <span className="combo-coord">
          <span className="k">CDL</span><span className="eq">=</span>
          <span className="v tabular-nums">
            {session.currentCandleIdx.toLocaleString()} / {session.totalCandles.toLocaleString()}
          </span>
        </span>
        <span className="combo-coord">
          <span className="k">LEV</span><span className="eq">=</span>
          <span className="v tabular-nums" style={{ color: 'var(--supervisor)' }}>{session.leverage.toFixed(1)}×</span>
        </span>
        <span className="combo-coord" title="Grid level count actually used by the engine (Simulation.comboGridLevels)">
          <span className="k">GL</span><span className="eq">=</span>
          <span className="v tabular-nums">{session.gridLevels}</span>
        </span>
        {session.mode === 'dual' && (
          <span className="combo-coord">
            <span className="k">ALLOC</span><span className="eq">=</span>
            <span className="v tabular-nums">
              <span style={{ color: 'var(--grid-long)' }}>{allocLong}%</span>
              <span style={{ color: 'var(--text-muted)' }}> / </span>
              <span style={{ color: 'var(--grid-short)' }}>{allocShort}%</span>
            </span>
          </span>
        )}
        {session.fundingDataMissing && (
          <span
            className="combo-coord funding-warn"
            title="No funding rates were cached for this window. Reported funding cost is $0 because it could not be measured, not because it was zero. Use the Data Manager to backfill funding rates."
          >
            <span className="k">FUNDING</span><span className="eq">=</span>
            <span className="v">missing</span>
          </span>
        )}
      </div>

      <div className="strip-controls">
        <span className="combo-coord"><span className="k">PLAY</span><span className="eq">=</span><span className="v">×{session.playbackSpeed}</span></span>
        {onRun && (
          <button
            type="button"
            className="pill-run"
            onClick={onRun}
            disabled={isRunning}
            style={{ opacity: isRunning ? 0.6 : 1 }}
          >
            {isRunning ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            {isRunning ? 'RUNNING…' : 'RUN'}
          </button>
        )}
      </div>

      <style jsx>{`
        .combo-strip {
          display: grid;
          grid-template-columns: auto 1fr auto;
          align-items: stretch;
          gap: 0;
          border-bottom: 1px solid var(--hairline);
          background:
            linear-gradient(to bottom, rgba(34, 211, 238, 0.03), transparent 60%),
            var(--card-bg);
        }
        .strip-brand {
          padding: 12px 18px;
          border-right: 1px solid var(--hairline);
          display: flex; align-items: center; gap: 10px;
        }
        .brand-mark {
          width: 22px; height: 22px;
          display: grid; place-items: center;
          color: var(--supervisor);
          border: 1px solid var(--supervisor-dim);
          border-radius: 2px;
          background: radial-gradient(circle at 30% 30%, var(--supervisor-faint) 0%, transparent 60%);
        }
        .brand-text {
          font-family: var(--f-display);
          font-weight: 600;
          font-size: 11px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }
        .brand-text :global(em) {
          font-style: normal;
          color: var(--supervisor);
          font-weight: 500;
        }
        .mode-pill {
          margin-left: 4px;
          padding: 3px 8px 2px;
          font-family: var(--f-display);
          font-size: 9.5px;
          font-weight: 600;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: var(--supervisor);
          background: var(--supervisor-faint);
          border: 1px solid var(--supervisor-dim);
          border-radius: 2px;
        }
        .strip-session {
          padding: 10px 20px;
          display: flex; align-items: center; gap: 26px;
          flex-wrap: wrap;
          overflow-x: auto;
        }
        .strip-controls {
          border-left: 1px solid var(--hairline);
          padding: 10px 16px;
          display: flex; align-items: center; gap: 10px;
        }
        .pill-run {
          padding: 5px 12px;
          border-radius: 2px;
          font-family: var(--f-display);
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--supervisor);
          border: 1px solid var(--supervisor);
          background: transparent;
          cursor: pointer;
          transition: background 0.14s ease;
          display: inline-flex; align-items: center; gap: 6px;
        }
        .pill-run:hover:not(:disabled) { background: var(--supervisor-dim); }
        .funding-warn :global(.k),
        .funding-warn :global(.v) {
          color: #f59e0b;
          font-weight: 600;
        }
        .funding-warn { cursor: help; }
      `}</style>
    </header>
  );
}
