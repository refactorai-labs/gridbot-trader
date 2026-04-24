# BB Breakout Strategy — Optimizer Integration

## Tasks
- [x] 1. Add indicator param ranges (`bbPeriod`, `bbDeviation`, `rsiLength`) to `DCA_PARAM_RANGES` in `randomSearch.ts`
- [x] 2. Add Strategy Conditions UI to `OptimizerTab.tsx` — import `ConditionEditor`, add entry/exit state, wire into `buildDCAConfig()`
- [x] 3. Add indicator verification tests to `indicators.test.ts` — BB population stddev, RSI Wilder smoothing, BB%B breakout conditions
- [x] 4. Run `npm test` to verify all tests pass (70/70)

## Review

**3 files modified, 0 new files:**

1. **`src/lib/optimizer/randomSearch.ts`** — Added 3 param ranges to `DCA_PARAM_RANGES`: `bbPeriod` (discrete 20–100, step 5), `bbDeviation` (continuous 0.5–3.0), `rsiLength` (discrete 7–28, step 1).

2. **`src/components/OptimizerTab.tsx`** — Imported `ConditionEditor` from DCAConfig. Added `entryCondition`, `exitEnabled`, `exitCondition` state with direction-aware defaults. Added `useEffect` to reset operator/signalValue on direction change. Added "Strategy Conditions" card with entry ConditionEditor and optional exit ConditionEditor. Updated `buildDCAConfig()` to clone conditions, override BB period/deviation and RSI length from optimizer params, and pass into `startConditions`/`closeConditions`.

3. **`src/__tests__/indicators.test.ts`** — Added 3 new `describe` blocks (5 tests total):
   - BB population stddev: verifies `÷ n` (not `÷ n-1`) using [2,4,4,4,5,5,7,9] where pop=2.0 vs sample≈2.138
   - RSI Wilder smoothing: verifies exact formula at warmup boundary + memory retention after price shock
   - BB%B breakout conditions: verifies `>1.0` above upper band, `<0.0` below lower band, `≈0.5` at middle band
