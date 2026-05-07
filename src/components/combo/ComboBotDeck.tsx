'use client';

import { BotPhase, GridSide, ComboMode } from '@/lib/types';
import { BotPhaseView, PnLView } from './types';

const PHASE_LABEL: Record<BotPhase, string> = {
  IDLE: 'IDLE',
  BREAKOUT: 'BREAKOUT',
  RUNNING: 'RUNNING',
  COOLDOWN: 'COOLDOWN',
  SL_RETRY: 'SL RETRY',
  REOPENING: 'REOPENING',
  HIBERNATING: 'HIBERNATING',
};
const PHASE_COLOR: Record<BotPhase, string> = {
  IDLE: 'var(--phase-idle)',
  BREAKOUT: 'var(--phase-breakout)',
  RUNNING: 'var(--phase-running)',
  COOLDOWN: 'var(--phase-cooldown)',
  SL_RETRY: 'var(--grid-short)',
  REOPENING: 'var(--phase-reopening)',
  HIBERNATING: 'var(--phase-hibernating)',
};

interface Props {
  long?: BotPhaseView | null;
  short?: BotPhaseView | null;
  pnl?: PnLView | null;
  mode: ComboMode;
}

export default function ComboBotDeck({ long, short, pnl, mode }: Props) {
  return (
    <section className="deck">
      {mode !== 'short' && <BotCard view={long ?? placeholder('long')} />}
      {mode !== 'long' && <BotCard view={short ?? placeholder('short')} />}
      <PnLCard pnl={pnl} />

      <style jsx>{`
        .deck {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          border-top: 1px solid var(--hairline);
          background: var(--card-bg);
        }
        .deck > :global(*) { border-right: 1px solid var(--hairline); }
        .deck > :global(*:last-child) { border-right: 0; }
        @media (max-width: 1280px) {
          .deck { grid-template-columns: 1fr 1fr; }
          .deck > :global(.pnl-card) {
            grid-column: 1 / 3;
            border-top: 1px solid var(--hairline);
            border-right: 0;
          }
        }
        @media (max-width: 900px) {
          .deck { grid-template-columns: 1fr; }
          .deck > :global(*) {
            border-right: 0;
            border-bottom: 1px solid var(--hairline);
          }
          .deck > :global(.pnl-card) { grid-column: 1 / 2; }
        }
      `}</style>
    </section>
  );
}

function placeholder(side: GridSide): BotPhaseView {
  return {
    side,
    phase: 'IDLE',
    retryCount: 0,
    retryCap: 2,
    currentTier: 0,
    cooldownCandlesRemaining: 0,
    hibernationCandlesRemaining: 0,
  };
}

function BotCard({ view }: { view: BotPhaseView }) {
  const color = PHASE_COLOR[view.phase];
  const label = PHASE_LABEL[view.phase];
  const pulse = view.phase === 'RUNNING' || view.phase === 'BREAKOUT';
  const sideClass = view.side === 'long' ? 'long' : 'short';
  const sideColor = view.side === 'long' ? 'var(--grid-long)' : 'var(--grid-short)';
  const sideLabel = view.side === 'long' ? 'LONG · BOT' : 'SHORT · BOT';

  return (
    <div className={`bot-card ${sideClass}`}>
      <div className="bot-head">
        <span className="side-tag" style={{ color: sideColor }}>{sideLabel}</span>
        <span
          className="phase-badge"
          style={{ color }}
          data-pulse={pulse ? 'true' : 'false'}
        >
          <span className="phase-lamp" />
          {label}
        </span>
      </div>

      <TierMeter tier={view.currentTier} />

      {view.reopenLights && <ReopenStack lights={view.reopenLights} />}

      <div className="state-row">
        <div className="retry-group">
          <span className="combo-section-label" style={{ fontSize: 9 }}>Retry</span>
          <span className="retry-dots">
            {Array.from({ length: view.retryCap }).map((_, i) => (
              <span key={i} className={`retry-dot ${i < view.retryCount ? 'filled' : ''}`} />
            ))}
          </span>
          <span className="count-ticker tabular-nums">{view.retryCount} / {view.retryCap}</span>
        </div>
        <div className="count-ticker tabular-nums">
          {view.phase === 'COOLDOWN' && view.cooldownCandlesRemaining > 0 && `CD · ${view.cooldownCandlesRemaining}`}
          {view.phase === 'HIBERNATING' && `HIB · ${view.hibernationCandlesRemaining}`}
        </div>
        <div className="last-event">
          {view.lastEventType && view.lastEventCandleIdx != null && (
            <>
              <span className="ev-type" style={{ color }}>{view.lastEventType.replace(/_/g, '·').toUpperCase()}</span>
              <span className="tabular-nums"> · idx {view.lastEventCandleIdx}</span>
            </>
          )}
        </div>
      </div>

      <style jsx>{`
        .bot-card {
          padding: 16px 20px;
          display: flex; flex-direction: column; gap: 14px;
          position: relative;
          min-height: 180px;
        }
        .bot-card::before {
          content: '';
          position: absolute; left: 0; top: 0; bottom: 0;
          width: 2px;
          background: ${sideColor};
        }
        .bot-head {
          display: flex; align-items: center; gap: 10px;
          justify-content: space-between;
        }
        .side-tag {
          font-family: var(--f-display);
          font-size: 10px; font-weight: 600;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }
        .phase-badge {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 4px 10px 3px 8px;
          border: 1px solid currentColor;
          border-radius: 2px;
          font-family: var(--f-display);
          font-size: 10px; font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        .phase-lamp {
          width: 7px; height: 7px; border-radius: 50%;
          background: currentColor;
          box-shadow: 0 0 6px currentColor;
        }
        .phase-badge[data-pulse='true'] .phase-lamp {
          animation: cmb-pulse 1.6s ease-in-out infinite;
        }
        @keyframes cmb-pulse {
          0%, 100% { box-shadow: 0 0 3px currentColor; opacity: 0.6; }
          50% { box-shadow: 0 0 12px currentColor, 0 0 2px currentColor; opacity: 1; }
        }
        .state-row {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 10px;
          align-items: center;
          padding-top: 10px;
          border-top: 1px dashed var(--hairline);
          margin-top: auto;
        }
        .retry-group {
          display: flex; align-items: center; gap: 8px;
        }
        .retry-dots { display: inline-flex; gap: 3px; }
        .retry-dot {
          width: 8px; height: 8px;
          border: 1px solid var(--hairline-strong);
          background: transparent;
        }
        .retry-dot.filled {
          background: var(--grid-short);
          border-color: var(--grid-short);
          box-shadow: 0 0 4px var(--grid-short);
        }
        .count-ticker {
          font-family: var(--f-data);
          font-size: 11px;
          color: var(--text-secondary);
        }
        .last-event {
          font-family: var(--f-display);
          font-size: 9.5px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--text-muted);
          text-align: right;
        }
      `}</style>
    </div>
  );
}

function TierMeter({ tier }: { tier: 0 | 1 | 2 | 3 }) {
  const pct = tier === 0 ? 0 : tier === 1 ? 25 : tier === 2 ? 50 : 100;
  return (
    <div className="tier-meter">
      <span className="combo-section-label" style={{ fontSize: 9 }}>TIER</span>
      <div className="tier-rail">
        <div className="tier-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="tier-stamp tabular-nums">{tier === 0 ? '— / 0%' : `T${tier} / ${pct}%`}</span>

      <style jsx>{`
        .tier-meter {
          display: grid;
          grid-template-columns: 42px 1fr 58px;
          align-items: center;
          gap: 10px;
        }
        .tier-rail {
          height: 10px;
          position: relative;
          background:
            linear-gradient(to right,
              var(--meter-empty) 0 25%,
              var(--hairline) 25% 25.3%,
              var(--meter-empty) 25.3% 50%,
              var(--hairline) 50% 50.3%,
              var(--meter-empty) 50.3% 75%,
              var(--hairline) 75% 75.3%,
              var(--meter-empty) 75.3% 100%);
          border-left: 1px solid var(--hairline-strong);
          border-right: 1px solid var(--hairline-strong);
          overflow: hidden;
        }
        .tier-fill {
          height: 100%;
          background: linear-gradient(to right,
            var(--phase-breakout) 0%, var(--phase-breakout) 25%,
            var(--phase-reopening) 25%, var(--phase-reopening) 50%,
            var(--supervisor) 50%, var(--supervisor) 100%);
          transition: width 0.4s cubic-bezier(.2, .8, .4, 1);
        }
        .tier-stamp {
          font-family: var(--f-data);
          font-size: 10px;
          color: var(--text-secondary);
          text-align: right;
        }
      `}</style>
    </div>
  );
}

function ReopenStack({ lights }: { lights: NonNullable<BotPhaseView['reopenLights']> }) {
  return (
    <div className="reopen-stack">
      <span className="label combo-section-label" style={{ fontSize: 9 }}>REOPEN</span>
      <Light on={lights.cooldownElapsed} tag="CD"    />
      <Light on={lights.regimeTrending}  tag="REG"   />
      <Light on={lights.atrCompressed}   tag="ATR"   />
      {lights.avwapAligned !== null && (
        <Light on={lights.avwapAligned}  tag="AVWAP" orange />
      )}

      <style jsx>{`
        .reopen-stack {
          display: grid;
          grid-template-columns: 42px repeat(4, 1fr);
          gap: 6px;
          align-items: center;
        }
      `}</style>
    </div>
  );
}

function Light({ on, tag, orange = false }: { on: boolean; tag: string; orange?: boolean }) {
  const color = orange ? 'var(--grid-fill)' : 'var(--grid-long)';
  return (
    <div className="reopen-light" data-on={on ? 'true' : 'false'}>
      <span className="bulb" style={{ ['--color' as string]: color } as React.CSSProperties} />
      <span className="tag">{tag}</span>

      <style jsx>{`
        .reopen-light {
          display: flex; flex-direction: column; align-items: center; gap: 4px;
        }
        .bulb {
          width: 16px; height: 16px;
          border-radius: 50%;
          background:
            radial-gradient(circle at 50% 40%, rgba(255, 255, 255, 0.04) 0%, transparent 60%),
            var(--input-bg);
          border: 1px solid var(--input-border);
          box-shadow:
            inset 0 1px 2px rgba(0, 0, 0, 0.5),
            inset 0 -1px 0 rgba(255, 255, 255, 0.04);
          transition: all 0.2s ease;
        }
        .reopen-light[data-on='true'] .bulb {
          background:
            radial-gradient(circle at 50% 35%, rgba(255, 255, 255, 0.45) 0%, var(--color) 60%, var(--color) 100%);
          border-color: var(--color);
          box-shadow:
            inset 0 1px 2px rgba(0, 0, 0, 0.3),
            0 0 8px var(--color),
            0 0 14px color-mix(in srgb, var(--color) 40%, transparent);
        }
        .tag {
          font-family: var(--f-display);
          font-size: 8.5px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .reopen-light[data-on='true'] .tag {
          color: var(--color);
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}

function PnLCard({ pnl }: { pnl: PnLView | null | undefined }) {
  const p = pnl ?? {
    totalEquity: 0, baseCapital: 0, totalPnl: 0, totalPnlPct: 0,
    longRealized: 0, longUnrealized: 0, shortRealized: 0, shortUnrealized: 0,
    fundingCost: 0, notional: 0, maxDrawdownPct: 0, winCount: 0, lossCount: 0,
  };
  const pos = p.totalPnl >= 0;

  return (
    <div className="pnl-card">
      <div className="pnl-head">
        <span className="combo-section-label">Profit &amp; loss</span>
        <span className="combo-coord">
          <span className="k">EQ</span><span className="eq">=</span>
          <span className="v tabular-nums">${formatNumber(p.totalEquity)}</span>
        </span>
      </div>

      <div className="pnl-equity">
        <span className="equity-value tabular-nums" style={{ color: pos ? 'var(--grid-long)' : 'var(--grid-short)' }}>
          {pos ? '+' : ''}${formatNumber(p.totalPnl)}
        </span>
        <span className="equity-delta tabular-nums" style={{ color: pos ? 'var(--grid-long)' : 'var(--grid-short)' }}>
          {pos ? '+' : ''}{p.totalPnlPct.toFixed(2)}%
        </span>
        <span className="base-note">vs ${formatNumber(p.baseCapital)} base</span>
      </div>

      <div className="pnl-split">
        <div className="long">
          <div className="lbl">Long realized</div>
          <div className="val tabular-nums" style={{ color: 'var(--grid-long)' }}>
            {formatSigned(p.longRealized)}
          </div>
          <div className="sub tabular-nums">
            unreal. <span style={{ color: 'var(--text-secondary)' }}>{formatSigned(p.longUnrealized)}</span>
          </div>
        </div>
        <div className="short">
          <div className="lbl">Short realized</div>
          <div className="val tabular-nums" style={{ color: 'var(--grid-short)' }}>
            {formatSigned(p.shortRealized)}
          </div>
          <div className="sub tabular-nums">
            unreal. <span style={{ color: 'var(--text-secondary)' }}>{formatSigned(p.shortUnrealized)}</span>
          </div>
        </div>
      </div>

      <div className="pnl-stats">
        <Stat k="Funding" v={formatSigned(-p.fundingCost)} neg={p.fundingCost > 0} />
        <Stat k="Notional" v={`$${formatCompact(p.notional)}`} />
        <Stat k="Max DD" v={`${p.maxDrawdownPct.toFixed(1)}%`} warn={p.maxDrawdownPct > 10} />
        <Stat k="W / L" v={`${p.winCount} / ${p.lossCount}`} />
      </div>

      <style jsx>{`
        .pnl-card {
          padding: 16px 20px;
          display: flex; flex-direction: column; gap: 16px;
          background: linear-gradient(to bottom, rgba(16, 185, 129, 0.02), transparent 60%);
        }
        .pnl-head {
          display: flex; align-items: baseline; justify-content: space-between;
        }
        .pnl-equity {
          display: flex; align-items: baseline; gap: 8px;
          flex-wrap: wrap;
        }
        .equity-value {
          font-family: var(--f-data);
          font-size: 26px; font-weight: 500;
          letter-spacing: -0.02em;
          line-height: 1;
        }
        .equity-delta {
          font-family: var(--f-data);
          font-size: 11px;
        }
        .base-note {
          font-family: var(--f-display);
          font-size: 9.5px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--text-muted);
          margin-left: auto;
        }
        .pnl-split {
          display: grid; grid-template-columns: 1fr 1fr;
          border: 1px solid var(--hairline);
          border-radius: 2px;
          overflow: hidden;
        }
        .pnl-split > :global(div) { padding: 10px 12px; }
        .pnl-split > :global(div + div) { border-left: 1px solid var(--hairline); }
        .pnl-split :global(.lbl) {
          font-family: var(--f-display);
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--text-muted);
          margin-bottom: 4px;
        }
        .pnl-split :global(.val) {
          font-family: var(--f-data);
          font-size: 14px; font-weight: 500;
          line-height: 1;
        }
        .pnl-split :global(.sub) {
          font-family: var(--f-data);
          font-size: 10px;
          color: var(--text-muted);
          margin-top: 4px;
        }
        .pnl-stats {
          display: grid; grid-template-columns: repeat(4, 1fr);
          border-top: 1px dashed var(--hairline);
          padding-top: 14px;
        }
      `}</style>
    </div>
  );
}

function Stat({ k, v, warn = false, neg = false }: { k: string; v: string; warn?: boolean; neg?: boolean }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className={`num ${warn ? 'warn' : ''} ${neg ? 'neg' : ''}`}>{v}</span>
      <style jsx>{`
        .stat {
          display: flex; flex-direction: column; gap: 4px;
          padding-right: 12px;
        }
        .stat + :global(.stat) {
          border-left: 1px solid var(--hairline);
          padding-left: 12px;
        }
        .k {
          font-family: var(--f-display);
          font-size: 9px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--text-muted);
        }
        .num {
          font-family: var(--f-data);
          font-size: 13px;
          color: var(--text-primary);
          line-height: 1;
        }
        .num.warn { color: var(--phase-breakout); }
        .num.neg { color: var(--grid-short); }
      `}</style>
    </div>
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatSigned(n: number): string {
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${formatNumber(Math.abs(n))}`;
}
function formatCompact(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(0);
}
