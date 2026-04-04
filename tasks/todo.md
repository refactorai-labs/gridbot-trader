# Grid Trade Bubble Markers

## Tasks
- [x] 1. Add `fills` field to `GridZoneConfig` interface
- [x] 2. Store `chart` ref in `GridZonePrimitive` via `attached()`, pass to pane view & renderer
- [x] 3. Implement `draw(target)` in `GridZoneRenderer` to render hollow circle bubbles at fill coordinates
- [x] 4. Update the primitive update effect to include fills (filtered by `currentCandleIdx`)
- [x] 5. Remove `setMarkers()` effect and unused `SeriesMarker` import
- [x] 6. Build and verify — passes clean

## Review

### Changes Made

**`src/components/charts/TradingChart.tsx`** — Single file, minimal changes:

1. **Imports**: Replaced `SeriesMarker` with `IChartApiBase` (needed for `timeScale()` coordinate conversion)
2. **`GridZoneConfig`**: Added `fills` array field for trade bubble data
3. **`GridZoneRenderer`**: Added `_chart` field; implemented `draw(target)` method that renders hollow circle bubbles at exact (time, price) coordinates using:
   - `timeScale().timeToCoordinate()` for X, `priceToCoordinate()` for Y
   - HiDPI-aware bitmap coordinate scaling (`horizontalPixelRatio` / `verticalPixelRatio`)
   - Three-layer rendering: outer glow (12% opacity), interior fill (18% opacity), crisp ring stroke
   - Green for buys, red for sells (uses existing `buyMarker`/`sellMarker` colors)
4. **`GridZonePaneView`**: Accepts and passes `chart` ref to renderer
5. **`GridZonePrimitive`**: Stores `param.chart` in `attached()`, passes to pane view
6. **Primitive update effect**: Now builds a `visibleFills` array from `fills` prop (filtered by `currentCandleIdx`) and includes it in `updateConfig()`
7. **Removed**: Entire `setMarkers()` useEffect block and `SeriesMarker` import

### What's Better
- **Exact positioning** — bubbles render at the exact (time, price) of each fill, not above/below bars
- **Foreground rendering** — `draw()` renders ON TOP of candles (unlike `drawBackground()`)
- **Visual clarity** — hollow rings with subtle glow are less intrusive than arrow markers
- **Playback-aware** — bubbles appear/disappear correctly during playback scrubbing
- **HiDPI correct** — proper pixel ratio scaling for Retina displays
