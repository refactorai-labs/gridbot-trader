'use client';

// /pionex — Pionex long futures grid backtester (plan §6). Phase 0: shell,
// symbol/window selection, data window check with gap report, Top N drops.
// Zones that arrive in later phases are rendered as labelled placeholders.

import { useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Database, Loader2, Play, SlidersHorizontal, Target } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import DrawdownPicker, { PickedWindow } from '@/components/pionex/DrawdownPicker';
import { PIONEX_SYMBOLS, PionexSymbol } from '@/lib/constants';
import { DataGapReport } from '@/lib/pionex/dataQuality';

interface DataCheck {
  report: DataGapReport;
  timingMs: { last: number; mark: number; funding: number };
  counts: { last1m: number; mark1m: number; funding: number };
}

// An emptied date input yields NaN; it renders as an empty field and disables the check.
const toInput = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');
const fromInput = (s: string) => Date.parse(`${s}T00:00:00.000Z`);
const fmtTs = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <section className="card p-4 flex items-center justify-between">
      <span className="card-header">{title}</span>
      <span className="badge badge-neutral">{phase}</span>
    </section>
  );
}

function SeriesRow({ label, q }: { label: string; q: DataGapReport['last'] }) {
  const ok = q.gaps.length === 0;
  return (
    <div className="flex items-center gap-3 text-xs font-mono">
      <span className="w-14" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)' }}>{q.found.toLocaleString()} / {q.expected.toLocaleString()} min</span>
      <span className={`badge ${ok ? 'badge-long' : 'badge-short'}`}>{ok ? 'complete' : `${q.gaps.length} gaps`}</span>
    </div>
  );
}

export default function PionexPage() {
  const [symbol, setSymbol] = useState<PionexSymbol>('ETHUSDT');
  const [startMs, setStartMs] = useState(() => Date.UTC(2022, 4, 4));
  const [endMs, setEndMs] = useState(() => Date.UTC(2022, 4, 20));
  const [leadDays, setLeadDays] = useState(2);
  const [picked, setPicked] = useState<PickedWindow | null>(null);
  const [check, setCheck] = useState<DataCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Id of the data check whose response may still be applied; any symbol/window
  // change bumps it so a late response for the old selection is dropped.
  const checkId = useRef(0);

  const resetCheck = () => {
    checkId.current++;
    setCheck(null);
    setError(null);
    setChecking(false);
  };

  const pickWindow = (w: PickedWindow) => {
    setPicked(w);
    setStartMs(w.startMs);
    setEndMs(w.endMs);
    resetCheck();
  };

  const runCheck = async () => {
    const id = ++checkId.current;
    setChecking(true);
    setError(null);
    setCheck(null);
    try {
      const res = await fetch('/api/pionex/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, startMs, endMs }),
      });
      const data = await res.json();
      if (id !== checkId.current) return;
      if (!res.ok) throw new Error(data.error ?? 'data check failed');
      setCheck(data);
    } catch (e) {
      if (id === checkId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === checkId.current) setChecking(false);
    }
  };

  const validWindow = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const days = validWindow ? (endMs - startMs) / 86_400_000 : 0;

  return (
    <div className="app-shell min-h-screen">
      <header className="topbar">
        <div className="flex items-center gap-4 min-w-0">
          <div className="brand-mark"><Target size={20} /></div>
          <div className="hidden sm:block min-w-0">
            <div className="font-mono text-sm font-bold tracking-[0.08em]" style={{ color: 'var(--text-primary)' }}>
              PIONEX GRID BACKTESTER
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Long futures grid · 1m last + mark · survival & liquidation
            </div>
          </div>
          <div className="topbar-divider" />
          <div className="topbar-pill topbar-pair">{symbol.replace('USDT', '/USDT')} PERP</div>
          <div className="topbar-pill">{days.toFixed(1)} d</div>
          {check && (
            <div className="hidden md:flex topbar-metric">
              <Database size={14} />
              <span>Data</span>
              <strong className={check.report.complete ? 'text-profit' : 'text-loss'}>
                {check.report.complete ? 'complete' : 'incomplete'}
              </strong>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden xl:flex topbar-date-row">
            <strong>{toInput(startMs)}</strong>
            <span>→</span>
            <strong>{toInput(endMs)}</strong>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="workbench">
        <aside className="app-rail" aria-label="Pionex sections">
          <Link href="/" className="rail-btn" title="Back to simulator">
            <ArrowLeft size={20} />
            <span>Simulator</span>
          </Link>
          <button className="rail-btn active" title="Parameters">
            <SlidersHorizontal size={20} />
            <span>Params</span>
          </button>
          <button className="rail-btn" title="Data">
            <Database size={20} />
            <span>Data</span>
          </button>
          <button className="rail-run" title="Run (phase 3)" disabled>
            <Play size={19} />
            <span>Run</span>
          </button>
        </aside>

        <div className="grid gap-3 xl:grid-cols-[340px_minmax(0,1fr)] items-start">
          {/* ── left column: window + parameters ── */}
          <div className="flex flex-col gap-3">
            <section className="card p-4 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="card-header">Window</span>
                {picked && <span className="badge badge-fill">hindsight</span>}
              </div>
              <div>
                <label className="form-label">Symbol</label>
                <select
                  className="form-select"
                  value={symbol}
                  onChange={e => { setSymbol(e.target.value as PionexSymbol); setPicked(null); resetCheck(); }}
                >
                  {PIONEX_SYMBOLS.map(s => <option key={s} value={s}>{s} PERP</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="form-label">From (UTC)</label>
                  <input
                    type="date"
                    className="form-input"
                    value={toInput(startMs)}
                    onChange={e => { setStartMs(fromInput(e.target.value)); setPicked(null); resetCheck(); }}
                  />
                </div>
                <div>
                  <label className="form-label">To (UTC)</label>
                  <input
                    type="date"
                    className="form-input"
                    value={toInput(endMs)}
                    onChange={e => { setEndMs(fromInput(e.target.value)); setPicked(null); resetCheck(); }}
                  />
                </div>
              </div>
              <DrawdownPicker symbol={symbol} leadDays={leadDays} onLeadDaysChange={setLeadDays} onPick={pickWindow} />
              <button className="btn btn-primary flex items-center justify-center gap-2" onClick={runCheck} disabled={checking || !validWindow}>
                {checking ? <Loader2 size={15} className="animate-spin" /> : <Database size={15} />}
                {checking ? 'Loading window…' : 'Check data window'}
              </button>
            </section>
            <Placeholder title="Parameters" phase="phase 3" />
          </div>

          {/* ── right column ── */}
          <div className="flex flex-col gap-3">
            <section className="card p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="card-header">Data coverage</span>
                {check && (
                  <span className={`badge ${check.report.complete ? 'badge-long' : 'badge-short'}`}>
                    {check.report.complete ? 'verdict allowed' : 'data-incomplete · no survival verdict'}
                  </span>
                )}
              </div>
              {error && <div className="text-xs font-mono" style={{ color: 'var(--grid-short)' }}>{error}</div>}
              {!check && !error && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Pick a window and check it. Missing 1m last, 1m mark or funding stretches are downloaded from
                  Binance; what is still missing afterwards is listed here and blocks a survival verdict.
                </p>
              )}
              {check && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <SeriesRow label="last 1m" q={check.report.last} />
                    <SeriesRow label="mark 1m" q={check.report.mark} />
                    <div className="flex items-center gap-3 text-xs font-mono">
                      <span className="w-14" style={{ color: 'var(--text-muted)' }}>funding</span>
                      <span style={{ color: 'var(--text-primary)' }}>{check.report.funding.records} settlements</span>
                      <span className={`badge ${check.report.funding.gaps.length === 0 ? 'badge-long' : 'badge-short'}`}>
                        {check.report.funding.gaps.length === 0 ? 'strict coverage' : `${check.report.funding.gaps.length} gaps`}
                      </span>
                    </div>
                  </div>
                  {check.report.errors.length > 0 && (
                    <ul className="text-[11px] font-mono flex flex-col gap-0.5" style={{ color: 'var(--grid-short)' }}>
                      {check.report.errors.map(m => <li key={m}>{m}</li>)}
                    </ul>
                  )}
                  {(check.report.last.gaps.length + check.report.mark.gaps.length + check.report.funding.gaps.length) > 0 && (
                    <ul className="text-[11px] font-mono flex flex-col gap-0.5 max-h-40 overflow-y-auto" style={{ color: 'var(--text-secondary)' }}>
                      {check.report.last.gaps.map(g => <li key={`l${g.startMs}`}>last · {fmtTs(g.startMs)} → {fmtTs(g.endMs)} · {g.minutes} min</li>)}
                      {check.report.mark.gaps.map(g => <li key={`m${g.startMs}`}>mark · {fmtTs(g.startMs)} → {fmtTs(g.endMs)} · {g.minutes} min</li>)}
                      {check.report.funding.gaps.map(g => <li key={`f${g.startMs}`}>funding · {fmtTs(g.startMs)} → {fmtTs(g.endMs)}</li>)}
                    </ul>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    {([['last', check.timingMs.last], ['mark', check.timingMs.mark], ['funding', check.timingMs.funding]] as const).map(([k, v]) => (
                      <div key={k} className="stat-card">
                        <div className="stat-label">{k} load</div>
                        <div className="stat-value">{(v / 1000).toFixed(1)}s</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
            <Placeholder title="Verdict · Pionex card" phase="phase 3" />
            <Placeholder title="Exposure" phase="phase 3" />
            <Placeholder title="Chart (5m) · liquidation lines · markers" phase="phase 3" />
            <Placeholder title="Equity · Liq distance · Position · Funding · Events" phase="phase 3" />
            <Placeholder title="Runs · pin · trio" phase="phase 3" />
          </div>
        </div>
      </div>
    </div>
  );
}
