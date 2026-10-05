'use client';

// /pionex — Pionex long futures grid backtester (plan §6): window + data check,
// parameters, run (path A and B), verdict and card, exposure, main chart, sub-charts
// and events, saved runs with two pins, and the equal-capital trio (§6.3).

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Database, Loader2, Play, SlidersHorizontal, Target, Users } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import TradingChart from '@/components/charts/TradingChart';
import DrawdownPicker, { PickedWindow } from '@/components/pionex/DrawdownPicker';
import ParamPanel from '@/components/pionex/ParamPanel';
import PionexCard from '@/components/pionex/PionexCard';
import ExposurePanel from '@/components/pionex/ExposurePanel';
import SubCharts from '@/components/pionex/SubCharts';
import Assumptions from '@/components/pionex/Assumptions';
import RunHistory from '@/components/pionex/RunHistory';
import { buildChartData } from '@/components/pionex/chartData';
import { PIONEX_SYMBOLS, PionexSymbol } from '@/lib/constants';
import { usePersistentState } from '@/lib/usePersistentState';
import { DataGapReport } from '@/lib/pionex/dataQuality';
import { BOT_A_PARAMS, GATE_WINDOWS, PionexParams, rerunRequest, toRunRequest, trioRequests } from '@/lib/pionex/params';
import type { PionexRunPayload, PionexRunRequest } from '@/lib/pionex/runStore';
import { PathId } from '@/lib/pionex/types';

interface DataCheck {
  report: DataGapReport;
  timingMs: { last: number; mark: number; funding: number };
  counts: { last1m: number; mark1m: number; funding: number };
}

// An emptied date input yields NaN; it renders as an empty field and disables the check.
const toInput = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');
const fromInput = (s: string) => Date.parse(`${s}T00:00:00.000Z`);
const fmtTs = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

interface RunTiming { load: number; compute: number; save: number }

const NO_FILLED = new Set<number>();

// A window without usable data comes back as 422 with the gap report (plan §3.10);
// it is shown in the data coverage card instead of a run.
class NoDataError extends Error {
  constructor(message: string, readonly check: DataCheck) { super(message); }
}

async function postRun(req: PionexRunRequest): Promise<{ run: PionexRunPayload; timingMs: RunTiming }> {
  const res = await fetch('/api/pionex/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (res.status === 422 && data.report) throw new NoDataError(data.error, data);
  if (!res.ok) throw new Error(data.error ?? 'run failed');
  return data;
}

async function getRun(id: string): Promise<PionexRunPayload> {
  const res = await fetch(`/api/pionex/runs/${id}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'run not found');
  return data.run;
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

  const [params, setParams] = usePersistentState<PionexParams>('pionex.params', BOT_A_PARAMS);
  const [run, setRun] = useState<PionexRunPayload | null>(null);
  const [trio, setTrio] = useState<PionexRunPayload[] | null>(null);
  const [timing, setTiming] = useState<RunTiming[] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [path, setPath] = useState<PathId>('A');
  const [pinned, setPinned] = usePersistentState<string[]>('pionex.pinned', []);
  const [pinnedRuns, setPinnedRuns] = useState<Record<string, PionexRunPayload>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  // Same guard for runs: a newer run / open request drops a late older response.
  const runId = useRef(0);

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

  // Runs requests in order; the first result becomes the shown run, several = trio.
  const execute = async (reqs: PionexRunRequest[]) => {
    const id = ++runId.current;
    setRunError(null);
    const results: PionexRunPayload[] = [];
    const timings: RunTiming[] = [];
    try {
      for (let i = 0; i < reqs.length; i++) {
        setRunning(reqs.length > 1 ? `Running trio ${i + 1}/${reqs.length}…` : 'Running A + B…');
        const r = await postRun(reqs[i]);
        if (id !== runId.current) return;
        results.push(r.run);
        timings.push(r.timingMs);
      }
      setRun(results[0]);
      setTrio(results.length > 1 ? results : null);
      setTiming(timings);
      setRefreshKey(k => k + 1);
    } catch (e) {
      if (id !== runId.current) return;
      if (e instanceof NoDataError) {
        checkId.current++; // drop a pending manual check for the same window
        setChecking(false);
        setCheck(e.check);
        setRun(null);
        setTrio(null);
      }
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === runId.current) setRunning(null);
    }
  };

  const runCurrent = () => execute([toRunRequest(params, symbol, startMs, endMs)]);
  const runTrio = () => execute(trioRequests(params, symbol, startMs, endMs));
  // Gate window: one click sets the window and runs it (decision 2, phase 3).
  const runGate = (w: { startMs: number; endMs: number }) => {
    setPicked(null);
    setStartMs(w.startMs);
    setEndMs(w.endMs);
    resetCheck();
    execute([toRunRequest(params, symbol, w.startMs, w.endMs)]);
  };

  const openRun = async (rid: string) => {
    const id = ++runId.current;
    setRunError(null);
    setRunning('Loading run…');
    try {
      const r = await getRun(rid);
      if (id !== runId.current) return;
      setRun(r);
      setTrio(null);
      setTiming(null);
    } catch (e) {
      if (id === runId.current) setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === runId.current) setRunning(null);
    }
  };

  const togglePin = (rid: string) =>
    setPinned(ps => (ps.includes(rid) ? ps.filter(x => x !== rid) : ps.length < 2 ? [...ps, rid] : ps));

  // Load the pinned runs that are not loaded yet; unknown ids are unpinned.
  useEffect(() => {
    pinned.filter(rid => !pinnedRuns[rid]).forEach(rid => {
      getRun(rid)
        .then(r => setPinnedRuns(m => ({ ...m, [rid]: r })))
        .catch(() => setPinned(ps => ps.filter(x => x !== rid)));
    });
  }, [pinned, pinnedRuns, setPinned]);

  const chart = useMemo(() => (run ? buildChartData(run, path) : null), [run, path]);
  const busy = running !== null;

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
          <button className="rail-run" title="Run" disabled={busy || !validWindow} onClick={runCurrent}>
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
              <button className="btn btn-secondary flex items-center justify-center gap-2" onClick={runCheck} disabled={checking || !validWindow}>
                {checking ? <Loader2 size={15} className="animate-spin" /> : <Database size={15} />}
                {checking ? 'Loading window…' : 'Check data window'}
              </button>
            </section>
            <ParamPanel params={params} onChange={setParams} />
            <section className="card p-4 flex flex-col gap-3">
              <div>
                <span className="form-label">Gate windows · one click runs</span>
                <div className="grid grid-cols-3 gap-2">
                  {GATE_WINDOWS[symbol].map(w => (
                    <button key={w.label} className="btn btn-secondary !px-2 text-xs" disabled={busy} onClick={() => runGate(w)}>
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button className="btn btn-primary flex items-center justify-center gap-2" disabled={busy || !validWindow} onClick={runCurrent}>
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                  Run
                </button>
                <button className="btn btn-secondary flex items-center justify-center gap-2" disabled={busy || !validWindow} onClick={runTrio} title="Equal-capital trio (plan §6.3)">
                  <Users size={15} />
                  Trio
                </button>
              </div>
              {running && <div className="text-xs font-mono animate-pulse" style={{ color: 'var(--text-muted)' }}>{running}</div>}
              {runError && <div className="text-xs font-mono" style={{ color: 'var(--grid-short)' }}>{runError}</div>}
              {timing && (
                <div className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                  {timing.map((t, i) => (
                    <div key={i}>load {(t.load / 1000).toFixed(1)}s · compute (A+B) {(t.compute / 1000).toFixed(2)}s · save {(t.save / 1000).toFixed(2)}s</div>
                  ))}
                </div>
              )}
              <p className="text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                Trio: same total capital and window — (1) all reserve as extra margin, (2) the panel&apos;s E plus
                top-ups, (3) two staggered bots. Set a total capital above I + E in “Common capital”.
              </p>
            </section>
            <Assumptions dataReport={run?.dataReport} />
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
            {trio && (
              <div className="grid gap-3 lg:grid-cols-3">
                {trio.map((r, i) => (
                  <div key={r.id} className="flex flex-col gap-3 min-w-0">
                    <div role="button" tabIndex={0} className="cursor-pointer" onClick={() => setRun(r)} title="Show this variant below">
                      <PionexCard run={r} compact title={r.name.replace(/^trio: /, '')} />
                    </div>
                    <ExposurePanel run={r} path={path} />
                    {run?.id === r.id && <span className="badge badge-neutral self-start">shown below · {i + 1}</span>}
                  </div>
                ))}
              </div>
            )}

            {!run && !busy && (
              <section className="card p-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                Set the parameters and press Run (or a gate window). Each run simulates path A and path B, is saved,
                and appears in the run list below.
              </section>
            )}

            {run && chart && (
              <>
                <PionexCard run={run} />
                {run.stale && (
                  <button className="btn btn-secondary self-start flex items-center gap-2 text-xs" disabled={busy} onClick={() => execute([rerunRequest(run)])}>
                    <Play size={13} />
                    Re-run (saves a fresh run)
                  </button>
                )}
                <ExposurePanel run={run} path={path} />
                <section className="chart-card chart-card-long">
                  <div className="flex items-center gap-2 px-3 pt-2 text-xs font-mono">
                    <span style={{ color: 'var(--text-muted)' }}>Chart path</span>
                    {(['A', 'B'] as PathId[]).map(p => (
                      <button key={p} className={`tab-btn !px-2 !py-1 ${path === p ? 'active' : ''}`} onClick={() => setPath(p)}>{p}</button>
                    ))}
                    <span className="ml-auto" style={{ color: 'var(--text-muted)' }}>
                      5m candles · fills · liq line per bot · bot 2 band (dashed) · interventions at their 5m candle
                    </span>
                  </div>
                  <TradingChart
                    candles={run.candles5m}
                    gridLevels={chart.levels}
                    side="long"
                    filledLevelIndices={NO_FILLED}
                    fills={chart.fills}
                    fitAll
                    height={460}
                    leverage={run.config.bot.leverage}
                    lineSeries={chart.lineSeries}
                    markers={chart.markers}
                    verticalMarkers={chart.verticalMarkers}
                    minBarSpacing={0.01}
                    hoverLines={chart.hoverLines}
                  />
                </section>
                <SubCharts run={run} />
              </>
            )}

            {pinned.length > 0 && (
              <div className="grid gap-3 lg:grid-cols-2">
                {pinned.map(rid => (pinnedRuns[rid]
                  ? <PionexCard key={rid} run={pinnedRuns[rid]} compact title={`📌 ${pinnedRuns[rid].name}`} />
                  : <section key={rid} className="card p-4 text-xs animate-pulse">loading pinned run…</section>))}
              </div>
            )}

            <RunHistory
              refreshKey={refreshKey}
              activeId={run?.id ?? null}
              pinned={pinned}
              onOpen={openRun}
              onTogglePin={togglePin}
              onDeleted={rid => {
                setPinned(ps => ps.filter(x => x !== rid));
                if (run?.id === rid) setRun(null);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
