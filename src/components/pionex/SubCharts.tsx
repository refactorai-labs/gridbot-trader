'use client';

// Sub-charts (plan §6): Wealth · Liq distance % · Position · Funding · Events.
// Path A and B are two lines; display samples are already thinned to 5m with the
// bucket minima kept (metrics come from the full stream, plan §6.1).

import { useEffect, useRef, useState } from 'react';
import { ColorType, createChart, Time } from 'lightweight-charts';
import { getChartColors } from '@/lib/constants';
import type { PionexRunPayload } from '@/lib/pionex/runStore';
import { PathId } from '@/lib/pionex/types';
import EventList from './EventList';
import { PATH_COLORS } from './format';

type Tab = 'wealth' | 'liq' | 'position' | 'funding' | 'events';
const TABS: { id: Tab; label: string }[] = [
  { id: 'wealth', label: 'Wealth' },
  { id: 'liq', label: 'Liq distance %' },
  { id: 'position', label: 'Position' },
  { id: 'funding', label: 'Funding (cum.)' },
  { id: 'events', label: 'Events' },
];

type Point = { timeMs: number; value: number };

// Line data needs strictly ascending, unique times (seconds): several samples share
// a minute. Wealth and distance keep the lowest value of the second (the worst);
// position and cumulative funding keep the last state (a close in that minute → 0).
function uniqueTimes(points: Point[], keep: (a: number, b: number) => number = Math.min) {
  const out: { time: Time; value: number }[] = [];
  for (const p of points) {
    const t = Math.floor(p.timeMs / 1000) as Time;
    const last = out[out.length - 1];
    if (last && last.time === t) last.value = keep(last.value, p.value);
    else out.push({ time: t, value: p.value });
  }
  return out;
}

const lastValue = (_a: number, b: number) => b;

export function seriesFor(run: PionexRunPayload, tab: Tab, path: PathId) {
  const eq = run.report.equity[path];
  if (tab === 'wealth') return uniqueTimes(eq.map(s => ({ timeMs: s.timeMs, value: s.wealth })));
  if (tab === 'liq') return uniqueTimes(eq.filter(s => s.liqDistPct !== null).map(s => ({ timeMs: s.timeMs, value: s.liqDistPct! * 100 })));
  if (tab === 'position') return uniqueTimes(eq.map(s => ({ timeMs: s.timeMs, value: s.qty })), lastValue);
  let cum = 0;
  return uniqueTimes(
    run.report.events[path].filter(e => e.type === 'funding').map(e => ({ timeMs: e.timeMs, value: (cum += e.amount ?? 0) })),
    lastValue
  );
}

function LineChart({ run, tab }: { run: PionexRunPayload; tab: Tab }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const colors = getChartColors();
    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: colors.background }, textColor: colors.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 },
      grid: { vertLines: { color: colors.gridLines }, horzLines: { color: colors.gridLines } },
      rightPriceScale: { borderColor: colors.scaleBorder },
      timeScale: { borderColor: colors.scaleBorder, timeVisible: true, secondsVisible: false },
      width: ref.current.clientWidth,
      height: 200,
    });
    (['A', 'B'] as PathId[]).forEach(p => {
      const s = chart.addLineSeries({ color: PATH_COLORS[p], lineWidth: 1, priceLineVisible: false, title: p });
      s.setData(seriesFor(run, tab, p));
    });
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(entries => entries.forEach(e => chart.applyOptions({ width: e.contentRect.width })));
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [run, tab]);
  return <div ref={ref} style={{ width: '100%', height: 200 }} />;
}

export default function SubCharts({ run }: { run: PionexRunPayload }) {
  const [tab, setTab] = useState<Tab>('wealth');
  return (
    <section className="card p-0 overflow-hidden">
      <div className="modern-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        {tab !== 'events' && (
          <span className="ml-auto self-center text-[11px] font-mono pr-2" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: PATH_COLORS.A }}>■ A</span> <span style={{ color: PATH_COLORS.B }}>■ B</span>
          </span>
        )}
      </div>
      <div className="p-3">
        {tab === 'events' ? <EventList run={run} /> : <LineChart key={tab} run={run} tab={tab} />}
      </div>
    </section>
  );
}
