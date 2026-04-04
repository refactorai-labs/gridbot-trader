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

---

# Config Panel Redesign — Make All Strategies Visible

## Problem
When DCA strategies are enabled alongside grid bots, the sidebar becomes extremely tall with nested scrolling:
1. **ConfigPanel** has its own `overflow-y-auto` + `maxHeight: calc(100vh - 120px)` — takes nearly the full viewport
2. Below it: DataManager → Strategy Toggles → DCA Long Config → DCA Short Config
3. Grid config (inside ConfigPanel) gets scrolled out of view
4. Two nested scroll containers (ConfigPanel + sidebar) create confusing UX

## Solution
Restructure the sidebar into a **unified accordion layout** — one scroll container with collapsible sections. Each strategy section has an inline enable/disable toggle in its header.

### Layout (top to bottom):
```
┌─ Configuration [collapse button] ─────┐
│                                        │
│ ▼ General Settings                     │
│   Name, Pair, Timeframe, Dates, Fee   │
│                                        │
│ ▼ Grid Long  ●───○                     │
│   Levels, Type, Bounds, Order Size...  │
│                                        │
│ ▼ Grid Short  ●───○                    │
│   ...                                  │
│                                        │
│ ▶ DCA Long  ○───●                      │
│   (collapsed, expandable)              │
│                                        │
│ ▶ DCA Short  ○───●                     │
│   (collapsed, expandable)              │
│                                        │
│ ▶ Adaptive Layer  ○───●                │
│   EMA Period, Vol. Multiplier          │
│                                        │
│ ▶ Data Manager                         │
│   Pair, Date range, Download           │
│                                        │
│  [▶ Run Simulation]                    │
└────────────────────────────────────────┘
```

## Todo

- [x] 1. **Refactor ConfigPanel** — Remove nested scroll, convert General Settings + Grid configs into collapsible sections. Accept strategy toggle state + DCA config as props.
- [x] 2. **Integrate DCA configs** — Move DCA Long/Short config sections into ConfigPanel with inline toggle switches in section headers.
- [x] 3. **Integrate DataManager** — Move into ConfigPanel as a collapsible section.
- [x] 4. **Update page.tsx** — Simplify sidebar to just render ConfigPanel (one card). Pass strategy toggles and DCA config state down.
- [x] 5. **Visual polish** — Consistent section headers with toggle switches, smooth transitions, proper spacing.
- [x] 6. **Test** — Build passes, all strategy combinations supported.

## Review

### Changes Made
1. **`src/components/config/ConfigPanel.tsx`** — Complete rewrite. Now a single unified card with 7 collapsible accordion sections: General, Grid Long, Grid Short, DCA Long, DCA Short, Adaptive Layer, Data Manager. Each strategy section has an inline toggle switch in its header. DCA and DataManager functionality moved inline (no separate components needed in sidebar). Removed nested `overflow-y-auto` / `maxHeight`.

2. **`src/components/config/GridSideConfig.tsx`** — Removed redundant side header (colored dot + "Long Grid" / "Short Grid" title) since the accordion header now provides this.

3. **`src/app/page.tsx`** — Simplified sidebar from 5 separate cards to a single `<ConfigPanel>`. Removed `DataManager` and `DCAConfig` imports from sidebar. All strategy toggle state and DCA config state passed as props.

4. **`src/app/globals.css`** — Added CSS for toggle switches (`.toggle-switch`, `.toggle-track`, `.toggle-knob`) and accordion sections (`.accordion-section`, `.accordion-header`, `.accordion-body`). Works with both light and dark themes via existing CSS variables.

### What's Better
- **No nested scrolling** — One scroll container (the sidebar `<aside>`) handles all content
- **Everything always accessible** — All config sections visible via accordion, even with all strategies enabled
- **Inline toggle switches** — Enable/disable strategies directly from section headers
- **Collapsed by default** — DCA and Adaptive sections start collapsed, reducing initial visual clutter
- **No business logic changes** — Same state management, same simulation flow
