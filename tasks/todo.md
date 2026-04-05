# Fix: Revert Broken autoScale and Apply Correctly on Mode Toggle Only

## Tasks
- [x] Remove `autoScale: true` from `updateCandles` callback in `TradingChart.tsx`
- [x] Remove `autoScale: true` from `updateChart` callback in `DCAChart.tsx`
- [x] Add dedicated `useEffect([fitAll])` for autoScale reset in `TradingChart.tsx`
- [x] Add dedicated `useEffect([fitAll])` for autoScale reset in `DCAChart.tsx`

## Review

**Changes made:**
- `src/components/charts/TradingChart.tsx`: Removed `priceScale('right').applyOptions({ autoScale: true })` from the `updateCandles` callback (fired every tick), added a new `useEffect` that only fires when `fitAll` toggles.
- `src/components/simulation/DCAChart.tsx`: Same pattern — removed autoScale from `updateChart` callback, added dedicated `useEffect([fitAll])`.

**Root cause:** The previous fix applied `autoScale: true` inside the data update callbacks, which fire on every playback tick. This caused:
1. Grid zones disappearing on TradingChart because `priceToCoordinate()` returned `null` during constant scale reconfiguration
2. Race conditions between `setData()` + `fitContent()`/`setVisibleLogicalRange()` and the autoScale reset

**Fix:** Move autoScale reset to a dedicated `useEffect` that only depends on `[fitAll]`, so it fires only when the user toggles between Fit All and Follow modes.

**Impact:** Minimal — removed 1 line and added 5 lines per file. No other logic changed.
