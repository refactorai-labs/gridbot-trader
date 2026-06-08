'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart3,
  Bot,
  ChevronRight,
  Database,
  Grid3X3,
  LineChart,
  Loader2,
  Play,
  Settings,
  Shield,
  SlidersHorizontal,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
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
import ComboPane from '@/components/combo/ComboPane';
import { SessionView, AdaptiveEventView } from '@/components/combo/types';
import { deriveBotPhaseView, derivePnLView, coerceComboMode } from '@/components/combo/derive';
import { DEFAULT_COMBO_CONFIG } from '@/components/config/ComboBotConfig';
import {
  SimulationConfig, ReplayData, SimulationSummary, PlaybackSpeed, SnapshotData,
  DCABreakoutConfig, DCATradeRecord, Direction, ComboBotConfig,
} from '@/lib/types';
import { DCATradeSnapshot } from '@/lib/strategies/dcaTypes';
import { SUPPORTED_PAIRS } from '@/lib/constants';
import { usePersistentState } from '@/lib/usePersistentState';
import OptimizerTab from '@/components/OptimizerTab';

// Mirrors the threshold in `src/app/api/simulations/[id]/replay/route.ts`.
// Used as a defensive guard so the auto-replay on page load can never push a
// payload large enough to crash Chrome — even if the backend somehow forgets
// to aggregate or compact.
const MAX_CHART_CANDLES = 3000;
// Hint ceiling for adaptive events. Backend compaction normally drops to
// 2 × chartCandles (≤ 6000); anything larger here means the route returned
// uncompacted diagnostics and we should refuse to mount rather than crash.
const MAX_EVENTS_HINT = 5000;

// Return a user-facing reason string when the replay payload is too large to
// render safely; `null` means safe to mount.
function checkReplayPayload(replay: ReplayData): string | null {
  const candleCount = Array.isArray(replay.candles) ? replay.candles.length : 0;
  const eventCount = Array.isArray(replay.adaptiveEvents) ? replay.adaptiveEvents.length : 0;
  if (candleCount > MAX_CHART_CANDLES) {
    return `Replay holds ${candleCount.toLocaleString()} candles (cap ${MAX_CHART_CANDLES.toLocaleString()}). Skipping render to keep the tab responsive.`;
  }
  if (eventCount > MAX_EVENTS_HINT) {
    return `Replay holds ${eventCount.toLocaleString()} adaptive events (cap ${MAX_EVENTS_HINT.toLocaleString()}). Skipping render to keep the tab responsive.`;
  }
  return null;
}

function getDefaultDCAConfig(direction: Direction): DCABreakoutConfig {
  return {
    direction,
    baseOrderSize: 100,
    leverageType: 'isolated',
    leverageValue: 1,
    startConditions: [{
      indicator: 'BB_PERCENT_B',
      params: { period: 20, deviation: 2 },
      condition: direction === 'LONG' ? 'CROSSING_DOWN' : 'CROSSING_UP',
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
  const [gridLongEnabled, setGridLongEnabled] = usePersistentState('gridLongEnabled', true);
  const [gridShortEnabled, setGridShortEnabled] = usePersistentState('gridShortEnabled', true);
  const [dcaLongEnabled, setDcaLongEnabled] = usePersistentState('dcaLongEnabled', false);
  const [dcaShortEnabled, setDcaShortEnabled] = usePersistentState('dcaShortEnabled', false);

  // DCA config
  const [dcaLongConfig, setDcaLongConfig] = usePersistentState<DCABreakoutConfig>('dcaLongConfig', () => getDefaultDCAConfig('LONG'));
  const [dcaShortConfig, setDcaShortConfig] = usePersistentState<DCABreakoutConfig>('dcaShortConfig', () => getDefaultDCAConfig('SHORT'));

  // Combo Bot (v3.1) config
  const [comboConfig, setComboConfig] = usePersistentState<ComboBotConfig>('comboConfig', DEFAULT_COMBO_CONFIG);

  // When Combo Bot is enabled, Grid Long/Short must be off (different engine, would be misleading)
  useEffect(() => {
    if (comboConfig.enabled) {
      setGridLongEnabled(false);
      setGridShortEnabled(false);
    }
  }, [comboConfig.enabled]);

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

  // Single source of truth for the selected pair (shared with ConfigPanel + Data Manager)
  const [selectedPairIdx, setSelectedPairIdx] = usePersistentState('selectedPairIdx', 0);

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
          comboBotEnabled: sim.comboBotEnabled,
          comboMode: sim.comboMode,
          comboGridLevels: sim.comboGridLevels,
          fundingDataMissing: sim.fundingDataMissing,
          requireDirectionalConfirmation: sim.requireDirectionalConfirmation,
          totalSlippageCost: sim.totalSlippageCost,
          longSlippageCost: sim.longSlippageCost,
          shortSlippageCost: sim.shortSlippageCost,
          totalFundingCost: sim.totalFundingCost,
          longFundingCost: sim.longFundingCost,
          shortFundingCost: sim.shortFundingCost,
        });

        // Sync grid toggles to match loaded simulation type
        if (sim.comboBotEnabled) {
          setGridLongEnabled(false);
          setGridShortEnabled(false);
        }

        const replayRes = await fetch(`/api/simulations/${savedId}/replay`);
        if (replayRes.ok) {
          const replay = await replayRes.json();
          const tooLarge = checkReplayPayload(replay);
          if (tooLarge) {
            localStorage.removeItem('lastSimulationId');
            setStatusMessage(`Last simulation skipped — ${tooLarge}`);
          } else {
            setReplayData(replay);
            setConfigCollapsed(true);
            setStatusMessage('');
          }
        } else {
          setStatusMessage('');
        }
      } catch {
        localStorage.removeItem('lastSimulationId');
        setStatusMessage('');
      }
    };

    loadSavedSimulation();
  }, []);

  // Current snapshot for P&L display
  const currentSnapshot = useMemo<SnapshotData | undefined>(() => {
    return replayData?.pnlSnapshots.reduce(
      (closest, s) => {
        if (s.candleIdx <= currentIdx && (!closest || s.candleIdx > closest.candleIdx)) {
          return s;
        }
        return closest;
      },
      undefined as SnapshotData | undefined
    );
  }, [replayData?.pnlSnapshots, currentIdx]);

  // Current adaptive state
  const currentAdaptiveEvents = useMemo(
    () => replayData?.adaptiveEvents.filter(e => e.candleIdx <= currentIdx) || [],
    [replayData?.adaptiveEvents, currentIdx],
  );
  const lastAdaptiveEvent = currentAdaptiveEvents[currentAdaptiveEvents.length - 1];

  // Filled level indices up to current playback position
  const { longFilledLevels, shortFilledLevels } = useMemo(() => {
    const longSet = new Set<number>();
    const shortSet = new Set<number>();
    if (replayData) {
      for (const order of replayData.gridOrders) {
        if (order.fillCandleIdx != null && order.fillCandleIdx <= currentIdx) {
          if (order.side === 'long') longSet.add(order.level);
          else shortSet.add(order.level);
        }
      }
    }
    return { longFilledLevels: longSet, shortFilledLevels: shortSet };
  }, [replayData?.gridOrders, currentIdx]);

  // Grid fill markers for trade visualization
  const { longFills, shortFills } = useMemo(() => {
    const longArr: GridFill[] = [];
    const shortArr: GridFill[] = [];
    if (replayData) {
      for (const order of replayData.gridOrders) {
        if (order.fillCandleIdx != null && order.fillPrice != null) {
          const fill: GridFill = {
            candleIdx: order.fillCandleIdx,
            price: order.fillPrice,
            type: order.orderType === 'buy' ? 'buy' : 'sell',
          };
          if (order.side === 'long') longArr.push(fill);
          else shortArr.push(fill);
        }
      }
    }
    return { longFills: longArr, shortFills: shortArr };
  }, [replayData?.gridOrders]);

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
      // ── Grid / Combo simulation (if enabled) ──
      // Combo is an opt-in supervisor wrapping grids; the sim path is the same.
      if (gridLongEnabled || gridShortEnabled || config.combo?.enabled) {
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
        while (attempts < 180) {
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
              comboBotEnabled: sim.comboBotEnabled,
              comboMode: sim.comboMode,
              comboGridLevels: sim.comboGridLevels,
              fundingDataMissing: sim.fundingDataMissing,
              requireDirectionalConfirmation: sim.requireDirectionalConfirmation,
              totalSlippageCost: sim.totalSlippageCost,
              longSlippageCost: sim.longSlippageCost,
              shortSlippageCost: sim.shortSlippageCost,
              totalFundingCost: sim.totalFundingCost,
              longFundingCost: sim.longFundingCost,
              shortFundingCost: sim.shortFundingCost,
            });

            const replayRes = await fetch(`/api/simulations/${id}/replay`);
            if (replayRes.ok) {
              const replay = await replayRes.json();
              const tooLarge = checkReplayPayload(replay);
              if (tooLarge) {
                // Fresh sim came back with a too-big payload. Don't mount the
                // chart; surface the reason so the user knows to shorten the
                // range or switch to a coarser timeframe.
                setError(tooLarge);
              } else {
                setReplayData(replay);
                setConfigCollapsed(true);
              }
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
          } else {
            setStatusMessage('Failed to load DCA candles');
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
  const chartGridClass = gridLongEnabled && gridShortEnabled ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1';
  const dcaGridClass = dcaLongEnabled && dcaShortEnabled ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1';
  const topPairLabel = simulation?.pair ?? SUPPORTED_PAIRS[selectedPairIdx]?.pair ?? 'WETH/USDC';
  const topTimeframe = simulation?.timeframe ?? '1h';
  const topCandleCount = simulation?.totalCandles ?? totalCandles;
  const gridPnl = (currentSnapshot?.realizedPnl ?? 0) + (currentSnapshot?.unrealizedPnl ?? 0);
  // Per-direction realized P&L is summed from the trade arrays (already split by direction
  // in handleRunSimulation). Snapshots cannot be used because the engine returns one merged
  // snapshot stream when both sides run, which would double-count.
  const currentCandleTs = currentCandles[currentIdx]?.timestamp ?? 0;
  const dcaLongPnlValue = dcaLongEnabled
    ? dcaLongTrades.reduce((sum, t) => sum + (t.closeTime <= currentCandleTs ? t.pnl : 0), 0)
    : 0;
  const dcaShortPnlValue = dcaShortEnabled
    ? dcaShortTrades.reduce((sum, t) => sum + (t.closeTime <= currentCandleTs ? t.pnl : 0), 0)
    : 0;
  const dcaPnl = dcaLongPnlValue + dcaShortPnlValue;
  const pnlTotal = gridPnl + dcaPnl;
  const pnlPct = initialCapital > 0 ? (pnlTotal / initialCapital) * 100 : 0;
  const hasPnlSource = !!currentSnapshot || dcaLongCurrentSnapshot != null || dcaShortCurrentSnapshot != null;
  const startLabel = simulation ? new Date(simulation.startTime).toLocaleDateString() : 'Not run';
  const endLabel = simulation ? new Date(simulation.endTime).toLocaleDateString() : 'Not run';

  const openConfigDrawer = (targetId?: string) => {
    setConfigCollapsed(false);
    if (!targetId) return;
    // Two rAFs: one for state flush, one for layout — guarantees the drawer
    // is mounted before we try to scroll into it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  };

  return (
    <div className="app-shell min-h-screen">
      <header className="topbar">
        <div className="flex items-center gap-4 min-w-0">
          <div className="brand-mark">
            <Grid3X3 size={20} />
          </div>
          <div className="hidden sm:block min-w-0">
            <div className="font-mono text-sm font-bold tracking-[0.08em]" style={{ color: 'var(--text-primary)' }}>
              GRID BOT SIMULATOR
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Multi-strategy backtesting platform
            </div>
          </div>
          <div className="topbar-divider" />
          <div className="topbar-pill topbar-pair">{topPairLabel}</div>
          <div className="topbar-pill">{topTimeframe}</div>
          <div className="hidden md:flex topbar-metric">
            <BarChart3 size={14} />
            <span>Candles</span>
            <strong>{topCandleCount ? topCandleCount.toLocaleString() : '0'}</strong>
          </div>
          {simulation && (
            <div className="hidden lg:flex topbar-metric">
              <span>Simulation</span>
              <strong className="text-profit">{simulation.status}</strong>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 min-w-0">
          <div className="hidden xl:flex topbar-date-row">
            <strong>{startLabel}</strong>
            <span className="topbar-date-arrow">→</span>
            <strong>{endLabel}</strong>
          </div>
          {hasData && hasPnlSource && (
            <div className={`topbar-pnl ${pnlTotal >= 0 ? 'text-profit' : 'text-loss'}`}>
              {pnlTotal >= 0 ? '+' : '-'}${Math.abs(pnlTotal).toFixed(2)}
              <span className={`topbar-pnl-chip ${pnlTotal >= 0 ? '' : 'loss'}`}>
                {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
              </span>
            </div>
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* Error display */}
      {error && (
        <div className="mx-3 mt-3 p-3 rounded-lg flex items-center gap-2" style={{
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
        <div className="mx-3 mt-3 p-3 rounded-lg flex items-center gap-2" style={{
          background: 'rgba(var(--grid-neutral-rgb), 0.08)',
          border: '1px solid rgba(var(--grid-neutral-rgb), 0.15)',
        }}>
          <Loader2 size={16} className="animate-spin" style={{ color: 'var(--grid-neutral)' }} />
          <span className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
            {statusMessage}
          </span>
        </div>
      )}

      <div className="workbench">
        <aside className="app-rail" aria-label="Simulator sections">
          <button className={`rail-btn ${configCollapsed ? '' : 'active'}`} onClick={() => openConfigDrawer('cfg-general')} title="General">
            <SlidersHorizontal size={20} />
            <span>General</span>
          </button>
          <button className={`rail-btn ${gridLongEnabled ? 'enabled' : ''}`} onClick={() => openConfigDrawer('cfg-grid-long')} title="Grid Long">
            <TrendingUp size={20} />
            <span>Grid Long</span>
          </button>
          <button className={`rail-btn ${gridShortEnabled ? 'enabled danger' : ''}`} onClick={() => openConfigDrawer('cfg-grid-short')} title="Grid Short">
            <TrendingDown size={20} />
            <span>Grid Short</span>
          </button>
          <button className={`rail-btn ${(dcaLongEnabled || dcaShortEnabled) ? 'enabled' : ''}`} onClick={() => openConfigDrawer('cfg-dca-long')} title="DCA">
            <LineChart size={20} />
            <span>DCA</span>
          </button>
          <button className={`rail-btn ${comboConfig.enabled ? 'enabled' : ''}`} onClick={() => openConfigDrawer('cfg-combo')} title="Combo">
            <Bot size={20} />
            <span>Combo</span>
          </button>
          <button className="rail-btn" onClick={() => openConfigDrawer('cfg-adaptive')} title="Adaptive">
            <Activity size={20} />
            <span>Adaptive</span>
          </button>
          <button className="rail-btn" onClick={() => openConfigDrawer('cfg-data')} title="Data">
            <Database size={20} />
            <span>Data</span>
          </button>
          <button className="rail-run" onClick={() => openConfigDrawer()} title="Open run configuration">
            <Play size={19} />
            <span>Run</span>
          </button>
        </aside>

        {!configCollapsed && (
          <aside className="config-drawer">
            <ConfigPanel
              selectedPairIdx={selectedPairIdx}
              onPairChange={setSelectedPairIdx}
              onRunSimulation={handleRunSimulation}
              isRunning={isRunning}
              isCollapsed={false}
              onToggleCollapse={() => setConfigCollapsed(true)}
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
              comboConfig={comboConfig}
              onComboConfigChange={setComboConfig}
            />
          </aside>
        )}

        <main className="workspace-main">
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

              {/* Combo Bot Supervisor Pane */}
              {replayData && simulation?.comboBotEnabled && (
                <ComboPane
                  session={{
                    pair: simulation.pair,
                    timeframe: simulation.timeframe,
                    startTime: new Date(simulation.startTime),
                    endTime: new Date(simulation.endTime),
                    // Chart-space total — matches the candles array the chart axis
                    // is rendering. Using DB-space (`simulation.totalCandles`) would
                    // make ComboEventTimeline plot events across a range the chart
                    // does not span. Summary-only displays (PerformanceSummary etc.)
                    // can still surface the original DB total.
                    totalCandles: replayData.candles.length,
                    currentCandleIdx: currentIdx,
                    leverage: comboConfig.leverage,
                    allocationLong: comboConfig.allocationLong,
                    mode: coerceComboMode(simulation.comboMode),
                    playbackSpeed: speed,
                    gridLevels: simulation.comboGridLevels ?? comboConfig.gridLevels,
                    fundingDataMissing: simulation.fundingDataMissing ?? false,
                    chartTimeframeMins: replayData.chartTimeframeMins,
                  }}
                  candles={replayData.candles}
                  longLevels={replayData.longLevels}
                  shortLevels={replayData.shortLevels}
                  filledLongIndices={longFilledLevels}
                  filledShortIndices={shortFilledLevels}
                  longFills={longFills}
                  shortFills={shortFills}
                  longBot={deriveBotPhaseView(
                    'long',
                    replayData.adaptiveEvents as AdaptiveEventView[],
                    currentIdx,
                    comboConfig.longSide?.retryCap ?? 2,
                  )}
                  shortBot={deriveBotPhaseView(
                    'short',
                    replayData.adaptiveEvents as AdaptiveEventView[],
                    currentIdx,
                    comboConfig.shortSide?.retryCap ?? 2,
                  )}
                  pnl={derivePnLView(
                    currentSnapshot,
                    simulation,
                    initialCapital,
                    comboConfig.leverage,
                  )}
                  events={replayData.adaptiveEvents as AdaptiveEventView[]}
                  avwapAnchor={replayData.avwapAnchor}
                />
              )}

              {/* Grid Bot Row (only when combo is NOT active) */}
              {replayData && !simulation?.comboBotEnabled && (gridLongEnabled || gridShortEnabled) && (
                <section className="workspace-section">
                  <div className="section-kicker">
                    <span>
                      Grid Bot
                    </span>
                    <span className="section-kicker-line" />
                    <span>{currentIdx + 1}/{totalCandles || 0}</span>
                  </div>
                  <div className={`grid ${chartGridClass} gap-3`}>
                    {gridLongEnabled && (
                      <div className="chart-card chart-card-long">
                        <TradingChart
                          candles={replayData.candles}
                          gridLevels={replayData.longLevels}
                          side="long"
                          filledLevelIndices={longFilledLevels}
                          fills={longFills}
                          currentCandleIdx={currentIdx}
                          visibleCandleCount={50}
                          fitAll={fitAllCharts}
                          height={420}
                        />
                      </div>
                    )}
                    {gridShortEnabled && (
                      <div className="chart-card chart-card-short">
                        <TradingChart
                          candles={replayData.candles}
                          gridLevels={replayData.shortLevels}
                          side="short"
                          filledLevelIndices={shortFilledLevels}
                          fills={shortFills}
                          currentCandleIdx={currentIdx}
                          visibleCandleCount={50}
                          fitAll={fitAllCharts}
                          height={420}
                        />
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* DCA Breakout Row */}
              {(dcaLongEnabled || dcaShortEnabled) && dcaChartCandles.length > 0 && (
                <section className="workspace-section">
                  <div className="section-kicker">
                    <span>
                      DCA Breakout
                    </span>
                    <span className="section-kicker-line" />
                    <span>{dcaChartCandles.length.toLocaleString()} candles</span>
                  </div>
                  <div className={`grid ${dcaGridClass} gap-3`}>
                    {dcaLongEnabled && (
                      <div className="chart-card chart-card-long">
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
                      <div className="chart-card chart-card-short">
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
                  <div className={`grid ${dcaGridClass} gap-3 mt-3`}>
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
                </section>
              )}

              {/* Results tabs */}
              <section className="analytics-grid">
                <div className="analytics-panel">
                  <div className="modern-tabs">
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

                  <div className="p-3">
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

                <aside className="analytics-side">
                  <CombinedPnL
                    totalEquity={initialCapital + pnlTotal}
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
                    dcaLongPnl={dcaLongEnabled ? dcaLongPnlValue : undefined}
                    dcaShortPnl={dcaShortEnabled ? dcaShortPnlValue : undefined}
                    dcaLongTrades={dcaLongEnabled ? dcaLongTrades.length : undefined}
                    dcaShortTrades={dcaShortEnabled ? dcaShortTrades.length : undefined}
                    equityHistory={replayData?.pnlSnapshots
                      .filter(s => s.candleIdx <= currentIdx)
                      .map(s => s.equity)}
                  />
                  {replayData && (
                    <AdaptiveStatus
                      events={replayData.adaptiveEvents}
                      currentCandleIdx={currentIdx}
                    />
                  )}
                </aside>
              </section>
            </>
          ) : (
            // Empty state
            <div className="empty-workspace">
              <div className="text-center">
                <Shield size={48} style={{ color: 'var(--grid-neutral)', margin: '0 auto 16px' }} />
                <h2 className="text-lg font-mono font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
                  Configure & Run
                </h2>
                <p className="text-sm max-w-md" style={{ color: 'var(--text-muted)' }}>
                  Set your grid parameters, select a trading pair and date range,
                  then hit Run Simulation to see the strategies in action.
                </p>
                <button className="btn btn-primary mt-5 inline-flex items-center gap-2" onClick={() => openConfigDrawer('cfg-general')}>
                  <Settings size={16} />
                  Open Configuration
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
