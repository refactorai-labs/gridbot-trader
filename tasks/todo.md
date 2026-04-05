# Fix: "Fit All" Chart Zoom Using `fitContent()` API

## Tasks
- [x] 1. Add `fitAll` prop to TradingChart, use `fitContent()` when true
- [x] 2. Add `fitAll` prop to DCAChart, use `fitContent()` when true
- [x] 3. Revert `visibleCandleCount` to fixed defaults in page.tsx, pass `fitAll={fitAllCharts}`
- [x] 4. Verify build compiles

## Review

### Changes Made (3 files)

**`src/components/charts/TradingChart.tsx`** — Added `fitAll?: boolean` prop. When `fitAll` is true, calls `chartRef.current.timeScale().fitContent()` instead of `setVisibleLogicalRange`. Added `fitAll` to the `useCallback` dependency array.

**`src/components/simulation/DCAChart.tsx`** — Same change: added `fitAll?: boolean` prop with `fitContent()` conditional logic and dependency array update.

**`src/app/page.tsx`** — Reverted `visibleCandleCount` from `fitAllCharts ? totalCandles : N` ternaries back to fixed defaults (`50` for TradingChart, `80` for DCAChart). Added `fitAll={fitAllCharts}` prop to all four chart instances.

### Root Cause
The previous implementation passed `totalCandles` (26000+) as `visibleCandleCount`, causing `setVisibleLogicalRange({from: 0, to: 25000+})` to render sub-pixel candles in ~600px. The lightweight-charts `fitContent()` API handles this correctly with proper margins.
