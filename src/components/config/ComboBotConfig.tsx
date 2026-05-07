'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { ComboBotConfig, ComboBotSideConfig, ComboMode, GridSide } from '@/lib/types';

export const DEFAULT_COMBO_SIDE_LONG: ComboBotSideConfig = {
  averagingDepth: 5,
  slBasePercent: 0.015,
  slAtrMultiplier: 1.0,
  slFloor: 0.02,
  slCap: 0.06,
  tier1Size: 0.25,
  tier2Size: 0.5,
  tier3Size: 1.0,
  cooldownCandles: 12,
  retryCap: 2,
  hibernationCandles: 288,
};

export const DEFAULT_COMBO_SIDE_SHORT: ComboBotSideConfig = {
  ...DEFAULT_COMBO_SIDE_LONG,
  averagingDepth: 2, // spec §1 — asymmetric
  slBasePercent: 0.008,
  slAtrMultiplier: 0.7,
  slFloor: 0.015,
  slCap: 0.04,
};

export const DEFAULT_COMBO_CONFIG: ComboBotConfig = {
  enabled: false,
  mode: 'dual',
  leverage: 5,
  allocationLong: 0.6,
  avwapEnabled: true,
  reopenPolicy: 'full_v31',
  totalCapital: 10000,
  gridLevels: 10,
  longSide: DEFAULT_COMBO_SIDE_LONG,
  shortSide: DEFAULT_COMBO_SIDE_SHORT,
  atrPeriod: 14,
  erLookback: 10,
  erSmoothingLength: 3,
  erRegimeThreshold: 0.6,
  rsiLongThreshold: 35,
  rsiShortThreshold: 65,
};

interface Props {
  config: ComboBotConfig;
  onChange: (c: ComboBotConfig) => void;
}

function SubSection({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full mb-1.5"
        style={{ color: 'var(--text-secondary)' }}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="text-xs font-mono uppercase tracking-wider">{title}</span>
      </button>
      {open && <div className="pl-1">{children}</div>}
    </div>
  );
}

function ModeRadio({ value, onChange }: { value: ComboMode; onChange: (v: ComboMode) => void }) {
  const options: { id: ComboMode; label: string; hint: string }[] = [
    { id: 'dual',  label: 'Dual',       hint: 'long + short' },
    { id: 'long',  label: 'Long-only',  hint: 'single grid' },
    { id: 'short', label: 'Short-only', hint: 'single grid' },
  ];
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {options.map(opt => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className="px-2 py-2 rounded transition-all flex flex-col items-start"
            style={{
              background: active ? 'var(--hover-bg)' : 'transparent',
              border: `1px solid ${active ? 'var(--grid-neutral)' : 'var(--card-border)'}`,
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <span className="text-xs font-semibold">{opt.label}</span>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
              {opt.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AllocationSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const longPct = Math.round(value * 100);
  const shortPct = 100 - longPct;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="form-label mb-0">Capital split (long / short)</label>
        <span className="text-xs font-mono tabular-nums" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--grid-long)' }}>{longPct}%</span>
          <span style={{ color: 'var(--text-muted)' }}> / </span>
          <span style={{ color: 'var(--grid-short)' }}>{shortPct}%</span>
        </span>
      </div>
      <input
        type="range"
        min={0.5}
        max={0.75}
        step={0.01}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="combo-range"
      />
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>50/50</span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>60/40 spec §1</span>
        <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>75/25</span>
      </div>
      <style jsx>{`
        .combo-range {
          width: 100%;
          height: 4px;
          border-radius: 9999px;
          background: linear-gradient(to right, var(--grid-long) 0%, var(--grid-long) ${(value - 0.5) / 0.25 * 100}%, var(--grid-short) ${(value - 0.5) / 0.25 * 100}%, var(--grid-short) 100%);
          outline: none;
          appearance: none;
          -webkit-appearance: none;
          cursor: pointer;
        }
        .combo-range::-webkit-slider-thumb {
          appearance: none;
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--text-primary);
          border: 2px solid var(--card-bg);
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          cursor: pointer;
        }
        .combo-range::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--text-primary);
          border: 2px solid var(--card-bg);
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}

function SideConfigCard({
  side,
  config,
  onChange,
  color,
}: {
  side: GridSide;
  config: ComboBotSideConfig;
  onChange: (c: ComboBotSideConfig) => void;
  color: string;
}) {
  const update = (partial: Partial<ComboBotSideConfig>) => onChange({ ...config, ...partial });
  return (
    <div
      className="rounded p-2.5 flex flex-col gap-2"
      style={{
        background: 'var(--btn-secondary-bg)',
        border: `1px solid var(--card-border)`,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{
            color,
            background: `${color}12`,
            border: `1px solid ${color}30`,
          }}
        >
          {side.toUpperCase()}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="form-label">Averaging depth</label>
          <input
            type="number" className="form-input" min={1} max={10}
            value={config.averagingDepth}
            onChange={e => update({ averagingDepth: parseInt(e.target.value) || 1 })}
          />
        </div>
        <div>
          <label className="form-label">Cooldown (candles)</label>
          <input
            type="number" className="form-input" min={1}
            value={config.cooldownCandles}
            onChange={e => update({ cooldownCandles: parseInt(e.target.value) || 1 })}
          />
        </div>
        <div>
          <label className="form-label">SL base (%)</label>
          <input
            type="number" className="form-input" step="0.1"
            value={(config.slBasePercent * 100).toFixed(2)}
            onChange={e => update({ slBasePercent: (parseFloat(e.target.value) || 0) / 100 })}
          />
        </div>
        <div>
          <label className="form-label">SL × ATR multiplier</label>
          <input
            type="number" className="form-input" step="0.1" min={0}
            value={config.slAtrMultiplier}
            onChange={e => update({ slAtrMultiplier: parseFloat(e.target.value) || 0 })}
          />
        </div>
        <div>
          <label className="form-label">Retry cap</label>
          <input
            type="number" className="form-input" min={1} max={5}
            value={config.retryCap}
            onChange={e => update({ retryCap: parseInt(e.target.value) || 1 })}
          />
        </div>
        <div>
          <label className="form-label">Hibernation (candles)</label>
          <input
            type="number" className="form-input" min={1}
            value={config.hibernationCandles}
            onChange={e => update({ hibernationCandles: parseInt(e.target.value) || 1 })}
          />
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-1">
          <label className="form-label mb-0">Reopen tier sizes</label>
          <span
            className="text-[10px] font-mono tabular-nums"
            style={{ color: 'var(--text-muted)' }}
          >
            {(config.tier1Size * 100).toFixed(0)}% / {(config.tier2Size * 100).toFixed(0)}% / {(config.tier3Size * 100).toFixed(0)}%
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <input type="number" className="form-input text-xs" step="0.05" min={0} max={1}
            value={config.tier1Size}
            onChange={e => update({ tier1Size: parseFloat(e.target.value) || 0 })} />
          <input type="number" className="form-input text-xs" step="0.05" min={0} max={1}
            value={config.tier2Size}
            onChange={e => update({ tier2Size: parseFloat(e.target.value) || 0 })} />
          <input type="number" className="form-input text-xs" step="0.05" min={0} max={1}
            value={config.tier3Size}
            onChange={e => update({ tier3Size: parseFloat(e.target.value) || 0 })} />
        </div>
      </div>
    </div>
  );
}

export default function ComboBotConfigEditor({ config, onChange }: Props) {
  const update = (partial: Partial<ComboBotConfig>) => onChange({ ...config, ...partial });

  if (!config.enabled) {
    return (
      <div className="flex flex-col gap-2">
        <div
          className="text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          The supervisor layers adaptive regime + SL + cooldown + reopen-stack over an existing long/short grid.
          Leave this off to run classic grids.
        </div>
        <button
          type="button"
          onClick={() => update({ enabled: true })}
          className="flex items-center justify-center gap-2 py-2 rounded transition-all"
          style={{
            border: `1px dashed var(--card-border)`,
            color: 'var(--text-secondary)',
            background: 'transparent',
          }}
        >
          <Sparkles size={12} />
          <span className="text-xs font-mono uppercase tracking-wider">Enable combo supervisor</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Mode + disable */}
      <SubSection title="Mode">
        <ModeRadio value={config.mode} onChange={v => update({ mode: v })} />
      </SubSection>

      {/* Allocation (dual only) */}
      {config.mode === 'dual' && (
        <SubSection title="Allocation">
          <AllocationSlider value={config.allocationLong} onChange={v => update({ allocationLong: v })} />
        </SubSection>
      )}

      {/* Shared */}
      <SubSection title="Shared">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">Total capital (USDT)</label>
            <input
              type="number" className="form-input" min={100} step={100}
              value={config.totalCapital}
              onChange={e => update({ totalCapital: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="form-label">Leverage (×)</label>
            <input
              type="number" className="form-input" min={1} max={20}
              value={config.leverage}
              onChange={e => update({ leverage: parseFloat(e.target.value) || 1 })}
            />
          </div>
          <div>
            <label className="form-label">Grid levels (per side)</label>
            <input
              type="number" className="form-input" min={4} max={40}
              value={config.gridLevels}
              onChange={e => update({ gridLevels: parseInt(e.target.value) || 10 })}
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox" checked={config.avwapEnabled}
                onChange={e => update({ avwapEnabled: e.target.checked })}
              />
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                AVWAP reopen (ablation)
              </span>
            </label>
          </div>
        </div>
      </SubSection>

      {/* Adaptive layer */}
      <SubSection title="Adaptive layer">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="form-label">ATR period</label>
            <input type="number" className="form-input" min={2} max={50}
              value={config.atrPeriod}
              onChange={e => update({ atrPeriod: parseInt(e.target.value) || 14 })} />
          </div>
          <div>
            <label className="form-label">ER lookback</label>
            <input type="number" className="form-input" min={3} max={50}
              value={config.erLookback}
              onChange={e => update({ erLookback: parseInt(e.target.value) || 10 })} />
          </div>
          <div>
            <label className="form-label">ER smoothing</label>
            <input type="number" className="form-input" min={1} max={10}
              value={config.erSmoothingLength}
              onChange={e => update({ erSmoothingLength: parseInt(e.target.value) || 3 })} />
          </div>
          <div>
            <label className="form-label">Regime threshold</label>
            <input type="number" className="form-input" step="0.05" min={0.2} max={0.9}
              value={config.erRegimeThreshold}
              onChange={e => update({ erRegimeThreshold: parseFloat(e.target.value) || 0.6 })} />
          </div>
          <div>
            <label className="form-label">RSI (long)</label>
            <input type="number" className="form-input" min={10} max={50}
              value={config.rsiLongThreshold}
              onChange={e => update({ rsiLongThreshold: parseFloat(e.target.value) || 35 })} />
          </div>
          <div>
            <label className="form-label">RSI (short)</label>
            <input type="number" className="form-input" min={50} max={90}
              value={config.rsiShortThreshold}
              onChange={e => update({ rsiShortThreshold: parseFloat(e.target.value) || 65 })} />
          </div>
        </div>
      </SubSection>

      {/* Per-side */}
      {config.mode !== 'short' && (
        <SubSection title="Long-side configuration" defaultOpen={false}>
          <SideConfigCard
            side="long"
            color="var(--grid-long)"
            config={config.longSide ?? DEFAULT_COMBO_SIDE_LONG}
            onChange={c => update({ longSide: c })}
          />
        </SubSection>
      )}
      {config.mode !== 'long' && (
        <SubSection title="Short-side configuration" defaultOpen={false}>
          <SideConfigCard
            side="short"
            color="var(--grid-short)"
            config={config.shortSide ?? DEFAULT_COMBO_SIDE_SHORT}
            onChange={c => update({ shortSide: c })}
          />
        </SubSection>
      )}

      <button
        type="button"
        onClick={() => update({ enabled: false })}
        className="text-xs font-mono lowercase"
        style={{ color: 'var(--text-muted)', alignSelf: 'flex-start' }}
      >
        disable combo supervisor
      </button>
    </div>
  );
}
