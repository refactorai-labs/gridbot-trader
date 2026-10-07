'use client';

import { useState, useEffect } from 'react';
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

  // Keep the raw typed string for the price bounds so decimals like "1.15" survive while
  // typing. Storing the parsed number directly (value={config.lowerBound}) would re-render
  // "1." back to "1" and strip the decimal point. Sync from props only when the external
  // numeric value actually differs from what's typed, so it never wipes an in-progress entry.
  const [lowerRaw, setLowerRaw] = useState(config.lowerBound ? String(config.lowerBound) : '');
  const [upperRaw, setUpperRaw] = useState(config.upperBound ? String(config.upperBound) : '');
  useEffect(() => {
    if ((parseFloat(lowerRaw) || 0) !== (config.lowerBound || 0))
      setLowerRaw(config.lowerBound ? String(config.lowerBound) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.lowerBound]);
  useEffect(() => {
    if ((parseFloat(upperRaw) || 0) !== (config.upperBound || 0))
      setUpperRaw(config.upperBound ? String(config.upperBound) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.upperBound]);

  // N price lines → N−1 slots; each slot funds one entry of `orderSize`.
  const slots = Math.max(0, config.gridLevels - 1);
  const fundingEstimate = slots * config.orderSize;

  const color = side === 'long' ? 'var(--grid-long)' : 'var(--grid-short)';

  return (
    <div className="flex flex-col gap-3">
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
            value={lowerRaw}
            onChange={(e) => { setLowerRaw(e.target.value); update('lowerBound', parseFloat(e.target.value) || 0); }}
            placeholder="Min price"
          />
        </div>
        <div>
          <label className="form-label">Upper Bound</label>
          <input
            type="text"
            inputMode="decimal"
            className="form-input"
            value={upperRaw}
            onChange={(e) => { setUpperRaw(e.target.value); update('upperBound', parseFloat(e.target.value) || 0); }}
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

      {/* Total capital (user-set; never overwritten) + funding estimate */}
      <div>
        <label className="form-label">Total Capital ($)</label>
        <input
          type="number"
          className="form-input"
          min={0}
          step="any"
          value={config.totalCapital}
          onChange={(e) => update('totalCapital', parseFloat(e.target.value) || 0)}
        />
        <div
          className="text-xs font-mono mt-1"
          style={{ color: config.totalCapital < fundingEstimate ? 'var(--grid-short)' : 'var(--text-muted)' }}
        >
          Funding estimate: {slots} slots (N−1) × ${config.orderSize.toLocaleString()} = ${fundingEstimate.toLocaleString()}
        </div>
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
