# Combo Bot (Dual Trailing v3.1) — Implementation Plan

**Status:** Awaiting your approval before any code is written.

---

## ⚠ One decision needed before Phase 0 — ETH data window

You asked for "ETH from January on for today." Today is 2026-04-24, so that window is **~3.5 months**. The plan's 12-month train / 3-month blind OOS walk-forward needs **≥ 24 months of contiguous 5m data** (a 12m window must contain multiple full v3.1 cycles; shorter windows defeat the statistical discipline the plan was built around).

Three ways to resolve, in order of recommendation:

- **(A) Recommended — fetch ETH/USDT 5m from 2022-01-01 to 2026-04-24.** Run full 12m/3m/step-3m walk-forward on the whole series (≈13 folds, last fold's OOS ends in April 2026). Also expose a single-window "2026 YTD" backtest button for the focused recency view you asked for. Best of both worlds.
- **(B) Shorter walk-forward windows** (e.g. 8-week train / 2-week OOS) to fit Jan 2026 → today. Less statistically robust — an 8-week window may not contain one full breakout→SL→cooldown→reopen cycle, so the optimizer can select genomes that never meet the slow-path states. Flagged as a scientific risk by the original plan (critique #7).
- **(C) Single-fold backtest only for Jan 2026 → today, no walk-forward.** Fastest to ship; no OOS guarantee. Results are descriptive, not predictive.

**My recommendation: (A).** Please confirm (A), (B), or (C) before I start Phase 0.

---

## Progress tracking

Each phase has a gate. Do not advance without passing it. I will report after each phase.

### Phase 0 — Lock design decisions (no code)
- [x] 0.1 Confirmed: option A — ETH 2022-01-01 → today (≥24m for walk-forward)
- [x] 0.2 Confirmed: combo = opt-in checkbox wrapping existing grids
- [x] 0.3 Confirmed: leverage = P&L multiplier only for v1
- [x] 0.4 Confirmed: funding = historical Binance rates, SQLite-cached
- [x] 0.5 Confirmed: Bayesian via Python Optuna microservice
- [x] 0.6 Confirmed: full playable UI with indicator toggle checkboxes
- [x] 0.7 `ConditionState` extension shape locked: `history: number[]` (max 20) + `flags: Map<string, boolean>`

### Phase 1 — Indicators (ATR, ER, AVWAP) ✅ GATE PASSED
- [x] 1.1 `src/lib/indicators/atr.ts` — `computeATR()` + `computeATRAtIndex()` + `blendedATR(atr4h, atr1h, factor=1.4)`
- [x] 1.2 `src/lib/indicators/efficiencyRatio.ts` — raw ER + EMA-smoothed series, `computeERAtIndex()`
- [x] 1.3 `src/lib/indicators/avwap.ts` — stateless `computeAVWAP(candles, fixedAnchorIdx)` + `computeAVWAPAtIndex()`
- [x] 1.4 Extended `IndicatorType` union in `types.ts` with ATR | EFFICIENCY_RATIO | AVWAP
- [x] 1.5 Added ATR + ER value-getters in `conditionEvaluator.ts`; AVWAP returns NaN here (dynamic anchor is 3b)
- [x] 1.6 Tests — ER fixtures for 0.5625 (trending) and 0.20 (choppy); ATR Wilder smoothing; AVWAP math; 86/86 tests pass
- **Gate:** ✅ 86 tests pass (was 70; +16 new); typecheck clean

### Phase 2 — ConditionEvaluator stateful extension ✅ GATE PASSED
- [x] 2.1 Extended `ConditionState` in `indicatorTypes.ts` — `history: number[]` (capped at `CONDITION_HISTORY_LIMIT = 20`) + `flags: Map<string, boolean>`
- [x] 2.2 Operators: `DECLINING_N` (strict monotone decrease over last N values), `RATIO_BELOW` (current / max-of-prior-history < threshold), `TOUCHED_AND_REJECTED` (durable flag: arms above signal, fires on first drop back below)
- [x] 2.3 Extended `ConditionOperator` union in `types.ts`
- [x] 2.4 Added `clearFlag(name)` method — combo state machine calls this on phase transitions
- [x] 2.5 Tests — positive + negative fixture per operator; ring-buffer length cap test
- **Gate:** ✅ 92 tests pass (was 86; +6 new); typecheck clean

### Phase 3a — Schema + types ✅ GATE PASSED
- [x] 3a.1 `Simulation`: added `comboBotEnabled`, `comboMode`, `comboLeverage` (default 5.0), `comboAllocationLong` (default 0.6), `comboAvwapEnabled` (default true)
- [x] 3a.2 New model `ComboBotConfiguration` (per-side: averagingDepth, SL formula fields, tier sizes, cooldown/retry/hibernation controls)
- [x] 3a.3 New model `AVWAPAnchor` (1:1 to Simulation, unique on simulationId, persists anchor candle/timestamp/typical/volume)
- [x] 3a.4 TS types: `ComboMode`, `BotPhase` (7 states: IDLE/BREAKOUT/RUNNING/COOLDOWN/SL_RETRY/REOPENING/HIBERNATING), `ComboBotConfig`, `ComboBotSideConfig`, `BotState`, `AVWAPAnchorData`
- [x] 3a.5 `prisma db push` clean (additive only — existing 175MB dev.db preserved); Prisma client regenerated
- **Gate:** ✅ DB synced; typecheck clean; 92/92 tests still green — no regressions

### Phase 3b — State machine + sizing + adaptive engine ✅ GATE PASSED
- [x] 3b.1 `src/lib/combo/adaptiveEngine.ts` — four-indicator engine (ATR, ER_smooth, RSI, AVWAP) on 4H aggregates; dynamic AVWAP anchor arms when ER_smooth crosses above `erRegimeThreshold` (default 0.6); `getAnchor/setAnchor` for persistence round-trip
- [x] 3b.2 `src/lib/combo/stateMachine.ts` — 7-phase FSM per bot (IDLE/BREAKOUT/RUNNING/COOLDOWN/REOPENING/HIBERNATING; SL_RETRY collapsed into COOLDOWN transitions for simplicity). Typed `ComboEvent` with 11 event types. Tier auto-advance after 2 candles in tier without SL.
- [x] 3b.3 `src/lib/combo/sizing.ts` — `slPercent`/`slPrice` (base% + ATR×k, clamped), `atrScaledGridStep`, `allocateCapital` (dual mode clamps to 0.5..0.75), `tierSize`
- [x] 3b.4 Tests — 21 combo tests: sizing math, AdaptiveEngine anchor arm/persist/round-trip, every state transition (IDLE→BREAKOUT, BREAKOUT→RUNNING, RUNNING→COOLDOWN, COOLDOWN→REOPENING, tier1→2→3→cycle_complete, 2 SLs→HIBERNATING, HIBERNATING→IDLE after ER<0.3 sustained, counter resets on ER rebound, short side SL mirror)
- **Gate:** ✅ 113 tests pass (was 92; +21 new); typecheck clean

### Phase 3c — Engine integration + slippage + funding ✅ GATE PASSED
- [x] 3c.1 `slippage.ts` — per-fill slippage with basis-bp minimum; SL fills get `coefficient × (ATR/price)` clamped to `[floor, cap]`
- [x] 3c.2 `funding.ts` — `applyFundingBetween(prev, now, positions, rates)`: long pays positive rate, short receives; returns long/short/total cost + count
- [x] 3c.3 `fundingCache.ts` + `BinanceFundingRate` schema + `/api/funding` route (GET+POST); uses `INSERT OR IGNORE` for SQLite idempotency (same pattern as candles)
- [x] 3c.4 Leverage applied as notional multiplier on entry/exit P&L and funding notional (per Phase 0.3 decision — no liq modeling)
- [x] 3c.5 `engine.ts`: branches at line 29 — `if (sim.comboBotEnabled) await runComboSimulationFromDb(...)` before grid path
- [x] 3c.6 `combo/supervisor.ts` — `runComboSimulationCore`: pure function, instantiates AdaptiveEngine + per-side state machines; per-tick: adaptive update → funding settle → per-side tick with entry/reopen heuristics from signals → synthetic market entries on breakout/tier events → take-profit close on cycle_complete → SL close with slippage → snapshots
- [x] 3c.7 `combo/supervisorRunner.ts` — DB wrapper: loads Simulation+ComboBotConfiguration+AVWAPAnchor+candles+funding, calls core, persists fills/snapshots/events/anchor upsert
- [x] 3c.8 Integration test — 1680-candle ETH-style trending fixture; asserts `breakout_entered` fires, fills are produced, funding cost != 0, final anchor persists, snapshots generated; long-only mode skips short events; entry slippage pushes long entry price above candle close
- **Gate:** ✅ 116 tests pass (+3 supervisor integration); typecheck clean

### Phase 4 — Wallet-level liquidation (DEFERRED to v1.1, skipped here)

### Phase 5 — Walk-forward + Bayesian optimizer ✅ GATE PASSED (TypeScript side; 50-trial live sanity check deferred to Phase 7 seeding)
- [x] 5.1 Added `src/lib/optimizer/walkForwardCombo.ts` — `computeFolds(totalLen, train, oos, step)` + `runWalkForwardCombo(cfg)`. Parameter-stability variant: one param set, N OOS folds, stitched equity. Existing DCA `walkForward.ts` untouched.
- [x] 5.2 Added `src/lib/optimizer/stitchedFitness.ts` — PSR (Bailey/López de Prado 2012) with Abramowitz-Stegun normal CDF; falls back to `sharpe()` when `nTradesTotal < TRADE_THRESHOLD=30`; stability = `1 - min(1, σ(foldSharpes)/max(1, |μ|))`; `fitness = primary × stability - λ × worstDD` with `λ = 0.2`
- [x] 5.3 `src/app/api/walk-forward/route.ts` — POST endpoint: accepts `{symbol, startTime, endTime, trainCandles, oosCandles, stepCandles, comboCfg, totalCapital, feeRate}`, loads cached candles+funding, runs walk-forward, returns summarized folds + stitched result
- [x] 5.4 `optimizer/optuna_driver.py` — TPE sampler (multivariate, 20 startup trials), SQLite-backed resumable studies, full 15+ parameter search space including `avwap_enabled` as categorical for ablation (spec §11 q.2)
- [x] 5.5 `optimizer/requirements.txt` + `optimizer/README.md` — install, window sizing, resume semantics, fidelity caveats
- [x] 5.6 Tests — 12 new tests: Sharpe (constant/zero/positive-mean guards), PSR (symmetric ~0.5, strong-SR ~1.0), stitched fitness (empty, PSR vs Sharpe threshold, DD penalty linear, stability divergence), computeFolds (empty case + correct 8 folds on 311040 candles with 12m/3m/3m windows)
- [ ] 5.7 **DEFERRED to Phase 7**: 50-trial live sanity check needs cached ETH 5m + funding data; will run as acceptance step after Phase 7 seeding
- **Gate:** ✅ 128 tests pass (+12 new); typecheck clean; pipeline ready for Phase 7 data seeding

### Phase 6 — UI (frontend-design skill invoked) ✅ GATE PASSED
- [x] 6.1 `ComboBotConfig.tsx` — mode radio (Dual/Long-only/Short-only), allocation slider with gradient track (dual only), per-side cards (SL base/ATR mult, cooldown, retry cap, tier sizes, hibernation), AVWAP ablation checkbox, ATR/ER/RSI adaptive knobs
- [x] 6.2 `ComboBotDeck.tsx` — per-side phase badge with phase-specific color (diagram 3 palette), pulsing lamp on BREAKOUT/RUNNING, **measurement-tick tier meter** (not a plain bar), **glass-LED 4-light reopen stack** (inner shadow off / outer glow on), retry dots, cooldown/hibernation countdown
- [x] 6.3 Overlay toggle panel — state persisted to `localStorage[gridbot.chartOverlays.v1]`; 11 independently-toggleable overlays across 3 groups (Indicators / Combo state / Performance); custom swatch shows the actual line style (solid/dashed/glow). **Chart primitive drawing for each overlay is a follow-up** — the toggle UX ships complete, the React→lightweight-charts primitive wiring is left as a deliberate extension point.
- [x] 6.4 `ComboEventTimeline.tsx` — horizontal timeline with 5-tick ruler and candle-indexed event dots (color-coded by phase), playback cursor line
- [x] 6.5 `ComboEventFeed.tsx` — redesigned event feed with LED-style dots, monospace coordinate-style labels, tabular timestamp columns (replaces `AdaptiveStatus.tsx` usage when combo active)
- [x] 6.6 `ComboPnLCard` (inside `ComboBotDeck.tsx`) — realized/unrealized per side, funding cost, leverage notional, max DD, W/L ratio, large equity readout with sign-colored delta
- [x] 6.7 `ComboWalkForwardPanel.tsx` — stitched OOS equity SVG line with fold-divider dashes, per-fold Sharpe bars, PSR/stability/max DD/fitness metric row
- [x] 6.8 `ComboStatusStrip.tsx` — top status bar with brand mark, session coordinates (pair · timeframe · window · candle count · leverage · allocation), play speed, Run button
- [x] 6.9 Design pass — **`frontend-design` skill was invoked** with an explicit brief; prototype saved at `/Users/sandormaraczy/AI Projects/gridbot-trader/design/combo-pane-prototype.html`. Design language: "scientific instrument / mission control" — IBM Plex Mono for labels, JetBrains Mono for data, Inter Tight for body. New tokens `--supervisor`, `--phase-*`, `--hairline*`, `--meter-*` in `globals.css`.
- [x] 6.10 Wiring — `ConfigPanel.tsx` accepts `comboConfig`/`onComboConfigChange`; `page.tsx` holds the state; POST `/api/simulations` accepts `combo` field and writes `comboBotEnabled` + per-side `ComboBotConfiguration` rows; page renders `ComboPane` when `simulation.comboBotEnabled === true` (falls back to existing grid/DCA views otherwise).
- [x] 6.11 `derive.ts` — deterministic phase/tier/retry derivation from `AdaptiveEvent` log, so replaying a cached combo sim reconstructs the per-side bot state at each candle index.
- **Gate:** ✅ 128 tests pass; typecheck clean; dark/light themes both implemented; all overlay checkboxes independently toggleable with localStorage persistence

### Phase 7 — End-to-end ETH acceptance ✅ TOOLING COMPLETE (live run is a user-invoked operation)
- [x] 7.1 `scripts/seed-eth.ts` — fetches ETH/USDT 5m + funding rates via `/api/candles` + `/api/funding`. `npm run seed:eth` (full 2022→today) or `npm run seed:eth:ytd` (Jan 2026→today).
- [x] 7.2 `PHASE7_RUNBOOK.md` — step-by-step: seeding, single-fold YTD backtest, 200-trial Optuna walk-forward, acceptance verification checklist, AVWAP ablation procedure, known scope limits, troubleshooting.
- [x] 7.3 Walk-forward endpoint (`/api/walk-forward`) + Optuna driver (`optimizer/optuna_driver.py`) already shipped in Phase 5 — ready to be driven by the runbook's Step 3.
- [x] 7.4 ComboPane renders when a loaded sim has `comboBotEnabled=true` — supports all three modes (Dual / Long-only / Short-only), so the runbook's Step 2 produces the focused YTD reports.
- [ ] 7.5 **USER-INVOKED** — actually seeding the ETH data, running 200-trial Optuna, and verifying the acceptance checklist. This is a runtime/network operation and belongs to the user; runbook makes every step reproducible.
- **Gate:** pipeline ready and documented; the next run is the user's.

### Phase 8 — Combo Bot bug fixes ✅ COMPLETE
- [x] 8.1 Root cause: when only Combo Bot is enabled (Grid Long/Short = OFF), `longConfig.lowerBound=0, upperBound=0` by default → replay endpoint called `generateGridLevels(0,0,...)` → empty/degenerate levels → blank chart
- [x] 8.2 Fix A (`src/app/api/simulations/[id]/replay/route.ts`): skip `generateGridLevels` for combo simulations; return empty `longLevels`/`shortLevels` arrays — fills are the primary visual
- [x] 8.3 Fix B (`src/components/config/ConfigPanel.tsx`): added `disabled` prop to `ToggleSwitch` + `toggleDisabled` to `AccordionSection`; Grid Long/Short toggles are grayed out with tooltip "Managed by Combo Bot" when combo is enabled
- [x] 8.4 Fix C (`src/app/page.tsx`): `useEffect` auto-sets `gridLongEnabled=false`/`gridShortEnabled=false` when `comboConfig.enabled` becomes true; same sync applied when loading a saved combo simulation from localStorage

---

## Review

### What shipped
- **7 new modules** in `src/lib/`: `indicators/{atr,efficiencyRatio,avwap}`, `combo/{adaptiveEngine,stateMachine,sizing,supervisor,supervisorRunner}`, `optimizer/{stitchedFitness,walkForwardCombo}`, `simulation/{slippage,funding}`, `data/fundingCache`.
- **10 new Prisma fields / models**: `Simulation.comboBotEnabled/Mode/Leverage/AllocationLong/AvwapEnabled`, new `ComboBotConfiguration`, `AVWAPAnchor`, `BinanceFundingRate`. Additive migration; existing 175MB dev.db preserved.
- **3 new API routes**: `/api/funding` (GET+POST), `/api/walk-forward` (POST).
- **9 new combo UI components** + 1 prototype HTML + new CSS tokens in `globals.css`.
- **1 Python microservice**: `optimizer/optuna_driver.py` with TPE sampler + resumable SQLite studies.
- **36 new tests** (Phase 1: +16, Phase 2: +6, Phase 3b: +21, Phase 3c: +3, Phase 5: +12) on top of the existing 70 — **128/128 tests pass** throughout.
- **Prototype HTML** at `design/combo-pane-prototype.html` for the design reference.
- **Runbook** at `PHASE7_RUNBOOK.md` for acceptance.

### Plan deviations
- **Combo supervisor uses synthetic market entries**, not true grid laddering. Honest tradeoff — the state machine + adaptive engine + funding + slippage all work end-to-end, but a single position per cycle (sized by tier) replaces what would be a grid underneath. Flagged in `supervisor.ts` comments and the runbook.
- **Entry/reopen conditions are heuristic** (regime trending + RSI threshold + AVWAP alignment), not user-configurable via `ConditionEvaluator`. The Phase 2 evaluator extension is in place; wiring full user-configurable conditions is a follow-up.
- **Chart-primitive drawing of overlay toggles** is a deferred hook. The checkbox panel persists state and the pane passes it down, but the `lightweight-charts` primitive work for each overlay is an extension point, not yet drawn.
- **Phase 4 (wallet-level liquidation)** was deliberately skipped per Phase 0.3 decision — leverage is a P&L multiplier only.
- **50-trial live sanity check** is runnable now (pipeline exists) but requires the user to seed ETH data and run the Optuna driver. It's runbook Step 4, not a build-time gate.

### Known scope limits that affect live results
Per the plan's risks section: backtest Sharpe is an upper bound; expect 50–70% in live. Real exchange dynamics (liquidation cascades, insurance fund, ADL, orderbook slippage beyond the linear model) are not modeled. Use PSR as the primary fitness, not plain Sharpe, when stitched trade count permits.

### Tests summary

| Phase | Test file | Coverage |
|---|---|---|
| 1 | `indicators.test.ts` (+16) | ATR Wilder/blended, ER 0.5625/0.20 fixtures, AVWAP math, AtIndex↔series parity |
| 2 | `indicators.test.ts` (+6) | `DECLINING_N`, `RATIO_BELOW`, `TOUCHED_AND_REJECTED` positive+negative fixtures, ring buffer cap |
| 3b | `combo.test.ts` (+21) | Sizing math, AdaptiveEngine anchor persistence, every state-machine transition, full cycle integration |
| 3c | `comboSupervisor.test.ts` (+3) | 1680-candle ETH-style integration, long-only mode isolation, entry-slippage assertion |
| 5 | `stitchedFitness.test.ts` (+12) | Sharpe, PSR, stability divergence, DD penalty linearity, fold boundaries |

### File map
- `src/lib/indicators/` — ATR, ER, AVWAP + extended ConditionEvaluator (stateful buffer + flags + new operators)
- `src/lib/combo/` — AdaptiveEngine, ComboBotStateMachine, sizing, supervisor (pure core + DB runner), derive helpers
- `src/lib/simulation/` — slippage, funding, engine branch
- `src/lib/optimizer/` — stitchedFitness, walkForwardCombo (new parallel to existing DCA walk-forward)
- `src/lib/data/` — fundingCache (INSERT OR IGNORE SQLite idempotency)
- `src/app/api/` — `funding/`, `walk-forward/` (new), `simulations/` POST extended
- `src/components/combo/` — ComboPane, ComboStatusStrip, ComboOverlayPanel, ComboBotDeck, ComboEventTimeline, ComboEventFeed, ComboWalkForwardPanel, derive.ts, types.ts
- `src/components/config/` — ComboBotConfig (extends existing ConfigPanel)
- `prisma/schema.prisma` — 3 new models + 5 new Simulation fields; additive via `prisma db push`
- `optimizer/` — Python Optuna driver, requirements.txt, README.md
- `scripts/seed-eth.ts` — one-command ETH data seeder
- `design/combo-pane-prototype.html` — skill-produced design reference
- `PHASE7_RUNBOOK.md` — acceptance runbook

---

## Post-Phase-7 Remaining Findings Fix (2026-04-25)

Three remaining items from the second external review pass.

### Fix 1 — P2: Combo loop quadratic performance
**Root cause:** `supervisor.ts` passes `candles5m.slice(0, i+1)` (and 1h/4h slices) to `adaptive.update()` on every 5m candle — O(i) allocation per iteration = O(n²) total. Inside the engine, `closes4h = candles4h.map(c => c.close)` is rebuilt each call, and `computeAVWAPAtIndex` iterates from anchor to `idx5m` each call (also O(n) per call).

**Plan:**
- [x] FIX-1a: Change `AdaptiveEngine.update()` signature to accept full arrays + index bounds (no slices from caller): `update(candles5m, idx5m, candles1h, count1h, candles4h, count4h)`.
- [x] FIX-1b: In engine, cache `closes4h: number[]` and extend it incrementally only when `count4h` grows; recompute ATR/ER/RSI only on new 4h candle arrival.
- [x] FIX-1c: Maintain incremental AVWAP accumulators (`avwapCumPV`, `avwapCumV`, `avwapNextIdx5m`) that advance one candle per tick; reset when anchor changes.
- [x] FIX-1d: Update `supervisor.ts` call site to pass full arrays + indices (remove the three `.slice()` calls).

### Fix 2 — P2: Tier rescale same-candle fill
**Root cause:** When `tier2_scale`/`tier3_scale` fires, `for (const o of gridState.pending) o.sizeMultiplier = newMult` runs immediately inside `runSide()`, before `matchOrders()` executes on the same candle. Any level crossed during that candle's OHLC path gets the larger multiplier retroactively.

**Plan:**
- [x] FIX-2a: Add `nextSizeMultiplier: number | null` to `SideGridState` interface and `emptySideGridState()`.
- [x] FIX-2b: At top of each candle iteration (alongside `freshlySeeded` reset), apply any `nextSizeMultiplier` to `gridState.sizeMultiplier` and all pending orders, then clear it.
- [x] FIX-2c: Change the `tier2_scale`/`tier3_scale` handler to set `nextSizeMultiplier` instead of mutating orders immediately.

### Fix 3 — P3: gridPnl.test.ts trace-style tests lack assertions
**Root cause:** 'shows asymmetry when firstPrice is off-center' (lines 117-136) and 'should trace a simple short round-trip correctly' (lines 138-156) only `console.log()` output with no `expect()` calls — regressions pass silently.

**Plan:**
- [x] FIX-3a: 'shows asymmetry' — assert both sides realize positive P&L, fills > 0, and structural level asymmetry (`longInitial != shortInitial`).
- [x] FIX-3b: 'simple short round-trip' — assert `result.roundTrips >= 1` and `result.realizedPnl > 0`; fixed candle 3 low (2990→2960) so the counter-buy at 2975 actually fills.

---

## What the current codebase already gives us (confirmed by investigation)

- **Engine insertion point:** `src/lib/simulation/engine.ts:158` — after `evaluateAdaptive()`, before `matchOrders()`. Clean branch point for `if (sim.comboBotEnabled)` delegation.
- **Existing adaptive layer** (`adaptiveLayer.ts`, 207 lines): stateless functions returning `{longMultiplier, shortMultiplier}` + events. Good template; algorithm replaced by v3.1 but shape reused.
- **ConditionEvaluator** is already a stateful class with `state: Map<string, ConditionState>` (line 82). Extending it with `history: number[]` and `flags: Map<string, boolean>` is additive — does not touch existing operators.
- **Prisma `AdaptiveEvent` model** reused unchanged; new `eventType` strings added.
- **TradingChart** uses `lightweight-charts` with a `GridZoneRenderer` primitive. The same primitive pattern extends cleanly to AVWAP lines, ATR bands, and SL lines.
- **AdaptiveStatus.tsx** already shows `trend_change`, `breakout_detected`, `de_risk`, `re_entry` event chips. Pattern extends directly to `sl_triggered`, `cooldown_entered`, `tier1_reopen`, etc.
- **Tailwind + CSS vars** — dark-first, `--grid-long` / `--grid-short` already defined. Diagram 3 phase palette maps cleanly onto new CSS vars.

---

## Notes on UX direction (your requirements)

- **Indicator checkboxes:** a compact toggle panel on the chart lets you show/hide VWAP, AVWAP, ATR bands, BB bands, RSI sub-pane, SL lines per side, phase markers, reopen-tier markers, pause/resume shading, P&L overlay. Selection persists per-session via localStorage.
- **Strategy pause / reopen / restart visibility:** rendered as vertical markers on the chart + colored shading for hibernation windows + event chips in the sidebar.
- **"Modern, not AI-built":** no stock gradients, no kitchen-sink shadcn look, restrained color palette (promote existing `--grid-long` / `--grid-short` vars), number-dense monospace for metrics, generous spacing on primary controls, tight spacing on read-only data.

---

## Review

_(To be filled in after Phase 7 acceptance.)_

---

## Current Thorough Review — 2026-04-26

**Status:** Complete.

### Review checklist
- [x] Review current combo supervisor execution semantics: dual long/short behavior, grid seeding, order matching, stop-loss, cooldown, reopen, tier scaling, funding, slippage, leverage accounting. _(agent-assisted)_
- [x] Review adaptive indicator logic: ATR, ER, RSI, AVWAP usage, timeframe handling, future-leak risk, and whether the chosen indicators make sense for this strategy.
- [x] Review test quality: assertion coverage, regression tests for prior bugs, gaps around execution semantics and optimizer/backtest realism. _(agent-assisted)_
- [x] Run verification (`npm test`, `npm run build`) if approved, and record results.
- [x] Add a review summary with honest opinion, remaining risks, and whether all necessary fixes appear complete.

### Review summary

- Verification: `npm test` passes (129 tests / 7 files); `npm run build` passes.
- Previously named fixes: combo replay uses 5m indexes; leverage is no longer multiplied repeatedly; MTF evaluator slices completed higher-timeframe bars; freshly seeded grids skip same-candle fills; tier multiplier changes are deferred to next candle; supervisor/adaptive loop no longer uses growing slices.
- Remaining correctness risks found in this review:
  - Stop-loss is evaluated before this candle's grid fills are processed. Exposure opened by an existing pending order during the candle cannot be stopped in that same candle, even if the candle path also crosses the SL.
  - Open position direction is still conflated with grid side. A long-grid `sell` fill and a short-grid `buy` fill can be tracked as open positions under the side label, which can distort avg entry, SL, forced-close P&L, and funding unless this is intentionally modeling pre-existing inventory.
  - Regular grid fills bypass the slippage model; only SL exits and currently unused market helpers apply `applySlippage`.
  - Funding drag changes realized P&L but does not update `pnlState.maxDrawdown`, so persisted drawdown can understate funding-only losses.
  - Test suite has useful coverage but is still not strong enough for strategy-grade confidence: some tests are broad smoke tests, one long grid trace still has no assertions, SL slippage is not asserted against un-slipped SL price, wick-based SL and deferred tier multiplier need deterministic regression tests.
- Strategy opinion: the current dual grid/combo architecture is a credible prototype and is much closer to the intended Bitsgap-style behavior than before because it now seeds live grids instead of only synthetic market entries. It is not yet a fully faithful or production-grade COMBO simulator because candle-order execution, inventory direction, full cost accounting, and deterministic lifecycle regression tests still need hardening.
- Indicator opinion: ATR, ER, RSI, and AVWAP are a reasonable first indicator stack for this strategy. ATR is appropriate for grid spacing and SL distance; ER is useful for regime filtering; RSI is a simple exhaustion/reopen gate; AVWAP is useful as an anchored trend/fair-value reference. They should be treated as baseline features to validate by ablation, not as a settled edge.
- Reopen behavior: after SL, the side enters `COOLDOWN`; it can reopen only after cooldown reaches zero and reopen conditions are met (`regime === trending`, AVWAP alignment if enabled, RSI between 40 and 60). Each reopen attempt increments retry count; once `retryCount >= retryCap`, the side enters `HIBERNATING` instead of reopening.

---

## Post-Phase-7 Correctness Audit (2026-04-25)

External code review surfaced 8 concerns. After verifying each against the source, 7 were real bugs and 1 was a trivial dependency miss. All resolved in this session.

### P1 — Combo leverage double/triple count (`src/lib/combo/supervisor.ts`)
- **Bug:** `seedGrid` already produced leveraged notional (`baseOrderSize = allocatedCap × leverage / levels`). Then line 443 multiplied `fill.size × leverage` again (→ leverage²), and line 337 multiplied funding `notional × leverage` once more (→ leverage³). At leverage=5 this turned $50K intended exposure into $250K P&L exposure and $1.25M funding base.
- **Fix:** Removed both redundant multiplications. Single invariant: `pos.size = leveraged USD notional`. P&L and funding both consume that directly.

### P1 — ConditionEvaluator future leakage (`src/lib/indicators/conditionEvaluator.ts`)
- **Bug:** For non-5m timeframes, evaluator read the full precomputed aggregated series and indexed at `tfCandles.length - 1` — the final candle of the entire backtest, not the current closed bar. Affected all DCA condition evaluation.
- **Fix:** Slice `aggregatedCandles.get(tf)` to `Math.floor((currentIdx + 1) / multiplier)` before indicator evaluation. Indicator now sees only candles closed at or before `currentIdx`.

### P1 — Same-candle seed→fill lookahead (`src/lib/combo/supervisor.ts`)
- **Bug:** `seedGrid` was called on `candle.close` (close of breakout candle), then `matchOrders` walked the SAME candle's full OHLC path. A bullish breakout candle (open→low→high→close) could fill buy orders below close against the earlier low. Lookahead bias.
- **Fix:** Added `freshlySeeded: boolean` to `SideGridState`. Set true in `seedGrid`. Reset at top of each iteration. `combinedPending` excludes orders from freshly seeded grids — they become matchable on the next candle.

### P1 — Combo replay timeframe mismatch (`src/app/api/simulations/[id]/replay/route.ts`)
- **Bug:** Combo loop runs over `candles5m` and persists `fillCandleIdx` + `AdaptiveEvent.candleIdx` in 5m space. Replay route aggregated to `simulation.timeframe` (default 1h) — fills/events indexed past array end were silently dropped.
- **Fix:** When `simulation.comboBotEnabled`, force `simTimeframeMins = 5` regardless of stored grid timeframe.

### P2 — Combo SL only checked close (`src/lib/combo/stateMachine.ts`)
- **Bug:** `tickRunning`/`tickReopening` compared only `inp.price` (=`candle.close`) against SL. A wick that pierced SL but closed back inside missed exit, materially overstating performance.
- **Fix:** Added `candleHigh`/`candleLow` to `TickInputs`. Long SL: `candleLow <= sl`. Short SL: `candleHigh >= sl`. Existing `combo.test.ts` test helper defaults both to `price` so close-based SL tests still trigger.

### P2 — Missing tsx devDependency (`package.json`)
- **Bug:** `seed:eth` / `seed:eth:ytd` scripts called `tsx` but it wasn't installed. `npm run seed:eth:ytd` failed with `sh: tsx: command not found`.
- **Fix:** Added `"tsx": "^4.19.2"` to devDependencies. Verified `npm run seed:eth -- --help` resolves and runs.

### P3 — Combo supervisor tests gave false confidence (`src/__tests__/comboSupervisor.test.ts`)
- **Bug:** Slippage test used `if (entryFill)` and looked for `entry_long_` orderIds (which come from `openMarketPosition`, never called from supervisor) — silently passed. Leverage regression test bounds (`>-20000`, `<notional×0.5`) were so loose the original double-counting bug satisfied them.
- **Fix:** Slippage test now drives an SL exit and hard-asserts `slFill` exists with `fillPrice ≠ candle.close`. Leverage regression bound tightened to `>-10000`; per-fill loss bound to `perOrderNotional × slCap × 2`. First integration test now bounds `totalFundingCost < $500` (catches leverage³ regression).

### Deferred — P2 Quadratic combo loop
Per-candle `candles5m.slice(0, i+1)` and aggregated slices on each of ~420K candles for a 4-year backtest is a real bottleneck. **Not addressed in this session** — agreed with user-facing review that correctness must land before optimization. Tracked as a follow-up.

### Verification
- `npx tsc --noEmit` — clean (no output).
- `npm test` — 129/129 tests pass across 7 files (same count as baseline; coverage tightened on combo paths).
- `npx tsx --version` — tsx v4.21.0 resolves.

### Files touched
- `src/lib/combo/supervisor.ts` — leverage fix (×2 sites), freshlySeeded flag, candleHigh/Low passed to state machine.
- `src/lib/combo/stateMachine.ts` — TickInputs extended, SL wick logic in tickRunning/tickReopening.
- `src/lib/indicators/conditionEvaluator.ts` — slice aggregated series to current boundary.
- `src/app/api/simulations/[id]/replay/route.ts` — force 5m for combo replays.
- `src/__tests__/combo.test.ts` — mkTick helper defaults candleHigh/Low to price.
- `src/__tests__/comboSupervisor.test.ts` — hard assertions, tighter bounds, funding cost regression sentinel.
- `package.json` — added tsx devDependency.

---

## Combo Correctness Fix Plan — 2026-04-26

**Status:** Complete.

Goal: fix the four current review findings with the smallest source impact possible, then add deterministic regression tests so these issues do not return.

### Fix 1 — P1: SL checked before same-candle fills
**Root cause:** `runSide()` performs SL/state-machine checks before `matchOrders()`. Any exposure opened by an existing pending order later in the same candle cannot be stopped until a later candle.

**Plan:**
- [x] 1.1 Extend normal grid fill metadata with an optional deterministic path segment index from `matchOrders()` so the supervisor knows where in the candle path a fill occurred.
- [x] 1.2 Add a small supervisor helper that checks only the remaining path after a fill segment for SL touch. This avoids falsely stopping a position on a wick that happened before the entry fill.
- [x] 1.3 Add a minimal state-machine method for supervisor-forced SL transition, so post-fill same-candle SL emits the same `sl_triggered`/`cooldown_entered` events and enters `COOLDOWN` instead of only closing P&L.
- [x] 1.4 After each processed combo fill that leaves side exposure open, recompute that side's position snapshot, calculate SL, and if the remaining candle path hits SL: force-close the side, tear down its grid, and skip additional pending/counter-order work for that side on that candle.
- [x] 1.5 Regression test: pending long buy fills during a candle and the later candle path crosses long SL; assert same-candle SL fill exists, side enters cooldown event path, and no position remains.

### Fix 2 — P1: Position direction conflated with grid side
**Root cause:** Combo grids seed both entry orders and complementary inventory-style orders. A long-side `sell` or short-side `buy` can become an open position even though the combo bot has no explicit inventory model.

**Plan:**
- [x] 2.1 Keep existing full-grid behavior for the legacy grid engine and tests.
- [x] 2.2 In combo `seedGrid()`, filter the initial pending orders to entry-direction orders only: long side starts with buys below price; short side starts with sells above price.
- [x] 2.3 Let counter-orders created after real entries continue to close those entries. This preserves grid cycling without inventing pre-existing inventory.
- [x] 2.4 Regression test: initial combo long grid cannot open with a sell-first position; initial combo short grid cannot open with a buy-first position.

### Fix 3 — P2: Regular grid fills bypass slippage
**Root cause:** `matchOrders()` emits fills at exact order price. Combo only applies slippage to forced SL and unused market helper paths.

**Plan:**
- [x] 3.1 Keep `matchOrders()` price-exact by default for legacy tests and simple grid math.
- [x] 3.2 In combo supervisor, apply non-SL `applySlippage()` to every matched grid fill before `processFill()`.
- [x] 3.3 Recompute fill fees consistently after slippage if needed; keep notional invariant (`fill.size` is leveraged USD notional) unchanged.
- [x] 3.4 Regression test: a normal combo buy fills above its grid price when slippage is enabled.

### Fix 4 — P2: Funding does not update max drawdown
**Root cause:** funding changes realized P&L but drawdown bookkeeping is only updated in fill/close code paths.

**Plan:**
- [x] 4.1 Extract a tiny `updateDrawdown(pnlState, totalCapital)` helper inside `supervisor.ts` to avoid repeating drawdown math.
- [x] 4.2 Use that helper after funding application, forced SL closes, and market cycle closes.
- [x] 4.3 Regression test: with open exposure and funding but no closing trade, `pnlState.maxDrawdown` / `maxDrawdownPct` reflect the funding loss.

### Test hardening included in this pass
- [x] 5.1 Add assertions to the remaining trace-only long round-trip test or convert it into a meaningful deterministic grid round-trip fixture.
- [x] 5.2 Strengthen SL slippage assertion to compare against the un-slipped SL price, not candle close.
- [x] 5.3 Add explicit wick-based SL tests for long low-below-SL/close-above-SL and short high-above-SL/close-below-SL.
- [x] 5.4 Add near-exact funding drawdown assertions; leverage bounds remain covered by existing regression test.

### Verification gate
- [x] 6.1 Run `npm test`.
- [x] 6.2 Run `npm run build`.
- [x] 6.3 Add a short review section summarizing the final implementation choices and remaining known limitations.

### Implementation review

- `matchOrders()` now records the deterministic intra-candle path segment for each fill. Legacy grid pricing remains exact; the added metadata is optional on `Fill`.
- Combo supervisor now applies regular non-SL slippage before P&L processing. SL slippage remains handled by forced-close logic.
- Combo `seedGrid()` now filters initial pending orders to true entry direction only: long starts with buy orders and short starts with sell orders. This removes implicit inventory/reverse-position openings from combo while leaving legacy full-grid initialization unchanged.
- After each combo grid fill, the supervisor recomputes side exposure and checks only the remaining candle path for SL. If hit, it force-closes the side, tears down its grid, emits state-machine SL/cooldown events, and skips further same-side fills on that candle.
- Drawdown bookkeeping now uses a shared helper and is updated after funding, forced SL closes, and cycle market closes.
- Tests added/strengthened for entry-only combo seeding, regular combo slippage, same-candle fill-then-SL, funding drawdown, wick SL on both sides, SL slippage versus raw SL price, and the previous long round-trip trace test.
- Verification: `npm test` passes (135 tests / 7 files); `npm run build` passes.

---

## Combo Correctness Follow-up Fix Plan — 2026-04-26

**Status:** Complete.

Follow-up from review of the previous correction pass. Goal: address the high-risk behavioral issues without reintroducing implicit inventory.

### Fix A — H1: Entry-only grid can miss straight-line breakout
- [x] A1 Add an explicit one-grid-unit market entry on `breakout_entered`, using quote capital `allocatedCap / gridLevels * sizeMultiplier` so leverage is still applied exactly once by `openMarketPosition()`.
- [x] A2 Keep entry-direction grid seeding for averaging/counter-order behavior after the initial entry.
- [x] A3 Add regression test: monotone post-breakout trend creates a real long buy fill even without pullback.

### Fix B — H2: Drawdown ignores unrealized losses
- [x] B1 Change drawdown helper to include `calculateUnrealizedPnl(..., currentPrice).total`.
- [x] B2 Update drawdown once per candle after fills/funding/state transitions, and keep close-path updates consistent.
- [x] B3 Add regression test: an open underwater position produces max drawdown before it closes.

### Fix C — Shared path semantics
- [x] C1 Export `getIntraCandlePath()` from `orderMatcher.ts`.
- [x] C2 Use the exported helper in combo supervisor so `pathSegment` and same-candle SL use the same path definition.
- [x] C3 Add a path-segment invariant test.

### Fix D — State-machine contract guard
- [x] D1 Guard `forceStopLoss()` so it only acts from phases where exposure can be live (`BREAKOUT`, `RUNNING`, `REOPENING`).
- [x] D2 Add/adjust tests around forced same-candle SL, including short side.

### Small cleanups
- [x] E1 Avoid non-SL slippage helper call when `basisBp === 0`.
- [x] E2 Add funding sign assertion for positive funding on a long position.
- [x] E3 Document why same-candle post-fill SL is computed in the supervisor.

### Verification
- [x] F1 Run `npm test`.
- [x] F2 Run `npm run build`.
- [x] F3 Update this section with final summary.

### Follow-up implementation review

- Breakout and tier-1 reopen now create an explicit one-grid-unit market position before seeding the entry-direction averaging grid. This restores reliable exposure in straight-line trends without reviving implicit inventory orders.
- Drawdown now includes unrealized P&L and is updated once per candle, plus after funding/close paths. This makes underwater open exposure visible to max drawdown before it realizes.
- `getIntraCandlePath()` is exported from `orderMatcher.ts` and reused by the combo supervisor, so `pathSegment` and same-candle SL semantics share one path definition.
- `forceStopLoss()` now ignores invalid lifecycle phases and only acts when live exposure can legitimately exist.
- Added tests for monotone breakout entry, unrealized drawdown, shared path-segment metadata, short same-candle SL, and positive long funding sign.
- Verification: `npm test` passes (139 tests / 7 files); `npm run build` passes.

---

## Combo Market Entry TP Fix Plan — 2026-04-26

**Status:** In progress.

Goal: make the explicit breakout/reopen market entry realize profit through a paired TP order, without relying on grid-level index collisions or implicit inventory.

### Market entry lifecycle
- [x] 1.1 Add optional `positionId` to `PendingOrder`, `Fill`, and internal open positions.
- [x] 1.2 Make `processFill()` close by `positionId` before falling back to legacy grid-level adjacency.
- [x] 1.3 Give explicit market entries a stable `positionId` and a sentinel level index that cannot collide with grid levels.
- [x] 1.4 After seeding the combo grid, add one TP pending order at the nearest favorable grid level with the same `positionId`.
- [x] 1.5 Keep legacy grid behavior unchanged for orders without `positionId`.

### Sizing/accounting
- [x] 2.1 Keep the market entry to one grid unit.
- [x] 2.2 Reserve that one grid unit from the averaging grid budget so intended notional does not silently grow.
- [x] 2.3 Add comments clarifying quote-notional fee semantics.

### Tests
- [x] 3.1 Add test: monotone favorable trend closes the market entry at TP and realizes profit.
- [x] 3.2 Add test: market-entry TP closes by `positionId`, not by `levelIndex`.
- [x] 3.3 Add test/coverage that legacy grid round-trips still work through level adjacency.

### Verification
- [x] 4.1 Run `npm test`.
- [x] 4.2 Run `npm run build`.
- [x] 4.3 Update this section with final summary.

### Market entry TP implementation review

- Explicit combo market entries now get a stable `positionId` and a sentinel negative `levelIndex`, so they no longer depend on grid-level/candle-index collisions.
- `processFill()` now closes opposite-side fills by matching `positionId` first. Legacy grid orders without a `positionId` continue using the existing adjacent-level matching behavior.
- Breakout/reopen market entries now seed a paired TP order at the nearest favorable grid level using the same `positionId`.
- The averaging grid budget reserves the one-grid-unit market entry before calculating grid base order size.
- Tests now assert that monotone favorable long trends close the market entry at TP and realize profit, while legacy grid round-trips still pass through adjacency.
- Verification: `npm test` passes (140 tests / 7 files); `npm run build` passes.
