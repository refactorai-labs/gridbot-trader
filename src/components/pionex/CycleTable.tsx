'use client';

// Cycle table (trailing plan, decisions 10–11): bot 1's closed cycles of one path,
// plus an "open since" row while bot 1 is still active. The open cycle starts at
// bot 1's last start / restart event, not at the window start.

import { useState } from 'react';
import type { PionexRunPayload } from '@/lib/pionex/runStore';
import { PathId } from '@/lib/pionex/types';
import { fmtDuration, fmtNum, fmtPct, fmtTime } from './format';

const cell = '!py-1 !text-xs whitespace-nowrap';

export default function CycleTable({ run }: { run: PionexRunPayload }) {
  const [path, setPath] = useState<PathId>('A');
  const summary = run.report.paths[path].summary;
  const log = summary.cycleLog;
  const open = summary.bots[0]?.status === 'active'
    ? run.report.events[path].filter(e => e.bot === 0 && (e.type === 'start' || e.type === 'restart')).pop() ?? null
    : null;

  return (
    <section className="card p-4 flex flex-col gap-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="card-header">Cycles (bot 1)</span>
        <select className="form-select !w-auto" value={path} onChange={e => setPath(e.target.value as PathId)}>
          <option value="A">Path A</option>
          <option value="B">Path B</option>
        </select>
        {log === undefined && <span style={{ color: 'var(--grid-short)' }}>Re-run for cycle details</span>}
        {log !== undefined && log.length === 0 && <span style={{ color: 'var(--text-muted)' }}>No closed cycle</span>}
      </div>
      {(log?.length || open) ? (
        <div className="overflow-x-auto">
          <table className="table !text-xs">
            <thead>
              <tr>
                <th>#</th><th>Start (UTC)</th><th>End (UTC)</th><th>Duration</th><th>Start price</th><th>Close price</th>
                <th>Δ %</th><th>Rounds</th><th>Profit</th><th>Withdrawn</th><th>I_next</th><th>E_next</th><th>Trigger</th>
              </tr>
            </thead>
            <tbody>
              {(log ?? []).map(c => (
                <tr key={c.index}>
                  <td className={cell}>{c.index}</td>
                  <td className={cell}>{fmtTime(c.startMs)}</td>
                  <td className={cell}>{fmtTime(c.endMs)}</td>
                  <td className={cell}>{fmtDuration(c.endMs - c.startMs)}</td>
                  <td className={cell}>{fmtNum(c.startPrice)}</td>
                  <td className={cell}>{fmtNum(c.closePrice)}</td>
                  <td className={cell}>{fmtPct(c.closePrice / c.startPrice - 1)}</td>
                  <td className={cell}>{c.rounds}</td>
                  <td className={cell}>{fmtNum(c.profit, 3)}</td>
                  <td className={cell}>{fmtNum(c.withdrawn, 3)}</td>
                  <td className={cell}>{c.iNext === undefined ? '—' : fmtNum(c.iNext)}</td>
                  <td className={cell}>{fmtNum(c.eNext)}</td>
                  <td className={cell}>{c.trigger}</td>
                </tr>
              ))}
              {open && (
                <tr style={{ color: 'var(--text-muted)' }}>
                  <td className={cell}>open</td>
                  <td className={cell}>{fmtTime(open.timeMs)}</td>
                  <td className={cell} colSpan={2}>open since {fmtTime(open.timeMs)}</td>
                  <td className={cell}>{fmtNum(open.price)}</td>
                  <td className={cell} colSpan={8}>—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
