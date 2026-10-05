'use client';

// Parameter accordion (plan §6): Bot, Common capital, Costs, Cycle, Top-up,
// Bot 2, Fixed close. Optional rules have an on/off switch in their header.

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { BOT_A_PARAMS, PionexParams } from '@/lib/pionex/params';

interface Props {
  params: PionexParams;
  onChange: (p: PionexParams) => void;
}

function Section({ title, children, defaultOpen = false, toggle, onToggle }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  toggle?: boolean;
  onToggle?: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="accordion-section">
      <div className="accordion-header">
        <button type="button" className="flex items-center gap-2 flex-1" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="text-xs font-mono font-semibold uppercase tracking-wider">{title}</span>
        </button>
        {toggle !== undefined && (
          <label className="toggle-switch" title={toggle ? 'on' : 'off'}>
            <input type="checkbox" checked={toggle} onChange={e => onToggle?.(e.target.checked)} />
            <span className="toggle-track" />
            <span className="toggle-knob" />
          </label>
        )}
      </div>
      {open && <div className="accordion-body grid grid-cols-2 gap-2">{children}</div>}
    </div>
  );
}

function Num({ label, value, onChange, step = 'any', disabled }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="form-label">{label}</label>
      <input
        type="number"
        className="form-input"
        step={step}
        value={Number.isFinite(value) ? value : ''}
        disabled={disabled}
        onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
    </div>
  );
}

export default function ParamPanel({ params: p, onChange }: Props) {
  const set = <K extends keyof PionexParams>(k: K, v: PionexParams[K]) => onChange({ ...p, [k]: v });
  const offset = p.bandMode === 'offset';

  return (
    <section className="card p-4 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <span className="card-header">Parameters</span>
        <button type="button" className="btn btn-secondary !py-1 !px-2 text-xs" onClick={() => onChange(BOT_A_PARAMS)}>
          Preset: Bot A
        </button>
      </div>

      <Section title="Bot" defaultOpen>
        <div className="col-span-2">
          <label className="form-label">Band</label>
          <select className="form-select" value={p.bandMode} onChange={e => set('bandMode', e.target.value as PionexParams['bandMode'])}>
            <option value="offset">% offset from start price</option>
            <option value="absolute">absolute prices</option>
          </select>
        </div>
        {offset ? (
          <>
            <Num label="Lower %" value={p.lowerPct} onChange={v => set('lowerPct', v)} />
            <Num label="Upper %" value={p.upperPct} onChange={v => set('upperPct', v)} />
          </>
        ) : (
          <>
            <Num label="Lower" value={p.lower} onChange={v => set('lower', v)} />
            <Num label="Upper" value={p.upper} onChange={v => set('upper', v)} />
          </>
        )}
        <Num label="Grids" value={p.gridCount} step="1" onChange={v => set('gridCount', v)} />
        <div>
          <label className="form-label">Mode</label>
          <select className="form-select" value={p.mode} onChange={e => set('mode', e.target.value as PionexParams['mode'])}>
            <option value="arithmetic">arithmetic</option>
            <option value="geometric">geometric</option>
          </select>
        </div>
        <Num label="Investment I" value={p.investment} onChange={v => set('investment', v)} />
        <Num label="Extra margin E" value={p.extraMargin} onChange={v => set('extraMargin', v)} />
        <Num label="Leverage" value={p.leverage} onChange={v => set('leverage', v)} />
      </Section>

      <Section title="Common capital" toggle={p.capitalTotal !== null} onToggle={v => set('capitalTotal', v ? p.investment + p.extraMargin : null)}>
        <div className="col-span-2">
          <Num
            label={p.capitalTotal === null ? 'Total = I + E (switch on to set a reserve)' : 'Total capital (USDT)'}
            value={p.capitalTotal ?? p.investment + p.extraMargin}
            disabled={p.capitalTotal === null}
            onChange={v => set('capitalTotal', v)}
          />
        </div>
      </Section>

      <Section title="Costs">
        <Num label="Maker fee %" value={p.makerFeePct} onChange={v => set('makerFeePct', v)} />
        <Num label="Taker fee %" value={p.takerFeePct} onChange={v => set('takerFeePct', v)} />
        <Num label="MMR %" value={p.mmrPct} onChange={v => set('mmrPct', v)} />
        <div>
          <label className="form-label">Funding override %</label>
          <input
            type="number"
            className="form-input"
            step="any"
            placeholder="Binance rate"
            value={p.fundingOverridePct ?? ''}
            onChange={e => set('fundingOverridePct', e.target.value === '' ? null : Number(e.target.value))}
          />
        </div>
        <label className="col-span-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={p.marginCheck} onChange={e => set('marginCheck', e.target.checked)} />
          Minimum margin check on buys (plan §3.5)
        </label>
      </Section>

      <Section title="Cycle (bot 1)" toggle={p.cycleOn} onToggle={v => set('cycleOn', v)}>
        <Num label="Take profit % of I" value={p.tpPct} onChange={v => set('tpPct', v)} />
        <Num label="Reinvest %" value={p.reinvestPct} onChange={v => set('reinvestPct', v)} />
      </Section>

      <Section title="Top-up" toggle={p.topUpOn} onToggle={v => set('topUpOn', v)}>
        <Num label="Trigger: liq dist % <" value={p.topUpTriggerPct} onChange={v => set('topUpTriggerPct', v)} />
        <Num label="Amount (USDT)" value={p.topUpAmount} onChange={v => set('topUpAmount', v)} />
      </Section>

      <Section title="Bot 2" toggle={p.bot2On} onToggle={v => set('bot2On', v)}>
        <Num label="Trigger: % below L1" value={p.bot2OffsetPct} onChange={v => set('bot2OffsetPct', v)} />
        <Num label="Capital × (I2, E2)" value={p.bot2Mult} onChange={v => set('bot2Mult', v)} />
      </Section>

      <Section title="Fixed close (bot 1)" toggle={p.closeOn} onToggle={v => set('closeOn', v)}>
        <div className="col-span-2">
          <Num label="Close at 5m close ≤ (permanent stop)" value={p.closePrice} onChange={v => set('closePrice', v)} />
        </div>
      </Section>
    </section>
  );
}
