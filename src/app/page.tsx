'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Grid3X3, Loader2, AlertCircle } from 'lucide-react';
import ConfigPanel from '@/components/config/ConfigPanel';
import TradingChart from '@/components/charts/TradingChart';
import PlaybackControls from '@/components/simulation/PlaybackControls';
import CombinedPnL from '@/components/simulation/CombinedPnL';
import AdaptiveStatus from '@/components/simulation/AdaptiveStatus';
import TradeLog from '@/components/results/TradeLog';
import PerformanceSummary from '@/components/results/PerformanceSummary';
import { SimulationConfig, ReplayData, SimulationSummary, PlaybackSpeed, SnapshotData } from '@/lib/types';

export default function SimulatorPage() {
  // Config state
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Simulation state
  const [simulationId, setSimulationId] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<SimulationSummary | null>(null);
  const [replayData, setReplayData] = useState<ReplayData | null>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [currentIdx, setCurrentIdx] = useState(0);
  const playbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Active tab
  const [activeTab, setActiveTab] = useState<'trades' | 'performance'>('performance');

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

  // Playback timer
  useEffect(() => {
    if (isPlaying && replayData) {
      playbackRef.current = setInterval(() => {
        setCurrentIdx(prev => {
          const next = prev + 1;
          if (next >= replayData.totalCandles) {
            setIsPlaying(false);
            return replayData.totalCandles - 1;
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
  }, [isPlaying, speed, replayData]);

  // Run simulation handler
  const handleRunSimulation = useCallback(async (config: SimulationConfig) => {
    setError(null);
    setIsRunning(true);
    setStatusMessage('Fetching candle data...');
    setReplayData(null);
    setSimulation(null);
    setCurrentIdx(0);
    setIsPlaying(false);

    try {
      // Step 1: Fetch and cache candle data
      const candleRes = await fetch('/api/candles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: config.pair,
          poolAddress: config.poolAddress,
          chain: config.chain,
          timeframe: config.timeframe,
          startTime: config.startTime,
          endTime: config.endTime,
        }),
      });

      if (!candleRes.ok) {
        const err = await candleRes.json();
        throw new Error(err.error || 'Failed to fetch candles');
      }

      const candleData = await candleRes.json();
      setStatusMessage(`Cached ${candleData.count} candles. Running simulation...`);

      // If adaptive is enabled, also fetch 4H candles
      if (config.adaptiveEnabled && config.timeframe !== '4h') {
        const res4h = await fetch('/api/candles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pair: config.pair,
            poolAddress: config.poolAddress,
            chain: config.chain,
            timeframe: '4h',
            startTime: config.startTime,
            endTime: config.endTime,
          }),
        });
        if (res4h.ok) {
          const data4h = await res4h.json();
          setStatusMessage(`Cached ${candleData.count} + ${data4h.count} 4H candles. Running simulation...`);
        }
      }

      // Step 2: Create and run simulation
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
      setStatusMessage('Simulation running...');

      // Step 3: Poll for completion
      let attempts = 0;
      while (attempts < 120) { // Max 2 minutes
        await new Promise(r => setTimeout(r, 1000));
        attempts++;

        const statusRes = await fetch(`/api/simulations/${id}`);
        if (!statusRes.ok) continue;

        const { simulation: sim } = await statusRes.json();

        if (sim.status === 'completed') {
          setStatusMessage('Loading results...');
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

          // Load replay data
          const replayRes = await fetch(`/api/simulations/${id}/replay`);
          if (replayRes.ok) {
            const replay = await replayRes.json();
            setReplayData(replay);
            setConfigCollapsed(true);
          }

          setStatusMessage('');
          setIsRunning(false);
          return;
        }

        if (sim.status === 'failed') {
          throw new Error(sim.errorMessage || 'Simulation failed');
        }

        setStatusMessage(`Simulation running... (${attempts}s)`);
      }

      throw new Error('Simulation timed out');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setIsRunning(false);
      setStatusMessage('');
    }
  }, []);

  // Current time display
  const currentTime = replayData && currentIdx < replayData.candles.length
    ? new Date(replayData.candles[currentIdx].timestamp * 1000).toLocaleString()
    : '';

  // Total capital from config
  const totalCapital = replayData
    ? (currentSnapshot?.longEquity ?? 0) + (currentSnapshot?.shortEquity ?? 0)
    : 0;
  const initialCapital = simulation ? (currentSnapshot?.equity ?? 10000) - (currentSnapshot?.realizedPnl ?? 0) - (currentSnapshot?.unrealizedPnl ?? 0) : 10000;

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
              Dual adaptive grid trading backtester
            </p>
          </div>
        </div>
        {simulation && (
          <div className="flex items-center gap-2">
            <span className="badge badge-neutral">{simulation.pair}</span>
            <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
              {simulation.timeframe} · {simulation.totalCandles} candles
            </span>
          </div>
        )}
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
        <div className={`flex-shrink-0 transition-all duration-300 ${configCollapsed ? 'w-[200px]' : 'w-[340px]'}`}>
          <ConfigPanel
            onRunSimulation={handleRunSimulation}
            isRunning={isRunning}
            isCollapsed={configCollapsed}
            onToggleCollapse={() => setConfigCollapsed(!configCollapsed)}
          />
        </div>

        {/* Main content */}
        <div className="flex-1 flex flex-col gap-4 min-w-0">
          {replayData ? (
            <>
              {/* Playback controls */}
              <PlaybackControls
                isPlaying={isPlaying}
                speed={speed}
                currentIdx={currentIdx}
                totalCandles={replayData.totalCandles}
                currentTime={currentTime}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onSeek={(idx) => { setCurrentIdx(idx); setIsPlaying(false); }}
                onSpeedChange={setSpeed}
              />

              {/* Dual chart layout */}
              <div className="flex gap-4">
                {/* Long chart */}
                <div className="flex-1 card overflow-hidden">
                  <TradingChart
                    candles={replayData.candles}
                    gridLevels={replayData.longLevels}
                    side="long"
                    filledLevelIndices={longFilledLevels}
                    currentCandleIdx={currentIdx}
                    visibleCandleCount={50}
                    height={380}
                  />
                </div>

                {/* Center P&L column */}
                <div className="flex flex-col gap-3 w-[200px] flex-shrink-0">
                  <CombinedPnL
                    totalEquity={currentSnapshot?.equity ?? initialCapital}
                    realizedPnl={currentSnapshot?.realizedPnl ?? 0}
                    unrealizedPnl={currentSnapshot?.unrealizedPnl ?? 0}
                    longPnl={simulation?.longPnl ?? 0}
                    shortPnl={simulation?.shortPnl ?? 0}
                    longMultiplier={lastAdaptiveEvent?.longMultiplier ?? 1}
                    shortMultiplier={lastAdaptiveEvent?.shortMultiplier ?? 1}
                    trend={lastAdaptiveEvent ? 'neutral' : 'neutral'}
                    deRiskPhase="none"
                    initialCapital={initialCapital}
                  />
                  <AdaptiveStatus
                    events={replayData.adaptiveEvents}
                    currentCandleIdx={currentIdx}
                  />
                </div>

                {/* Short chart */}
                <div className="flex-1 card overflow-hidden">
                  <TradingChart
                    candles={replayData.candles}
                    gridLevels={replayData.shortLevels}
                    side="short"
                    filledLevelIndices={shortFilledLevels}
                    currentCandleIdx={currentIdx}
                    visibleCandleCount={50}
                    height={380}
                  />
                </div>
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
                </div>

                <div className="mt-4">
                  {activeTab === 'performance' && simulation && (
                    <PerformanceSummary simulation={simulation} />
                  )}
                  {activeTab === 'trades' && replayData && (
                    <TradeLog trades={replayData.gridOrders} />
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
                  then hit Run Simulation to see the dual grid strategy in action.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
