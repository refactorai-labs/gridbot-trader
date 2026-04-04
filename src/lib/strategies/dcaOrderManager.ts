// DCA safety order calculation math (matches 3Commas logic)

import { DCABreakoutConfig, Direction } from '../types';
import { SafetyOrderLevel } from './dcaTypes';

/**
 * Compute safety order levels based on config and base order price.
 * Deviation for SO #n: deviationFirstOrder * (deviationStepMultiplier ^ (n-1))
 * Size for SO #n: averagingOrderSize * (orderSizeMultiplier ^ (n-1))
 */
export function computeSafetyOrderLevels(
  config: DCABreakoutConfig,
  baseOrderPrice: number
): SafetyOrderLevel[] {
  const levels: SafetyOrderLevel[] = [];

  for (let n = 1; n <= config.maxAveragingOrders; n++) {
    const deviation = config.deviationFirstOrder * Math.pow(config.deviationStepMultiplier, n - 1);
    const size = config.averagingOrderSize * Math.pow(config.orderSizeMultiplier, n - 1);

    let triggerPrice: number;
    if (config.direction === 'LONG') {
      triggerPrice = baseOrderPrice * (1 - deviation / 100);
    } else {
      triggerPrice = baseOrderPrice * (1 + deviation / 100);
    }

    levels.push({ orderNumber: n, deviation, size, triggerPrice });
  }

  return levels;
}

/**
 * Compute weighted average entry price from base order + filled safety orders.
 */
export function computeAvgEntryPrice(
  baseOrderPrice: number,
  baseOrderSize: number,
  filledSOs: SafetyOrderLevel[]
): number {
  // Weighted average: sum(price * size) / sum(size)
  let weightedSum = baseOrderPrice * baseOrderSize;
  let totalSize = baseOrderSize;

  for (const so of filledSOs) {
    weightedSum += so.triggerPrice * so.size;
    totalSize += so.size;
  }

  return weightedSum / totalSize;
}

/**
 * Compute take profit price from average entry price.
 * LONG: avgPrice * (1 + tpPercent/100)
 * SHORT: avgPrice * (1 - tpPercent/100)
 */
export function computeTakeProfitPrice(
  avgPrice: number,
  tpPercent: number,
  direction: Direction
): number {
  if (direction === 'LONG') {
    return avgPrice * (1 + tpPercent / 100);
  } else {
    return avgPrice * (1 - tpPercent / 100);
  }
}

/**
 * Compute stop loss price from base order price (not avg price).
 * LONG: baseOrderPrice * (1 - slPercent/100)
 * SHORT: baseOrderPrice * (1 + slPercent/100)
 */
export function computeStopLossPrice(
  baseOrderPrice: number,
  slPercent: number,
  direction: Direction
): number {
  if (direction === 'LONG') {
    return baseOrderPrice * (1 - slPercent / 100);
  } else {
    return baseOrderPrice * (1 + slPercent / 100);
  }
}

/**
 * Check trailing take profit logic.
 * LONG: track highest price above TP. Triggered when price drops trailingPercent from that high.
 * SHORT: track lowest price below TP. Triggered when price rises trailingPercent from that low.
 */
export function checkTrailingTP(
  currentPrice: number,
  trailingHighPrice: number,
  trailingPercent: number,
  direction: Direction
): { triggered: boolean; newHigh: number } {
  if (direction === 'LONG') {
    const newHigh = Math.max(trailingHighPrice, currentPrice);
    const pullbackThreshold = newHigh * (1 - trailingPercent / 100);
    const triggered = currentPrice <= pullbackThreshold;
    return { triggered, newHigh };
  } else {
    // SHORT: track lowest price (trailingHighPrice stores the low watermark)
    const newHigh = Math.min(trailingHighPrice, currentPrice);
    const pullbackThreshold = newHigh * (1 + trailingPercent / 100);
    const triggered = currentPrice >= pullbackThreshold;
    return { triggered, newHigh };
  }
}
