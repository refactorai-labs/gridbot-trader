'use client';

// View (c): Monte Carlo robustness of the walk-forward candidates.
//   1. Bootstrap Sharpe box-strips (p5/p25/p50/p75/p95) per candidate.
//   2. Perturbation scatter — Sharpe (x) vs maxDD (y), base config highlighted.
//   3. Cross-window stability table — winning params + median row + distance.
//
// The pre-registered candidate ranking (decided before MC results were seen):
//   1. rank by bootstrap p5 Sharpe (tail-first);
//   2. discard fragile peaks — perturbation p5 < 0.5×base, or bootstrap p95 maxDD > 25%;
//   3. tie-break by lower stabilityDistance.

import { useMemo } from 'react';

export interface McMetrics {
  totalReturn: number; sharpe: number; sortino: number; maxDrawdown: number; cvar5: number; days: number;
}
export interface McCandidate {
  fromWindow: number;
  params: Record<string, number>;
  fullSpan: { B: McMetrics; fullClose: McMetrics; fullHold: McMetrics };
  bootstrap: {
    sharpe: { p5: number; p25: number; p50: number; p75: number; p95: number };
    maxDD: { p50: number; p95: number };
    n: number;
  };
  perturbation: {
    points: Array<{ sharpe: number; maxDrawdown: number; totalReturn: number }>;
    sharpeP5: number; sharpeP50: number; n: number;
  };
  stabilityDistance: number;
}
export interface McArtifact {
  kind: string;
  generatedAt: string;
  sourceWalkForward: string;
  span: { start: number; end: number };
  paramMedians: Record<string, number>;
  candidates: McCandidate[];
}

const TARGET_SHARPE = 1.1;
const DD_TARGET = 0.20;
const DD_FRAGILE = 0.25;

const TEAL = '#2dd4bf';
const AMBER = '#f59e0b';
const SLATE = 'rgba(148,163,184,0.85)';
const FAINT = 'rgba(148,163,184,0.18)';

const PARAM_COLS: Array<{ key: string; label: string; fmt: (v: number) => string }> = [
  { key: 'partialFraction', label: 'FRAC', fmt: v => v.toFixed(2) },
  { key: 'bankAt', label: 'BANK', fmt: v => v.toFixed(2) },
  { key: 'unwindAt', label: 'UNWD', fmt: v => v.toFixed(2) },
  { key: 'atrMult', label: 'K·ATR', fmt: v => v.toFixed(1) },
  { key: 'gridLevels', label: 'LVLS', fmt: v => String(Math.round(v)) },
  { key: 'erLow', label: 'ER<', fmt: v => v.toFixed(2) },
  { key: 'confirmBars', label: 'CONF', fmt: v => String(Math.round(v)) },
  { key: 'deriskAfterBars', label: 'DRSK', fmt: v => String(Math.round(v)) },
  { key: 'cooldownBars', label: 'COOL', fmt: v => String(Math.round(v)) },
  { key: 'initialFraction', label: 'INIT', fmt: v => v.toFixed(2) },
  { key: 'anchorMaxOffset', label: 'OFFS', fmt: v => v.toFixed(2) },
  { key: 'deriskSoft', label: 'SOFT', fmt: v => (v >= 0.5 ? 'Y' : 'N') },
];

interface Ranked { c: McCandidate; fragile: boolean; baseSharpe: number; rank: number }

function rankCandidates(cands: McCandidate[]): { ranked: Ranked[]; winnerWindow: number | null } {
  const annotated = cands.map(c => {
    const baseSharpe = c.fullSpan.B.sharpe;
    const fragile =
      c.perturbation.sharpeP5 < 0.5 * baseSharpe || c.bootstrap.maxDD.p95 > DD_FRAGILE;
    return { c, fragile, baseSharpe };
  });
  // rank-1 = best by bootstrap p5 Sharpe, tie-break lower stabilityDistance
  const order = [...annotated].sort(
    (a, b) =>
      b.c.bootstrap.sharpe.p5 - a.c.bootstrap.sharpe.p5 ||
      a.c.stabilityDistance - b.c.stabilityDistance
  );
  const rankOf = new Map(order.map((a, i) => [a.c.fromWindow, i + 1]));
  const ranked = annotated.map(a => ({ ...a, rank: rankOf.get(a.c.fromWindow)! }));
  const survivors = order.filter(a => !a.fragile);
  return { ranked, winnerWindow: survivors[0]?.c.fromWindow ?? null };
}

function niceDomain(vals: number[], extra: number[] = []): [number, number] {
  const all = [...vals, ...extra].filter(v => isFinite(v));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

/* ── Bootstrap Sharpe box-strips ───────────────────────────────────────── */
function BootstrapStrips({ ranked, winnerWindow }: { ranked: Ranked[]; winnerWindow: number | null }) {
  const rows = ranked;
  const W = 760;
  const rowH = 30;
  const axisH = 26;
  const leftPad = 96;
  const rightPad = 18;
  const plotW = W - leftPad - rightPad;
  const H = axisH + rows.length * rowH + 10;

  const [xMin, xMax] = niceDomain(
    rows.flatMap(r => [r.c.bootstrap.sharpe.p5, r.c.bootstrap.sharpe.p95]),
    [0, TARGET_SHARPE]
  );
  const x = (v: number) => leftPad + ((v - xMin) / (xMax - xMin)) * plotW;
  const ticks = [0, TARGET_SHARPE].filter(t => t >= xMin && t <= xMax);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
      {/* axis gridlines */}
      {ticks.map(t => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={axisH - 6} y2={H - 6}
            stroke={t === TARGET_SHARPE ? 'rgba(45,212,191,0.35)' : 'rgba(255,255,255,0.10)'}
            strokeWidth={1} strokeDasharray={t === TARGET_SHARPE ? '3 3' : undefined} />
          <text x={x(t)} y={14} fill={t === TARGET_SHARPE ? TEAL : SLATE} fontSize={9}
            textAnchor="middle" letterSpacing="0.05em">
            {t === TARGET_SHARPE ? `TARGET ${t}` : t.toFixed(1)}
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = axisH + i * rowH + rowH / 2;
        const b = r.c.bootstrap.sharpe;
        const isWinner = r.c.fromWindow === winnerWindow;
        const stroke = isWinner ? TEAL : SLATE;
        return (
          <g key={r.c.fromWindow}>
            {isWinner && (
              <rect x={2} y={axisH + i * rowH + 2} width={W - 4} height={rowH - 4}
                fill="rgba(45,212,191,0.06)" stroke="rgba(45,212,191,0.25)" rx={3} />
            )}
            <text x={10} y={y + 3} fill={isWinner ? TEAL : 'rgba(226,232,240,0.7)'} fontSize={10}>
              W{r.c.fromWindow}
            </text>
            <text x={62} y={y + 3} fill={r.fragile ? 'rgba(248,113,113,0.8)' : SLATE} fontSize={8} textAnchor="end">
              #{r.rank}
            </text>
            {/* whisker p5–p95 */}
            <line x1={x(b.p5)} x2={x(b.p95)} y1={y} y2={y} stroke={stroke} strokeWidth={1} opacity={0.55} />
            <line x1={x(b.p5)} x2={x(b.p5)} y1={y - 4} y2={y + 4} stroke={stroke} strokeWidth={1} opacity={0.55} />
            <line x1={x(b.p95)} x2={x(b.p95)} y1={y - 4} y2={y + 4} stroke={stroke} strokeWidth={1} opacity={0.55} />
            {/* box p25–p75 */}
            <rect x={x(b.p25)} y={y - 6} width={Math.max(1, x(b.p75) - x(b.p25))} height={12}
              fill={isWinner ? 'rgba(45,212,191,0.22)' : 'rgba(148,163,184,0.14)'} stroke={stroke} strokeWidth={1} rx={2} />
            {/* median p50 */}
            <line x1={x(b.p50)} x2={x(b.p50)} y1={y - 6} y2={y + 6} stroke={isWinner ? '#5eead4' : '#e2e8f0'} strokeWidth={1.5} />
          </g>
        );
      })}
    </svg>
  );
}

/* ── Perturbation scatter (Sharpe vs maxDD) ────────────────────────────── */
function PerturbScatter({ ranked, winnerWindow }: { ranked: Ranked[]; winnerWindow: number | null }) {
  const W = 760;
  const H = 320;
  const padL = 44; const padR = 16; const padT = 16; const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const allSharpe = ranked.flatMap(r => [...r.c.perturbation.points.map(p => p.sharpe), r.baseSharpe]);
  const allDD = ranked.flatMap(r => [...r.c.perturbation.points.map(p => p.maxDrawdown), r.c.fullSpan.B.maxDrawdown]);
  const [sMin, sMax] = niceDomain(allSharpe, [0, TARGET_SHARPE]);
  const ddMax = Math.max(DD_FRAGILE + 0.03, ...allDD.filter(isFinite)) * 1.04;

  const x = (v: number) => padL + ((v - sMin) / (sMax - sMin)) * plotW;
  const y = (dd: number) => padT + (dd / ddMax) * plotH; // 0 at top, deeper DD lower

  const xTicks = [0, TARGET_SHARPE].filter(t => t >= sMin && t <= sMax);
  const yTicks = [DD_TARGET, DD_FRAGILE];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ fontFamily: '"JetBrains Mono", monospace' }}>
      <rect x={padL} y={padT} width={plotW} height={plotH} fill="none" stroke="rgba(255,255,255,0.07)" />
      {/* reference lines */}
      {xTicks.map(t => (
        <g key={`x${t}`}>
          <line x1={x(t)} x2={x(t)} y1={padT} y2={padT + plotH}
            stroke={t === TARGET_SHARPE ? 'rgba(45,212,191,0.3)' : 'rgba(255,255,255,0.12)'}
            strokeDasharray={t === TARGET_SHARPE ? '3 3' : undefined} />
          <text x={x(t)} y={H - 20} fill={t === TARGET_SHARPE ? TEAL : SLATE} fontSize={9} textAnchor="middle">
            {t === TARGET_SHARPE ? `TGT ${t}` : t.toFixed(1)}
          </text>
        </g>
      ))}
      {yTicks.map(t => (
        <g key={`y${t}`}>
          <line x1={padL} x2={padL + plotW} y1={y(t)} y2={y(t)}
            stroke={t === DD_FRAGILE ? 'rgba(248,113,113,0.3)' : 'rgba(245,158,11,0.3)'} strokeDasharray="3 3" />
          <text x={padL - 4} y={y(t) + 3} fill={t === DD_FRAGILE ? 'rgba(248,113,113,0.8)' : AMBER} fontSize={8} textAnchor="end">
            {(t * 100).toFixed(0)}%
          </text>
        </g>
      ))}
      <text x={4} y={padT + 8} fill={SLATE} fontSize={8}>maxDD</text>
      <text x={W - padR} y={H - 6} fill={SLATE} fontSize={8} textAnchor="end">perturbed Sharpe →</text>

      {/* perturbation clouds */}
      {ranked.map(r => {
        const isWinner = r.c.fromWindow === winnerWindow;
        return r.c.perturbation.points.filter(p => isFinite(p.sharpe)).map((p, j) => (
          <circle key={`${r.c.fromWindow}-${j}`} cx={x(p.sharpe)} cy={y(p.maxDrawdown)} r={isWinner ? 2.4 : 1.8}
            fill={isWinner ? 'rgba(45,212,191,0.55)' : FAINT} />
        ));
      })}
      {/* base configs */}
      {ranked.map(r => {
        const isWinner = r.c.fromWindow === winnerWindow;
        const cx = x(r.baseSharpe); const cy = y(r.c.fullSpan.B.maxDrawdown);
        return (
          <g key={`base-${r.c.fromWindow}`}>
            <circle cx={cx} cy={cy} r={isWinner ? 5 : 3.5}
              fill={isWinner ? TEAL : 'rgba(226,232,240,0.75)'} stroke="#06080d" strokeWidth={1} />
            <text x={cx + 6} y={cy - 5} fill={isWinner ? TEAL : SLATE} fontSize={8}>W{r.c.fromWindow}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function RobustnessView({ artifact, displayFont }: { artifact: McArtifact; displayFont: string }) {
  const { ranked, winnerWindow } = useMemo(() => rankCandidates(artifact.candidates), [artifact]);
  const fmt = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
  const boots = artifact.candidates[0]?.bootstrap.n ?? 0;
  const perturbs = artifact.candidates[0]?.perturbation.n ?? 0;
  const winner = ranked.find(r => r.c.fromWindow === winnerWindow);

  return (
    <div className="mt-4 space-y-4">
      {/* header / verdict strip */}
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded border border-white/10 bg-white/10 sm:grid-cols-4 lg:grid-cols-5">
        {[
          ['SOURCE', artifact.sourceWalkForward.replace('walkforward-', '').toUpperCase()],
          ['SPAN', `${fmt(artifact.span.start)} → ${fmt(artifact.span.end)}`],
          ['CANDIDATES', String(artifact.candidates.length)],
          ['BOOTSTRAP × PERTURB', `${boots} × ${perturbs}`],
          ['SELECTED', winner ? `W${winner.c.fromWindow} · p5 ${winner.c.bootstrap.sharpe.p5.toFixed(2)}` : 'NONE PASS BAR'],
        ].map(([label, value], i) => (
          <div key={label} className="bg-[#0a0d14] px-4 py-3">
            <div className="text-[9px] tracking-[0.25em] text-slate-500">{label}</div>
            <div className={`mt-1 text-sm font-semibold ${i === 4 ? (winner ? 'text-teal-300' : 'text-red-400') : 'text-slate-200'}`}>
              {value}
            </div>
          </div>
        ))}
      </section>

      {!winner && (
        <div className="rounded border border-red-400/30 bg-red-400/5 px-4 py-2 text-[11px] text-red-300">
          No candidate clears the pre-registered bar (perturbation p5 ≥ 0.5×base Sharpe and bootstrap p95 maxDD ≤ 25%).
          Candidates are still ranked #1…N by tail Sharpe (rank column) for reference — but per the pre-registered gate
          the recommendation is to skip the holdout and report failure honestly.
        </div>
      )}

      {/* bootstrap Sharpe box-strips */}
      <section className="rounded border border-white/10 bg-[#07090f]/80 p-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-[9px] tracking-[0.25em] text-slate-500">
            BOOTSTRAP SHARPE · {boots} PATHS · 7-DAY BLOCKS · p5▕p25–p75▏p95
          </span>
          <span className="text-[9px] tracking-[0.2em] text-slate-500">TAIL-FIRST RANKING #</span>
        </div>
        <BootstrapStrips ranked={ranked} winnerWindow={winnerWindow} />
      </section>

      {/* perturbation scatter */}
      <section className="rounded border border-white/10 bg-[#07090f]/80 p-3">
        <div className="flex flex-wrap items-center gap-4 px-1 pb-2 text-[10px] text-slate-400">
          <span className="text-[9px] tracking-[0.25em] text-slate-500">PARAMETER ROBUSTNESS · ±15% PERTURBATION</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: TEAL }} /> SELECTED base + cloud</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-slate-300" /> candidate base</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-[2px] w-4 bg-amber-400/60" /> DD target / fragile</span>
        </div>
        <PerturbScatter ranked={ranked} winnerWindow={winnerWindow} />
      </section>

      {/* stability table */}
      <section className="overflow-x-auto rounded border border-white/10 bg-[#07090f]/80">
        <table className="w-full text-right text-[10px]">
          <thead>
            <tr className="border-b border-white/10 text-[9px] tracking-[0.18em] text-slate-500">
              <th className="px-2 py-2 text-left">CAND</th>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2 text-teal-300">B SH</th>
              <th className="px-2 py-2">BOOT p5</th>
              <th className="px-2 py-2">DD p95</th>
              <th className="px-2 py-2">PERT p5</th>
              {PARAM_COLS.map(c => <th key={c.key} className="px-2 py-2">{c.label}</th>)}
              <th className="px-2 py-2">STAB</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(r => {
              const isWinner = r.c.fromWindow === winnerWindow;
              return (
                <tr key={r.c.fromWindow} className={`border-b border-white/5 ${isWinner ? 'bg-teal-300/[0.06]' : ''}`}>
                  <td className={`px-2 py-1.5 text-left ${isWinner ? 'text-teal-300' : 'text-slate-500'}`}>
                    W{r.c.fromWindow}{r.fragile ? ' ⚠' : ''}
                  </td>
                  <td className={`px-2 py-1.5 ${r.fragile ? 'text-red-400/80' : 'text-slate-400'}`}>{r.rank}</td>
                  <td className={`px-2 py-1.5 ${r.baseSharpe >= 0 ? 'text-teal-300' : 'text-red-400'}`}>{r.baseSharpe.toFixed(2)}</td>
                  <td className={`px-2 py-1.5 ${r.c.bootstrap.sharpe.p5 >= 0 ? 'text-slate-300' : 'text-red-400'}`}>{r.c.bootstrap.sharpe.p5.toFixed(2)}</td>
                  <td className={`px-2 py-1.5 ${r.c.bootstrap.maxDD.p95 <= DD_FRAGILE ? 'text-slate-300' : 'text-amber-300'}`}>{(r.c.bootstrap.maxDD.p95 * 100).toFixed(0)}%</td>
                  <td className="px-2 py-1.5 text-slate-300">{r.c.perturbation.sharpeP5.toFixed(2)}</td>
                  {PARAM_COLS.map(c => (
                    <td key={c.key} className="px-2 py-1.5 text-slate-400">
                      {r.c.params[c.key] !== undefined ? c.fmt(r.c.params[c.key]) : '—'}
                    </td>
                  ))}
                  <td className={`px-2 py-1.5 ${r.c.stabilityDistance <= 1 ? 'text-slate-300' : 'text-amber-300'}`}>{r.c.stabilityDistance.toFixed(2)}</td>
                </tr>
              );
            })}
            {/* per-parameter median row */}
            <tr className="border-t border-white/15 bg-white/[0.03] text-slate-300">
              <td className={`px-2 py-1.5 text-left ${displayFont}`}>MEDIAN</td>
              <td className="px-2 py-1.5">—</td>
              <td className="px-2 py-1.5">—</td>
              <td className="px-2 py-1.5">—</td>
              <td className="px-2 py-1.5">—</td>
              <td className="px-2 py-1.5">—</td>
              {PARAM_COLS.map(c => (
                <td key={c.key} className="px-2 py-1.5">
                  {artifact.paramMedians[c.key] !== undefined ? c.fmt(artifact.paramMedians[c.key]) : '—'}
                </td>
              ))}
              <td className="px-2 py-1.5">0.00</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div className="px-1 text-[9px] tracking-wider text-slate-600">
        RANK = bootstrap p5 Sharpe (tail-first), tie-break lower stability distance · ⚠ = fragile peak
        (perturbation p5 &lt; 0.5×base Sharpe, or bootstrap p95 maxDD &gt; 25%) · STAB = normalized param distance to the cross-window median
      </div>
    </div>
  );
}
