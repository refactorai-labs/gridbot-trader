'use client';

// Assumptions panel (plan §3, §3.9, §6.1): the modelling assumptions, the verdict
// labels (with their Hungarian meaning), and the data gaps of the shown run.

import type { DataGapReport } from '@/lib/pionex/dataQuality';
import { Verdict } from '@/lib/pionex/types';
import { fmtTime, VERDICT_LABEL } from './format';

const ASSUMPTIONS = [
  'Decision-support backtest, not a Pionex clone. Binance USDT-M 1m last + 1m mark, Binance funding.',
  'Binance mark ≠ Pionex mark; the intra-candle last and mark paths are unknown (§3.9).',
  'Two global price paths per candle: A = O→L→H→C, B = O→H→L→C. Neither is a proven lower bound (§3.4.2).',
  'Mark–last rule: one offset per candle d = min(mark − last over O/H/L/C); model mark = last + d; liquidation threshold in last price T = P_liq − d (§3.4.1).',
  'Liquidation when equity(mark) ≤ qty · mark · mmr; a single mmr input (no tiers), no liquidation fee (§3.4, §3.9).',
  'Fees: maker on grid fills, taker on the initial market buy and every intervention close (§2/4).',
  'Funding: each settlement applied once in its minute bucket floor(fundingTime / 60 s), at that minute’s mark open (§3.4.3).',
  'Minimum margin check (§3.5) is an approximation of Pionex’s two-layer buffer; only the open position reserves margin.',
  'Interventions (TP, top-up, bot 2, fixed close) are decided on a closed 5m candle and executed at the next 1m open, in the fixed order closes → top-ups → restart → bot 2 (§3.8).',
  'Full-grid liquidation price differs from Pionex Est. Liq. (Bot A +1.4 %); no correction factor (§3.9).',
  'Hindsight-selected stress windows use future information (the peak); not a live entry strategy (§6.2).',
];

const ORDER: Verdict[] = ['data_incomplete', 'not_started', 'path_dependent', 'liquidated', 'borderline', 'survived'];

export default function Assumptions({ dataReport }: { dataReport?: DataGapReport }) {
  const gaps = dataReport
    ? [
        ...dataReport.last.gaps.map(g => `last · ${fmtTime(g.startMs)} → ${fmtTime(g.endMs)} · ${g.minutes} min`),
        ...dataReport.mark.gaps.map(g => `mark · ${fmtTime(g.startMs)} → ${fmtTime(g.endMs)} · ${g.minutes} min`),
        ...dataReport.funding.gaps.map(g => `funding · ${fmtTime(g.startMs)} → ${fmtTime(g.endMs)}`),
        ...dataReport.errors,
      ]
    : [];

  return (
    <section className="card p-4 flex flex-col gap-3">
      <span className="card-header">Assumptions</span>
      <ul className="text-[11px] leading-snug flex flex-col gap-1 list-disc pl-4" style={{ color: 'var(--text-secondary)' }}>
        {ASSUMPTIONS.map(a => <li key={a}>{a}</li>)}
      </ul>
      <div className="flex flex-col gap-1">
        <span className="form-label !mb-0">Verdict labels (priority order)</span>
        {ORDER.map(v => (
          <div key={v} className="flex items-start gap-2 text-[11px]">
            <span className={`badge ${VERDICT_LABEL[v].badge} whitespace-nowrap`}>{VERDICT_LABEL[v].text}</span>
            <span style={{ color: 'var(--text-muted)' }}>{VERDICT_LABEL[v].hu}</span>
          </div>
        ))}
      </div>
      {dataReport && (
        <div className="flex flex-col gap-1">
          <span className="form-label !mb-0">Data gaps of this run</span>
          {gaps.length === 0 ? (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>none — 1m last, 1m mark and funding complete</span>
          ) : (
            <ul className="text-[11px] font-mono max-h-40 overflow-y-auto" style={{ color: 'var(--grid-short)' }}>
              {gaps.map(g => <li key={g}>{g}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
