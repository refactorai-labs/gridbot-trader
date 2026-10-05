'use client';

// /research — Strategy B research dashboard.
// View (a): strategy anatomy. One chart, the whole story: regime tape, cycle
// zone boxes, both legs' grid activity, banking / unwind / stop events.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IChartApi, UTCTimestamp } from 'lightweight-charts';
import { Chakra_Petch, IBM_Plex_Mono } from 'next/font/google';
import AnatomyChart, { LayerVisibility } from '@/components/research/AnatomyChart';
import WalkForwardView, { WfArtifact } from '@/components/research/WalkForwardView';
import RobustnessView, { McArtifact } from '@/components/research/RobustnessView';
import { ArtifactEvent, ResearchArtifact } from '@/components/research/types';

const display = Chakra_Petch({ weight: ['500', '600', '700'], subsets: ['latin'] });
const mono = IBM_Plex_Mono({ weight: ['400', '500', '600'], subsets: ['latin'] });

const MODE_LABEL: Record<string, string> = {
  B: 'STRATEGY B',
  fullClose: 'FULL CLOSE',
  fullHold: 'FULL HOLD',
  oneSided: 'ONE-SIDED',
};

type CycleOutcome = 'STOPPED' | 'DERISKED' | 'UNWOUND' | 'EXITED' | 'OPEN';

const OUTCOME_STYLE: Record<CycleOutcome, string> = {
  STOPPED: 'text-red-400 border-red-400/40',
  DERISKED: 'text-slate-400 border-slate-400/40',
  UNWOUND: 'text-cyan-300 border-cyan-300/40',
  EXITED: 'text-teal-300 border-teal-300/40',
  OPEN: 'text-amber-300 border-amber-300/40',
};

function fmtDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ');
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

type ViewTab = 'anatomy' | 'walkforward' | 'robustness';

const TAB_LABEL: Record<ViewTab, string> = {
  anatomy: 'A · ANATOMY',
  walkforward: 'B · WALK-FORWARD',
  robustness: 'C · ROBUSTNESS',
};

export default function ResearchPage() {
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [view, setView] = useState<ViewTab>('anatomy');
  const [selected, setSelected] = useState<string>('sample-B');
  const [artifact, setArtifact] = useState<ResearchArtifact | null>(null);
  const [wfArtifact, setWfArtifact] = useState<WfArtifact | null>(null);
  const [mcArtifact, setMcArtifact] = useState<McArtifact | null>(null);
  const [wfSel, setWfSel] = useState<string | null>(null);
  const [mcSel, setMcSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCycle, setSelectedCycle] = useState<number | null>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  const [layers, setLayers] = useState<LayerVisibility>({
    regime: true,
    zones: true,
    fills: true,
    structural: true,
  });

  useEffect(() => {
    fetch('/api/research')
      .then(r => r.json())
      .then(d => setArtifacts(d.artifacts ?? []))
      .catch(() => setArtifacts([]));
  }, []);

  useEffect(() => {
    setArtifact(null);
    setError(null);
    setSelectedCycle(null);
    fetch(`/api/research?name=${selected}`)
      .then(r => {
        if (!r.ok) throw new Error(`artifact "${selected}" not found — run scripts/research/run-sample.ts`);
        return r.json();
      })
      .then(setArtifact)
      .catch(e => setError(e.message));
  }, [selected]);

  const sampleArtifacts = useMemo(
    () => artifacts.filter(a => a.startsWith('sample-') || (a.startsWith('holdout-') && a !== 'holdout-final')),
    [artifacts]
  );

  const wfArtifacts = useMemo(() => artifacts.filter(a => a.startsWith('walkforward-')).sort(), [artifacts]);
  const mcArtifacts = useMemo(() => artifacts.filter(a => a.startsWith('montecarlo-')).sort(), [artifacts]);

  // Default selections. V4 is the headline walk-forward variant (the others are
  // visible via the selector); otherwise fall back to the latest v-tag.
  const wfName = useMemo(
    () =>
      wfSel ??
      wfArtifacts.find(a => a === 'walkforward-v4') ??
      wfArtifacts.filter(a => /-v\d+$/.test(a)).pop() ??
      wfArtifacts[wfArtifacts.length - 1] ??
      null,
    [wfSel, wfArtifacts]
  );
  const mcName = useMemo(
    () => mcSel ?? mcArtifacts.filter(a => /-v\d+$/.test(a)).pop() ?? mcArtifacts[mcArtifacts.length - 1] ?? null,
    [mcSel, mcArtifacts]
  );

  // Fetch the selected walk-forward / monte-carlo artifact, refetching when the
  // selection changes (artifacts are large, so only refetch on a real change).
  const loadedWf = useRef<string | null>(null);
  useEffect(() => {
    if (view !== 'walkforward' || !wfName || loadedWf.current === wfName) return;
    loadedWf.current = wfName;
    setWfArtifact(null);
    setError(null);
    fetch(`/api/research?name=${wfName}`)
      .then(r => {
        if (!r.ok) throw new Error(`walk-forward artifact missing — run scripts/research/walk-forward.ts`);
        return r.json();
      })
      .then(setWfArtifact)
      .catch(e => { loadedWf.current = null; setError(e.message); });
  }, [view, wfName]);

  const loadedMc = useRef<string | null>(null);
  useEffect(() => {
    if (view !== 'robustness' || !mcName || loadedMc.current === mcName) return;
    loadedMc.current = mcName;
    setMcArtifact(null);
    setError(null);
    fetch(`/api/research?name=${mcName}`)
      .then(r => {
        if (!r.ok) throw new Error(`monte-carlo artifact missing — run scripts/research/monte-carlo.ts`);
        return r.json();
      })
      .then(setMcArtifact)
      .catch(e => { loadedMc.current = null; setError(e.message); });
  }, [view, mcName]);

  // Only cycles overlapping the displayed window.
  const cycles = useMemo(() => {
    if (!artifact) return [];
    const first = artifact.candles30m[0]?.timestamp ?? 0;
    return artifact.diagnostics.cycles.filter(c => (c.endSec ?? Infinity) > first);
  }, [artifact]);

  const cycleMeta = useMemo(() => {
    if (!artifact) return [];
    const lastSec = artifact.candles30m[artifact.candles30m.length - 1]?.timestamp ?? 0;
    return cycles.map(c => {
      const end = c.endSec ?? lastSec;
      const span = artifact.events.filter(e => e.timeSec >= c.startSec && e.timeSec <= end + 60);
      const banked = span.some(e => e.reason === 'bankProfit');
      let outcome: CycleOutcome = 'EXITED';
      if (span.some(e => e.type === 'stop')) outcome = 'STOPPED';
      else if (span.some(e => e.reason === 'derisk' || e.reason === 'stopDerisk')) outcome = 'DERISKED';
      else if (span.some(e => e.reason === 'hedgeUnwind')) outcome = 'UNWOUND';
      else if (c.endSec === null) outcome = 'OPEN';
      const pnl = span.reduce((s, e) => s + (e.realizedPnl ?? 0), 0);
      return { cycle: c, end, banked, outcome, pnl };
    });
  }, [artifact, cycles]);

  const structuralLog = useMemo(() => {
    if (!artifact) return [];
    let evts = artifact.events.filter(e => e.type !== 'funding' && e.type !== 'gridFill');
    if (selectedCycle !== null && cycleMeta[selectedCycle]) {
      const { cycle, end } = cycleMeta[selectedCycle];
      evts = evts.filter(e => e.timeSec >= cycle.startSec && e.timeSec <= end + 60);
    }
    return evts.slice(-220);
  }, [artifact, selectedCycle, cycleMeta]);

  const fees = useMemo(
    () => artifact?.events.reduce((s, e) => s + (e.type !== 'funding' ? e.fee ?? 0 : 0), 0) ?? 0,
    [artifact]
  );

  const zoomToCycle = useCallback(
    (idx: number) => {
      setSelectedCycle(prev => (prev === idx ? null : idx));
      const meta = cycleMeta[idx];
      if (!chart || !meta) return;
      const span = Math.max(meta.end - meta.cycle.startSec, 86_400);
      chart.timeScale().setVisibleRange({
        from: (meta.cycle.startSec - span * 0.2) as UTCTimestamp,
        to: (meta.end + span * 0.2) as UTCTimestamp,
      });
    },
    [chart, cycleMeta]
  );

  const resetView = useCallback(() => {
    setSelectedCycle(null);
    chart?.timeScale().fitContent();
  }, [chart]);

  const ret = artifact ? artifact.summary.equityEnd / artifact.summary.equityStart - 1 : 0;

  return (
    <div
      className={`${mono.className} min-h-screen text-slate-200`}
      style={{
        background:
          'radial-gradient(1200px 600px at 70% -10%, rgba(20,184,166,0.07), transparent 60%),' +
          'radial-gradient(900px 500px at 0% 110%, rgba(99,102,241,0.06), transparent 60%),' +
          '#06080d',
      }}
    >
      <div className="mx-auto max-w-[1640px] px-6 py-6">
        {/* ── header ── */}
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <div className="text-[10px] tracking-[0.35em] text-teal-300/70">GRIDBOT-TRADER / RESEARCH BENCH</div>
            <h1 className={`${display.className} mt-1 text-3xl font-bold tracking-wide text-slate-100`}>
              STRATEGY ANATOMY
              <span className="ml-3 text-base font-medium text-slate-400">ETH/USDT PERP · 30M SIGNAL · 1M FILLS</span>
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded border border-white/10 bg-white/[0.03] p-1">
              {(['anatomy', 'walkforward', 'robustness'] as ViewTab[]).map(v => (
                <button
                  key={v}
                  onClick={() => { setView(v); setError(null); }}
                  className={`${display.className} px-3 py-1.5 text-xs tracking-widest transition-colors ${
                    view === v ? 'bg-indigo-400/15 text-indigo-200' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {TAB_LABEL[v]}
                </button>
              ))}
            </div>
            {view === 'anatomy' && (
              <div className="flex gap-1 rounded border border-white/10 bg-white/[0.03] p-1">
                {sampleArtifacts.map(a => {
                  const isHoldout = a.startsWith('holdout-');
                  const m = a.replace(/^(sample|holdout)-/, '');
                  const active = a === selected;
                  return (
                    <button
                      key={a}
                      onClick={() => setSelected(a)}
                      className={`${display.className} px-3 py-1.5 text-xs tracking-widest transition-colors ${
                        active ? 'bg-teal-400/15 text-teal-200' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {isHoldout ? `HO·${MODE_LABEL[m] ?? m}` : MODE_LABEL[m] ?? m}
                    </button>
                  );
                })}
              </div>
            )}
            {view === 'walkforward' && wfArtifacts.length > 0 && (
              <div className="flex gap-1 rounded border border-white/10 bg-white/[0.03] p-1">
                {wfArtifacts.map(a => (
                  <button
                    key={a}
                    onClick={() => setWfSel(a)}
                    className={`${display.className} px-2.5 py-1.5 text-xs tracking-widest uppercase transition-colors ${
                      a === wfName ? 'bg-teal-400/15 text-teal-200' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {a.replace('walkforward-', '')}
                  </button>
                ))}
              </div>
            )}
            {view === 'robustness' && mcArtifacts.length > 0 && (
              <div className="flex gap-1 rounded border border-white/10 bg-white/[0.03] p-1">
                {mcArtifacts.map(a => (
                  <button
                    key={a}
                    onClick={() => setMcSel(a)}
                    className={`${display.className} px-2.5 py-1.5 text-xs tracking-widest uppercase transition-colors ${
                      a === mcName ? 'bg-teal-400/15 text-teal-200' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {a.replace('montecarlo-', '')}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        {error && (
          <div className="mt-8 rounded border border-red-400/30 bg-red-400/5 p-6 text-sm text-red-300">{error}</div>
        )}
        {((view === 'anatomy' && !artifact) || (view === 'walkforward' && !wfArtifact) || (view === 'robustness' && !mcArtifact)) && !error && (
          <div className="mt-8 animate-pulse text-sm text-slate-500">loading artifact…</div>
        )}

        {view === 'walkforward' && wfArtifact && (
          <WalkForwardView artifact={wfArtifact} displayFont={display.className} />
        )}

        {view === 'robustness' && mcArtifact && (
          <RobustnessView artifact={mcArtifact} displayFont={display.className} />
        )}

        {view === 'anatomy' && artifact && (
          <>
            {/* ── stat strip ── */}
            <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded border border-white/10 bg-white/10 sm:grid-cols-4 lg:grid-cols-8">
              {[
                ['WINDOW RETURN', fmtPct(ret), ret >= 0 ? 'text-teal-300' : 'text-red-400'],
                ['BUY & HOLD', fmtPct(artifact.summary.buyHoldReturn), 'text-slate-300'],
                ['MAX DRAWDOWN', fmtPct(artifact.summary.maxDrawdown), 'text-amber-300'],
                ['CYCLES', String(artifact.diagnostics.cyclesStarted), 'text-slate-200'],
                ['BANKS', String(artifact.diagnostics.banks), 'text-amber-300'],
                ['UNWINDS', String(artifact.diagnostics.unwinds), 'text-cyan-300'],
                ['STOPS L/S', `${artifact.summary.stops.long}/${artifact.summary.stops.short}`, 'text-red-400'],
                ['FEES PAID', `$${fees.toFixed(0)}`, 'text-slate-300'],
              ].map(([label, value, cls]) => (
                <div key={label} className="bg-[#0a0d14] px-4 py-3">
                  <div className="text-[9px] tracking-[0.25em] text-slate-500">{label}</div>
                  <div className={`mt-1 text-lg font-semibold ${cls}`}>{value}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_300px]">
              {/* ── chart card ── */}
              <section className="rounded border border-white/10 bg-[#07090f]/80 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
                  <div className="flex flex-wrap items-center gap-4 text-[10px] text-slate-400">
                    <Legend swatch="bg-teal-400/20 border border-teal-300/50" label="RANGE ZONE" />
                    <Legend swatch="bg-red-400/20" label="INVALIDATION" />
                    <Legend swatch="border-b-2 border-dashed border-red-400" label="HARD STOP" />
                    <Legend swatch="bg-indigo-400/30" label="TREND REGIME" />
                    <Legend swatch="bg-amber-400/30" label="VOL EXPANSION" />
                    <Legend swatch="rounded-full bg-amber-400" label="PARTIAL CLOSE ▼ %" />
                    <Legend swatch="rounded-full bg-cyan-300" label="UNWIND" />
                    <Legend swatch="text-red-400" label="✕ STOP" raw />
                    <Legend swatch="rotate-45 border border-teal-300 bg-teal-300/20" label="INITIAL OPEN" />
                  </div>
                  <div className="flex items-center gap-2">
                    {(Object.keys(layers) as Array<keyof LayerVisibility>).map(k => (
                      <button
                        key={k}
                        onClick={() => setLayers(l => ({ ...l, [k]: !l[k] }))}
                        className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                          layers[k]
                            ? 'border-teal-300/40 bg-teal-300/10 text-teal-200'
                            : 'border-white/10 text-slate-500'
                        }`}
                      >
                        {k}
                      </button>
                    ))}
                    <button
                      onClick={resetView}
                      className="rounded border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-200"
                    >
                      fit all
                    </button>
                  </div>
                </div>
                <AnatomyChart
                  candles={artifact.candles30m}
                  events={artifact.events}
                  cycles={cycles}
                  regimeSeries={artifact.diagnostics.regimeSeries}
                  selectedCycle={selectedCycle}
                  layers={layers}
                  height={560}
                  onChartReady={setChart}
                />
              </section>

              {/* ── right rail: cycle navigator + structural log ── */}
              <aside className="flex max-h-[640px] flex-col gap-4">
                <section className="rounded border border-white/10 bg-[#07090f]/80">
                  <h2 className={`${display.className} border-b border-white/10 px-3 py-2 text-xs tracking-[0.25em] text-slate-400`}>
                    CYCLES · {cycleMeta.length}
                  </h2>
                  <div className="max-h-64 overflow-y-auto">
                    {cycleMeta.map((m, i) => (
                      <button
                        key={i}
                        onClick={() => zoomToCycle(i)}
                        className={`flex w-full items-center justify-between gap-2 border-b border-white/5 px-3 py-2 text-left text-[11px] transition-colors hover:bg-white/[0.04] ${
                          selectedCycle === i ? 'bg-teal-300/10' : ''
                        }`}
                      >
                        <span className="text-slate-500">C{i + 1}</span>
                        <span className="flex-1 text-slate-400">{fmtDate(m.cycle.startSec)}</span>
                        {m.banked && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="banked" />}
                        <span className={m.pnl >= 0 ? 'text-teal-300' : 'text-red-400'}>
                          {m.pnl >= 0 ? '+' : ''}{m.pnl.toFixed(0)}
                        </span>
                        <span className={`rounded border px-1.5 py-0.5 text-[9px] tracking-wider ${OUTCOME_STYLE[m.outcome]}`}>
                          {m.outcome}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="flex min-h-0 flex-1 flex-col rounded border border-white/10 bg-[#07090f]/80">
                  <h2 className={`${display.className} border-b border-white/10 px-3 py-2 text-xs tracking-[0.25em] text-slate-400`}>
                    STRUCTURAL EVENTS {selectedCycle !== null ? `· C${selectedCycle + 1}` : '· ALL'}
                  </h2>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {structuralLog.map((e, i) => (
                      <EventRow key={i} e={e} />
                    ))}
                  </div>
                </section>
              </aside>
            </div>

            <footer className="mt-4 flex justify-between text-[10px] tracking-wider text-slate-600">
              <span>
                ARTIFACT {selected} · {artifact.window.start.slice(0, 10)} → {artifact.window.end.slice(0, 10)} · GENERATED{' '}
                {artifact.generatedAt.slice(0, 16).replace('T', ' ')}
              </span>
              <span>FILLS SIMULATED ON 1M BARS · SIGNALS ON CLOSED 30M BARS ONLY · FEES/FUNDING/SLIPPAGE INCLUDED</span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Legend({ swatch, label, raw }: { swatch: string; label: string; raw?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {raw ? <span className={swatch}>✕</span> : <span className={`inline-block h-2.5 w-2.5 ${swatch}`} />}
      <span>{label}</span>
    </span>
  );
}

const EVENT_STYLE: Record<string, string> = {
  initialOpen: 'text-teal-300 border-teal-300/40',
  partialClose: 'text-amber-300 border-amber-300/40',
  fullClose: 'text-cyan-300 border-cyan-300/40',
  stop: 'text-red-400 border-red-400/40',
};

function EventRow({ e }: { e: ArtifactEvent }) {
  return (
    <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5 text-[10px]">
      <span className="text-slate-600">{fmtDate(e.timeSec)}</span>
      <span className={`rounded border px-1 py-0.5 text-[9px] tracking-wider ${EVENT_STYLE[e.type] ?? 'text-slate-400 border-white/10'}`}>
        {e.type === 'partialClose' ? `BANK ${Math.round((e.fraction ?? 0) * 100)}%` : e.reason === 'hedgeUnwind' ? 'UNWIND' : e.type.toUpperCase()}
      </span>
      <span className={e.leg === 'long' ? 'text-teal-400' : 'text-red-400'}>{e.leg?.[0].toUpperCase()}</span>
      <span className="flex-1 text-right text-slate-400">@{e.price?.toFixed(1)}</span>
      {e.realizedPnl !== undefined && (
        <span className={e.realizedPnl >= 0 ? 'text-teal-300' : 'text-red-400'}>
          {e.realizedPnl >= 0 ? '+' : ''}{e.realizedPnl.toFixed(1)}
        </span>
      )}
    </div>
  );
}
