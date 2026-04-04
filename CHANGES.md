# Gridbot Trader — Multi-Strategy Expansion: All Changes

## Overview

Expanded the existing grid bot simulator into a multi-strategy backtesting platform with Binance 5m data, a DCA breakout strategy (3Commas-compatible), and a parameter optimizer with walk-forward validation. Implementation followed 6 phases executed across parallel agent workstreams.

---

## Phase 1 — Binance Data Layer

Replaced GeckoTerminal with Binance `/api/v3/klines` for 5m candle data. Cached in SQLite with batch inserts. Aggregates higher timeframes in code.

### Files Created
- **`src/lib/data/binanceApi.ts`** — Binance klines fetcher with forward pagination, rate limiting (2.5s delay), converts ms→s timestamps. Fetches up to 1000 candles/request, auto-paginates for large ranges.
- **`src/lib/data/aggregator.ts`** — `aggregate5mTo()` groups N 5m candles into higher timeframes (15m, 1H, 4H). Proper OHLCV: open of first, close of last, max high, min low, sum volume. Drops incomplete trailing groups.
- **`src/components/DataManager.tsx`** — Pair selector, date range picker, download button with progress, cache status display.

### Files Modified
- **`src/lib/data/candleCache.ts`** — Rewired for `BinanceCandle` model (BigInt `openTime` in ms). Batch `INSERT OR IGNORE` in chunks of 500 rows via raw SQL (Prisma `createMany` with `skipDuplicates` not supported on SQLite). Removed poolAddress/chain params.
- **`src/lib/constants.ts`** — Added `BINANCE_API` config (baseUrl, requestDelay, candlesPerRequest). Added `binanceSymbol` to `SUPPORTED_PAIRS`. Added 5m/15m to `TIMEFRAMES`.
- **`src/app/api/candles/route.ts`** — Updated POST/GET to use Binance-based signatures (pair + timeframe, no poolAddress).
- **`src/lib/types.ts`** — Added `binanceSymbol?: string` to `PairConfig` interface.

### Files Deleted
- **`src/lib/data/geckoterminal.ts`** — GeckoTerminal API client (replaced by Binance)
- **`src/lib/data/pools.ts`** — GeckoTerminal pool address lookup (no longer needed)

### Schema Changes
- Added `BinanceCandle` model (pair + openTime + interval, BigInt timestamps)
- Removed legacy `CandleCache` model

---

## Phase 2 — Indicator Engine

Built BB%B, RSI, MACD indicators with multi-timeframe condition evaluator for DCA entry triggers.

### Files Created
- **`src/lib/indicators/bollingerBandsB.ts`** — `computeBB()` (full series) and `computeBBAtIndex()` (single point). SMA basis, population stddev, returns upper/lower/basis/%B.
- **`src/lib/indicators/rsi.ts`** — `computeRSI()` and `computeRSIAtIndex()`. Wilder's smoothing method (exponential moving average of gains/losses).
- **`src/lib/indicators/macd.ts`** — `computeMACD()` and `computeMACDAtIndex()`. EMA-based MACD line, signal line, histogram. Uses `emaSeries()` from existing technical.ts.
- **`src/lib/indicators/conditionEvaluator.ts`** — `ConditionEvaluator` class with multi-timeframe AND logic. Higher timeframes update at candle boundaries (15m every 3rd, 1H every 12th, 4H every 48th). Supports CROSSING_UP, CROSSING_DOWN, LESS_THAN, GREATER_THAN operators.
- **`src/lib/indicators/indicatorTypes.ts`** — Type definitions for BB, RSI, MACD parameters and results. ConditionState tracking, EvaluationResult.
- **`src/__tests__/indicators.test.ts`** — 19 tests covering all three indicators + condition evaluator.
- **`vitest.config.ts`** — Vitest config with `@/` path alias.

---

## Phase 3 — DCA Breakout Strategy

Full DCA breakout strategy with 3Commas-compatible configuration, safety orders, trailing take profit, and stop loss.

### Files Created
- **`src/lib/strategies/dcaTypes.ts`** — `SafetyOrderLevel` and `DCATradeSnapshot` types.
- **`src/lib/strategies/dcaOrderManager.ts`** — Safety order math: `computeSafetyOrderLevels()` (deviation % with step multiplier), `computeAvgEntryPrice()` (volume-weighted), `computeTakeProfitPrice()`, `computeStopLossPrice()`, `checkTrailingTP()`.
- **`src/lib/strategies/entryTriggers.ts`** — `EntryTrigger` interface + `BreakoutTrigger` implementation wrapping `ConditionEvaluator`. Pluggable architecture for future trigger types.
- **`src/lib/strategies/dcaBreakout.ts`** — Full DCA state machine (`DCABreakoutStrategy implements Strategy`). States: IDLE → OPEN → CLOSE → IDLE. Handles base orders, safety order fills, take profit (with trailing), stop loss, close conditions, and profit reinvestment.
- **`src/lib/simulation/dcaEngine.ts`** — `runDCASimulation()` with `runSingleDirection()` for long/short. `combineMetrics()` for dual-direction results. Caps snapshots at ~2000 for performance.
- **`src/__tests__/dcaOrderManager.test.ts`** — 20 tests for safety order math, avg price, TP/SL levels, trailing TP.

### Files Modified
- **`src/app/api/simulations/route.ts`** — Extended POST handler with `strategyType: 'dca'` routing that runs DCA simulation synchronously and returns results.

### Strategy Architecture
```
Entry Triggers (pluggable):           Trade Management:
  - Breakout (BB%B + RSI + MACD)  →   DCA system (base order → safety orders
  - (future: mean reversion, etc.)      → avg down → TP/SL → close)
```

---

## Phase 4 — Grid Engine 5m Upgrade + Fee Fix

Fixed the P&L fee accounting bug, added intra-candle price path for 5m accuracy, and switched to Binance data with aggregation.

### Files Modified
- **`src/lib/simulation/pnlTracker.ts`** — **Fee bug fix** at line 80:
  - Before: `const entryQty = openPos.size / openPos.entryPrice`
  - After: `const entryQty = (openPos.size - openPos.entryFees) / openPos.entryPrice`
  - Fees are now properly deducted from the invested amount before calculating quantity.

- **`src/lib/simulation/orderMatcher.ts`** — Added `getIntraCandlePath()`:
  - Bullish candles (close > open): open → low → high → close
  - Bearish candles: open → high → low → close
  - `isBuyFilled()` and `isSellFilled()` check if price crosses limit levels along path segments
  - Max 1 fill per grid level per candle via `filledLevels` Set

- **`src/lib/simulation/engine.ts`** — Added `getBinanceSymbol()` helper mapping poolAddress → Binance symbol. Always fetches 5m candles from Binance, aggregates to simulation timeframe via `aggregate5mTo()`. 4H adaptive candles generated from 5m data instead of separate API call.

---

## Phase 5 — UI: Scrollable 2x2 Chart Layout

Refactored into a multi-strategy layout with Grid Bot charts (top row) and DCA Breakout charts (bottom row), synchronized playback, and strategy toggles.

### Files Created
- **`src/components/simulation/DCAChart.tsx`** — TradingView lightweight-charts with Bollinger Bands overlay, entry/close markers (green ▲ for entries, red/orange for closes), TP/SL price lines, trade state display badge.
- **`src/components/simulation/DCAConfig.tsx`** — DCA config panel with collapsible sections matching 3Commas structure: base order, safety orders, take profit (with trailing toggle), stop loss, and indicator conditions.
- **`src/components/simulation/DCAPnL.tsx`** — DCA-specific P&L display with state badge, current trade details, realized/unrealized P&L breakdown, safety orders filled count.

### Files Modified
- **`src/app/page.tsx`** — Major refactor (~800 lines):
  - Added strategy toggles (Grid Long/Short, DCA Long/Short)
  - DCA config state management (long + short configs)
  - DCA simulation handling alongside grid simulation
  - 2x2 chart grid: Grid Bot top row, DCA Breakout bottom row
  - Sidebar with DataManager, DCA config panels
  - Combined P&L with DCA data
  - Optimizer tab in results section
- **`src/components/simulation/CombinedPnL.tsx`** — Added optional `dcaLongPnl`, `dcaShortPnl`, `dcaLongTrades`, `dcaShortTrades` props. Backward compatible with grid-only mode.
- **`src/components/simulation/PlaybackControls.tsx`** — Added `sticky top-0 z-10` positioning with `backdropFilter: blur(12px)` for scroll-through effect.

### Layout
```
┌──────────────────────────────────────────────────────────┐
│  [Playback Controls — STICKY]                            │
├──────────────────────────┬───────────────────────────────┤
│   GRID BOT — LONG        │   GRID BOT — SHORT            │
├──────────────────────────┼───────────────────────────────┤
│   DCA BREAKOUT — LONG     │   DCA BREAKOUT — SHORT        │
├──────────────────────────┴───────────────────────────────┤
│  Combined P&L + DCA P&L Panels                           │
├──────────────────────────────────────────────────────────┤
│  [Performance]  [Trade Log]  [Optimizer]  ← tabs         │
└──────────────────────────────────────────────────────────┘
```

---

## Phase 6 — Optimizer (Random Search + Walk-Forward)

Parameter optimizer with random search, walk-forward validation, and a full UI for configuring and viewing results.

### Files Created
- **`src/lib/optimizer/fitnessFunction.ts`** — `evaluateFitness()` with Sharpe ratio scoring + hard constraint checking (min trades, max drawdown %, min profit factor). Returns score + constraint pass/fail.
- **`src/lib/optimizer/randomSearch.ts`** — `generateRandomParams()` within defined ranges. `generateSearchSpace()` with continuous/discrete/choice parameter types. `DCA_PARAM_RANGES` covering 9 key DCA parameters (base order size, deviation, multipliers, SO count, TP%, trailing, SL%).
- **`src/lib/optimizer/walkForward.ts`** — `computeWindows()` creates sliding IS/OOS windows. `runWalkForward()` runs optimization on in-sample, validates on out-of-sample. A config passes only if it performs in ALL out-of-sample windows.
- **`src/app/api/simulate/route.ts`** — Headless DCA simulation endpoint. Takes config + candle data, returns metrics synchronously. No database writes — designed for high-throughput optimizer use.
- **`src/components/OptimizerTab.tsx`** — Full optimizer UI: direction selector, search settings (iterations, walk-forward windows), constraint sliders, parameter range editors, results table sorted by fitness, progress indicator.
- **`src/__tests__/optimizer.test.ts`** — 19 tests covering fitness function, random search, walk-forward window computation.

---

## Session 0 — Shared Foundation (created before parallel work)

### Files Created
- **`src/lib/indicators/indicatorTypes.ts`** — Shared indicator parameter/result types
- **`src/lib/strategies/strategyInterface.ts`** — Common `Strategy` interface (initialize, onCandle, getMetrics, getSnapshots, getTrades)

### Files Modified
- **`src/lib/types.ts`** — Added all new types:
  - `StrategyType`, `Direction`, `DCATradeState`, `StopLossAction`, `CloseReason`
  - `DCABreakoutConfig` (3Commas-compatible config shape)
  - `DCATradeRecord`, `DCATradeState_Live`
  - `IndicatorType`, `ConditionOperator`, `IndicatorCondition`
  - `StrategyMetrics`, `DCASimulationConfig`
  - Removed deprecated `GeckoTerminalOHLCResponse`
- **`prisma/schema.prisma`** — Added `BinanceCandle` + `DCATradeLog` models, removed `CandleCache`
- **`CLAUDE.md`** — Updated with new project structure documentation

---

## Final Integration & Cleanup

- Wired `OptimizerTab` into page.tsx tab navigation (Performance | Trade Log | Optimizer)
- Removed `GECKO_API` constant from `constants.ts`
- Removed legacy `CandleCache` model from Prisma schema
- Deleted `src/lib/data/geckoterminal.ts` and `src/lib/data/pools.ts`
- Updated stale comments referencing GeckoTerminal
- Applied schema migration with `prisma db push`

---

## Test Results

- **58 tests passing** across 3 test files:
  - `indicators.test.ts` — 19 tests (BB%B, RSI, MACD, condition evaluator)
  - `dcaOrderManager.test.ts` — 20 tests (safety orders, avg price, TP/SL, trailing)
  - `optimizer.test.ts` — 19 tests (fitness function, random search, walk-forward)
- **Full `npm run build` passes** with no type errors
- **No remaining references** to deleted GeckoTerminal code

---

## File Summary

| Action   | Count | Files |
|----------|-------|-------|
| Created  | 21    | binanceApi, aggregator, DataManager, bollingerBandsB, rsi, macd, conditionEvaluator, indicatorTypes, dcaTypes, dcaOrderManager, entryTriggers, dcaBreakout, dcaEngine, strategyInterface, DCAChart, DCAConfig, DCAPnL, fitnessFunction, randomSearch, walkForward, OptimizerTab, simulate route, 3 test files, vitest.config |
| Modified | 13    | types.ts, constants.ts, candleCache.ts, candles route, simulations route, pnlTracker.ts, orderMatcher.ts, engine.ts, page.tsx, CombinedPnL, PlaybackControls, schema.prisma, CLAUDE.md |
| Deleted  | 2     | geckoterminal.ts, pools.ts |
