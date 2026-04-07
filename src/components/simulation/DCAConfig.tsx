'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DCABreakoutConfig, Direction, IndicatorCondition, IndicatorType } from '@/lib/types';

// ── Constants for ConditionEditor dropdowns ──────────────────

const INDICATOR_OPTIONS: { value: IndicatorType; label: string }[] = [
  { value: 'BB_PERCENT_B', label: 'BB %B' },
  { value: 'RSI', label: 'RSI' },
  { value: 'MACD_LINE', label: 'MACD Line' },
  { value: 'MACD_SIGNAL', label: 'MACD Signal' },
  { value: 'MACD_HISTOGRAM', label: 'MACD Histogram' },
];

const OPERATOR_OPTIONS = [
  { value: 'CROSSING_DOWN', label: 'Crossing Down' },
  { value: 'CROSSING_UP', label: 'Crossing Up' },
  { value: 'LESS_THAN', label: 'Less Than' },
  { value: 'GREATER_THAN', label: 'Greater Than' },
];

const TIMEFRAME_OPTIONS = [
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '4h', label: '4h' },
];

const INDICATOR_PARAMS: Record<string, { key: string; label: string; default: number; step?: number }[]> = {
  BB_PERCENT_B: [
    { key: 'period', label: 'Period', default: 20 },
    { key: 'deviation', label: 'Deviation', default: 2, step: 0.5 },
  ],
  RSI: [
    { key: 'length', label: 'Length', default: 14 },
  ],
  MACD_LINE: [
    { key: 'fastLength', label: 'Fast', default: 12 },
    { key: 'slowLength', label: 'Slow', default: 26 },
    { key: 'signalLength', label: 'Signal', default: 9 },
  ],
  MACD_SIGNAL: [
    { key: 'fastLength', label: 'Fast', default: 12 },
    { key: 'slowLength', label: 'Slow', default: 26 },
    { key: 'signalLength', label: 'Signal', default: 9 },
  ],
  MACD_HISTOGRAM: [
    { key: 'fastLength', label: 'Fast', default: 12 },
    { key: 'slowLength', label: 'Slow', default: 26 },
    { key: 'signalLength', label: 'Signal', default: 9 },
  ],
};

const DEFAULT_SIGNALS: Record<string, { LONG: number; SHORT: number }> = {
  BB_PERCENT_B: { LONG: 0.2, SHORT: 0.8 },
  RSI: { LONG: 30, SHORT: 70 },
  MACD_LINE: { LONG: 0, SHORT: 0 },
  MACD_SIGNAL: { LONG: 0, SHORT: 0 },
  MACD_HISTOGRAM: { LONG: 0, SHORT: 0 },
};

function getDefaultParams(indicator: string): Record<string, number> {
  const defs = INDICATOR_PARAMS[indicator] || [];
  return Object.fromEntries(defs.map(d => [d.key, d.default]));
}

// ── Reusable ConditionEditor ─────────────────────────────────

export function ConditionEditor({
  condition,
  onChange,
  direction,
}: {
  condition: IndicatorCondition;
  onChange: (c: IndicatorCondition) => void;
  direction: Direction;
}) {
  const paramDefs = INDICATOR_PARAMS[condition.indicator] || [];

  const handleIndicatorChange = (indicator: IndicatorType) => {
    onChange({
      ...condition,
      indicator,
      params: getDefaultParams(indicator),
      condition: direction === 'LONG' ? 'CROSSING_DOWN' : 'CROSSING_UP',
      signalValue: DEFAULT_SIGNALS[indicator]?.[direction] ?? 0,
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Row 1: Indicator + Timeframe */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="form-label">Indicator</label>
          <select
            className="form-select"
            value={condition.indicator}
            onChange={(e) => handleIndicatorChange(e.target.value as IndicatorType)}
          >
            {INDICATOR_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label">Timeframe</label>
          <select
            className="form-select"
            value={condition.timeframe}
            onChange={(e) => onChange({ ...condition, timeframe: e.target.value })}
          >
            {TIMEFRAME_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>
      {/* Row 2: Operator + Signal */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="form-label">Operator</label>
          <select
            className="form-select"
            value={condition.condition}
            onChange={(e) => onChange({ ...condition, condition: e.target.value as IndicatorCondition['condition'] })}
          >
            {OPERATOR_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label">Signal Value</label>
          <input
            type="number"
            className="form-input"
            step="0.1"
            value={condition.signalValue}
            onChange={(e) => onChange({ ...condition, signalValue: parseFloat(e.target.value) || 0 })}
          />
        </div>
      </div>
      {/* Row 3: Indicator-specific params */}
      {paramDefs.length > 0 && (
        <div className={`grid gap-2 ${paramDefs.length === 1 ? 'grid-cols-1' : paramDefs.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {paramDefs.map(p => (
            <div key={p.key}>
              <label className="form-label">{p.label}</label>
              <input
                type="number"
                className="form-input"
                step={p.step ?? 1}
                value={condition.params[p.key] ?? p.default}
                onChange={(e) => onChange({
                  ...condition,
                  params: { ...condition.params, [p.key]: parseFloat(e.target.value) || 0 },
                })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
        <ConditionEditor
          condition={config.startConditions[0]}
          onChange={(cond) => update({ startConditions: [cond] })}
          direction={direction}
        />
      </Section>

      {/* Exit Conditions */}
      <Section title="Exit Conditions" defaultOpen={false}>
        <div className="flex items-center gap-2 mb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!config.closeConditions?.length}
              onChange={(e) => {
                if (e.target.checked) {
                  update({
                    closeConditions: [{
                      indicator: 'BB_PERCENT_B',
                      params: { period: 20, deviation: 2 },
                      condition: isLong ? 'CROSSING_UP' : 'CROSSING_DOWN',
                      signalValue: isLong ? 0.8 : 0.2,
                      timeframe: '5m',
                    }],
                  });
                } else {
                  update({ closeConditions: undefined });
                }
              }}
            />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {config.closeConditions?.length ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>
        {config.closeConditions?.length ? (
          <ConditionEditor
            condition={config.closeConditions[0]}
            onChange={(cond) => update({ closeConditions: [cond] })}
            direction={direction}
          />
        ) : null}
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
