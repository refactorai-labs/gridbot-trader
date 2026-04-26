'use client';

import { WalkForwardView } from './types';

interface Props {
  result: WalkForwardView | null;
}

export default function ComboWalkForwardPanel({ result }: Props) {
  if (!result) return null;

  const folds = result.folds;
  const maxAbsSharpe = Math.max(1, ...folds.map(f => Math.abs(f.sharpe)));
  const equity = result.stitchedEquity.length > 0 ? result.stitchedEquity : [0];
  const equityPath = buildPath(equity);

  return (
    <section className="wf-panel">
      <div className="wf-header">
        <div className="wf-title">
          <h4>Walk-forward · stitched OOS</h4>
          <span className="sub">
            {result.foldCount} folds ·
            {' '}{Math.round(result.trainCandles / 8640)}mo train /
            {' '}{Math.round(result.oosCandles / 8640)}mo OOS /
            {' '}step {Math.round(result.stepCandles / 8640)}mo
          </span>
        </div>
        <div className="wf-metrics">
          <Metric k={result.usedPSR ? 'PSR' : 'SHARPE'} v={result.psr.toFixed(3)} accent />
          <Metric k="STABILITY" v={result.stability.toFixed(2)} />
          <Metric k="MAX DD" v={`${(result.maxDrawdownPct * 100).toFixed(1)}%`} warn={result.maxDrawdownPct > 0.1} />
          <Metric k="TRADES" v={result.nTrades.toLocaleString()} />
          <Metric k="FITNESS" v={result.fitness.toFixed(3)} accent />
        </div>
      </div>

      <div className="wf-body">
        <div className="wf-curve">
          <span className="wf-curve-label">Stitched OOS equity</span>
          <svg viewBox="0 0 800 180" preserveAspectRatio="none">
            <defs>
              <linearGradient id="wfFade" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--supervisor)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--supervisor)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g stroke="var(--hairline)" strokeDasharray="2 3">
              {folds.slice(0, -1).map((_, i) => {
                const x = ((i + 1) / folds.length) * 800;
                return <line key={i} x1={x} y1={0} x2={x} y2={180} />;
              })}
            </g>
            <line x1={0} y1={150} x2={800} y2={150} stroke="var(--hairline-strong)" strokeDasharray="3 4" />
            <path d={`${equityPath} L800,180 L0,180 Z`} fill="url(#wfFade)" />
            <polyline points={equityPath.replace(/^M/, '').replace(/L/g, ' ')} fill="none" stroke="var(--supervisor)" strokeWidth="1.6" />
          </svg>
        </div>

        <div className="wf-folds">
          {folds.map(f => {
            const pct = Math.min(100, (Math.abs(f.sharpe) / maxAbsSharpe) * 100);
            const neg = f.sharpe < 0;
            return (
              <div key={f.foldIndex} className={`wf-fold ${neg ? 'neg' : ''}`}>
                <span className="fold-tag">F{String(f.foldIndex + 1).padStart(2, '0')}</span>
                <div className="fold-bar" style={{ ['--pct' as string]: `${pct}%` } as React.CSSProperties} />
                <span className="fold-val tabular-nums">{neg ? '−' : '+'}{Math.abs(f.sharpe).toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <style jsx>{`
        .wf-panel {
          border-top: 1px solid var(--hairline);
          padding: 18px 22px;
          background: linear-gradient(to bottom, var(--supervisor-faint), transparent 30%), var(--card-bg);
        }
        .wf-header {
          display: flex; align-items: baseline; justify-content: space-between;
          margin-bottom: 14px;
          gap: 16px;
          flex-wrap: wrap;
        }
        .wf-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .wf-title h4 {
          font-family: var(--f-display);
          margin: 0; font-size: 12px; font-weight: 600;
          letter-spacing: 0.18em; text-transform: uppercase;
        }
        .wf-title .sub {
          font-family: var(--f-body-tight);
          font-size: 11px;
          color: var(--text-muted);
        }
        .wf-metrics { display: flex; gap: 20px; flex-wrap: wrap; }
        .wf-body {
          display: grid;
          grid-template-columns: 1fr 280px;
          gap: 20px;
        }
        @media (max-width: 1280px) {
          .wf-body { grid-template-columns: 1fr; }
        }
        .wf-curve {
          position: relative;
          height: 180px;
          background: linear-gradient(to bottom, rgba(34, 211, 238, 0.02), transparent 70%);
          border: 1px solid var(--hairline);
          border-radius: 2px;
          overflow: hidden;
        }
        .wf-curve::before {
          content: '';
          position: absolute; inset: 0;
          background-image:
            linear-gradient(to right, var(--hairline) 1px, transparent 1px),
            linear-gradient(to bottom, var(--hairline) 1px, transparent 1px);
          background-size: 40px 30px;
          opacity: 0.45;
        }
        .wf-curve svg { display: block; width: 100%; height: 100%; position: relative; }
        .wf-curve-label {
          position: absolute; left: 10px; top: 8px;
          font-family: var(--f-display);
          font-size: 9.5px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .wf-folds {
          display: flex; flex-direction: column; gap: 4px;
          max-height: 180px;
          overflow-y: auto;
        }
        .wf-fold {
          display: grid;
          grid-template-columns: 36px 1fr auto;
          align-items: center;
          gap: 10px;
          padding: 4px 10px;
          border: 1px solid var(--hairline);
          border-radius: 2px;
          font-family: var(--f-display);
          font-size: 10px;
          letter-spacing: 0.08em;
          background: rgba(255, 255, 255, 0.01);
        }
        .fold-tag { color: var(--text-muted); font-weight: 600; }
        .fold-bar {
          height: 6px;
          background: var(--meter-empty);
          position: relative;
        }
        .fold-bar::after {
          content: '';
          position: absolute;
          left: 0; top: 0; bottom: 0;
          width: var(--pct, 50%);
          background: var(--phase-running);
        }
        .wf-fold.neg .fold-bar::after { background: var(--grid-short); }
        .fold-val {
          font-family: var(--f-data);
          font-size: 10px;
          color: var(--text-secondary);
          letter-spacing: 0;
        }
        .wf-fold.neg .fold-val { color: var(--grid-short); }
      `}</style>
    </section>
  );
}

function Metric({ k, v, accent = false, warn = false }: { k: string; v: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="wf-metric">
      <span className="k">{k}</span>
      <span className={`v ${accent ? 'accent' : ''} ${warn ? 'warn' : ''} tabular-nums`}>{v}</span>
      <style jsx>{`
        .wf-metric { display: flex; flex-direction: column; gap: 4px; }
        .k {
          font-family: var(--f-display);
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .v {
          font-family: var(--f-data);
          font-size: 16px; font-weight: 500;
          line-height: 1;
        }
        .v.accent { color: var(--supervisor); }
        .v.warn { color: var(--phase-breakout); }
      `}</style>
    </div>
  );
}

function buildPath(values: number[]): string {
  if (values.length === 0) return 'M0,150';
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = Math.max(1e-9, maxV - minV);
  const top = 24;
  const bottom = 156;
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * 800;
    const y = bottom - ((v - minV) / range) * (bottom - top);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `M${pts.join(' L')}`;
}
