# Fix: SHORT Grid Not Trading When Price Is In Range

## Problem
The SHORT side only places SELL orders above the starting price, leaving levels below empty. Similarly, LONG only places BUY orders below. Real grid bots populate all levels with complementary orders on the opposite side of price.

## Tasks
- [x] Add `else if (level.price > currentPrice)` branch for LONG → place SELL orders above price
- [x] Add `else if (level.price < currentPrice)` branch for SHORT → place BUY orders below price
- [x] Add 2 unit tests verifying full grid coverage for both sides
- [x] Run existing tests to confirm no regressions
- [x] Write review summary

## Review

**Changes made:**

1. **`src/lib/simulation/orderMatcher.ts`** — Added two `else if` branches in `initializeOrders`:
   - **LONG**: Levels above `currentPrice` now get SELL orders (implied "already bought" positions)
   - **SHORT**: Levels below `currentPrice` now get BUY orders (implied "already shorted" positions)
   - ~12 lines added, no existing code modified

2. **`src/__tests__/gridPnl.test.ts`** — Added 2 unit tests:
   - `should initialize orders on ALL levels for LONG` — verifies BUYs below + SELLs above
   - `should initialize orders on ALL levels for SHORT` — verifies SELLs above + BUYs below

**Test results:** All 6 tests pass. The "off-center start" test now shows PnL ratio of 1.00x (both sides fully utilized) instead of the previous asymmetric behavior.

**Impact:** Only `initializeOrders` logic changed. No other files modified. The `matchOrders`, `createCounterOrder`, and `processFill` functions are all order-type agnostic and handle the new complementary orders correctly without changes.
