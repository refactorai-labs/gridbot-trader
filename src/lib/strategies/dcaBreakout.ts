// DCA Breakout Strategy — state machine implementation

import {
  OHLC, DCABreakoutConfig, DCATradeRecord, DCATradeState_Live,
  StrategyMetrics, SnapshotData, CloseReason, Direction,
} from '../types';
import { Strategy, StrategyTrade } from './strategyInterface';
import { DCATradeSnapshot, SafetyOrderLevel } from './dcaTypes';
import { BreakoutTrigger } from './entryTriggers';
import {
  computeSafetyOrderLevels, computeAvgEntryPrice,
  computeTakeProfitPrice, computeStopLossPrice, checkTrailingTP,
} from './dcaOrderManager';
import { aggregate5mTo } from '../data/aggregator';

export class DCABreakoutStrategy implements Strategy {
  name: string;

  private config: DCABreakoutConfig;
  private feeRate: number;
  private candles: OHLC[] = [];
  private aggregatedCandles: Map<string, OHLC[]> = new Map();

  // Entry trigger
  private entryTrigger: BreakoutTrigger;
  private exitTrigger: BreakoutTrigger | null = null;

  // Trade state
  private tradeState: DCATradeState_Live | null = null;
  private safetyOrders: SafetyOrderLevel[] = [];
  private filledSOs: SafetyOrderLevel[] = [];
  private stopped = false; // true if stopLossAction === 'CLOSE_AND_STOP' was triggered

  // Results
  private trades: DCATradeRecord[] = [];
  private snapshots: DCATradeSnapshot[] = [];
  private strategyTrades: StrategyTrade[] = [];

  // Metrics tracking
  private realizedPnl = 0;
  private totalCapital: number;
  private currentCapital: number;
  private maxEquity = 0;
  private maxDrawdown = 0;
  private maxDrawdownPct = 0;
  private winCount = 0;
  private lossCount = 0;
  private totalDuration = 0;

  constructor(config: DCABreakoutConfig, feeRate: number) {
    this.config = config;
    this.feeRate = feeRate;
    this.name = `DCA_${config.direction}`;
    this.totalCapital = config.baseOrderSize;
    this.currentCapital = config.baseOrderSize;

    this.entryTrigger = new BreakoutTrigger(config.startConditions);
    if (config.closeConditions && config.closeConditions.length > 0) {
      this.exitTrigger = new BreakoutTrigger(config.closeConditions);
    }
  }

  initialize(candles: OHLC[]): void {
    this.candles = candles;

    // Collect all unique timeframes from conditions
    const timeframes = new Set<string>();
    for (const cond of this.config.startConditions) {
      if (cond.timeframe !== '5m') timeframes.add(cond.timeframe);
    }
    if (this.config.closeConditions) {
      for (const cond of this.config.closeConditions) {
        if (cond.timeframe !== '5m') timeframes.add(cond.timeframe);
      }
    }

    // Pre-build aggregated candle maps
    const tfMinutes: Record<string, number> = {
      '15m': 15, '1h': 60, '1H': 60, '4h': 240, '4H': 240,
    };
    for (const tf of timeframes) {
      const minutes = tfMinutes[tf];
      if (minutes) {
        this.aggregatedCandles.set(tf, aggregate5mTo(candles, minutes));
      }
    }
  }

  onCandle(candle: OHLC, candleIdx: number): void {
    if (this.stopped) return;

    if (this.tradeState === null) {
      // IDLE state — check entry trigger
      this.handleIdle(candle, candleIdx);
    } else {
      // OPEN state — manage trade
      this.handleOpen(candle, candleIdx);
    }
  }

  private handleIdle(candle: OHLC, candleIdx: number): void {
    const triggered = this.entryTrigger.check(this.candles, candleIdx, this.aggregatedCandles);
    if (!triggered) return;

    // Place base order at candle close price
    const basePrice = candle.close;
    const baseFee = this.currentCapital > this.config.baseOrderSize
      ? this.config.baseOrderSize * this.feeRate
      : this.currentCapital * this.feeRate;
    const baseSize = Math.min(this.config.baseOrderSize, this.currentCapital);

    // Compute safety order levels
    this.safetyOrders = computeSafetyOrderLevels(this.config, basePrice);
    this.filledSOs = [];

    const avgEntry = basePrice;
    const tpPrice = computeTakeProfitPrice(avgEntry, this.config.takeProfitPercent, this.config.direction);
    const slPrice = this.config.stopLossEnabled
      ? computeStopLossPrice(basePrice, this.config.stopLossPercent, this.config.direction)
      : 0;

    this.tradeState = {
      state: 'OPEN',
      direction: this.config.direction,
      baseOrderPrice: basePrice,
      totalInvested: baseSize,
      totalQuantity: baseSize / basePrice,
      avgEntryPrice: avgEntry,
      safetyOrdersFilled: 0,
      takeProfitPrice: tpPrice,
      stopLossPrice: slPrice,
      trailingHighPrice: 0,
      trailingActive: false,
      openTime: candle.timestamp,
    };

    // Record base order fill
    this.strategyTrades.push({
      id: `dca_base_${this.trades.length + 1}`,
      type: 'dca_base_order',
      side: this.config.direction === 'LONG' ? 'buy' : 'sell',
      price: basePrice,
      size: baseSize,
      fees: baseFee,
      pnl: 0,
      timestamp: candle.timestamp,
      candleIdx,
    });
  }

  private handleOpen(candle: OHLC, candleIdx: number): void {
    const ts = this.tradeState!;
    const dir = ts.direction;

    // 1. Check safety order fills
    this.checkSafetyOrders(candle, candleIdx);

    // 2. Check stop loss first (before TP — SL takes priority)
    if (this.config.stopLossEnabled && ts.stopLossPrice > 0) {
      const slHit = dir === 'LONG'
        ? candle.low <= ts.stopLossPrice
        : candle.high >= ts.stopLossPrice;

      if (slHit) {
        this.closeTrade(ts.stopLossPrice, candle, candleIdx, 'STOP_LOSS');
        if (this.config.stopLossAction === 'CLOSE_AND_STOP') {
          this.stopped = true;
        }
        return;
      }
    }

    // 3. Check take profit / trailing
    const tpHit = dir === 'LONG'
      ? candle.high >= ts.takeProfitPrice
      : candle.low <= ts.takeProfitPrice;

    if (tpHit) {
      if (this.config.trailingEnabled) {
        if (!ts.trailingActive) {
          // Activate trailing — don't close yet
          ts.trailingActive = true;
          ts.trailingHighPrice = dir === 'LONG' ? candle.high : candle.low;
        }
      } else {
        // No trailing — close at TP
        this.closeTrade(ts.takeProfitPrice, candle, candleIdx, 'TAKE_PROFIT');
        return;
      }
    }

    // 4. If trailing active, check pullback
    if (ts.trailingActive) {
      const priceToCheck = dir === 'LONG' ? candle.high : candle.low;
      const { triggered, newHigh } = checkTrailingTP(
        candle.close, ts.trailingHighPrice, this.config.trailingPercent, dir
      );

      // Update high watermark using the extreme price of the candle
      if (dir === 'LONG') {
        ts.trailingHighPrice = Math.max(ts.trailingHighPrice, candle.high);
      } else {
        ts.trailingHighPrice = Math.min(ts.trailingHighPrice, candle.low);
      }

      if (triggered) {
        this.closeTrade(candle.close, candle, candleIdx, 'TRAILING_TP');
        return;
      }
    }

    // 5. Check close conditions (indicator-based exit)
    if (this.exitTrigger) {
      const exitTriggered = this.exitTrigger.check(this.candles, candleIdx, this.aggregatedCandles);
      if (exitTriggered) {
        this.closeTrade(candle.close, candle, candleIdx, 'CLOSE_CONDITION');
        return;
      }
    }
  }

  private checkSafetyOrders(candle: OHLC, candleIdx: number): void {
    const ts = this.tradeState!;

    for (const so of this.safetyOrders) {
      // Skip already filled
      if (this.filledSOs.some(f => f.orderNumber === so.orderNumber)) continue;

      const filled = ts.direction === 'LONG'
        ? candle.low <= so.triggerPrice
        : candle.high >= so.triggerPrice;

      if (filled) {
        this.filledSOs.push(so);
        ts.safetyOrdersFilled++;

        // Update position
        ts.totalInvested += so.size;
        ts.totalQuantity += so.size / so.triggerPrice;
        ts.avgEntryPrice = computeAvgEntryPrice(
          ts.baseOrderPrice, this.config.baseOrderSize, this.filledSOs
        );

        // Recompute TP (based on new avg entry)
        ts.takeProfitPrice = computeTakeProfitPrice(
          ts.avgEntryPrice, this.config.takeProfitPercent, ts.direction
        );

        // SL stays based on base order price (no recompute needed)

        // Reset trailing if it was active (avg price changed)
        if (ts.trailingActive) {
          ts.trailingActive = false;
          ts.trailingHighPrice = 0;
        }

        // Record SO fill
        const soFee = so.size * this.feeRate;
        this.strategyTrades.push({
          id: `dca_so_${this.trades.length + 1}_${so.orderNumber}`,
          type: 'dca_safety_order',
          side: ts.direction === 'LONG' ? 'buy' : 'sell',
          price: so.triggerPrice,
          size: so.size,
          fees: soFee,
          pnl: 0,
          timestamp: candle.timestamp,
          candleIdx,
          metadata: { orderNumber: so.orderNumber },
        });
      }
    }
  }

  private closeTrade(
    closePrice: number,
    candle: OHLC,
    candleIdx: number,
    reason: CloseReason
  ): void {
    const ts = this.tradeState!;

    // Calculate P&L
    const entryFees = ts.totalInvested * this.feeRate;
    const exitFees = ts.totalInvested * this.feeRate; // fee on notional at exit
    const totalFees = entryFees + exitFees;

    let rawPnl: number;
    if (ts.direction === 'LONG') {
      rawPnl = (closePrice - ts.avgEntryPrice) * ts.totalQuantity;
    } else {
      rawPnl = (ts.avgEntryPrice - closePrice) * ts.totalQuantity;
    }
    const pnl = rawPnl - totalFees;
    const pnlPercent = ts.totalInvested > 0 ? (pnl / ts.totalInvested) * 100 : 0;

    const durationMinutes = (candle.timestamp - ts.openTime) / 60;

    // Record trade
    const tradeRecord: DCATradeRecord = {
      tradeNumber: this.trades.length + 1,
      direction: ts.direction,
      baseOrderPrice: ts.baseOrderPrice,
      baseOrderSize: this.config.baseOrderSize,
      avgEntryPrice: ts.avgEntryPrice,
      safetyOrdersFilled: ts.safetyOrdersFilled,
      closePrice,
      closeReason: reason,
      pnl,
      pnlPercent,
      openTime: ts.openTime,
      closeTime: candle.timestamp,
      durationMinutes,
    };
    this.trades.push(tradeRecord);

    // Update metrics
    this.realizedPnl += pnl;
    if (pnl > 0) this.winCount++;
    else if (pnl < 0) this.lossCount++;
    this.totalDuration += durationMinutes;

    // Reinvest profit
    if (pnl > 0 && this.config.reinvestProfit > 0) {
      this.currentCapital += pnl * (this.config.reinvestProfit / 100);
    } else if (pnl < 0) {
      // Losses reduce capital
      this.currentCapital += pnl;
      if (this.currentCapital < 0) this.currentCapital = 0;
    }

    // Track drawdown
    const equity = this.totalCapital + this.realizedPnl;
    if (equity > this.maxEquity) this.maxEquity = equity;
    const drawdown = this.maxEquity - equity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
      this.maxDrawdownPct = this.maxEquity > 0 ? (drawdown / this.maxEquity) * 100 : 0;
    }

    // Record close trade
    this.strategyTrades.push({
      id: `dca_close_${tradeRecord.tradeNumber}`,
      type: `dca_${reason.toLowerCase()}`,
      side: ts.direction === 'LONG' ? 'sell' : 'buy',
      price: closePrice,
      size: ts.totalInvested,
      fees: exitFees,
      pnl,
      timestamp: candle.timestamp,
      candleIdx,
      metadata: { closeReason: reason },
    });

    // Reset to IDLE
    this.tradeState = null;
    this.safetyOrders = [];
    this.filledSOs = [];
  }

  /** Force-close any open trade at end of data */
  closeOpenTrade(candle: OHLC, candleIdx: number): void {
    if (this.tradeState) {
      this.closeTrade(candle.close, candle, candleIdx, 'END_OF_DATA');
    }
  }

  /** Create a snapshot of current state */
  createSnapshot(candle: OHLC, candleIdx: number): DCATradeSnapshot {
    const ts = this.tradeState;
    let unrealizedPnl = 0;

    if (ts) {
      if (ts.direction === 'LONG') {
        unrealizedPnl = (candle.close - ts.avgEntryPrice) * ts.totalQuantity;
      } else {
        unrealizedPnl = (ts.avgEntryPrice - candle.close) * ts.totalQuantity;
      }
      // Subtract estimated fees
      unrealizedPnl -= ts.totalInvested * this.feeRate * 2;
    }

    return {
      candleIdx,
      timestamp: candle.timestamp,
      price: candle.close,
      state: ts ? ts.state : 'IDLE',
      avgEntryPrice: ts ? ts.avgEntryPrice : 0,
      totalInvested: ts ? ts.totalInvested : 0,
      unrealizedPnl,
      realizedPnlCumulative: this.realizedPnl,
      takeProfitPrice: ts ? ts.takeProfitPrice : 0,
      stopLossPrice: ts ? ts.stopLossPrice : 0,
      safetyOrdersFilled: ts ? ts.safetyOrdersFilled : 0,
    };
  }

  getTradeRecords(): DCATradeRecord[] {
    return this.trades;
  }

  getDCASnapshots(): DCATradeSnapshot[] {
    return this.snapshots;
  }

  addSnapshot(snapshot: DCATradeSnapshot): void {
    this.snapshots.push(snapshot);
  }

  // Strategy interface methods

  getMetrics(): StrategyMetrics {
    const totalTrades = this.trades.length;
    const avgTradePnl = totalTrades > 0 ? this.realizedPnl / totalTrades : 0;
    const avgTradeDuration = totalTrades > 0 ? this.totalDuration / totalTrades : 0;

    // Compute profit factor
    const grossProfit = this.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(this.trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Simple Sharpe ratio approximation (annualized)
    const returns = this.trades.map(t => t.pnlPercent / 100);
    const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    return {
      totalPnl: this.realizedPnl,
      totalPnlPct: this.totalCapital > 0 ? (this.realizedPnl / this.totalCapital) * 100 : 0,
      totalTrades,
      winCount: this.winCount,
      lossCount: this.lossCount,
      maxDrawdown: this.maxDrawdown,
      maxDrawdownPct: this.maxDrawdownPct,
      sharpeRatio,
      profitFactor,
      avgTradePnl,
      avgTradeDuration,
    };
  }

  getSnapshots(): SnapshotData[] {
    // Convert DCA snapshots to the common SnapshotData format
    const dir = this.config.direction;
    return this.snapshots.map(s => ({
      candleIdx: s.candleIdx,
      timestamp: s.timestamp,
      price: s.price,
      equity: this.totalCapital + s.realizedPnlCumulative + s.unrealizedPnl,
      realizedPnl: s.realizedPnlCumulative,
      unrealizedPnl: s.unrealizedPnl,
      longRealizedPnl: dir === 'LONG' ? s.realizedPnlCumulative : 0,
      shortRealizedPnl: dir === 'SHORT' ? s.realizedPnlCumulative : 0,
      longUnrealizedPnl: dir === 'LONG' ? s.unrealizedPnl : 0,
      shortUnrealizedPnl: dir === 'SHORT' ? s.unrealizedPnl : 0,
      longEquity: dir === 'LONG' ? this.totalCapital + s.realizedPnlCumulative + s.unrealizedPnl : 0,
      shortEquity: dir === 'SHORT' ? this.totalCapital + s.realizedPnlCumulative + s.unrealizedPnl : 0,
      longOrdersActive: dir === 'LONG' && s.state === 'OPEN' ? 1 : 0,
      shortOrdersActive: dir === 'SHORT' && s.state === 'OPEN' ? 1 : 0,
      longFillCount: dir === 'LONG' ? this.strategyTrades.filter(t => t.candleIdx <= s.candleIdx).length : 0,
      shortFillCount: dir === 'SHORT' ? this.strategyTrades.filter(t => t.candleIdx <= s.candleIdx).length : 0,
    }));
  }

  getTrades(): StrategyTrade[] {
    return this.strategyTrades;
  }
}
