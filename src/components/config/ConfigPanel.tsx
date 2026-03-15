'use client';

import { useState } from 'react';
import { Settings, Play, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import GridSideConfig from './GridSideConfig';
import { SimulationConfig, GridSideConfig as GridSideConfigType } from '@/lib/types';
import { SUPPORTED_PAIRS, DEFAULT_GRID_CONFIG, DEFAULT_SIMULATION } from '@/lib/constants';

interface ConfigPanelProps {
  onRunSimulation: (config: SimulationConfig) => void;
  isRunning: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export default function ConfigPanel({
  onRunSimulation,
  isRunning,
  isCollapsed,
  onToggleCollapse,
}: ConfigPanelProps) {
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);
  const [timeframe, setTimeframe] = useState('1h');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 16);
  });
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().slice(0, 16);
  });
  const [simName, setSimName] = useState('');
  const [feeRate, setFeeRate] = useState(DEFAULT_SIMULATION.feeRate * 100); // display as %
  const [adaptiveEnabled, setAdaptiveEnabled] = useState(DEFAULT_SIMULATION.adaptiveEnabled);
  const [emaPeriod, setEmaPeriod] = useState(DEFAULT_SIMULATION.emaPeriod);
  const [volumeMultiplier, setVolumeMultiplier] = useState(DEFAULT_SIMULATION.volumeMultiplier);

  const [longConfig, setLongConfig] = useState<GridSideConfigType>({
    side: 'long',
    ...DEFAULT_GRID_CONFIG,
    lowerBound: 0,
    upperBound: 0,
  });

  const [shortConfig, setShortConfig] = useState<GridSideConfigType>({
    side: 'short',
    ...DEFAULT_GRID_CONFIG,
    lowerBound: 0,
    upperBound: 0,
  });

  const selectedPair = SUPPORTED_PAIRS[selectedPairIdx];

  const handleRun = () => {
    if (!longConfig.lowerBound || !longConfig.upperBound || !shortConfig.lowerBound || !shortConfig.upperBound) {
      alert('Please set grid boundaries for both long and short sides');
      return;
    }

    const config: SimulationConfig = {
      name: simName || `${selectedPair.label} ${timeframe} Simulation`,
      pair: selectedPair.pair,
      poolAddress: selectedPair.poolAddress,
      chain: selectedPair.chain,
      timeframe,
      startTime: new Date(startDate).toISOString(),
      endTime: new Date(endDate).toISOString(),
      longConfig,
      shortConfig,
      adaptiveEnabled,
      emaPeriod,
      volumeMultiplier,
      feeRate: feeRate / 100,
    };

    onRunSimulation(config);
  };

  if (isCollapsed) {
    return (
      <div className="card p-3">
        <button
          onClick={onToggleCollapse}
          className="flex items-center gap-2 w-full"
          style={{ color: 'var(--text-secondary)' }}
        >
          <Settings size={14} />
          <span className="text-xs font-mono uppercase tracking-wider">Configuration</span>
          <ChevronDown size={14} className="ml-auto" />
        </button>
      </div>
    );
  }

  return (
    <div className="card p-4 flex flex-col gap-4 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Settings size={14} style={{ color: 'var(--grid-neutral)' }} />
          <span className="card-header text-xs">Configuration</span>
        </div>
        <button onClick={onToggleCollapse} style={{ color: 'var(--text-muted)' }}>
          <ChevronUp size={14} />
        </button>
      </div>

      {/* Simulation name */}
      <div>
        <label className="form-label">Name</label>
        <input
          type="text"
          className="form-input"
          value={simName}
          onChange={(e) => setSimName(e.target.value)}
          placeholder="My Simulation"
        />
      </div>

      {/* Pair selection */}
      <div>
        <label className="form-label">Trading Pair</label>
        <select
          className="form-select"
          value={selectedPairIdx}
          onChange={(e) => setSelectedPairIdx(parseInt(e.target.value))}
        >
          {SUPPORTED_PAIRS.map((pair, idx) => (
            <option key={pair.pair} value={idx}>{pair.label}</option>
          ))}
        </select>
      </div>

      {/* Timeframe */}
      <div>
        <label className="form-label">Timeframe</label>
        <select
          className="form-select"
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value)}
        >
          <option value="1h">1 Hour</option>
          <option value="4h">4 Hours</option>
        </select>
      </div>

      {/* Date range */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="form-label">Start</label>
          <input
            type="datetime-local"
            className="form-input text-xs"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label">End</label>
          <input
            type="datetime-local"
            className="form-input text-xs"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      {/* Fee rate */}
      <div>
        <label className="form-label">Fee Rate (%)</label>
        <input
          type="number"
          className="form-input"
          step="0.01"
          min={0}
          value={feeRate}
          onChange={(e) => setFeeRate(parseFloat(e.target.value) || 0)}
        />
      </div>

      {/* Divider */}
      <div className="border-t" style={{ borderColor: 'var(--card-border)' }} />

      {/* Grid configs — tabs */}
      <div className="grid grid-cols-2 gap-4">
        <GridSideConfig side="long" config={longConfig} onChange={setLongConfig} />
        <GridSideConfig side="short" config={shortConfig} onChange={setShortConfig} />
      </div>

      {/* Divider */}
      <div className="border-t" style={{ borderColor: 'var(--card-border)' }} />

      {/* Adaptive layer */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="form-label mb-0">Adaptive Layer</span>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={adaptiveEnabled}
              onChange={(e) => setAdaptiveEnabled(e.target.checked)}
              className="accent-indigo-500"
            />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {adaptiveEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>

        {adaptiveEnabled && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="form-label">EMA Period</label>
              <input
                type="number"
                className="form-input"
                value={emaPeriod}
                onChange={(e) => setEmaPeriod(parseInt(e.target.value) || 50)}
              />
            </div>
            <div>
              <label className="form-label">Vol. Multiplier</label>
              <input
                type="number"
                className="form-input"
                step="0.1"
                value={volumeMultiplier}
                onChange={(e) => setVolumeMultiplier(parseFloat(e.target.value) || 1.5)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Run button */}
      <button
        className="btn btn-primary w-full flex items-center justify-center gap-2 mt-2"
        onClick={handleRun}
        disabled={isRunning}
      >
        {isRunning ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Running...
          </>
        ) : (
          <>
            <Play size={16} />
            Run Simulation
          </>
        )}
      </button>
    </div>
  );
}
