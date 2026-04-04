'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DCABreakoutConfig, Direction } from '@/lib/types';

interface DCAConfigProps {
  config: DCABreakoutConfig;
  onChange: (config: DCABreakoutConfig) => void;
  direction: Direction;
}

function Section({ title, children, defaultOpen = true }: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full mb-1.5"
        style={{ color: 'var(--text-secondary)' }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="text-xs font-mono uppercase tracking-wider">{title}</span>
      </button>
      {open && <div className="pl-1">{children}</div>}
    </div>
  );
}

export default function DCAConfig({ config, onChange, direction }: DCAConfigProps) {
  const isLong = direction === 'LONG';
  const badgeClass = isLong ? 'badge-long' : 'badge-short';

  const update = (partial: Partial<DCABreakoutConfig>) => {
    onChange({ ...config, ...partial });
  };

  return (
    <div className="card p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className={`badge ${badgeClass}`}>{direction}</span>
        <span className="card-header text-xs">DCA Breakout</span>
      </div>

      {/* Base Order */}
      <Section title="Base Order">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">Size (USDT)</label>
            <input
              type="number"
              className="form-input"
              value={config.baseOrderSize}
              min={1}
              onChange={(e) => update({ baseOrderSize: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="form-label">Leverage</label>
            <input
              type="number"
              className="form-input"
              value={config.leverageValue}
              min={1}
              max={125}
              onChange={(e) => update({ leverageValue: parseInt(e.target.value) || 1 })}
            />
          </div>
        </div>
      </Section>

      {/* Entry Conditions */}
      <Section title="Entry Conditions" defaultOpen={false}>
        <div className="text-xs font-mono px-2 py-1.5 rounded" style={{
          color: 'var(--text-muted)',
          backgroundColor: 'var(--hover-bg)',
        }}>
          Using default breakout trigger (BB%B)
        </div>
      </Section>

      {/* Safety Orders */}
      <Section title="Safety Orders">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">1st Deviation (%)</label>
            <input
              type="number"
              className="form-input"
              step="0.1"
              value={config.deviationFirstOrder}
              onChange={(e) => update({ deviationFirstOrder: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="form-label">Step Multiplier</label>
            <input
              type="number"
              className="form-input"
              step="0.1"
              value={config.deviationStepMultiplier}
              onChange={(e) => update({ deviationStepMultiplier: parseFloat(e.target.value) || 1 })}
            />
          </div>
          <div>
            <label className="form-label">SO Size (USDT)</label>
            <input
              type="number"
              className="form-input"
              value={config.averagingOrderSize}
              onChange={(e) => update({ averagingOrderSize: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="form-label">Size Multiplier</label>
            <input
              type="number"
              className="form-input"
              step="0.1"
              value={config.orderSizeMultiplier}
              onChange={(e) => update({ orderSizeMultiplier: parseFloat(e.target.value) || 1 })}
            />
          </div>
          <div className="col-span-2">
            <label className="form-label">Max Safety Orders</label>
            <input
              type="number"
              className="form-input"
              value={config.maxAveragingOrders}
              min={0}
              max={20}
              onChange={(e) => update({ maxAveragingOrders: parseInt(e.target.value) || 0 })}
            />
          </div>
        </div>
      </Section>

      {/* Take Profit */}
      <Section title="Take Profit">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">TP (%)</label>
            <input
              type="number"
              className="form-input"
              step="0.1"
              value={config.takeProfitPercent}
              onChange={(e) => update({ takeProfitPercent: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <div>
            <label className="form-label">Reinvest (%)</label>
            <input
              type="number"
              className="form-input"
              step="1"
              value={config.reinvestProfit}
              min={0}
              max={100}
              onChange={(e) => update({ reinvestProfit: parseFloat(e.target.value) || 0 })}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.trailingEnabled}
              onChange={(e) => update({ trailingEnabled: e.target.checked })}
              className="accent-indigo-500"
            />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Trailing TP</span>
          </label>
          {config.trailingEnabled && (
            <div className="flex-1">
              <input
                type="number"
                className="form-input"
                step="0.1"
                value={config.trailingPercent}
                placeholder="Trail %"
                onChange={(e) => update({ trailingPercent: parseFloat(e.target.value) || 0 })}
              />
            </div>
          )}
        </div>
      </Section>

      {/* Stop Loss */}
      <Section title="Stop Loss" defaultOpen={false}>
        <div className="flex items-center gap-2 mb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.stopLossEnabled}
              onChange={(e) => update({ stopLossEnabled: e.target.checked })}
              className="accent-indigo-500"
            />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {config.stopLossEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>
        {config.stopLossEnabled && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="form-label">SL (%)</label>
              <input
                type="number"
                className="form-input"
                step="0.5"
                value={config.stopLossPercent}
                onChange={(e) => update({ stopLossPercent: parseFloat(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className="form-label">Action</label>
              <select
                className="form-select"
                value={config.stopLossAction}
                onChange={(e) => update({ stopLossAction: e.target.value as DCABreakoutConfig['stopLossAction'] })}
              >
                <option value="CLOSE_TRADE">Close Trade</option>
                <option value="CLOSE_AND_STOP">Close & Stop</option>
              </select>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
