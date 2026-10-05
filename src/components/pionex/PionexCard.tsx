'use client';

// Verdict + Pionex-style card (plan §6, §6.1). Path A and B side by side for every
// value; per-bot details below. `compact` shows the key rows only (pins, trio).

import type { PionexRunPayload } from '@/lib/pionex/runStore';
import { PathId } from '@/lib/pionex/types';
import { fmtDay, fmtDuration, fmtLiq, fmtNum, fmtPct, fmtTime, VERDICT_LABEL } from './format';

interface Props {
  run: PionexRunPayload;
  compact?: boolean;
  title?: string;
}

const PATHS: PathId[] = ['A', 'B'];

export function capitalOf(run: PionexRunPayload): number {
  const b = run.config.bot;
  return run.config.capitalTotal ?? b.investment + b.extraMargin;
}

export default function PionexCard({ run, compact, title }: Props) {
  const v = VERDICT_LABEL[run.report.verdict];
  const capital = capitalOf(run);
  const row = (label: string, f: (p: PathId) => string, key = true) => ({ label, f, key });
  const s = (p: PathId) => run.report.paths[p].summary;
  const m = (p: PathId) => run.report.paths[p].metrics;

  const rows = [
    row('Status', p => (s(p).status === 'liquidated' ? `liquidated ${fmtTime(s(p).liquidatedAtMs)}` : s(p).status)),
    row('Final wealth', p => `${fmtNum(s(p).finalWealth)} (${fmtPct(s(p).finalWealth / capital - 1, 1)})`),
    row('Min liq distance', p => `${fmtPct(m(p).minLiqDistPct)} · ${fmtTime(m(p).minLiqDistAtMs)}`),
    row('MTM max drawdown', p => `${fmtPct(m(p).maxDrawdownPct)} · ${fmtTime(m(p).maxDrawdownAtMs)}`),
    row('Cycles · rounds', p => `${s(p).cycles} · ${s(p).rounds}`),
    row('Grid profit', p => fmtNum(s(p).gridProfit, 3)),
    row('Withdrawn', p => fmtNum(s(p).withdrawn)),
    row('Start price', p => fmtNum(s(p).startPrice), false),
    row('Bot 1 start · Est. liq (full grid)', p => fmtLiq(s(p).startLiq.fullGrid), false),
    row('Bot 1 start · P_liq (position)', p => fmtLiq(s(p).startLiq.current), false),
    row('Underwater · longest', p => `${fmtDuration(m(p).underwaterMs)} · ${fmtDuration(m(p).longestUnderwaterMs)}`, false),
    row('Recovered by end', p => (m(p).recovered ? 'yes' : 'no'), false),
    row('Fees · funding paid', p => `${fmtNum(s(p).totals.fees)} · ${fmtNum(s(p).totals.funding)}`, false),
    row('Top-ups', p => fmtNum(s(p).totals.topUps), false),
    row('Skipped buys · rejected', p => `${run.report.paths[p].skippedBuys} · ${run.report.paths[p].rejected}`, false),
    row('Skipped minutes', p => String(s(p).skippedMinutes), false),
  ].filter(r => !compact || r.key);

  return (
    <section className="card p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="card-header truncate">{title ?? run.name}</div>
          <div className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
            {run.symbol} · {fmtDay(run.startMs)} → {fmtDay(run.endMs)} · capital {fmtNum(capital)}
          </div>
        </div>
        <span className={`badge ${v.badge} whitespace-nowrap`} title={v.hu}>{v.text}</span>
      </div>
      {run.report.verdict === 'data_incomplete' && (
        <div className="text-xs" style={{ color: 'var(--grid-short)' }}>
          Data gaps in the window — no survival claim (see Assumptions for the gap list).
        </div>
      )}
      {run.stale && (
        <div className="text-xs" style={{ color: 'var(--grid-short)' }}>
          Saved with an older report version — the liquidation line and per-bot liq values are not reliable. Re-run this window.
        </div>
      )}

      <table className="table !text-xs">
        <thead>
          <tr><th /><th>Path A · O→L→H→C</th><th>Path B · O→H→L→C</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}>
              <td className="!py-1.5 !text-xs" style={{ color: 'var(--text-muted)' }}>{r.label}</td>
              {PATHS.map(p => <td key={p} className="!py-1.5 !text-xs">{r.f(p)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

      {!compact && (
        <div className="overflow-x-auto">
          <table className="table !text-xs">
            <thead>
              <tr>
                <th>Bot</th><th>Path</th><th>Status</th><th>Band (last)</th><th>Rounds</th><th>Grid profit</th><th>Cycles</th><th>Wallet</th>
                <th title="Right after the bot's first start: full-grid estimate · current position">Liq start: full · pos</th>
                <th title="End of window (open bots only): full-grid estimate · current position">Liq end: full · pos</th>
              </tr>
            </thead>
            <tbody>
              {PATHS.flatMap(p => s(p).bots.map((b, i) => (
                <tr key={`${p}${i}`}>
                  <td className="!py-1.5 !text-xs">{i + 1}</td>
                  <td className="!py-1.5 !text-xs">{p}</td>
                  <td className="!py-1.5 !text-xs">{b.status === 'liquidated' ? `liquidated ${fmtTime(b.liquidatedAtMs)}` : b.status}</td>
                  <td className="!py-1.5 !text-xs">{fmtNum(b.lower)}–{fmtNum(b.upper)}</td>
                  <td className="!py-1.5 !text-xs">{b.rounds}</td>
                  <td className="!py-1.5 !text-xs">{fmtNum(b.gridProfit, 3)}</td>
                  <td className="!py-1.5 !text-xs">{b.cycles}</td>
                  <td className="!py-1.5 !text-xs">{fmtNum(b.wallet)}</td>
                  <td className="!py-1.5 !text-xs whitespace-nowrap">{fmtLiq(b.startLiq?.fullGrid)} · {fmtLiq(b.startLiq?.current)}</td>
                  <td className="!py-1.5 !text-xs whitespace-nowrap">{fmtLiq(b.endLiq?.fullGrid)} · {fmtLiq(b.endLiq?.current)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
