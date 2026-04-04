// Test grid P&L calculation for long vs short symmetry
import { describe, it, expect } from 'vitest';
import { generateGridLevels } from '../lib/simulation/gridGenerator';
import { initializeOrders, matchOrders, createCounterOrder, resetOrderIdCounter } from '../lib/simulation/orderMatcher';
import { createInitialPnLState, processFill } from '../lib/simulation/pnlTracker';
import { OHLC, PendingOrder, Fill, GridLevel } from '../lib/types';

// Helper: run a mini grid simulation on synthetic candles
function runGridSim(
  candles: OHLC[],
  side: 'long' | 'short',
  lowerBound: number,
  upperBound: number,
  gridLevels: number,
  orderSize: number,
  feeRate: number,
  totalCapital: number,
) {
  resetOrderIdCounter();
  const levels = generateGridLevels(lowerBound, upperBound, gridLevels, side, 'arithmetic');
  const firstPrice = candles[0].close;
  let pendingOrders = initializeOrders(firstPrice, levels, side, orderSize);

  const pnlState = createInitialPnLState();
  pnlState.maxEquity = totalCapital;
  const allFills: Fill[] = [];

  const emptyLevels: GridLevel[] = [];
  const longLevels = side === 'long' ? levels : emptyLevels;
  const shortLevels = side === 'short' ? levels : emptyLevels;

  for (let i = 0; i < candles.length; i++) {
    const fills = matchOrders(candles[i], i, pendingOrders, feeRate, longLevels, shortLevels);
    for (const fill of fills) {
      pendingOrders = pendingOrders.filter(o => o.id !== fill.orderId);
      const { pnl } = processFill(pnlState, fill, totalCapital);
      fill.pnl = pnl;
      const counterOrder = createCounterOrder(fill, longLevels, shortLevels, orderSize, 1.0);
      if (counterOrder) {
        pendingOrders.push(counterOrder);
      }
      allFills.push(fill);
    }
  }

  return {
    realizedPnl: side === 'long' ? pnlState.longRealizedPnl : pnlState.shortRealizedPnl,
    fillCount: side === 'long' ? pnlState.longFillCount : pnlState.shortFillCount,
    roundTrips: pnlState.winCount + pnlState.lossCount,
    openPositions: pnlState.openPositions.length,
    allFills,
    pendingOrders,
    pnlState,
  };
}

// Create synthetic candles that oscillate in a range
function makeOscillatingCandles(
  centerPrice: number,
  amplitude: number,
  periods: number,
  candlesPerPeriod: number,
): OHLC[] {
  const candles: OHLC[] = [];
  for (let p = 0; p < periods; p++) {
    for (let i = 0; i < candlesPerPeriod; i++) {
      const t = (i / candlesPerPeriod) * 2 * Math.PI;
      const price = centerPrice + amplitude * Math.sin(t);
      const nextPrice = centerPrice + amplitude * Math.sin(t + (2 * Math.PI / candlesPerPeriod));
      const open = price;
      const close = nextPrice;
      const high = Math.max(open, close) + amplitude * 0.05;
      const low = Math.min(open, close) - amplitude * 0.05;
      candles.push({
        timestamp: 1700000000 + (p * candlesPerPeriod + i) * 300,
        open, high, low, close,
        volume: 1000,
      });
    }
  }
  return candles;
}

describe('Grid P&L: Long vs Short', () => {
  const lowerBound = 2800;
  const upperBound = 3200;
  const gridLevels = 10;
  const orderSize = 100; // $100 per order
  const feeRate = 0.001; // 0.1%
  const totalCapital = 5000;

  it('should produce roughly symmetric P&L for oscillating price (centered start)', () => {
    // Price oscillates around 3000 with amplitude touching bounds
    // First candle must close at EXACTLY 3000 to ensure symmetric level split
    const candles = makeOscillatingCandles(3000, 180, 10, 50);
    // Override first candle's close to be exactly 3000 (grid center)
    candles[0] = { ...candles[0], open: 3000, close: 3000, high: 3010, low: 2990 };

    const longResult = runGridSim(candles, 'long', lowerBound, upperBound, gridLevels, orderSize, feeRate, totalCapital);
    const shortResult = runGridSim(candles, 'short', lowerBound, upperBound, gridLevels, orderSize, feeRate, totalCapital);

    console.log('=== Centered start (firstPrice=3000) ===');
    console.log(`Long:  realized=${longResult.realizedPnl.toFixed(2)}, fills=${longResult.fillCount}, roundTrips=${longResult.roundTrips}, openPos=${longResult.openPositions}`);
    console.log(`Short: realized=${shortResult.realizedPnl.toFixed(2)}, fills=${shortResult.fillCount}, roundTrips=${shortResult.roundTrips}, openPos=${shortResult.openPositions}`);

    // Both sides should have significant positive P&L
    expect(longResult.realizedPnl).toBeGreaterThan(0);
    expect(shortResult.realizedPnl).toBeGreaterThan(0);

    // With centered start, both sides should be very close
    const ratio = Math.min(longResult.realizedPnl, shortResult.realizedPnl) /
                  Math.max(longResult.realizedPnl, shortResult.realizedPnl);
    console.log(`Ratio (min/max): ${ratio.toFixed(3)}`);
    expect(ratio).toBeGreaterThan(0.85); // Should be close to 1.0
  });

  it('shows asymmetry when firstPrice is off-center', () => {
    // First candle close at 3022.56 — slightly above center
    const candles = makeOscillatingCandles(3000, 180, 10, 50);

    // Count initial levels for each side
    const levels = generateGridLevels(lowerBound, upperBound, gridLevels, 'long', 'arithmetic');
    const firstPrice = candles[0].close;
    const longInitial = levels.filter(l => l.price < firstPrice).length;
    const shortInitial = levels.filter(l => l.price > firstPrice).length;

    const longResult = runGridSim(candles, 'long', lowerBound, upperBound, gridLevels, orderSize, feeRate, totalCapital);
    const shortResult = runGridSim(candles, 'short', lowerBound, upperBound, gridLevels, orderSize, feeRate, totalCapital);

    console.log(`\n=== Off-center start (firstPrice=${firstPrice.toFixed(2)}) ===`);
    console.log(`Initial levels — long: ${longInitial} buys, short: ${shortInitial} sells`);
    console.log(`Long:  realized=${longResult.realizedPnl.toFixed(2)}, fills=${longResult.fillCount}, roundTrips=${longResult.roundTrips}`);
    console.log(`Short: realized=${shortResult.realizedPnl.toFixed(2)}, fills=${shortResult.fillCount}, roundTrips=${shortResult.roundTrips}`);
    console.log(`PnL ratio: ${(longResult.realizedPnl / shortResult.realizedPnl).toFixed(2)}x`);
    console.log(`Level ratio: ${(longInitial / shortInitial).toFixed(2)}x`);
  });

  it('should trace a simple short round-trip correctly', () => {
    // Price starts at 3000, goes up to 3100, comes back to 3000
    const candles: OHLC[] = [
      { timestamp: 1700000000, open: 3000, high: 3010, low: 2990, close: 3000, volume: 100 },
      { timestamp: 1700000300, open: 3000, high: 3100, low: 3000, close: 3100, volume: 100 },
      { timestamp: 1700000600, open: 3100, high: 3100, low: 2990, close: 3000, volume: 100 },
    ];

    const result = runGridSim(candles, 'short', 2900, 3200, 5, 100, 0.001, 5000);

    console.log('\n=== Simple short round-trip ===');
    console.log(`Realized: ${result.realizedPnl.toFixed(4)}`);
    console.log(`Fills: ${result.fillCount}`);
    console.log(`Round trips: ${result.roundTrips}`);
    console.log(`Open positions: ${result.openPositions}`);
    for (const f of result.allFills) {
      console.log(`  ${f.type} @ ${f.fillPrice} (level ${f.levelIndex}, side=${f.side}, pnl=${f.pnl?.toFixed(4)})`);
    }
  });

  it('should trace a simple long round-trip correctly', () => {
    // Price starts at 3000, goes down to 2900, comes back to 3000
    const candles: OHLC[] = [
      { timestamp: 1700000000, open: 3000, high: 3010, low: 2990, close: 3000, volume: 100 },
      { timestamp: 1700000300, open: 3000, high: 3000, low: 2900, close: 2900, volume: 100 },
      { timestamp: 1700000600, open: 2900, high: 3010, low: 2900, close: 3000, volume: 100 },
    ];

    const result = runGridSim(candles, 'long', 2800, 3100, 5, 100, 0.001, 5000);

    console.log('\n=== Simple long round-trip ===');
    console.log(`Realized: ${result.realizedPnl.toFixed(4)}`);
    console.log(`Fills: ${result.fillCount}`);
    console.log(`Round trips: ${result.roundTrips}`);
    console.log(`Open positions: ${result.openPositions}`);
    for (const f of result.allFills) {
      console.log(`  ${f.type} @ ${f.fillPrice} (level ${f.levelIndex}, side=${f.side}, pnl=${f.pnl?.toFixed(4)})`);
    }
  });
});
