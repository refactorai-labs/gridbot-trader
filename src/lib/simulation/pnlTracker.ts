// P&L tracking for grid bot simulation
// Tracks realized P&L from completed round-trips and unrealized P&L from open positions

import { Fill, PendingOrder, SnapshotData, GridSide } from '../types';

export interface PnLState {
  realizedPnl: number;
  longRealizedPnl: number;
  shortRealizedPnl: number;
  totalFees: number;
  longFillCount: number;
  shortFillCount: number;
  winCount: number;
  lossCount: number;
  maxEquity: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  // Track open positions from buy fills awaiting matching sells (and vice versa)
  openPositions: OpenPosition[];
}

interface OpenPosition {
  side: GridSide;
  entryType: 'buy' | 'sell';
  entryPrice: number;
  size: number;
  levelIndex: number;
}

export function createInitialPnLState(): PnLState {
  return {
    realizedPnl: 0,
    longRealizedPnl: 0,
    shortRealizedPnl: 0,
    totalFees: 0,
    longFillCount: 0,
    shortFillCount: 0,
    winCount: 0,
    lossCount: 0,
    maxEquity: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    openPositions: [],
  };
}

// Process a fill and update P&L state
// Returns the P&L for this specific fill (if it closes a position)
export function processFill(
  state: PnLState,
  fill: Fill,
  totalCapital: number
): { pnl: number; pnlPct: number } {
  // Track fees
  state.totalFees += fill.fees;

  // Update fill counts
  if (fill.side === 'long') {
    state.longFillCount++;
  } else {
    state.shortFillCount++;
  }

  // Check if this fill closes an existing open position
  const matchIdx = state.openPositions.findIndex(
    p => p.side === fill.side &&
         p.entryType !== fill.type &&
         (fill.type === 'sell'
           ? p.levelIndex === fill.levelIndex - 1  // sell closes buy one level below
           : p.levelIndex === fill.levelIndex + 1) // buy closes sell one level above
  );

  if (matchIdx >= 0) {
    // This fill closes an open position — calculate round-trip P&L
    const openPos = state.openPositions[matchIdx];
    state.openPositions.splice(matchIdx, 1);

    let pnl: number;
    if (fill.side === 'long') {
      // Long grid: buy low, sell high → profit = sell - buy
      if (fill.type === 'sell') {
        pnl = (fill.fillPrice - openPos.entryPrice) * (fill.size / fill.fillPrice) - fill.fees;
      } else {
        pnl = (openPos.entryPrice - fill.fillPrice) * (fill.size / fill.fillPrice) - fill.fees;
      }
    } else {
      // Short grid: sell high, buy low → profit = sell - buy
      if (fill.type === 'buy') {
        pnl = (openPos.entryPrice - fill.fillPrice) * (fill.size / openPos.entryPrice) - fill.fees;
      } else {
        pnl = (fill.fillPrice - openPos.entryPrice) * (fill.size / fill.fillPrice) - fill.fees;
      }
    }

    const pnlPct = totalCapital > 0 ? (pnl / totalCapital) * 100 : 0;

    // Update realized P&L
    state.realizedPnl += pnl;
    if (fill.side === 'long') {
      state.longRealizedPnl += pnl;
    } else {
      state.shortRealizedPnl += pnl;
    }

    // Track wins/losses
    if (pnl > 0) state.winCount++;
    else if (pnl < 0) state.lossCount++;

    // Track max drawdown
    const equity = totalCapital + state.realizedPnl;
    if (equity > state.maxEquity) state.maxEquity = equity;
    const drawdown = state.maxEquity - equity;
    if (drawdown > state.maxDrawdown) {
      state.maxDrawdown = drawdown;
      state.maxDrawdownPct = state.maxEquity > 0 ? (drawdown / state.maxEquity) * 100 : 0;
    }

    return { pnl, pnlPct };
  }

  // No matching position — this fill opens a new position
  state.openPositions.push({
    side: fill.side,
    entryType: fill.type,
    entryPrice: fill.fillPrice,
    size: fill.size,
    levelIndex: fill.levelIndex,
  });

  return { pnl: 0, pnlPct: 0 };
}

// Calculate unrealized P&L from open positions at a given price
export function calculateUnrealizedPnl(
  state: PnLState,
  currentPrice: number
): { total: number; long: number; short: number } {
  let longUnrealized = 0;
  let shortUnrealized = 0;

  for (const pos of state.openPositions) {
    if (pos.side === 'long') {
      if (pos.entryType === 'buy') {
        // Bought, not yet sold — unrealized = current - entry
        longUnrealized += (currentPrice - pos.entryPrice) * (pos.size / pos.entryPrice);
      }
    } else {
      if (pos.entryType === 'sell') {
        // Sold, not yet bought back — unrealized = entry - current
        shortUnrealized += (pos.entryPrice - currentPrice) * (pos.size / pos.entryPrice);
      }
    }
  }

  return {
    total: longUnrealized + shortUnrealized,
    long: longUnrealized,
    short: shortUnrealized,
  };
}

// Create a P&L snapshot at the current candle
export function createSnapshot(
  state: PnLState,
  candleIdx: number,
  timestamp: number,
  currentPrice: number,
  totalCapital: number,
  longOrdersActive: number,
  shortOrdersActive: number
): SnapshotData {
  const unrealized = calculateUnrealizedPnl(state, currentPrice);
  const equity = totalCapital + state.realizedPnl + unrealized.total;

  return {
    candleIdx,
    timestamp,
    price: currentPrice,
    equity,
    realizedPnl: state.realizedPnl,
    unrealizedPnl: unrealized.total,
    longRealizedPnl: state.longRealizedPnl,
    shortRealizedPnl: state.shortRealizedPnl,
    longUnrealizedPnl: unrealized.long,
    shortUnrealizedPnl: unrealized.short,
    longEquity: (totalCapital / 2) + state.longRealizedPnl + unrealized.long,
    shortEquity: (totalCapital / 2) + state.shortRealizedPnl + unrealized.short,
    longOrdersActive,
    shortOrdersActive,
    longFillCount: state.longFillCount,
    shortFillCount: state.shortFillCount,
  };
}
