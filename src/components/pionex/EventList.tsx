'use client';

// Event list (plan §6.4): every ledger event, rejection and cancellation in time
// order with its original 1m time; path and type filters, 500 rows per page.

import { useMemo, useState } from 'react';
import type { PionexRunPayload } from '@/lib/pionex/runStore';
import { PathId } from '@/lib/pionex/types';
import { fmtNum, fmtTime } from './format';

const PAGE = 500;

export default function EventList({ run }: { run: PionexRunPayload }) {
  const [path, setPath] = useState<PathId>('A');
  const [type, setType] = useState('all');
  const [page, setPage] = useState(0);

  const events = run.report.events[path];
  const types = useMemo(() => Array.from(new Set(events.map(e => e.type))).sort(), [events]);
  const shown = useMemo(() => (type === 'all' ? events : events.filter(e => e.type === type)), [events, type]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const current = Math.min(page, pages - 1);
  const rows = shown.slice(current * PAGE, (current + 1) * PAGE);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select className="form-select !w-auto" value={path} onChange={e => { setPath(e.target.value as PathId); setPage(0); }}>
          <option value="A">Path A</option>
          <option value="B">Path B</option>
        </select>
        <select className="form-select !w-auto" value={type} onChange={e => { setType(e.target.value); setPage(0); }}>
          <option value="all">all types</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{shown.length.toLocaleString()} events</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="btn btn-secondary !py-1 !px-2" disabled={current === 0} onClick={() => setPage(current - 1)}>‹</button>
          <span className="font-mono">{current + 1}/{pages}</span>
          <button className="btn btn-secondary !py-1 !px-2" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>›</button>
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto">
        <table className="table !text-xs">
          <thead>
            <tr><th>Time (UTC)</th><th>Bot</th><th>Type</th><th>Price</th><th>Mark</th><th>Qty</th><th>Amount</th><th>Reason</th></tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={current * PAGE + i}>
                <td className="!py-1 !text-xs whitespace-nowrap">{fmtTime(e.timeMs)}</td>
                <td className="!py-1 !text-xs">{(e.bot ?? 0) + 1}</td>
                <td className="!py-1 !text-xs">{e.type}</td>
                <td className="!py-1 !text-xs">{fmtNum(e.price)}</td>
                <td className="!py-1 !text-xs">{fmtNum(e.mark)}</td>
                <td className="!py-1 !text-xs">{fmtNum(e.qty, 5)}</td>
                <td className="!py-1 !text-xs">{fmtNum(e.amount, 4)}</td>
                <td className="!py-1 !text-xs">{e.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
