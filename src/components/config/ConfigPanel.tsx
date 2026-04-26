'use client';

import { useState } from 'react';
import { Settings, Play, Loader2, ChevronDown, ChevronUp, ChevronRight, Download, Database } from 'lucide-react';
import GridSideConfig from './GridSideConfig';
import { ConditionEditor } from '@/components/simulation/DCAConfig';
import ComboBotConfigEditor, { DEFAULT_COMBO_CONFIG } from './ComboBotConfig';
import { SimulationConfig, GridSideConfig as GridSideConfigType, DCABreakoutConfig, Direction, ComboBotConfig } from '@/lib/types';
import { SUPPORTED_PAIRS, DEFAULT_GRID_CONFIG, DEFAULT_SIMULATION, TIMEFRAMES } from '@/lib/constants';

// ── Reusable sub-components ──────────────────────────────────

function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label
      className="toggle-switch"
      onClick={(e) => e.stopPropagation()}
      style={disabled ? { opacity: 0.35, pointerEvents: 'none' } : undefined}
      title={disabled ? 'Managed by Combo Bot' : undefined}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <div className="toggle-track" />
      <div className="toggle-knob" />
    </label>
  );
}

function AccordionSection({
  title,
  children,
  defaultOpen = true,
  color,
  toggle,
  onToggle,
  toggleDisabled,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  color?: string;
  toggle?: boolean;
  onToggle?: (v: boolean) => void;
  toggleDisabled?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasToggle = toggle !== undefined;

  return (
    <div className="accordion-section">
      <button
        onClick={() => setOpen(!open)}
        className="accordion-header"
        type="button"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {color && <div className="accordion-dot" style={{ background: color }} />}
        <span className="text-xs font-mono font-semibold uppercase tracking-wider flex-1 text-left">{title}</span>
        {hasToggle && <ToggleSwitch checked={toggle!} onChange={onToggle!} disabled={toggleDisabled} />}
      </button>
      {open && <div className="accordion-body">{children}</div>}
    </div>
  );
}

function DCASubSection({ title, children, defaultOpen = true }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full mb-1.5"
        style={{ color: 'var(--text-secondary)' }}
        type="button"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="text-xs font-mono uppercase tracking-wider">{title}</span>
      </button>
      {open && <div className="pl-1">{children}</div>}
    </div>
  );
}

// ── Inline DCA config (renders inside accordion) ──────────────

function DCAConfigInline({ config, onChange, direction }: { config: DCABreakoutConfig; onChange: (c: DCABreakoutConfig) => void; direction: Direction }) {
  const update = (partial: Partial<DCABreakoutConfig>) => onChange({ ...config, ...partial });
  const isLong = direction === 'LONG';

  return (
    <div className="flex flex-col gap-3">
      <DCASubSection title="Base Order">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">Size (USDT)</label>
            <input type="number" className="form-input" value={config.baseOrderSize} min={1}
              onChange={(e) => update({ baseOrderSize: parseFloat(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="form-label">Leverage</label>
            <input type="number" className="form-input" value={config.leverageValue} min={1} max={125}
              onChange={(e) => update({ leverageValue: parseInt(e.target.value) || 1 })} />
          </div>
        </div>
      </DCASubSection>

      <DCASubSection title="Entry Conditions" defaultOpen={false}>
        <ConditionEditor
          condition={config.startConditions[0]}
          onChange={(cond) => update({ startConditions: [cond] })}
          direction={direction}
        />
      </DCASubSection>

      <DCASubSection title="Exit Conditions" defaultOpen={false}>
        <div className="flex items-center gap-2 mb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={!!config.closeConditions?.length}
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
              }} />
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
      </DCASubSection>

      <DCASubSection title="Safety Orders">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">1st Deviation (%)</label>
            <input type="number" className="form-input" step="0.1" value={config.deviationFirstOrder}
              onChange={(e) => update({ deviationFirstOrder: parseFloat(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="form-label">Step Multiplier</label>
            <input type="number" className="form-input" step="0.1" value={config.deviationStepMultiplier}
              onChange={(e) => update({ deviationStepMultiplier: parseFloat(e.target.value) || 1 })} />
          </div>
          <div>
            <label className="form-label">SO Size (USDT)</label>
            <input type="number" className="form-input" value={config.averagingOrderSize}
              onChange={(e) => update({ averagingOrderSize: parseFloat(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="form-label">Size Multiplier</label>
            <input type="number" className="form-input" step="0.1" value={config.orderSizeMultiplier}
              onChange={(e) => update({ orderSizeMultiplier: parseFloat(e.target.value) || 1 })} />
          </div>
          <div className="col-span-2">
            <label className="form-label">Max Safety Orders</label>
            <input type="number" className="form-input" value={config.maxAveragingOrders} min={0} max={20}
              onChange={(e) => update({ maxAveragingOrders: parseInt(e.target.value) || 0 })} />
          </div>
        </div>
      </DCASubSection>

      <DCASubSection title="Take Profit">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">TP (%)</label>
            <input type="number" className="form-input" step="0.1" value={config.takeProfitPercent}
              onChange={(e) => update({ takeProfitPercent: parseFloat(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="form-label">Reinvest (%)</label>
            <input type="number" className="form-input" step="1" value={config.reinvestProfit} min={0} max={100}
              onChange={(e) => update({ reinvestProfit: parseFloat(e.target.value) || 0 })} />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={config.trailingEnabled}
              onChange={(e) => update({ trailingEnabled: e.target.checked })}
 />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Trailing TP</span>
          </label>
          {config.trailingEnabled && (
            <div className="flex-1">
              <input type="number" className="form-input" step="0.1" value={config.trailingPercent}
                placeholder="Trail %"
                onChange={(e) => update({ trailingPercent: parseFloat(e.target.value) || 0 })} />
            </div>
          )}
        </div>
      </DCASubSection>

      <DCASubSection title="Stop Loss" defaultOpen={false}>
        <div className="flex items-center gap-2 mb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={config.stopLossEnabled}
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
              <input type="number" className="form-input" step="0.5" value={config.stopLossPercent}
                onChange={(e) => update({ stopLossPercent: parseFloat(e.target.value) || 0 })} />
            </div>
            <div>
              <label className="form-label">Action</label>
              <select className="form-select" value={config.stopLossAction}
                onChange={(e) => update({ stopLossAction: e.target.value as DCABreakoutConfig['stopLossAction'] })}>
                <option value="CLOSE_TRADE">Close Trade</option>
                <option value="CLOSE_AND_STOP">Close & Stop</option>
              </select>
            </div>
          </div>
        )}
      </DCASubSection>
    </div>
  );
}

// ── Inline Data Manager ──────────────────────────────────────

function DataManagerInline() {
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isDownloading, setIsDownloading] = useState(false);
  const [status, setStatus] = useState('');
  const [cachedCount, setCachedCount] = useState<number | null>(null);

  const selectedPair = SUPPORTED_PAIRS[selectedPairIdx];
  const binanceSymbol = selectedPair.binanceSymbol;

  const handleDownload = async () => {
    if (!binanceSymbol) { setStatus('No Binance symbol configured'); return; }
    setIsDownloading(true); setStatus('Fetching 5m candles from Binance...');
    try {
      const res = await fetch('/api/candles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pair: binanceSymbol, timeframe: '5m',
          startTime: new Date(startDate).toISOString(), endTime: new Date(endDate).toISOString() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed');
      setCachedCount(data.count);
      setStatus(`Done! ${data.count.toLocaleString()} candles cached.`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally { setIsDownloading(false); }
  };

  const handleCheckCache = async () => {
    if (!binanceSymbol) return;
    try {
      const params = new URLSearchParams({ pair: binanceSymbol, timeframe: '5m',
        start: new Date(startDate).toISOString(), end: new Date(endDate).toISOString() });
      const res = await fetch(`/api/candles?${params}`);
      const data = await res.json();
      setCachedCount(data.count ?? 0);
      setStatus(`${(data.count ?? 0).toLocaleString()} cached candles found.`);
    } catch { setStatus('Failed to check cache'); }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="form-label">Trading Pair</label>
        <select className="form-select" value={selectedPairIdx}
          onChange={(e) => { setSelectedPairIdx(parseInt(e.target.value)); setCachedCount(null); }}>
          {SUPPORTED_PAIRS.map((pair, idx) => (
            <option key={pair.pair} value={idx}>{pair.label}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="form-label">Start Date</label>
          <input type="date" className="form-input text-xs" value={startDate}
            onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="form-label">End Date</label>
          <input type="date" className="form-input text-xs" value={endDate}
            onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={handleDownload} disabled={isDownloading || !binanceSymbol}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded"
          style={{ backgroundColor: 'var(--grid-neutral)', color: '#fff',
            opacity: isDownloading || !binanceSymbol ? 0.5 : 1 }}>
          {isDownloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          {isDownloading ? 'Downloading...' : 'Download 5m'}
        </button>
        <button onClick={handleCheckCache} disabled={!binanceSymbol}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded"
          style={{ backgroundColor: 'var(--btn-secondary-bg)', color: 'var(--text-primary)',
            border: '1px solid var(--card-border)' }}>
          <Database size={12} /> Check
        </button>
      </div>
      {status && (
        <div className="text-xs font-mono px-2 py-1.5 rounded"
          style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--hover-bg)' }}>
          {status}
        </div>
      )}
      {cachedCount !== null && (
        <div className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          Cached: {cachedCount.toLocaleString()} candles ({selectedPair.label} 5m)
        </div>
      )}
    </div>
  );
}

// ── Main ConfigPanel ─────────────────────────────────────────

interface ConfigPanelProps {
  onRunSimulation: (config: SimulationConfig) => void;
  isRunning: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  // Strategy toggles
  gridLongEnabled: boolean;
  gridShortEnabled: boolean;
  dcaLongEnabled: boolean;
  dcaShortEnabled: boolean;
  onGridLongToggle: (v: boolean) => void;
  onGridShortToggle: (v: boolean) => void;
  onDcaLongToggle: (v: boolean) => void;
  onDcaShortToggle: (v: boolean) => void;
  // DCA configs
  dcaLongConfig: DCABreakoutConfig;
  dcaShortConfig: DCABreakoutConfig;
  onDcaLongConfigChange: (c: DCABreakoutConfig) => void;
  onDcaShortConfigChange: (c: DCABreakoutConfig) => void;
  // Combo Bot config
  comboConfig: ComboBotConfig;
  onComboConfigChange: (c: ComboBotConfig) => void;
}

export default function ConfigPanel({
  onRunSimulation,
  isRunning,
  isCollapsed,
  onToggleCollapse,
  gridLongEnabled, gridShortEnabled, dcaLongEnabled, dcaShortEnabled,
  onGridLongToggle, onGridShortToggle, onDcaLongToggle, onDcaShortToggle,
  dcaLongConfig, dcaShortConfig, onDcaLongConfigChange, onDcaShortConfigChange,
  comboConfig, onComboConfigChange,
}: ConfigPanelProps) {
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);
  const [timeframe, setTimeframe] = useState('1h');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 16);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [simName, setSimName] = useState('');
  const [feeRate, setFeeRate] = useState(DEFAULT_SIMULATION.feeRate * 100);
  const [adaptiveEnabled, setAdaptiveEnabled] = useState(DEFAULT_SIMULATION.adaptiveEnabled);
  const [emaPeriod, setEmaPeriod] = useState(DEFAULT_SIMULATION.emaPeriod);
  const [volumeMultiplier, setVolumeMultiplier] = useState(DEFAULT_SIMULATION.volumeMultiplier);

  const [longConfig, setLongConfig] = useState<GridSideConfigType>({
    side: 'long', ...DEFAULT_GRID_CONFIG, lowerBound: 0, upperBound: 0,
  });
  const [shortConfig, setShortConfig] = useState<GridSideConfigType>({
    side: 'short', ...DEFAULT_GRID_CONFIG, lowerBound: 0, upperBound: 0,
  });

  const selectedPair = SUPPORTED_PAIRS[selectedPairIdx];

  const handleRun = () => {
    if ((gridLongEnabled || gridShortEnabled) &&
        (!longConfig.lowerBound || !longConfig.upperBound || !shortConfig.lowerBound || !shortConfig.upperBound)) {
      alert('Please set grid boundaries for both long and short sides');
      return;
    }

    // When combo is enabled, it owns capital. Distribute it into the grid configs so
    // both paths (grid and combo) see the same totalCapital. Keeps the DB schema stable.
    let effectiveLongConfig = longConfig;
    let effectiveShortConfig = shortConfig;
    if (comboConfig.enabled) {
      const total = comboConfig.totalCapital;
      const longFrac = comboConfig.mode === 'long' ? 1 : comboConfig.mode === 'short' ? 0 : comboConfig.allocationLong;
      effectiveLongConfig = { ...longConfig, totalCapital: total * longFrac };
      effectiveShortConfig = { ...shortConfig, totalCapital: total * (1 - longFrac) };
    }

    const config: SimulationConfig = {
      name: simName || `${selectedPair.label} ${timeframe} Simulation`,
      pair: selectedPair.pair,
      poolAddress: selectedPair.poolAddress,
      chain: selectedPair.chain,
      timeframe,
      startTime: new Date(startDate).toISOString(),
      endTime: new Date(endDate).toISOString(),
      longConfig: effectiveLongConfig,
      shortConfig: effectiveShortConfig,
      adaptiveEnabled,
      emaPeriod,
      volumeMultiplier,
      feeRate: feeRate / 100,
      combo: comboConfig.enabled ? comboConfig : undefined,
    };

    onRunSimulation(config);
  };

  // Collapsed view
  if (isCollapsed) {
    return (
      <div className="card p-3">
        <button onClick={onToggleCollapse} className="flex items-center gap-2 w-full"
          style={{ color: 'var(--text-secondary)' }}>
          <Settings size={14} />
          <span className="text-xs font-mono uppercase tracking-wider">Configuration</span>
          <ChevronDown size={14} className="ml-auto" />
        </button>
      </div>
    );
  }

  return (
    <div className="card p-4 flex flex-col gap-0">
      {/* Header */}
      <div className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <Settings size={14} style={{ color: 'var(--grid-neutral)' }} />
          <span className="card-header text-xs">Configuration</span>
        </div>
        <button onClick={onToggleCollapse} style={{ color: 'var(--text-muted)' }}>
          <ChevronUp size={14} />
        </button>
      </div>

      {/* ── General Settings ── */}
      <AccordionSection title="General" defaultOpen={true}>
        <div className="flex flex-col gap-3">
          <div>
            <label className="form-label">Name</label>
            <input type="text" className="form-input" value={simName}
              onChange={(e) => setSimName(e.target.value)} placeholder="My Simulation" />
          </div>
          <div>
            <label className="form-label">Trading Pair</label>
            <select className="form-select" value={selectedPairIdx}
              onChange={(e) => setSelectedPairIdx(parseInt(e.target.value))}>
              {SUPPORTED_PAIRS.map((pair, idx) => (
                <option key={pair.pair} value={idx}>{pair.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label">Timeframe</label>
            <select className="form-select" value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}>
              {TIMEFRAMES.map(tf => (
                <option key={tf.value} value={tf.value}>{tf.label}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="form-label">Start</label>
              <input type="datetime-local" className="form-input text-xs" value={startDate}
                onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="form-label">End</label>
              <input type="datetime-local" className="form-input text-xs" value={endDate}
                onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="form-label">Fee Rate (%)</label>
            <input type="number" className="form-input" step="0.01" min={0} value={feeRate}
              onChange={(e) => setFeeRate(parseFloat(e.target.value) || 0)} />
          </div>
        </div>
      </AccordionSection>

      {/* ── Grid Long ── */}
      <AccordionSection
        title="Grid Long"
        defaultOpen={gridLongEnabled}
        color="var(--grid-long)"
        toggle={gridLongEnabled}
        onToggle={onGridLongToggle}
        toggleDisabled={comboConfig.enabled}
      >
        <GridSideConfig side="long" config={longConfig} onChange={setLongConfig} />
      </AccordionSection>

      {/* ── Grid Short ── */}
      <AccordionSection
        title="Grid Short"
        defaultOpen={gridShortEnabled}
        color="var(--grid-short)"
        toggle={gridShortEnabled}
        onToggle={onGridShortToggle}
        toggleDisabled={comboConfig.enabled}
      >
        <GridSideConfig side="short" config={shortConfig} onChange={setShortConfig} />
      </AccordionSection>

      {/* ── DCA Long ── */}
      <AccordionSection
        title="DCA Long"
        defaultOpen={false}
        color="var(--grid-long)"
        toggle={dcaLongEnabled}
        onToggle={onDcaLongToggle}
      >
        <DCAConfigInline config={dcaLongConfig} onChange={onDcaLongConfigChange} direction="LONG" />
      </AccordionSection>

      {/* ── DCA Short ── */}
      <AccordionSection
        title="DCA Short"
        defaultOpen={false}
        color="var(--grid-short)"
        toggle={dcaShortEnabled}
        onToggle={onDcaShortToggle}
      >
        <DCAConfigInline config={dcaShortConfig} onChange={onDcaShortConfigChange} direction="SHORT" />
      </AccordionSection>

      {/* ── Combo Bot (Dual Trailing v3.1) ── */}
      <AccordionSection
        title="Combo Bot · v3.1"
        defaultOpen={comboConfig.enabled}
        color="var(--supervisor, #22d3ee)"
        toggle={comboConfig.enabled}
        onToggle={(v) => onComboConfigChange({ ...comboConfig, enabled: v })}
      >
        <ComboBotConfigEditor config={comboConfig} onChange={onComboConfigChange} />
      </AccordionSection>

      {/* ── Adaptive Layer ── */}
      <AccordionSection
        title="Adaptive Layer"
        defaultOpen={false}
        color="var(--adaptive-accent)"
        toggle={adaptiveEnabled}
        onToggle={setAdaptiveEnabled}
      >
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="form-label">EMA Period</label>
            <input type="number" className="form-input" value={emaPeriod}
              onChange={(e) => setEmaPeriod(parseInt(e.target.value) || 50)} />
          </div>
          <div>
            <label className="form-label">Vol. Multiplier</label>
            <input type="number" className="form-input" step="0.1" value={volumeMultiplier}
              onChange={(e) => setVolumeMultiplier(parseFloat(e.target.value) || 1.5)} />
          </div>
        </div>
      </AccordionSection>

      {/* ── Data Manager ── */}
      <AccordionSection title="Data Manager" defaultOpen={false}>
        <DataManagerInline />
      </AccordionSection>

      {/* ── Run Button ── */}
      <div className="pt-4 mt-1" style={{ borderTop: '1px solid var(--card-border)' }}>
        <button
          className="btn btn-primary w-full flex items-center justify-center gap-2"
          onClick={handleRun}
          disabled={isRunning}
        >
          {isRunning ? (
            <><Loader2 size={16} className="animate-spin" /> Running...</>
          ) : (
            <><Play size={16} /> Run Simulation</>
          )}
        </button>
      </div>
    </div>
  );
}
