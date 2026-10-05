'use client';

// Exposure (plan §6): bot 1 · bot 2 · total · free cash, for one path. Allocated =
// I + E at the bot's start (bot 2: × capital multiplier, plan §3.8); notional = I · lev
// (full grid); wallet and status at the end of the window.

import type { PionexRunPayload } from '@/lib/pionex/runStore';
import { PathId } from '@/lib/pionex/types';
import { capitalOf } from './PionexCard';
import { fmtNum } from './format';

export default function ExposurePanel({ run, path }: { run: PionexRunPayload; path: PathId }) {
  const s = run.report.paths[path].summary;
  const { bot } = run.config;
  const mult = run.config.bot2?.capitalMultiplier ?? 1;
  const rows = s.bots.map((b, i) => {
    const k = i === 0 ? 1 : mult;
    return {
      label: `Bot ${i + 1}`,
      allocated: (bot.investment + bot.extraMargin) * k,
      notional: bot.investment * k * bot.leverage,
      wallet: b.wallet,
      status: b.status,
    };
  });
  const total = {
    allocated: rows.reduce((x, r) => x + r.allocated, 0),
    notional: rows.reduce((x, r) => x + r.notional, 0),
    wallet: rows.reduce((x, r) => x + r.wallet, 0),
  };

  return (
    <section className="card p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="card-header">Exposure · path {path}</span>
        <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>capital {fmtNum(capitalOf(run))}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="table !text-xs">
          <thead>
            <tr><th /><th>Allocated I+E</th><th>Notional I·lev</th><th>Wallet at end</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.label}>
                <td className="!py-1.5 !text-xs">{r.label}</td>
                <td className="!py-1.5 !text-xs">{fmtNum(r.allocated)}</td>
                <td className="!py-1.5 !text-xs">{fmtNum(r.notional)}</td>
                <td className="!py-1.5 !text-xs">{fmtNum(r.wallet)}</td>
                <td className="!py-1.5 !text-xs">{r.status}</td>
              </tr>
            ))}
            <tr>
              <td className="!py-1.5 !text-xs font-semibold">Total</td>
              <td className="!py-1.5 !text-xs">{fmtNum(total.allocated)}</td>
              <td className="!py-1.5 !text-xs">{fmtNum(total.notional)}</td>
              <td className="!py-1.5 !text-xs">{fmtNum(total.wallet)}</td>
              <td className="!py-1.5 !text-xs" />
            </tr>
            <tr>
              <td className="!py-1.5 !text-xs">Free cash · withdrawn</td>
              <td className="!py-1.5 !text-xs" colSpan={4}>{fmtNum(s.freeCash)} · {fmtNum(s.withdrawn)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
