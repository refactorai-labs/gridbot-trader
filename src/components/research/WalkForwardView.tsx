'use client';

// View (b): stitched out-of-sample equity curves (Strategy B vs the three
// baselines vs buy & hold) with a synchronized drawdown subchart, the
// per-mode stitched metrics, per-window OOS Sharpe comparison, and the
// winning-parameter stability table.

import { useEffect, useMemo, useRef } from 'react';
import { createChart, IChartApi, ColorType, UTCTimestamp, LineStyle } from 'lightweight-charts';

export interface WfCurvePoint { timeSec: number; equity: number; price?: number }
export interface WfMetrics {
  totalReturn: number; sharpe: number; sortino: number; maxDrawdown: number; cvar5: number; days: number;
}
export interface WfArtifact {
  kind: string;
  generatedAt: string;
  protocol: { isMonths: number; oosMonths: number; samples: number };
  windows: Array<{
    window: number;
    isStart: number; isEnd: number; oosStart: number; oosEnd: number;
    bestParams: Record<string, number>;
    isScore: number;
    isMetrics: WfMetrics;
    oos: Record<string, { metrics: WfMetrics; counters: Record<string, number> }>;
  }>;
  stitched: Record<string, { curve: WfCurvePoint[]; metrics: WfMetrics }>;
}

const SERIES: Array<{ key: string; label: string; color: string; dashed?: boolean }> = [
  { key: 'B', label: 'STRATEGY B', color: '#2dd4bf' },
  { key: 'fullClose', label: 'FULL CLOSE', color: '#f59e0b' },
  { key: 'fullHold', label: 'FULL HOLD', color: '#818cf8' },
  { key: 'oneSided', label: 'ONE-SIDED', color: '#64748b' },
  { key: 'buyHold', label: 'BUY & HOLD', color: 'rgba(226,232,240,0.65)', dashed: true },
];

const PARAM_COLS: Array<{ key: string; label: string; fmt: (v: number) => string }> = [
  { key: 'partialFraction', label: 'FRAC', fmt: v => v.toFixed(2) },
  { key: 'bankAt', label: 'BANK', fmt: v => v.toFixed(2) },
  { key: 'unwindAt', label: 'UNWD', fmt: v => v.toFixed(2) },
  { key: 'invalidationAtrMult', label: 'W·ATR', fmt: v => v.toFixed(1) },
  { key: 'stopAtrMult', label: 'S·ATR', fmt: v => v.toFixed(1) },
  { key: 'atrMult', label: 'K·ATR', fmt: v => v.toFixed(1) },
  { key: 'gridLevels', label: 'LVLS', fmt: v => String(v) },
  { key: 'donchianLookback', label: 'DONCH', fmt: v => String(v) },
  { key: 'erLow', label: 'ER<', fmt: v => v.toFixed(2) },
  { key: 'erHigh', label: 'ER>', fmt: v => v.toFixed(2) },
  { key: 'cooldownBars', label: 'COOL', fmt: v => String(v) },
  { key: 'initialFraction', label: 'INIT', fmt: v => v.toFixed(2) },
  { key: 'deriskSoft', label: 'SOFT', fmt: v => (v >= 0.5 ? 'Y' : 'N') },
];

function drawdownOf(curve: WfCurvePoint[]): Array<{ timeSec: number; value: number }> {
  let peak = -Infinity;
  return curve.map(p => {
    if (p.equity > peak) peak = p.equity;
    return { timeSec: p.timeSec, value: peak > 0 ? -((peak - p.equity) / peak) * 100 : 0 };
  });
}

function EquityDrawdownChart({ artifact }: { artifact: WfArtifact }) {
  const eqRef = useRef<HTMLDivElement>(null);
  const ddRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!eqRef.current || !ddRef.current) return;
    const opts = {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(226,232,240,0.55)',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.025)' },
        horzLines: { color: 'rgba(255,255,255,0.025)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.07)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.07)', timeVisible: false },
    } as const;

    const eqChart = createChart(eqRef.current, { ...opts, width: eqRef.current.clientWidth, height: 360 });
    const ddChart = createChart(ddRef.current, { ...opts, width: ddRef.current.clientWidth, height: 150 });

    for (const s of SERIES) {
      const data = artifact.stitched[s.key]?.curve;
      if (!data) continue;
      eqChart
        .addLineSeries({
          color: s.color,
          lineWidth: s.key === 'B' ? 2 : 1,
          lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        .setData(data.map(p => ({ time: p.timeSec as UTCTimestamp, value: p.equity })));
      ddChart
        .addLineSeries({
          color: s.color,
          lineWidth: s.key === 'B' ? 2 : 1,
          lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        .setData(drawdownOf(data).map(p => ({ time: p.timeSec as UTCTimestamp, value: p.value })));
    }
    eqChart.timeScale().fitContent();
    ddChart.timeScale().fitContent();

    // bi-directional time sync
    let syncing = false;
    const sync = (src: IChartApi, dst: IChartApi) => () => {
      if (syncing) return;
      syncing = true;
      const range = src.timeScale().getVisibleLogicalRange();
      if (range) dst.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    };
    eqChart.timeScale().subscribeVisibleLogicalRangeChange(sync(eqChart, ddChart));
    ddChart.timeScale().subscribeVisibleLogicalRangeChange(sync(ddChart, eqChart));

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        eqChart.applyOptions({ width: entry.contentRect.width });
        ddChart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(eqRef.current);
    return () => {
      observer.disconnect();
      eqChart.remove();
      ddChart.remove();
    };
  }, [artifact]);

  return (
    <div>
      <div className="px-1 pb-1 text-[9px] tracking-[0.25em] text-slate-500">STITCHED OOS EQUITY · $10K START</div>
      <div ref={eqRef} className="w-full" />
      <div className="px-1 pb-1 pt-2 text-[9px] tracking-[0.25em] text-slate-500">DRAWDOWN %</div>
      <div ref={ddRef} className="w-full" />
    </div>
  );
}

export default function WalkForwardView({ artifact, displayFont }: { artifact: WfArtifact; displayFont: string }) {
  const modeRows = useMemo(
    () =>
      SERIES.map(s => ({ ...s, metrics: artifact.stitched[s.key]?.metrics })).filter(
        (r): r is typeof r & { metrics: WfMetrics } => Boolean(r.metrics)
      ),
    [artifact]
  );

  const fmt = (s: number) => new Date(s * 1000).toISOString().slice(2, 10);

  return (
    <div className="mt-4 space-y-4">
      {/* stitched metrics table */}
      <section className="overflow-x-auto rounded border border-white/10 bg-[#07090f]/80">
        <table className="w-full text-right text-[11px]">
          <thead>
            <tr className="border-b border-white/10 text-[9px] tracking-[0.2em] text-slate-500">
              <th className="px-3 py-2 text-left">STITCHED OOS · {artifact.windows.length} WINDOWS · {artifact.protocol.isMonths}M IS / {artifact.protocol.oosMonths}M OOS · {artifact.protocol.samples} SAMPLES/WIN</th>
              <th className="px-3 py-2">RETURN</th>
              <th className="px-3 py-2">SHARPE</th>
              <th className="px-3 py-2">SORTINO</th>
              <th className="px-3 py-2">MAX DD</th>
              <th className="px-3 py-2">CVAR 5%</th>
            </tr>
          </thead>
          <tbody>
            {modeRows.map(r => (
              <tr key={r.key} className="border-b border-white/5">
                <td className="px-3 py-2 text-left">
                  <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />
                  <span className={displayFont}>{r.label}</span>
                </td>
                <td className={`px-3 py-2 ${r.metrics.totalReturn >= 0 ? 'text-teal-300' : 'text-red-400'}`}>
                  {(r.metrics.totalReturn * 100).toFixed(1)}%
                </td>
                <td className={`px-3 py-2 font-semibold ${r.metrics.sharpe >= 1.1 ? 'text-teal-300' : 'text-slate-300'}`}>
                  {r.metrics.sharpe.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-slate-300">{r.metrics.sortino.toFixed(2)}</td>
                <td className={`px-3 py-2 ${r.metrics.maxDrawdown <= 0.2 ? 'text-slate-300' : 'text-amber-300'}`}>
                  {(r.metrics.maxDrawdown * 100).toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-slate-300">{(r.metrics.cvar5 * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* curves */}
      <section className="rounded border border-white/10 bg-[#07090f]/80 p-3">
        <div className="flex flex-wrap gap-4 px-1 pb-2 text-[10px] text-slate-400">
          {SERIES.map(s => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-4" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
        <EquityDrawdownChart artifact={artifact} />
      </section>

      {/* per-window OOS sharpe + winning params */}
      <section className="overflow-x-auto rounded border border-white/10 bg-[#07090f]/80">
        <table className="w-full text-right text-[10px]">
          <thead>
            <tr className="border-b border-white/10 text-[9px] tracking-[0.18em] text-slate-500">
              <th className="px-2 py-2 text-left">WIN</th>
              <th className="px-2 py-2 text-left">OOS SPAN</th>
              <th className="px-2 py-2">IS✓</th>
              <th className="px-2 py-2 text-teal-300">B</th>
              <th className="px-2 py-2 text-amber-300">FC</th>
              <th className="px-2 py-2 text-indigo-300">FH</th>
              <th className="px-2 py-2 text-slate-400">1S</th>
              {PARAM_COLS.map(c => (
                <th key={c.key} className="px-2 py-2">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifact.windows.map(w => (
              <tr key={w.window} className="border-b border-white/5">
                <td className="px-2 py-1.5 text-left text-slate-500">W{w.window}</td>
                <td className="px-2 py-1.5 text-left text-slate-400">{fmt(w.oosStart)} → {fmt(w.oosEnd)}</td>
                <td className="px-2 py-1.5 text-slate-300">{w.isScore.toFixed(2)}</td>
                {(['B', 'fullClose', 'fullHold', 'oneSided'] as const).map(m => {
                  const sh = w.oos[m]?.metrics.sharpe;
                  return (
                    <td key={m} className={`px-2 py-1.5 ${sh !== undefined && sh >= 0 ? 'text-teal-300' : 'text-red-400'}`}>
                      {sh?.toFixed(2) ?? '—'}
                    </td>
                  );
                })}
                {PARAM_COLS.map(c => (
                  <td key={c.key} className="px-2 py-1.5 text-slate-400">
                    {w.bestParams[c.key] !== undefined ? c.fmt(w.bestParams[c.key]) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
