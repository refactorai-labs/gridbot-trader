// Order matching engine — checks grid order fills against candle OHLC ranges

import { OHLC, PendingOrder, Fill, GridLevel, GridSide } from '../types';

let orderIdCounter = 0;

export function generateOrderId(): string {
  return `order_${++orderIdCounter}`;
}

export function resetOrderIdCounter(): void {
  orderIdCounter = 0;
}

// Initialize pending orders for a grid side based on current price
export function initializeOrders(
  currentPrice: number,
  levels: GridLevel[],
  side: GridSide,
  orderSize: number,
  sizeMultiplier: number = 1.0
): PendingOrder[] {
  const orders: PendingOrder[] = [];

  for (const level of levels) {
    if (side === 'long') {
      // Long grid: place buy orders below current price
      if (level.price < currentPrice) {
        orders.push({
          id: generateOrderId(),
          side: 'long',
          type: 'buy',
          levelIndex: level.index,
          price: level.price,
          size: orderSize,
          sizeMultiplier,
        });
      }
    } else {
      // Short grid: place sell orders above current price
      if (level.price > currentPrice) {
        orders.push({
          id: generateOrderId(),
          side: 'short',
          type: 'sell',
          levelIndex: level.index,
          price: level.price,
          size: orderSize,
          sizeMultiplier,
        });
      }
    }
  }

  return orders;
}

// Match pending orders against a candle's price range
export function matchOrders(
  candle: OHLC,
  candleIdx: number,
  pendingOrders: PendingOrder[],
  feeRate: number,
  longLevels: GridLevel[],
  shortLevels: GridLevel[]
): Fill[] {
  const fills: Fill[] = [];

  // Separate buy and sell orders
  const buyOrders = pendingOrders
    .filter(o => o.type === 'buy' && o.sizeMultiplier > 0)
    .sort((a, b) => a.price - b.price); // Lowest first

  const sellOrders = pendingOrders
    .filter(o => o.type === 'sell' && o.sizeMultiplier > 0)
    .sort((a, b) => b.price - a.price); // Highest first

  // Check buy fills: filled if candle.low <= order.price
  for (const order of buyOrders) {
    if (candle.low <= order.price) {
      const effectiveSize = order.size * order.sizeMultiplier;
      const fees = effectiveSize * feeRate;

      fills.push({
        orderId: order.id,
        side: order.side,
        type: 'buy',
        levelIndex: order.levelIndex,
        fillPrice: order.price,
        candleIdx,
        timestamp: candle.timestamp,
        size: effectiveSize,
        fees,
      });
    }
  }

  // Check sell fills: filled if candle.high >= order.price
  for (const order of sellOrders) {
    if (candle.high >= order.price) {
      const effectiveSize = order.size * order.sizeMultiplier;
      const fees = effectiveSize * feeRate;

      fills.push({
        orderId: order.id,
        side: order.side,
        type: 'sell',
        levelIndex: order.levelIndex,
        fillPrice: order.price,
        candleIdx,
        timestamp: candle.timestamp,
        size: effectiveSize,
        fees,
      });
    }
  }

  return fills;
}

// Create a counter-order after a fill (buy filled → place sell at next level up, and vice versa)
export function createCounterOrder(
  fill: Fill,
  longLevels: GridLevel[],
  shortLevels: GridLevel[],
  orderSize: number,
  sizeMultiplier: number
): PendingOrder | null {
  const levels = fill.side === 'long' ? longLevels : shortLevels;

  if (fill.type === 'buy') {
    // Buy filled → place sell at next level up
    const nextLevel = levels.find(l => l.index === fill.levelIndex + 1);
    if (!nextLevel) return null;

    return {
      id: generateOrderId(),
      side: fill.side,
      type: 'sell',
      levelIndex: nextLevel.index,
      price: nextLevel.price,
      size: orderSize,
      sizeMultiplier,
    };
  } else {
    // Sell filled → place buy at next level down
    const nextLevel = levels.find(l => l.index === fill.levelIndex - 1);
    if (!nextLevel) return null;

    return {
      id: generateOrderId(),
      side: fill.side,
      type: 'buy',
      levelIndex: nextLevel.index,
      price: nextLevel.price,
      size: orderSize,
      sizeMultiplier,
    };
  }
}
