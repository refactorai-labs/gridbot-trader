'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Grid3X3, Loader2, AlertCircle } from 'lucide-react';
import ThemeToggle from '@/components/ThemeToggle';
import ConfigPanel from '@/components/config/ConfigPanel';
import TradingChart, { GridFill } from '@/components/charts/TradingChart';
import DCAChart from '@/components/simulation/DCAChart';
import DCAPnL from '@/components/simulation/DCAPnL';
import PlaybackControls from '@/components/simulation/PlaybackControls';
import CombinedPnL from '@/components/simulation/CombinedPnL';
import AdaptiveStatus from '@/components/simulation/AdaptiveStatus';
import TradeLog from '@/components/results/TradeLog';
import PerformanceSummary from '@/components/results/PerformanceSummary';
import {
  SimulationConfig, ReplayData, SimulationSummary, PlaybackSpeed, SnapshotData,
  DCABreakoutConfig, DCATradeRecord, Direction,
} from '@/lib/types';
import { DCATradeSnapshot } from '@/lib/strategies/dcaTypes';
import { SUPPORTED_PAIRS } from '@/lib/constants';
import OptimizerTab from '@/components/OptimizerTab';

function getDefaultDCAConfig(direction: Direction): DCABreakoutConfig {
  return {
    direction,
    baseOrderSize: 100,
    leverageType: 'isolated',
    leverageValue: 1,
    startConditions: [{
      indicator: 'BB_PERCENT_B',
      params: { period: 20, deviation: 2 },
      condition: 'LESS_THAN',
      signalValue: direction === 'LONG' ? 0.2 : 0.8,
      timeframe: '5m',
    }],
    deviationFirstOrder: 1,
    deviationStepMultiplier: 1.5,
    averagingOrderSize: 100,
    orderSizeMultiplier: 1.2,
    maxAveragingOrders: 5,
    takeProfitPercent: 2,
    trailingEnabled: false,
    trailingPercent: 0.5,
    reinvestProfit: 0,
    stopLossEnabled: true,
    stopLossPercent: 5,
    stopLossAction: 'CLOSE_TRADE',
  };
}

export default function SimulatorPage() {
  // Config state
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Strategy toggles
  const [gridLongEnabled, setGridLongEnabled] = useState(true);
  const [gridShortEnabled, setGridShortEnabled] = useState(true);
  const [dcaLongEnabled, setDcaLongEnabled] = useState(false);
  const [dcaShortEnabled, setDcaShortEnabled] = useState(false);

  // DCA config
  const [dcaLongConfig, setDcaLongConfig] = useState<DCABreakoutConfig>(getDefaultDCAConfig('LONG'));
  const [dcaShortConfig, setDcaShortConfig] = useState<DCABreakoutConfig>(getDefaultDCAConfig('SHORT'));

  // Grid simulation state
  const [simulationId, setSimulationId] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<SimulationSummary | null>(null);
  const [replayData, setReplayData] = useState<ReplayData | null>(null);

  // DCA simulation state
  const [dcaLongSnapshots, setDcaLongSnapshots] = useState<DCATradeSnapshot[]>([]);
  const [dcaShortSnapshots, setDcaShortSnapshots] = useState<DCATradeSnapshot[]>([]);
  const [dcaLongTrades, setDcaLongTrades] = useState<DCATradeRecord[]>([]);
  const [dcaShortTrades, setDcaShortTrades] = useState<DCATradeRecord[]>([]);
  const [dcaCandles, setDcaCandles] = useState<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }[]>([]);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [fitAllCharts, setFitAllCharts] = useState(false);
  const playbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Active tab
  const [activeTab, setActiveTab] = useState<'trades' | 'performance' | 'optimizer'>('performance');

  // Track selected pair index for DCA candle fetching
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);

  // Reload last simulation on mount
  useEffect(() => {
    const savedId = localStorage.getItem('lastSimulationId');
    if (!savedId) return;

    const loadSavedSimulation = async () => {
      try {
        setStatusMessage('Loading last simulation...');
        const statusRes = await fetch(`/api/simulations/${savedId}`);
        if (!statusRes.ok) {
          localStorage.removeItem('lastSimulationId');
          setStatusMessage('');
          return;
        }

        const { simulation: sim } = await statusRes.json();
        if (sim.status !== 'completed') {
          setStatusMessage('');
          return;
        }

        setSimulationId(savedId);
        setSimulation({
          id: sim.id,
          name: sim.name,
          pair: sim.pair,
          timeframe: sim.timeframe,
          status: sim.status,
          createdAt: sim.createdAt,
          startTime: sim.startTime,
          endTime: sim.endTime,
          totalPnl: sim.totalPnl,
          totalPnlPct: sim.totalPnlPct,
          longPnl: sim.longPnl,
          shortPnl: sim.shortPnl,
          totalTrades: sim.totalTrades,
          maxDrawdown: sim.maxDrawdown,
          maxDrawdownPct: sim.maxDrawdownPct,
          totalCandles: sim.totalCandles,
          winCount: sim.winCount,
          lossCount: sim.lossCount,
        });

        const replayRes = await fetch(`/api/simulations/${savedId}/replay`);
        if (replayRes.ok) {
          const replay = await replayRes.json();
          setReplayData(replay);
          setConfigCollapsed(true);
        }

        setStatusMessage('');
      } catch {
        localStorage.removeItem('lastSimulationId');
        setStatusMessage('');
      }
    };

    loadSavedSimulation();
  }, []);

  // Current snapshot for P&L display
  const currentSnapshot: SnapshotData | undefined = replayData?.pnlSnapshots.reduce(
    (closest, s) => {
      if (s.candleIdx <= currentIdx && (!closest || s.candleIdx > closest.candleIdx)) {
        return s;
      }
      return closest;
    },
    undefined as SnapshotData | undefined
  );

  // Current adaptive state
  const currentAdaptiveEvents = replayData?.adaptiveEvents.filter(
    e => e.candleIdx <= currentIdx
  ) || [];
  const lastAdaptiveEvent = currentAdaptiveEvents[currentAdaptiveEvents.length - 1];

  // Filled level indices up to current playback position
  const longFilledLevels = new Set<number>();
  const shortFilledLevels = new Set<number>();
  if (replayData) {
    for (const order of replayData.gridOrders) {
      if (order.fillCandleIdx != null && order.fillCandleIdx <= currentIdx) {
        if (order.side === 'long') longFilledLevels.add(order.level);
        else shortFilledLevels.add(order.level);
      }
    }
  }

  // Grid fill markers for trade visualization
  const longFills: GridFill[] = [];
  const shortFills: GridFill[] = [];
  if (replayData) {
    for (const order of replayData.gridOrders) {
      if (order.fillCandleIdx != null && order.fillPrice != null) {
        const fill: GridFill = {
          candleIdx: order.fillCandleIdx,
          price: order.fillPrice,
          type: order.orderType === 'buy' ? 'buy' : 'sell',
        };
        if (order.side === 'long') longFills.push(fill);
        else shortFills.push(fill);
      }
    }
  }

  // DCA P&L for combined display
  const dcaLongCurrentSnapshot = dcaLongSnapshots.reduce<DCATradeSnapshot | undefined>(
    (closest, s) => (s.candleIdx <= currentIdx && (!closest || s.candleIdx > closest.candleIdx) ? s : closest),
    undefined
  );
  const dcaShortCurrentSnapshot = dcaShortSnapshots.reduce<DCATradeSnapshot | undefined>(
    (closest, s) => (s.candleIdx <= currentIdx && (!closest || s.candleIdx > closest.candleIdx) ? s : closest),
    undefined
  );

  // Total candles (grid or DCA, whichever is available)
  const totalCandles = replayData?.totalCandles ?? dcaCandles.length;

  // Playback timer
  useEffect(() => {
    if (isPlaying && totalCandles > 0) {
      playbackRef.current = setInterval(() => {
        setCurrentIdx(prev => {
          const next = prev + 1;
          if (next >= totalCandles) {
            setIsPlaying(false);
            return totalCandles - 1;
          }
          return next;
        });
      }, 1000 / speed);
    }

    return () => {
      if (playbackRef.current) {
        clearInterval(playbackRef.current);
        playbackRef.current = null;
      }
    };
  }, [isPlaying, speed, totalCandles]);

  // Run simulation handler (grid + DCA)
  const handleRunSimulation = useCallback(async (config: SimulationConfig) => {
    setError(null);
    setIsRunning(true);
    setStatusMessage('Fetching candle data...');
    setReplayData(null);
    setSimulation(null);
    setDcaLongSnapshots([]);
    setDcaShortSnapshots([]);
    setDcaLongTrades([]);
    setDcaShortTrades([]);
    setDcaCandles([]);
    setCurrentIdx(0);
    setIsPlaying(false);

    const selectedPair = SUPPORTED_PAIRS[selectedPairIdx];

    try {
      // ── Grid simulation (if enabled) ──
      if (gridLongEnabled || gridShortEnabled) {
        const candleRes = await fetch('/api/candles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pair: selectedPair.binanceSymbol,
            timeframe: '5m',
            startTime: config.startTime,
            endTime: config.endTime,
          }),
        });

        if (!candleRes.ok) {
          const err = await candleRes.json();
          throw new Error(err.error || 'Failed to fetch candles');
        }

        const candleData = await candleRes.json();
        setStatusMessage(`Cached ${candleData.count} candles. Running grid simulation...`);

        // Fetch 4H candles for adaptive layer
        if (config.adaptiveEnabled && config.timeframe !== '4h') {
          const res4h = await fetch('/api/candles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pair: selectedPair.binanceSymbol,
              timeframe: '4h',
              startTime: config.startTime,
              endTime: config.endTime,
            }),
          });
          if (res4h.ok) {
            const data4h = await res4h.json();
            setStatusMessage(`Cached ${candleData.count} + ${data4h.count} 4H candles. Running...`);
          }
        }

        // Create and run grid simulation
        const simRes = await fetch('/api/simulations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });

        if (!simRes.ok) {
          const err = await simRes.json();
          throw new Error(err.error || 'Failed to create simulation');
        }

        const { id } = await simRes.json();
        setSimulationId(id);
        localStorage.setItem('lastSimulationId', id);
        setStatusMessage('Grid simulation running...');

        // Poll for completion
        let attempts = 0;
        while (attempts < 120) {
          await new Promise(r => setTimeout(r, 1000));
          attempts++;

          const statusRes = await fetch(`/api/simulations/${id}`);
          if (!statusRes.ok) continue;

          const { simulation: sim } = await statusRes.json();

          if (sim.status === 'completed') {
            setStatusMessage('Loading grid results...');
            setSimulation({
              id: sim.id,
              name: sim.name,
              pair: sim.pair,
              timeframe: sim.timeframe,
              status: sim.status,
              createdAt: sim.createdAt,
              startTime: sim.startTime,
              endTime: sim.endTime,
              totalPnl: sim.totalPnl,
              totalPnlPct: sim.totalPnlPct,
              longPnl: sim.longPnl,
              shortPnl: sim.shortPnl,
              totalTrades: sim.totalTrades,
              maxDrawdown: sim.maxDrawdown,
              maxDrawdownPct: sim.maxDrawdownPct,
              totalCandles: sim.totalCandles,
              winCount: sim.winCount,
              lossCount: sim.lossCount,
            });

            const replayRes = await fetch(`/api/simulations/${id}/replay`);
            if (replayRes.ok) {
              const replay = await replayRes.json();
              setReplayData(replay);
              setConfigCollapsed(true);
            }
            break;
          }

          if (sim.status === 'failed') {
            throw new Error(sim.errorMessage || 'Grid simulation failed');
          }

          setStatusMessage(`Grid simulation running... (${attempts}s)`);
        }
      }

      // ── DCA simulation (if enabled) ──
      if (dcaLongEnabled || dcaShortEnabled) {
        setStatusMessage('Running DCA simulation...');

        const binanceSymbol = selectedPair.binanceSymbol;
        if (!binanceSymbol) {
          throw new Error('No Binance symbol configured for DCA');
        }

        // Ensure 5m candles are cached
        const candle5mRes = await fetch('/api/candles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pair: binanceSymbol,
            timeframe: '5m',
            startTime: config.startTime,
            endTime: config.endTime,
          }),
        });

        if (!candle5mRes.ok) {
          const err = await candle5mRes.json();
          throw new Error(err.error || 'Failed to fetch 5m candles for DCA');
        }

        // Run DCA simulation
        const dcaBody: Record<string, unknown> = {
          strategyType: 'dca',
          pair: binanceSymbol,
          timeframe: '5m',
          startTime: config.startTime,
          endTime: config.endTime,
          feeRate: config.feeRate,
        };
        if (dcaLongEnabled) dcaBody.longConfig = dcaLongConfig;
        if (dcaShortEnabled) dcaBody.shortConfig = dcaShortConfig;

        const dcaRes = await fetch('/api/simulations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dcaBody),
        });

        if (!dcaRes.ok) {
          const err = await dcaRes.json();
          throw new Error(err.error || 'DCA simulation failed');
        }

        const dcaResult = await dcaRes.json();

        // Split snapshots and trades by direction
        const allSnapshots: DCATradeSnapshot[] = dcaResult.snapshots || [];
        const allTrades: DCATradeRecord[] = dcaResult.trades || [];

        // If only one direction is enabled, all results belong to it
        if (dcaLongEnabled && !dcaShortEnabled) {
          setDcaLongSnapshots(allSnapshots);
          setDcaLongTrades(allTrades);
        } else if (dcaShortEnabled && !dcaLongEnabled) {
          setDcaShortSnapshots(allSnapshots);
          setDcaShortTrades(allTrades);
        } else {
          // Both enabled — split by direction
          setDcaLongTrades(allTrades.filter(t => t.direction === 'LONG'));
          setDcaShortTrades(allTrades.filter(t => t.direction === 'SHORT'));
          // Snapshots don't have direction directly, but they're interleaved
          // The DCA engine returns combined snapshots sorted by timestamp
          // For display, we'll use the combined set for both charts
          setDcaLongSnapshots(allSnapshots);
          setDcaShortSnapshots(allSnapshots);
        }

        // Fetch the 5m candles for DCA chart rendering (if no grid replay data)
        if (!replayData) {
          const params = new URLSearchParams({
            pair: binanceSymbol,
            timeframe: '5m',
            start: new Date(config.startTime).toISOString(),
            end: new Date(config.endTime).toISOString(),
          });
          const candleGetRes = await fetch(`/api/candles?${params}`);
          if (candleGetRes.ok) {
            const candleGetData = await candleGetRes.json();
            if (candleGetData.candles) {
              setDcaCandles(candleGetData.candles);
            }
          }
        }

        setConfigCollapsed(true);
      }

      setStatusMessage('');
      setIsRunning(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setIsRunning(false);
      setStatusMessage('');
    }
  }, [selectedPairIdx, gridLongEnabled, gridShortEnabled, dcaLongEnabled, dcaShortEnabled, dcaLongConfig, dcaShortConfig, replayData]);

  // Determine which candles to use for DCA charts
  const dcaChartCandles = replayData?.candles ?? dcaCandles;

  // Current time display
  const currentCandles = replayData?.candles ?? dcaCandles;
  const currentTime = currentCandles.length > 0 && currentIdx < currentCandles.length
    ? new Date(currentCandles[currentIdx].timestamp * 1000).toLocaleString()
    : '';

  // Total capital
  const initialCapital = simulation ? (currentSnapshot?.equity ?? 10000) - (currentSnapshot?.realizedPnl ?? 0) - (currentSnapshot?.unrealizedPnl ?? 0) : 10000;

  // Has any data to show?
  const hasData = replayData || dcaLongSnapshots.length > 0 || dcaShortSnapshots.length > 0;

  return (
    <div className="min-h-screen p-4">
      {/* Header */}
      <header className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg" style={{ background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
            <Grid3X3 size={20} style={{ color: 'var(--grid-neutral)' }} />
          </div>
          <div>
            <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
              GRID BOT SIMULATOR
            </h1>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Multi-strategy backtesting platform
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {simulation && (
            <div className="flex items-center gap-2">
              <span className="badge badge-neutral">{simulation.pair}</span>
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {simulation.timeframe} · {simulation.totalCandles} candles
              </span>
            </div>
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* Error display */}
      {error && (
        <div className="mb-4 p-3 rounded-lg flex items-center gap-2" style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
        }}>
          <AlertCircle size={16} className="text-loss flex-shrink-0" />
          <span className="text-sm text-loss">{error}</span>
          <button
            className="ml-auto text-xs btn-secondary btn py-0.5 px-2"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status message */}
      {statusMessage && (
        <div className="mb-4 p-3 rounded-lg flex items-center gap-2" style={{
          background: 'rgba(99, 102, 241, 0.08)',
          border: '1px solid rgba(99, 102, 241, 0.15)',
        }}>
          <Loader2 size={16} className="animate-spin" style={{ color: 'var(--grid-neutral)' }} />
          <span className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
            {statusMessage}
          </span>
        </div>
      )}

      {/* Main layout */}
      <div className="flex gap-4">
        {/* Config sidebar */}
        <aside className={`flex-shrink-0 transition-all duration-300 ${configCollapsed ? 'w-[200px]' : 'w-[340px]'} sticky top-4 self-start max-h-[calc(100vh-40px)] overflow-y-auto`}>
          <ConfigPanel
            onRunSimulation={handleRunSimulation}
            isRunning={isRunning}
            isCollapsed={configCollapsed}
            onToggleCollapse={() => setConfigCollapsed(!configCollapsed)}
            gridLongEnabled={gridLongEnabled}
            gridShortEnabled={gridShortEnabled}
            dcaLongEnabled={dcaLongEnabled}
            dcaShortEnabled={dcaShortEnabled}
            onGridLongToggle={setGridLongEnabled}
            onGridShortToggle={setGridShortEnabled}
            onDcaLongToggle={setDcaLongEnabled}
            onDcaShortToggle={setDcaShortEnabled}
            dcaLongConfig={dcaLongConfig}
            dcaShortConfig={dcaShortConfig}
            onDcaLongConfigChange={setDcaLongConfig}
            onDcaShortConfigChange={setDcaShortConfig}
          />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col gap-4 min-w-0">
          {hasData ? (
            <>
              {/* Playback controls */}
              <PlaybackControls
                isPlaying={isPlaying}
                speed={speed}
                currentIdx={currentIdx}
                totalCandles={totalCandles}
                currentTime={currentTime}
                isFitAll={fitAllCharts}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onSeek={(idx) => { setCurrentIdx(idx); setIsPlaying(false); }}
                onSpeedChange={setSpeed}
                onToggleFitAll={() => setFitAllCharts(f => !f)}
              />

              {/* Grid Bot Row */}
              {replayData && (gridLongEnabled || gridShortEnabled) && (
                <div>
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="text-xs font-mono uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                      Grid Bot
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {gridLongEnabled && (
                      <div className="card overflow-hidden">
                        <TradingChart
                          candles={replayData.candles}
                          gridLevels={replayData.longLevels}
                          side="long"
                          filledLevelIndices={longFilledLevels}
                          fills={longFills}
                          currentCandleIdx={currentIdx}
                          visibleCandleCount={50}
                          fitAll={fitAllCharts}
                          height={380}
                        />
                      </div>
                    )}
                    {gridShortEnabled && (
                      <div className="card overflow-hidden">
                        <TradingChart
                          candles={replayData.candles}
                          gridLevels={replayData.shortLevels}
                          side="short"
                          filledLevelIndices={shortFilledLevels}
                          fills={shortFills}
                          currentCandleIdx={currentIdx}
                          visibleCandleCount={50}
                          fitAll={fitAllCharts}
                          height={380}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* DCA Breakout Row */}
              {(dcaLongEnabled || dcaShortEnabled) && dcaChartCandles.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="text-xs font-mono uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                      DCA Breakout
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {dcaLongEnabled && (
                      <div className="card overflow-hidden">
                        <DCAChart
                          candles={dcaChartCandles}
                          side="LONG"
                          snapshots={dcaLongSnapshots}
                          trades={dcaLongTrades}
                          currentCandleIdx={currentIdx}
                          visibleCandleCount={80}
                          fitAll={fitAllCharts}
                          height={400}
                        />
                      </div>
                    )}
                    {dcaShortEnabled && (
                      <div className="card overflow-hidden">
                        <DCAChart
                          candles={dcaChartCandles}
                          side="SHORT"
                          snapshots={dcaShortSnapshots}
                          trades={dcaShortTrades}
                          currentCandleIdx={currentIdx}
                          visibleCandleCount={80}
                          fitAll={fitAllCharts}
                          height={400}
                        />
                      </div>
                    )}
                  </div>

                  {/* DCA P&L panels */}
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    {dcaLongEnabled && dcaLongSnapshots.length > 0 && (
                      <DCAPnL
                        snapshots={dcaLongSnapshots}
                        trades={dcaLongTrades}
                        currentIdx={currentIdx}
                        direction="LONG"
                      />
                    )}
                    {dcaShortEnabled && dcaShortSnapshots.length > 0 && (
                      <DCAPnL
                        snapshots={dcaShortSnapshots}
                        trades={dcaShortTrades}
                        currentIdx={currentIdx}
                        direction="SHORT"
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Combined P&L */}
              <div className="flex gap-4">
                <div className="w-[240px] flex-shrink-0 flex flex-col gap-3">
                  <CombinedPnL
                    totalEquity={currentSnapshot?.equity ?? initialCapital}
                    realizedPnl={currentSnapshot?.realizedPnl ?? 0}
                    unrealizedPnl={currentSnapshot?.unrealizedPnl ?? 0}
                    longRealizedPnl={currentSnapshot?.longRealizedPnl ?? 0}
                    shortRealizedPnl={currentSnapshot?.shortRealizedPnl ?? 0}
                    longUnrealizedPnl={currentSnapshot?.longUnrealizedPnl ?? 0}
                    shortUnrealizedPnl={currentSnapshot?.shortUnrealizedPnl ?? 0}
                    longMultiplier={lastAdaptiveEvent?.longMultiplier ?? 1}
                    shortMultiplier={lastAdaptiveEvent?.shortMultiplier ?? 1}
                    trend={lastAdaptiveEvent ? 'neutral' : 'neutral'}
                    deRiskPhase="none"
                    initialCapital={initialCapital}
                    dcaLongPnl={dcaLongEnabled && dcaLongCurrentSnapshot ? dcaLongCurrentSnapshot.realizedPnlCumulative : undefined}
                    dcaShortPnl={dcaShortEnabled && dcaShortCurrentSnapshot ? dcaShortCurrentSnapshot.realizedPnlCumulative : undefined}
                    dcaLongTrades={dcaLongEnabled ? dcaLongTrades.length : undefined}
                    dcaShortTrades={dcaShortEnabled ? dcaShortTrades.length : undefined}
                  />
                  {replayData && (
                    <AdaptiveStatus
                      events={replayData.adaptiveEvents}
                      currentCandleIdx={currentIdx}
                    />
                  )}
                </div>
                <div className="flex-1" />
              </div>

              {/* Results tabs */}
              <div>
                <div className="flex gap-0 border-b" style={{ borderColor: 'var(--card-border)' }}>
                  <button
                    className={`tab-btn ${activeTab === 'performance' ? 'active' : ''}`}
                    onClick={() => setActiveTab('performance')}
                  >
                    Performance
                  </button>
                  <button
                    className={`tab-btn ${activeTab === 'trades' ? 'active' : ''}`}
                    onClick={() => setActiveTab('trades')}
                  >
                    Trade Log
                  </button>
                  <button
                    className={`tab-btn ${activeTab === 'optimizer' ? 'active' : ''}`}
                    onClick={() => setActiveTab('optimizer')}
                  >
                    Optimizer
                  </button>
                </div>

                <div className="mt-4">
                  {activeTab === 'performance' && simulation && (
                    <PerformanceSummary simulation={simulation} />
                  )}
                  {activeTab === 'trades' && replayData && (
                    <TradeLog trades={replayData.gridOrders} />
                  )}
                  {activeTab === 'optimizer' && (
                    <OptimizerTab
                      pair={SUPPORTED_PAIRS[selectedPairIdx]?.pair ?? 'WETH/USDC'}
                      binanceSymbol={SUPPORTED_PAIRS[selectedPairIdx]?.binanceSymbol ?? 'ETHUSDT'}
                      startTime={simulation?.startTime ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}
                      endTime={simulation?.endTime ?? new Date().toISOString()}
                    />
                  )}
                </div>
              </div>
            </>
          ) : (
            // Empty state
            <div className="flex-1 flex items-center justify-center card" style={{ minHeight: '500px' }}>
              <div className="text-center">
                <Grid3X3 size={48} style={{ color: 'var(--text-muted)', margin: '0 auto 16px' }} />
                <h2 className="text-lg font-mono font-bold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Configure & Run
                </h2>
                <p className="text-sm max-w-md" style={{ color: 'var(--text-muted)' }}>
                  Set your grid parameters, select a trading pair and date range,
                  then hit Run Simulation to see the strategies in action.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
