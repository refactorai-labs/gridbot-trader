'use client';

import { useState, useCallback, useRef } from 'react';
import { Play, Square, ChevronDown, ChevronUp, Check, X, Loader2 } from 'lucide-react';
import { DCA_PARAM_RANGES, ParamRange, generateRandomParams } from '@/lib/optimizer/randomSearch';
import { DEFAULT_CONSTRAINTS, FitnessConstraints } from '@/lib/optimizer/fitnessFunction';
import { StrategyMetrics, DCABreakoutConfig, DCASimulationConfig } from '@/lib/types';

interface OptimizerTabProps {
  pair: string;
  binanceSymbol: string;
  startTime: string;
  endTime: string;
}

interface OptimizerResult {
  rank: number;
  params: Record<string, any>;
  metrics: StrategyMetrics;
  score: number;
  meetsConstraints: boolean;
  wfPassed: boolean | null; // null = not tested yet
}

export default function OptimizerTab({ pair, binanceSymbol, startTime, endTime }: OptimizerTabProps) {
  // Parameter ranges (editable)
  const [paramRanges, setParamRanges] = useState<ParamRange[]>(
    DCA_PARAM_RANGES.map(r => ({ ...r }))
  );

  // Search settings
  const [iterations, setIterations] = useState(100);
  const [wfWindows, setWfWindows] = useState(3);
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');

  // Constraints
  const [constraints, setConstraints] = useState<FitnessConstraints>({ ...DEFAULT_CONSTRAINTS });

  // State
  const [isRunning, setIsRunning] = useState(false);
  const [currentIteration, setCurrentIteration] = useState(0);
  const [bestScore, setBestScore] = useState<number | null>(null);
  const [results, setResults] = useState<OptimizerResult[]>([]);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [showRanges, setShowRanges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  // Sort
  const [sortField, setSortField] = useState<'score' | 'totalPnlPct' | 'sharpeRatio' | 'maxDrawdownPct' | 'totalTrades'>('score');
  const [sortAsc, setSortAsc] = useState(false);

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortedResults = [...results].sort((a, b) => {
    let aVal: number, bVal: number;
    switch (sortField) {
      case 'score': aVal = a.score; bVal = b.score; break;
      case 'totalPnlPct': aVal = a.metrics.totalPnlPct; bVal = b.metrics.totalPnlPct; break;
      case 'sharpeRatio': aVal = a.metrics.sharpeRatio; bVal = b.metrics.sharpeRatio; break;
      case 'maxDrawdownPct': aVal = a.metrics.maxDrawdownPct; bVal = b.metrics.maxDrawdownPct; break;
      case 'totalTrades': aVal = a.metrics.totalTrades; bVal = b.metrics.totalTrades; break;
      default: aVal = a.score; bVal = b.score;
    }
    return sortAsc ? aVal - bVal : bVal - aVal;
  });

  const updateRange = (index: number, field: 'min' | 'max' | 'step', value: number) => {
    setParamRanges(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  // Build a DCABreakoutConfig from random params
  const buildDCAConfig = useCallback((params: Record<string, any>): DCABreakoutConfig => {
    return {
      direction,
      baseOrderSize: params.baseOrderSize ?? 100,
      leverageType: 'isolated',
      leverageValue: 1,
      startConditions: [],
      deviationFirstOrder: params.deviationFirstOrder ?? 2,
      deviationStepMultiplier: params.deviationStepMultiplier ?? 1.5,
      averagingOrderSize: params.averagingOrderSize ?? 100,
      orderSizeMultiplier: params.orderSizeMultiplier ?? 1.2,
      maxAveragingOrders: params.maxAveragingOrders ?? 5,
      takeProfitPercent: params.takeProfitPercent ?? 3,
      trailingEnabled: true,
      trailingPercent: params.trailingPercent ?? 0.5,
      reinvestProfit: 0,
      stopLossEnabled: true,
      stopLossPercent: params.stopLossPercent ?? 10,
      stopLossAction: 'CLOSE_TRADE',
    };
  }, [direction]);

  const runOptimizer = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setResults([]);
    setCurrentIteration(0);
    setBestScore(null);
    setSelectedRow(null);
    abortRef.current = false;

    const allResults: OptimizerResult[] = [];
    let bestSoFar = -Infinity;

    try {
      for (let i = 0; i < iterations; i++) {
        if (abortRef.current) break;

        const params = generateRandomParams(paramRanges);
        const dcaConfig = buildDCAConfig(params);

        const simConfig: DCASimulationConfig = {
          name: `opt_${i}`,
          pair: binanceSymbol,
          timeframe: '5m',
          startTime,
          endTime,
          feeRate: 0.001,
          longConfig: direction === 'LONG' ? dcaConfig : undefined,
          shortConfig: direction === 'SHORT' ? dcaConfig : undefined,
        };

        // Call headless simulate endpoint
        const res = await fetch('/api/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategyType: 'dca', config: simConfig }),
        });

        if (!res.ok) {
          const err = await res.json();
          console.error(`Iteration ${i} failed:`, err.error);
          continue;
        }

        const { metrics } = await res.json() as { metrics: StrategyMetrics };

        // Evaluate fitness
        const violations: string[] = [];
        if (metrics.totalTrades < constraints.minTrades) violations.push('trades');
        if (metrics.maxDrawdownPct > constraints.maxDrawdownPct) violations.push('drawdown');
        if (metrics.profitFactor < constraints.minProfitFactor && metrics.totalTrades > 0) violations.push('pf');

        let score = metrics.sharpeRatio;
        if (violations.length > 0) score = -100 - violations.length;

        const result: OptimizerResult = {
          rank: 0,
          params,
          metrics,
          score,
          meetsConstraints: violations.length === 0,
          wfPassed: null,
        };

        allResults.push(result);

        if (score > bestSoFar) bestSoFar = score;

        setCurrentIteration(i + 1);
        setBestScore(bestSoFar);

        // Update results every 5 iterations or on last
        if ((i + 1) % 5 === 0 || i === iterations - 1) {
          const ranked = [...allResults]
            .sort((a, b) => b.score - a.score)
            .map((r, idx) => ({ ...r, rank: idx + 1 }));
          setResults(ranked);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
    }

    setIsRunning(false);
  }, [iterations, paramRanges, constraints, buildDCAConfig, binanceSymbol, startTime, endTime, direction]);

  const stopOptimizer = () => {
    abortRef.current = true;
  };

  return (
    <div className="space-y-4">
      {/* Direction selector */}
      <div className="card p-4">
        <div className="flex items-center gap-4 mb-4">
          <label className="form-label mb-0">Direction</label>
          <button
            className={`btn btn-sm ${direction === 'LONG' ? 'btn-long' : 'btn-secondary'}`}
            onClick={() => setDirection('LONG')}
          >
            LONG
          </button>
          <button
            className={`btn btn-sm ${direction === 'SHORT' ? 'btn-short' : 'btn-secondary'}`}
            onClick={() => setDirection('SHORT')}
          >
            SHORT
          </button>
        </div>

        {/* Search settings */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="form-label">Iterations</label>
            <input
              type="range"
              min={50}
              max={1000}
              step={50}
              value={iterations}
              onChange={e => setIterations(Number(e.target.value))}
              className="w-full"
            />
            <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{iterations}</span>
          </div>
          <div>
            <label className="form-label">Walk-Forward Windows</label>
            <input
              type="range"
              min={3}
              max={5}
              step={1}
              value={wfWindows}
              onChange={e => setWfWindows(Number(e.target.value))}
              className="w-full"
            />
            <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{wfWindows}</span>
          </div>
        </div>

        {/* Constraints */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <label className="form-label">Min Trades</label>
            <input
              type="number"
              className="form-input"
              value={constraints.minTrades}
              onChange={e => setConstraints(c => ({ ...c, minTrades: Number(e.target.value) }))}
            />
          </div>
          <div>
            <label className="form-label">Max Drawdown %</label>
            <input
              type="number"
              className="form-input"
              value={constraints.maxDrawdownPct}
              onChange={e => setConstraints(c => ({ ...c, maxDrawdownPct: Number(e.target.value) }))}
            />
          </div>
          <div>
            <label className="form-label">Min Profit Factor</label>
            <input
              type="number"
              step="0.1"
              className="form-input"
              value={constraints.minProfitFactor}
              onChange={e => setConstraints(c => ({ ...c, minProfitFactor: Number(e.target.value) }))}
            />
          </div>
        </div>

        {/* Parameter Ranges (collapsible) */}
        <div className="mb-4">
          <button
            className="flex items-center gap-1 text-xs font-mono mb-2"
            style={{ color: 'var(--text-muted)' }}
            onClick={() => setShowRanges(!showRanges)}
          >
            {showRanges ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            PARAMETER RANGES
          </button>
          {showRanges && (
            <div className="space-y-2">
              {paramRanges.map((range, idx) => (
                <div key={range.name} className="grid grid-cols-4 gap-2 items-center">
                  <span className="text-xs font-mono truncate" style={{ color: 'var(--text-secondary)' }}>
                    {range.name}
                  </span>
                  <input
                    type="number"
                    className="form-input text-xs py-1"
                    placeholder="min"
                    value={range.min ?? ''}
                    onChange={e => updateRange(idx, 'min', Number(e.target.value))}
                  />
                  <input
                    type="number"
                    className="form-input text-xs py-1"
                    placeholder="max"
                    value={range.max ?? ''}
                    onChange={e => updateRange(idx, 'max', Number(e.target.value))}
                  />
                  {range.type === 'discrete' && (
                    <input
                      type="number"
                      className="form-input text-xs py-1"
                      placeholder="step"
                      value={range.step ?? ''}
                      onChange={e => updateRange(idx, 'step', Number(e.target.value))}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Run / Stop button */}
        <div className="flex items-center gap-3">
          {!isRunning ? (
            <button className="btn btn-primary flex items-center gap-2" onClick={runOptimizer}>
              <Play size={14} /> Run Optimizer
            </button>
          ) : (
            <button className="btn btn-secondary flex items-center gap-2" onClick={stopOptimizer}>
              <Square size={14} /> Stop
            </button>
          )}

          {/* Progress */}
          {(isRunning || currentIteration > 0) && (
            <div className="flex items-center gap-3">
              {isRunning && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--grid-neutral)' }} />}
              <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                {currentIteration} / {iterations}
              </span>
              {bestScore !== null && (
                <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                  Best: {bestScore.toFixed(2)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="card p-3" style={{ borderColor: 'rgba(239, 68, 68, 0.3)' }}>
          <span className="text-sm" style={{ color: 'var(--grid-short)' }}>{error}</span>
        </div>
      )}

      {/* Results Table */}
      {sortedResults.length > 0 && (
        <div className="card p-4">
          <span className="card-header text-xs block mb-3">
            Results ({sortedResults.filter(r => r.meetsConstraints).length} / {sortedResults.length} pass constraints)
          </span>
          <div className="overflow-x-auto" style={{ maxHeight: '400px', overflowY: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th className="cursor-pointer" onClick={() => handleSort('sharpeRatio')}>
                    Sharpe {sortField === 'sharpeRatio' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}
                  </th>
                  <th className="cursor-pointer" onClick={() => handleSort('totalPnlPct')}>
                    P&L % {sortField === 'totalPnlPct' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}
                  </th>
                  <th>Win Rate</th>
                  <th className="cursor-pointer" onClick={() => handleSort('maxDrawdownPct')}>
                    Max DD {sortField === 'maxDrawdownPct' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}
                  </th>
                  <th className="cursor-pointer" onClick={() => handleSort('totalTrades')}>
                    Trades {sortField === 'totalTrades' ? (sortAsc ? '\u25B2' : '\u25BC') : ''}
                  </th>
                  <th>PF</th>
                  <th>Pass</th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.slice(0, 50).map((r, idx) => {
                  const winRate = r.metrics.totalTrades > 0
                    ? ((r.metrics.winCount / r.metrics.totalTrades) * 100)
                    : 0;
                  const isSelected = selectedRow === idx;

                  return (
                    <tr
                      key={idx}
                      className="cursor-pointer"
                      style={{
                        background: isSelected ? 'rgba(var(--grid-neutral-rgb), 0.08)' : undefined,
                      }}
                      onClick={() => setSelectedRow(isSelected ? null : idx)}
                    >
                      <td>{r.rank}</td>
                      <td style={{ color: r.metrics.sharpeRatio >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}>
                        {r.metrics.sharpeRatio.toFixed(2)}
                      </td>
                      <td style={{ color: r.metrics.totalPnlPct >= 0 ? 'var(--grid-long)' : 'var(--grid-short)' }}>
                        {r.metrics.totalPnlPct.toFixed(2)}%
                      </td>
                      <td>{winRate.toFixed(1)}%</td>
                      <td style={{ color: 'var(--grid-short)' }}>
                        {r.metrics.maxDrawdownPct.toFixed(1)}%
                      </td>
                      <td>{r.metrics.totalTrades}</td>
                      <td>{r.metrics.profitFactor === Infinity ? 'Inf' : r.metrics.profitFactor.toFixed(2)}</td>
                      <td>
                        {r.meetsConstraints
                          ? <Check size={14} style={{ color: 'var(--grid-long)' }} />
                          : <X size={14} style={{ color: 'var(--grid-short)' }} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Selected row detail */}
          {selectedRow !== null && sortedResults[selectedRow] && (
            <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--btn-secondary-bg)', border: '1px solid var(--card-border)' }}>
              <span className="text-xs font-mono block mb-2" style={{ color: 'var(--text-muted)' }}>
                CONFIG #{sortedResults[selectedRow].rank}
              </span>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(sortedResults[selectedRow].params).map(([key, val]) => (
                  <div key={key}>
                    <span className="text-xs block" style={{ color: 'var(--text-muted)' }}>{key}</span>
                    <span className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>
                      {typeof val === 'number' ? val.toFixed(2) : String(val)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
