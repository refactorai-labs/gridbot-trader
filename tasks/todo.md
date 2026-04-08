# Bug Fixes — 4 Confirmed Bugs from Codebase Review

## Tasks

- [x] Bug 1 (HIGH): Fix unrealized P&L to include complementary positions (pnlTracker.ts + engine.ts)
- [x] Bug 2 (MEDIUM): Wrap JSON.parse in try-catch in AdaptiveStatus.tsx
- [x] Bug 3 (LOW): Add error message on failed DCA candle fetch in page.tsx
- [x] Bug 4 (LOW): Validate numeric fields before SQL interpolation in candleCache.ts
- [x] Build verification — npm run build passes

## Review

**4 bugs fixed across 5 files:**

1. **`src/lib/simulation/pnlTracker.ts`** — `calculateUnrealizedPnl()` now handles complementary positions (`long+sell`, `short+buy`) that were silently skipped. Added 2 `else` branches.

2. **`src/lib/simulation/engine.ts`** — `calculateFinalUnrealized()` same fix — added `long+sell` and `short+buy` branches so final equity calculation is complete.

3. **`src/components/simulation/AdaptiveStatus.tsx`** — Wrapped `JSON.parse(event.detailsJson)` in try-catch. Malformed JSON now returns `null` (skipped) instead of crashing the component tree.

4. **`src/app/page.tsx`** — Added `else` branch after `if (candleGetRes.ok)` to call `setStatusMessage('Failed to load DCA candles')` on fetch failure.

5. **`src/lib/data/candleCache.ts`** — Added `isFinite()` filter on OHLCV values before SQL interpolation. Skips candles with NaN/Infinity. Also added `if (!values) continue` guard for empty batches.
