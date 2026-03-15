'use client';

import { GridSideConfig as GridSideConfigType, GridSide } from '@/lib/types';

interface GridSideConfigProps {
  side: GridSide;
  config: GridSideConfigType;
  onChange: (config: GridSideConfigType) => void;
}

export default function GridSideConfig({ side, config, onChange }: GridSideConfigProps) {
  const update = (field: string, value: number | string) => {
    onChange({ ...config, [field]: value } as GridSideConfigType);
  };

  const color = side === 'long' ? 'var(--grid-long)' : 'var(--grid-short)';

  return (
    <div className="flex flex-col gap-3">
      {/* Side header */}
      <div className="flex items-center gap-2">
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: color }}
        />
        <span className="text-xs font-mono font-bold uppercase" style={{ color }}>
          {side} Grid
        </span>
      </div>

      {/* Grid levels */}
      <div>
        <label className="form-label">Grid Levels</label>
        <input
          type="number"
          className="form-input"
          min={2}
          max={50}
          value={config.gridLevels}
          onChange={(e) => update('gridLevels', parseInt(e.target.value) || 10)}
        />
      </div>

      {/* Grid type */}
      <div>
        <label className="form-label">Grid Type</label>
        <select
          className="form-select"
          value={config.gridType}
          onChange={(e) => update('gridType', e.target.value)}
        >
          <option value="arithmetic">Arithmetic</option>
          <option value="geometric">Geometric</option>
        </select>
      </div>

      {/* Price range */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="form-label">Lower Bound</label>
          <input
            type="text"
            inputMode="decimal"
            className="form-input"
            value={config.lowerBound || ''}
            onChange={(e) => update('lowerBound', parseFloat(e.target.value) || 0)}
            placeholder="Min price"
          />
        </div>
        <div>
          <label className="form-label">Upper Bound</label>
          <input
            type="text"
            inputMode="decimal"
            className="form-input"
            value={config.upperBound || ''}
            onChange={(e) => update('upperBound', parseFloat(e.target.value) || 0)}
            placeholder="Max price"
          />
        </div>
      </div>

      {/* Order size */}
      <div>
        <label className="form-label">Order Size ($)</label>
        <input
          type="number"
          className="form-input"
          min={1}
          step="any"
          value={config.orderSize}
          onChange={(e) => update('orderSize', parseFloat(e.target.value) || 100)}
        />
      </div>

      {/* Total capital */}
      <div>
        <label className="form-label">Total Capital ($)</label>
        <input
          type="number"
          className="form-input"
          min={1}
          step="any"
          value={config.totalCapital}
          onChange={(e) => update('totalCapital', parseFloat(e.target.value) || 5000)}
        />
      </div>

      {/* Profit mode */}
      <div>
        <label className="form-label">Profit Mode</label>
        <select
          className="form-select"
          value={config.profitMode}
          onChange={(e) => update('profitMode', e.target.value)}
        >
          <option value="next_level">Next Grid Level</option>
          <option value="custom">Custom Distance</option>
        </select>
      </div>

      {config.profitMode === 'custom' && (
        <div>
          <label className="form-label">Custom Profit Distance ($)</label>
          <input
            type="number"
            className="form-input"
            step="any"
            value={config.customProfitDistance || ''}
            onChange={(e) => update('customProfitDistance', parseFloat(e.target.value) || 0)}
          />
        </div>
      )}
    </div>
  );
}
