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
  if (levels.length === 0) return orders;

  const lowestLevel = levels[0].price;
  const highestLevel = levels[levels.length - 1].price;

  for (const level of levels) {
    if (side === 'long') {
      if (currentPrice < lowestLevel) {
        // Price below entire grid: place sell orders (already "bought" implicitly)
        orders.push({
          id: generateOrderId(),
          side: 'long',
          type: 'sell',
          levelIndex: level.index,
          price: level.price,
          size: orderSize,
          sizeMultiplier,
        });
      } else if (level.price < currentPrice) {
        // Normal: place buy orders below current price
        orders.push({
          id: generateOrderId(),
          side: 'long',
          type: 'buy',
          levelIndex: level.index,
          price: level.price,
          size: orderSize,
          sizeMultiplier,
        });
      } else if (level.price > currentPrice) {
        // Complementary: place sell orders above current price (implied "already bought")
        orders.push({
          id: generateOrderId(),
          side: 'long',
          type: 'sell',
          levelIndex: level.index,
          price: level.price,
          size: orderSize,
          sizeMultiplier,
        });
      }
    } else {
      if (currentPrice > highestLevel) {
        // Price above entire grid: place buy orders (already "sold" implicitly)
        orders.push({
          id: generateOrderId(),
          side: 'short',
          type: 'buy',
          levelIndex: level.index,
          price: level.price,
          size: orderSize,
          sizeMultiplier,
        });
      } else if (level.price > currentPrice) {
        // Normal: place sell orders above current price
        orders.push({
          id: generateOrderId(),
          side: 'short',
          type: 'sell',
          levelIndex: level.index,
          price: level.price,
          size: orderSize,
          sizeMultiplier,
        });
      } else if (level.price < currentPrice) {
        // Complementary: place buy orders below current price (implied "already shorted")
        orders.push({
          id: generateOrderId(),
          side: 'short',
          type: 'buy',
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

// Generate a deterministic intra-candle price path for fill ordering
export function getIntraCandlePath(candle: OHLC): number[] {
  if (candle.close >= candle.open) {
    // Bullish: open -> low -> high -> close
    return [candle.open, candle.low, candle.high, candle.close];
  } else {
    // Bearish: open -> high -> low -> close
    return [candle.open, candle.high, candle.low, candle.close];
  }
}

// Check if a price level is crossed between two path points
function isBuyFilled(orderPrice: number, from: number, to: number): boolean {
  return to <= orderPrice && (from >= orderPrice || to <= orderPrice);
}

function isSellFilled(orderPrice: number, from: number, to: number): boolean {
  return to >= orderPrice && (from <= orderPrice || to >= orderPrice);
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
  const filledLevels = new Set<string>(); // "side:levelIndex" — max 1 fill per level per candle

  const path = getIntraCandlePath(candle);

  const activeOrders = pendingOrders.filter(o => o.sizeMultiplier > 0);

  // Walk each segment of the price path
  for (let seg = 0; seg < path.length - 1; seg++) {
    const from = path[seg];
    const to = path[seg + 1];

    for (const order of activeOrders) {
      const levelKey = `${order.side}:${order.levelIndex}`;
      if (filledLevels.has(levelKey)) continue;

      let filled = false;
      if (order.type === 'buy') {
        filled = isBuyFilled(order.price, from, to);
      } else {
        filled = isSellFilled(order.price, from, to);
      }

      if (filled) {
        filledLevels.add(levelKey);
        const effectiveSize = order.size * order.sizeMultiplier;
        const fees = effectiveSize * feeRate;

        fills.push({
          orderId: order.id,
          side: order.side,
          type: order.type,
          levelIndex: order.levelIndex,
          fillPrice: order.price,
          candleIdx,
          timestamp: candle.timestamp,
          size: effectiveSize,
          fees,
          pathSegment: seg,
          positionId: order.positionId,
        });
      }
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
