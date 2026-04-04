# Investigation: Grid Short P&L lower than Long

## Root Cause Analysis

**Finding: NOT a calculation bug — this is structural grid behavior.**

The P&L difference between long and short sides is caused by **asymmetric initial level counts**:
- The simulation uses `candles[0].close` as the starting price
- Long gets buy orders at levels BELOW the starting price
- Short gets sell orders at levels ABOVE the starting price
- If the starting price isn't exactly at the grid center, one side gets more levels

### Test Results (unit test: `src/__tests__/gridPnl.test.ts`)

**Centered start (price = grid center):**
| Side | Realized P&L | Fills | Round-trips |
|------|-------------|-------|-------------|
| Long | $51.79 | 79 | 39 |
| Short | $49.57 | 80 | 40 |
| **Ratio** | **0.957** | | |

**Off-center start (price = center + 0.75%):**
| Side | Realized P&L | Fills | Round-trips |
|------|-------------|-------|-------------|
| Long | $64.50 | 100 | 49 |
| Short | $36.86 | 60 | 30 |
| **Ratio** | **1.75x** | | |

Initial level split was 6 long / 4 short (1.5x), leading to 1.75x P&L difference.

### Verified Components
- [x] `pnlTracker.ts` — P&L formula correct for both long and short round-trips
- [x] `orderMatcher.ts` — Fill detection matches old behavior (`low <= buy`, `high >= sell`)
- [x] `orderMatcher.ts` — Counter-order placement correct (buy→sell+1, sell→buy-1)
- [x] `orderMatcher.ts` — `initializeOrders` correctly handles edge cases
- [x] `engine.ts` — Fill processing order doesn't affect total P&L
- [x] `CombinedPnL.tsx` — Display reads directly from snapshot data, no transformation bugs

## Fix Applied

- [x] Reverted `entryQty` formula in `pnlTracker.ts` from `(size - fees) / price` back to `size / price`
  - The previous change double-counted entry fees (once in reduced qty, once as direct subtraction)
  - Impact was symmetric and negligible (~$0.06 over 40 round-trips) but incorrect

## Notes for User
- The P&L asymmetry is proportional to how far the starting price is from the grid center
- With more grid levels (e.g., 30+), the off-by-one effect is smaller
- This is the same behavior real grid bots (Binance, Pionex) exhibit

---

## Completed Work

- [x] Phase 1 — Binance Data Layer (binanceApi, aggregator, DataManager, candleCache rewrite)
- [x] Phase 2 — Indicator Engine (BB%B, RSI, MACD, conditionEvaluator)
- [x] Phase 3 — DCA Breakout Strategy (dcaBreakout, dcaOrderManager, entryTriggers, dcaEngine)
- [x] Phase 4 — Grid Engine 5m Upgrade + Fee Fix (intra-candle path, pnlTracker fix)
- [x] Phase 5 — UI 2x2 Chart Layout (DCAChart, DCAConfig, DCAPnL, page.tsx refactor)
- [x] Phase 6 — Optimizer (randomSearch, walkForward, fitnessFunction, OptimizerTab)
- [x] Tests — 58 passing (indicators, dcaOrderManager, optimizer)
- [x] Cleanup — Removed GeckoTerminal, updated schema, build passes

See `CHANGES.md` for full details.
