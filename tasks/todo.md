# Fix: No DCA Trades After CROSSING_DOWN Default Change

## Tasks

- [x] Step 1: Fix default operator in page.tsx — make direction-dependent (LONG→CROSSING_DOWN, SHORT→CROSSING_UP)
- [x] Step 2: Fix MACD param keys in DCAConfig.tsx — change `fast`/`slow`/`signal` to `fastLength`/`slowLength`/`signalLength`
- [x] Step 3: Make handleIndicatorChange reset operator based on direction
- [x] Step 4: Build verification — npm run build passes

## Review

**3 bugs fixed across 2 files:**

1. **`src/app/page.tsx`** (line 32)
   - Default operator is now direction-dependent: `CROSSING_DOWN` for LONG, `CROSSING_UP` for SHORT
   - Previously hardcoded `CROSSING_DOWN` for both → SHORT never triggered (BB%B rarely reaches 0.8 to cross down from it)

2. **`src/components/simulation/DCAConfig.tsx`** — MACD param keys
   - Changed `fast`→`fastLength`, `slow`→`slowLength`, `signal`→`signalLength` in `INDICATOR_PARAMS`
   - Now matches backend expectations in `conditionEvaluator.ts` (lines 39, 46, 53)
   - Previously, custom MACD params were silently ignored (always fell back to 12/26/9)

3. **`src/components/simulation/DCAConfig.tsx`** — handleIndicatorChange
   - Now resets operator to direction-aware default when switching indicators
   - Prevents stale operator from previous indicator carrying over
