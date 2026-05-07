# Active Plan — Strategy Document Feasibility Review

**Status:** Completed.

## Todo

- [x] Identify the provided archive contents and locate the main strategy document.
- [x] Read current project instructions, task history, package setup, and persistence schema enough to frame the review.
- [x] Thoroughly read `files/dual-grid-bot-strategy-v3.1.md` from the provided zip, including the diagrams where useful.
- [x] Compare the proposed feature set against the existing grid, combo supervisor, indicator, optimizer, API, and UI code paths.
- [x] Give a grounded opinion on whether the functionality can work, where it is strong, where it is risky, and what would need validation before trusting it.
- [x] Add a review section here summarizing what was reviewed and the main conclusions.

## Initial Context

- The archive contains `dual-grid-bot-strategy-v3.1.md`, three SVG diagrams, and a nested strategy zip.
- The project already has Binance candle/funding cache support, ATR/ER/AVWAP indicators, a combo supervisor, grid/DCA simulation paths, walk-forward tooling, and Prisma persistence for combo-related configuration.
- I will keep the review analytical only unless you ask for implementation changes.

## Review — Strategy Document Feasibility

- Read the full `dual-grid-bot-strategy-v3.1.md` spec and all three diagrams from `/Users/sandormaraczy/Downloads/files 2.zip`. The nested zip contains the same document and diagrams.
- Reviewed the relevant local implementation: `src/lib/combo/supervisor.ts`, `src/lib/combo/stateMachine.ts`, `src/lib/combo/adaptiveEngine.ts`, `src/lib/combo/sizing.ts`, `src/lib/combo/supervisorRunner.ts`, indicator helpers, slippage/funding models, combo config UI, Prisma combo models, simulation routes, and combo walk-forward fitness.
- Opinion: the feature set is conceptually workable as a backtested strategy framework. The strongest parts are the clear side-specific risk model, explicit state machine, event-anchored AVWAP, funding/slippage awareness, and the insistence on out-of-sample validation rather than raw backtest Sharpe.
- Main caution: the current codebase implements a useful MVP, not the exact v3.1 spec. The adaptive engine has ATR/ER/RSI/AVWAP and anchor persistence support, but the current reopen decision is a simpler trend + neutral RSI + AVWAP-tolerance heuristic. It does not yet enforce the spec's four-condition AND gate: ATR ratio below breakout ATR, ATR slope declining, RSI crossing 65/35, and AVWAP reject/reclaim.
- Other gaps: defaults in code differ from the spec in places, especially SL multiplier/floor/cap and hibernation/cooldown expressed in 5m candles; tier advancement currently uses a fixed short candle count instead of the spec's 80% containment over 24 closes and 12-candle hold; DB runner hardcodes some adaptive parameters; optimizer has stitched OOS and PSR-style scoring, but no true genetic algorithm, no correction for number of genomes tested, and no per-parameter +/-10% perturbation stability test.
- Risk assessment: the strategy could work in the narrow sense of being implementable and backtestable, but profitability is unproven. The biggest real risks are leverage/margin path risk during fast cascades, false reopen timing, optimizer overfitting, regime dependence, and Binance candle-level backtest limitations around intra-candle path/liquidity.
- Recommended next validation before trusting it: implement the exact reopen stack behind an ablation switch; compare current MVP vs exact v3.1 vs no-AVWAP; run long OOS windows across BTC 2021-2026 plus ETH as a sanity check; include fees, funding, ATR-scaled SL slippage, and parameter perturbation; judge by drawdown, liquidation buffer, false-reopen rate, and fold stability rather than total return alone.

## Review — Combo Optimization Feasibility

- Checked `src/lib/optimizer/randomSearch.ts`, `src/lib/optimizer/walkForward.ts`, `src/lib/optimizer/walkForwardCombo.ts`, `src/lib/optimizer/stitchedFitness.ts`, `src/components/OptimizerTab.tsx`, and `/api/walk-forward`.
- Current DCA optimizer is UI-driven random search over DCA parameters, scored mostly by Sharpe with simple constraints.
- Current combo optimizer support is lower-level: `/api/walk-forward` can evaluate one supplied combo config across stitched out-of-sample folds, using PSR/Sharpe fallback, fold stability, and drawdown penalty.
- There is no current combo parameter-search loop, no UI for combo optimization, no ablation matrix runner, and no exact v3.1 reopen-mode variants yet.
- Conclusion: the current codebase can evaluate some of the proposed baselines manually by changing `ComboBotConfig` mode and `avwapEnabled`, but it cannot yet run the full six-way test matrix or optimize the exact v3.1 strategy without small but important additions.

---

# Active Plan — Combo Optimization Scope Analysis

**Status:** Planning only.

## Todo

- [x] Review current combo engine, adaptive indicator, optimizer, walk-forward, and UI/API paths.
- [x] Identify what can be tested now versus what needs new work.
- [x] Decide whether scope should be cut or phased.
- [x] Propose the simplest implementation plan for exact v3.1 reopen logic, ablations, walk-forward, and optimization.

## Review — Scope Recommendation

- Do not cut the core strategy scope: dual combo bot, long/short sides, ATR, ER, RSI, AVWAP, tiered reopen, per-side metrics, walk-forward, and ablation testing are all part of the minimum useful research system.
- Cut or defer live trading, a fancy optimizer UI, genetic algorithm, broad indicator combinatorics, and any "best settings" claim from a single backtest.
- Current code has a strong base: combo engine, state machine, adaptive indicator engine, funding/slippage, stitched OOS scoring, and an endpoint that evaluates one combo config.
- Current code is missing the proof harness: exact reopen policy variants, full v3.1 reopen diagnostics, ablation runner, combo parameter search, per-side/fold metrics, and parameter perturbation stability.
- Recommended next architecture: add a `reopenPolicy`/variant layer first, then an ablation runner, then combo search, then Bayesian/TPE optimization once the objective function is stable.

---

# Active Plan — Audit Plan Review

**Status:** Completed planning review.

## Todo

- [x] Verify the audit's claims against `conditionEvaluator`, combo supervisor, schema, Optuna driver, walk-forward, and tests.
- [x] Separate accurate findings from overstatements or risky implementation assumptions.
- [x] Decide whether to agree with the proposed milestones and identify changes before implementation.

## Review — Audit Plan Findings

- I agree with the plan's core framing: the next product milestone should be a strategy research engine, not live trading or UI polish.
- The repo does have the claimed Optuna TPE sidecar at `optimizer/optuna_driver.py`; my earlier statement that there was no combo parameter-search loop was incomplete because I had only checked the TypeScript/UI path.
- The repo also already has `DECLINING_N`, `RATIO_BELOW`, and `TOUCHED_AND_REJECTED` in `conditionEvaluator.ts`, with tests. They are useful, but `RATIO_BELOW` currently compares to recent max history, not explicitly `ATR_current / ATR_at_breakout`, so full v3.1 still needs breakout ATR state.
- I agree with adding `ReopenPolicy`, diagnostics, per-side/fold metrics, and a CLI ablation runner as Milestone 1.
- I would change the policy ladder: `atr_rsi_avwap` and `full_v31` should not be identical. `atr_rsi_avwap` should be the current-style AVWAP alignment/reject test, while `full_v31` should add tier containment/hold semantics and spec-exact crossings.
- I would not add `atrAtBreakout` only to `AVWAPAnchor`; it belongs either in a broader breakout context object or a new persisted combo regime/breakout state. Tying ATR state to AVWAP makes the schema semantically narrow.
- I would avoid claiming "70% built" as a release-readiness measure. The building blocks exist, but the remaining 30% is the correctness-critical research harness.
- I would not fix short-side SL defaults only in `sizing.ts`; the defaults live in config/schema/driver/test fixtures. The formula function is generic, while the per-side default values are what need correction.
- I would keep M2 random search before relying on Optuna, even though Optuna exists, because the objective is not stable until M1 proves the ablation/reporting harness.

---

# Active Plan — Context Reconstruction

**Status:** Completed for current strategy-purpose analysis.

## Task — Review play button color change

- [ ] Inspect current local modified files.
- [ ] Review the changed CSS against nearby playback control styles.
- [ ] Judge release readiness and note any risks.
- [ ] Add review summary after completing the review.

---

## Todo

- [x] Read project instructions and the existing task history in `tasks/todo.md`.
- [x] Confirm whether prior chat context is directly accessible in this session.
- [x] Read the current Combo Bot/Raider core files: supervisor, state machine, adaptive engine, sizing, funding/slippage, walk-forward optimizer, and combo UI entry points.
- [x] Read the API and persistence paths that save/replay combo simulations.
- [x] Summarize the grounded project context, shipped phases, known limits, and likely next steps from opened files only.
- [x] Add a review section for this context pass after the summary is complete.

## Current Findings

- Prior chat transcripts are not directly available to me unless their content is present in this thread or stored in repo files.
- `tasks/todo.md` contains substantial prior work history for the Combo Bot/Raider, including Phase 6 UI, Phase 7 ETH acceptance tooling, and Phase 8 combo-only bug fixes.
- I will treat `tasks/todo.md`, `AGENTS.md`, and the source files I open as the source of truth.

## Review — Context Reconstruction

- Opened the Combo/Raider execution path: `src/lib/combo/supervisor.ts`, `src/lib/combo/stateMachine.ts`, `src/lib/combo/adaptiveEngine.ts`, `src/lib/combo/sizing.ts`, `src/lib/combo/supervisorRunner.ts`.
- Opened supporting tests: `src/__tests__/combo.test.ts` and `src/__tests__/comboSupervisor.test.ts`.
- Opened config/API/persistence paths: `src/components/config/ComboBotConfig.tsx`, `src/app/api/simulations/route.ts`, `src/app/api/simulations/[id]/replay/route.ts`, `src/lib/simulation/engine.ts`, `src/lib/optimizer/walkForwardCombo.ts`, `src/app/api/walk-forward/route.ts`, and relevant Prisma schema sections.
- Current implemented purpose: backtest a dual-side adaptive grid supervisor where each side can stop out independently, cool down, reopen in risk tiers, hibernate after repeated failed retries, and be evaluated through simulation replay and walk-forward optimization.
- Main caveat: the current Combo/Raider implementation does not yet run a true continuous classic long/short grid pair underneath all market conditions; it seeds ATR-centered dynamic side grids on breakout/reopen events and uses synthetic market entries plus grid counter-orders.

---

## Task — Fix play button color: green → blue

- [x] Read `PlaybackControls.tsx` — no inline color overrides, all styling is in CSS
- [x] Located `.playback-btn.transport-play` block in `globals.css` (lines 1077–1097)
- [x] Replaced all green values (`rgba(16,185,129,...)`, `--grid-long-bg/border`) with `#2563eb` blue matching the scrubber

### Review
Single block edit in `globals.css`. Play button background, border, icon color, and glow ring now all use `rgba(37, 99, 235, ...)` / `#2563eb` — identical to the scrubber track and thumb. Hover deepens glow and border slightly. No component files touched.

---

# Active Plan — UI Redesign Review

**Status:** Implementing approved screenshot-aligned redesign.

## Generated UI Directions

- [x] Option 1 — premium dark quant terminal with left config rail, central chart, right metrics, bottom logs.
- [x] Option 2 — calm light brokerage workstation with compact command bar and right insight panels.
- [x] Option 3 — dark graphite split workspace with vertical mode toolbar and analytics drawer.
- [x] Option 4 — hybrid light workspace with dark strategy rail and focused strategy-builder workflow.
- [x] Option 5 — analytics-first institutional comparison layout with run summaries and dense tables.

Generated preview files:
- `/Users/sandormaraczy/.codex/generated_images/019dcb0c-4cee-7af2-8c80-ac138ae85e29/ig_060710c9e3de2ebb0169ee59bbfe3c8191ba96d862ebb608ae.png`
- `/Users/sandormaraczy/.codex/generated_images/019dcb0c-4cee-7af2-8c80-ac138ae85e29/ig_060710c9e3de2ebb0169ee5b1ee6188191a6a445d7108f26b0.png`
- `/Users/sandormaraczy/.codex/generated_images/019dcb0c-4cee-7af2-8c80-ac138ae85e29/ig_060710c9e3de2ebb0169ee5b6fd7848191b452671de6c52cad.png`
- `/Users/sandormaraczy/.codex/generated_images/019dcb0c-4cee-7af2-8c80-ac138ae85e29/ig_060710c9e3de2ebb0169ee5a6999148191a98f47768f12b10f.png`
- `/Users/sandormaraczy/.codex/generated_images/019dcb0c-4cee-7af2-8c80-ac138ae85e29/ig_060710c9e3de2ebb0169ee5a08fc10819194fbed2c3d6b146b.png`

## Scope Guardrails

- [x] Keep backend routes, Prisma schema, simulation engines, optimizer logic, and strategy logic unchanged.
- [x] Limit work to frontend presentation and layout files unless a compile error forces a tiny type-only adjustment.
- [x] Preserve existing props, state flow, API payloads, and event handlers.
- [x] Keep changes simple and localized; no new component library.

## Todo

- [x] Inspect current dashboard, theme, chart wrappers, config sidebar, playback controls, and result panels.
- [x] Run one UI-focused sub-agent to independently map UX risks and smallest safe file set.
- [x] Confirm preferred direction: modern dark trading dashboard with icon rail + config drawer.
- [x] Update `src/app/globals.css` tokens and shared primitives for a cleaner trading-workstation theme. _(Pass 2 visual-polish section appended; additive only.)_
- [x] Redesign `src/app/page.tsx` layout only: top metadata bar, icon rail + drawer, two-chart workspace, analytics area. _(Topbar date row + pnl chip refined; structural shell unchanged.)_
- [~] Refresh `src/components/config/ConfigPanel.tsx` visually. _(Deferred — accordion already shipped in earlier pass; no visual gap surfaced this round.)_
- [x] Refresh `src/components/simulation/PlaybackControls.tsx` as a compact transport bar with stable sizing. _(Circular play with halo, segmented speed, gradient scrubber.)_
- [x] Refresh chart headers in `src/components/charts/TradingChart.tsx` and `src/components/simulation/DCAChart.tsx` without changing chart data or fill-marker logic. _(Side ribbon + leverage chip + filled-meter + indicator chip slot. Marker math untouched.)_
- [x] Refresh readout surfaces in `src/components/simulation/CombinedPnL.tsx`, `src/components/results/PerformanceSummary.tsx`, and `src/components/results/TradeLog.tsx`. _(Hero equity + sparkline; hero/secondary split; side-color edge rows + sticky head.)_
- [~] Review combo UI consistency. _(ComboPane left as-is — its design language is already shipped in Phase 6.)_
- [x] Run typecheck/build-safe verification and the existing test suite where practical. _(tsc clean · 140/140 tests · `npm run build` green.)_
- [x] Add a review section below with changed files, verification results, and any residual UI risks.

## Pass-2 review (2026-04-26)

**Prototype reference:** `design/dashboard-polish-prototype.html` (1,885 lines, generated via `frontend-design` skill before any component edit).

**Files touched (8):**
- `src/app/globals.css` — appended a "Visual Polish — Pass 2" section: refined card shadow stack, side ribbon, chart-panel-header, indicator chip / leverage chip / chip-meta / filled-meter classes, fully styled transport bar (`.transport-bar`, `.transport-group`, `.transport-scrubber`, `.transport-readout`, `.speed-selector`, `.transport-toggle-btn`, `.playback-btn.transport-play`), gradient scrubber track via `--scrubber-progress` CSS var, refined `.modern-tabs` active underline with neutral glow, perf-hero cards, `.cpnl-hero` + `.cpnl-delta-chip`, full `.equity-sparkline` token set, `.trade-log-table` with side-color left edge + sticky head, `.topbar-date-arrow` + `.topbar-pnl-chip`. All additive — existing tokens and existing combo-pane CSS untouched.
- `src/components/charts/TradingChart.tsx` — added optional `leverage` and `indicators` props (BB%B, RSI, MACD sign). Replaced the bare header JSX above the chart canvas with side ribbon + badge + leverage chip + filled-meter + indicator chip cluster. **Lines 164–165, 639, 734–742 (fill marker coordinate math + primitive attachment) were not modified.**
- `src/components/simulation/DCAChart.tsx` — same header treatment for visual parity. Markers logic untouched.
- `src/components/simulation/CombinedPnL.tsx` — full restructure: hero `$X.XX` mono readout at top, sign-coloured P&L number + delta chip, 2×2 breakdown grid, optional adaptive status pill, optional sparkline. New optional `equityHistory?: number[]` prop. Pure-SVG sparkline (`EquitySparkline`), `useMemo` keyed on the array, downsampled to ≤120 points.
- `src/components/results/PerformanceSummary.tsx` — split into 2 hero cards (Total P&L profit-tinted, Win Rate) + 4 secondary stat tiles. tabular-nums everywhere.
- `src/components/results/TradeLog.tsx` — semantic `<table class="trade-log-table">` with sticky `<thead>` and 2px left side-color edge per row, denser rows, alternating row tint, hover state.
- `src/components/simulation/PlaybackControls.tsx` — circular green play with ring (`.transport-play`), gradient scrubber driven by `--scrubber-progress` inline style, segmented speed pills inside `.speed-selector`, dedicated Fit-All toggle (`.transport-toggle-btn`).
- `src/app/page.tsx` — topbar date row uses `→` arrow instead of word labels; topbar pnl readout gets a separate sign-coloured chip; `equityHistory` is now derived from `replayData.pnlSnapshots` and passed to `<CombinedPnL>`.

**Verification:**
- `npx tsc --noEmit` — clean.
- `npm test` — 140/140 pass across 7 files (combo, supervisor, gridPnl, indicators, optimizer, stitchedFitness, comboSupervisor).
- `npm run build` — Next.js production build succeeds; `/` route 92 kB / 179 kB First Load JS, no warnings related to changed components.
- Manual smoke not yet run by me; user should compare side-by-side with `design/dashboard-polish-prototype.html` and the two reference screenshots (`/Users/sandormaraczy/.codex/generated_images/019dcb0c-…/ig_…ee5f…png` and `…ee5b6f…png`).

**Hard guardrail status:** `GridFillMarkerPrimitive` and its attachment in `TradingChart.tsx` were not touched. Buy fills still render as green hollow circles at exact `(candles[fill.candleIdx].timestamp, fill.price)` coordinates, sell fills as red, both with `zOrder() === 'top'`.

**Residual UI risks / known follow-ups:**
- Indicator chips (BB%B / RSI / MACD) on the chart header are wired through props but `page.tsx` does not yet compute/pass real values — chips render only when those props are supplied. Wiring real indicator state is a future PR; no chip currently shows on real charts. The `leverage` prop is similarly unused at the call sites.
- Sparkline derives `equityHistory` per render via `replayData.pnlSnapshots.filter(...).map(...)`. With ~140 max points this is cheap, but on very long replays (>10K snapshots) it would be worth `useMemo`-ing in `page.tsx` itself.
- Light-theme verification was not run manually; CSS additions include explicit `[data-theme="light"]` overrides for the new surfaces (transport bar, perf-hero card, indicator chip, trade-log header, speed selector) but a visual pass on the toggle is recommended.
- ConfigPanel and ComboPane were intentionally not touched — their styling already matches the language and the gap-list did not include them.

## Fill-Marker Guardrail

- [x] Confirmed current buy/sell circles are `TradingChart` fill markers anchored from `fillCandleIdx` + `fillPrice`.
- [ ] Preserve `GridFillMarkerPrimitive` semantics: circles stay on chart fill locations, above candles, with buy = green and sell = red/coral.

## Review

_To be filled after implementation._

---

# Active Plan — v3.1 Research Plan Review

**Status:** Reviewing only; no implementation changes.

## Todo

- [x] Read the current task history before modifying this file.
- [x] Inspect the referenced combo state machine, supervisor, shared types, walk-forward runner, and tests.
- [x] Compare the submitted findings against the revised plan.
- [x] Provide a grounded verdict on whether the findings were targeted and resolved.
- [x] Add a review section summarizing this assessment.

## Review — v3.1 Research Plan Corrections

- The findings are targeted and grounded in the current code. `stateMachine.ts` still reads ATR/ER directly, `supervisor.ts` still owns the simple reopen heuristic, defaults differ from the spec, and walk-forward metrics are currently too thin for ablation attribution.
- The revised plan resolves the broad architecture direction: keep `adaptiveEngine.ts` pure, move market-condition decisions into the supervisor, add reopen policy variants, add diagnostics, use effective ATR, and defer Prisma persistence.
- Not all findings are fully resolved in the written plan. The plan still contradicts itself on simulation-level vs per-side `reopenPolicy`, does not explicitly add `lastEffectiveAtr`, does not add `hibernationExitOk` to `TickInputs`, does not reset containment history on `tier1_reopen`, does not specify failed reopen runtime tracking, and keeps timestamped ablation output while requiring byte-identical CSV determinism.
- Before implementation, tighten those points in the plan so M1 stays a clean ablation instead of mixing policy, side, and state-machine behavior changes.

---

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

---

## UI Review-Findings Fix Pass — 2026-04-27

**Status:** Complete.

### Findings addressed
- **P1 — Negative Total P&L lost its sign** (`PerformanceSummary.tsx`): replaced `Math.abs(totalPnl)` rendering with explicit `+`/`-` prefix so a loss now shows `-$X.XX` instead of `$X.XX`.
- **P2 — Topbar P&L was grid-only** (`page.tsx`): `pnlTotal` now sums grid `currentSnapshot` realized+unrealized **plus** DCA cumulative realized P&L from `dcaLongCurrentSnapshot`/`dcaShortCurrentSnapshot`. Topbar chip is hidden when no P&L source exists, eliminating the misleading `+$0.00` on DCA-only runs that were still loading.
- **P2 — Combined equity vs. delta mismatch** (`page.tsx` → `CombinedPnL`): `totalEquity` is now derived as `initialCapital + pnlTotal`, so the hero number and the embedded delta describe the same value. DCA-only and mixed views are now internally consistent.
- **P2 — Transport bar overflow on mobile** (`globals.css`): `.transport-bar` gets `flex-wrap: wrap` + `row-gap: 8px`. `.transport-scrubber` `min-width` dropped from 200px to 140px with `flex: 1 1 220px`. Added a `@media (max-width: 720px)` rule that places the scrubber on its own row.
- **P3 — Performance stats fixed 4 columns** (`PerformanceSummary.tsx`): `grid-cols-4` → `grid-cols-2 md:grid-cols-4`.
- **P3 — Rail buttons all open the same drawer**: deferred. ConfigPanel sections don't have anchor IDs yet, so wiring deep-link nav would expand scope into ConfigPanel restructuring. The rail still opens the same drawer (no regression vs Pass 2).

### Slider color (user request)
- `.timeline-scrubber` track fill, thumb border, and thumb ring shadow recolored from `var(--grid-long)` (green) to `#2563eb` with `rgba(37, 99, 235, 0.18)` ring — matches the `.btn-primary` Run Simulation button. Light theme inherits the same blue.

### Files touched (3)
- `src/components/results/PerformanceSummary.tsx` — sign fix on Total P&L hero, responsive secondary stats grid.
- `src/app/page.tsx` — strategy-aware topbar P&L (grid + DCA), coherent `totalEquity` to `CombinedPnL`, hide topbar chip when no P&L source.
- `src/app/globals.css` — transport bar wrap + ≤720px scrubber-on-own-row block, scrubber recolored to `#2563eb`.

### Hard guardrails preserved
- `GridFillMarkerPrimitive` and its `TradingChart.tsx` attachment untouched.
- Marker math (`candles[fill.candleIdx].timestamp` + `fill.price`) untouched.
- Long/short two-chart layout, config submit flow, DCA/combo/optimizer/playback/trade log access — all untouched.
- Backend, simulation engines, order matcher, Prisma schema — untouched.

### Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 140/140 pass across 7 files.
- `npm run build` — green; `/` route still 92 kB / 179 kB First Load JS.
- Manual smoke not run by me — recommend a quick check in browser: DCA-only run topbar matches DCA P&L; CombinedPnL hero and delta agree; ≤720px viewport wraps the transport bar; a losing sim renders `-$X.XX`; scrubber renders blue.

---

# Active Plan — Submitted Combo v3.1 Plan Review

**Status:** Reviewing only; no implementation changes.

## Todo

- [x] Read the current combo, indicator, simulation, optimizer, API, UI, and schema files relevant to the submitted plan.
- [x] Compare each major claim in the submitted plan against the current implementation.
- [x] Identify outdated assumptions, duplicated work, missing work, and risky sequencing.
- [x] Refine the plan into the smallest practical milestone order.
- [x] Add a review section here summarizing findings and recommended changes.

## Review — Submitted Combo v3.1 Plan Findings

- The submitted v2 plan is directionally right but stale relative to the repo. Combo-as-checkbox, dual/long/short modes, schema fields, side configs, AVWAP anchor persistence, adaptive engine, state machine, funding, slippage, replay overlays, `/api/walk-forward`, and the Optuna driver already exist.
- The remaining product risk is not scaffolding. It is strategy correctness: current reopen logic is still a simple supervisor heuristic (`trending + RSI coiled + AVWAP tolerance`) instead of the v3.1 four-condition AND gate.
- Exact v3.1 still needs a first-class reopen policy module with diagnostics for: `ATR_current / ATR_at_breakout`, ATR declining for N candles, RSI cross through 65/35, and AVWAP reject/reclaim. Current `ConditionEvaluator` has useful operators, but `AVWAP` returns `NaN`, `RATIO_BELOW` compares against recent history rather than breakout ATR, and the combo supervisor does not consume a reusable policy object.
- The current state machine has the main phases and hibernation, but tier advancement is still a fixed two-candle timer. It does not implement 80% containment over 24 closes for Tier 2 or a 12-candle hold before Tier 3/full restore.
- Defaults do not match the spec baseline: current long and short SL defaults are mostly symmetrical except averaging depth, while the spec calls for long `1.5% + ATR x 1.0`, floor/cap `2%/6%`, and short `0.8% + ATR x 0.7`, floor/cap `1.5%/4%`. Cooldown/hibernation units also need a deliberate decision because the spec text mixes "candles" with 4H/5m implications.
- Walk-forward exists, but it is the single-parameter-set robustness variant. It does not do classic per-fold training optimization followed by blind OOS, and it does not currently use the training window except for fold boundary spacing. The plan must stop saying the current endpoint performs "optimizer on 12m train -> blind 3m OOS" unless that nested optimization is actually built.
- Fitness has PSR/Sharpe fallback, fold-Sharpe stability, and drawdown penalty. It does not correct PSR for number of trials/genomes, and it does not run +/-10% parameter perturbation stability.
- The Optuna sidecar exists and is usable, but the search space includes broad/default ranges that do not exactly match the spec baseline. It should become a later milestone after the policy/diagnostic harness proves that the simulated behavior is the strategy being tested.
- The UI exists for enabling combo and editing core knobs. It does not yet expose policy variants, condition-by-condition reopen lights, false-reopen metrics, or ablation matrices. Those matter more than more styling.
- Recommended refined order:
  1. M1: Add `ReopenPolicy` + diagnostics only. Keep schema stable. Add tests for all four conditions and both sides.
  2. M2: Replace the supervisor's simple reopen heuristic with policy variants: current MVP, ATR+RSI, ATR+RSI+AVWAP, full v3.1.
  3. M3: Implement spec tier containment/hold semantics and failed-reopen counters with regression tests.
  4. M4: Add a deterministic ablation runner/report over cached ETH/BTC data. Output per-side SLs, reopen attempts, false reopens, cooldown/hibernation time, drawdown, funding, slippage, and stitched OOS fitness.
  5. M5: Only then tune Optuna search space and fitness perturbation. Treat Optuna as optimizer plumbing, not proof of strategy correctness.
  6. M6: UI polish for the reopen stack lights and ablation results once the metrics are stable.

---

# Active Plan — Combo Bot v3.1 Exact Reopen + Research Harness

**Status:** Awaiting explicit implementation approval.

Goal: make the existing opt-in Combo Bot match the v3.1 dual-grid reopen lifecycle exactly enough for research-grade backtests and walk-forward validation. Do not rebuild existing scaffolding. Keep classic grid and DCA behavior unchanged when Combo Bot is disabled.

## Current Grounding

- `src/lib/combo/supervisor.ts` still derives reopen from a local heuristic: trending regime + coiled RSI + AVWAP tolerance.
- `src/lib/combo/stateMachine.ts` still advances reopen tiers after `TIER_ADVANCE_CANDLES = 2`.
- Current long/short defaults are mostly symmetrical except depth; v3.1 needs asymmetric SL defaults.
- `/api/walk-forward`, `walkForwardCombo.ts`, and `optimizer/optuna_driver.py` already exist, but current walk-forward evaluates one parameter set across OOS folds; it is not nested train-optimize/blind-OOS.
- Combo replay/UI infrastructure already exists, so backend policy correctness and deterministic diagnostics come first.

## Todo

- [x] Read `tasks/todo.md` and inspect the current combo supervisor, state machine, shared types, config defaults, tests, and walk-forward runner before planning changes.
- [x] Write this implementation plan in `tasks/todo.md`.
- [x] Wait for explicit implementation approval before editing source code.
- [x] Add shared types for `ReopenPolicyName`, `ReopenDiagnostics`, policy inputs/results, and containment state.
- [x] Implement pure reopen policy evaluation with variants: `mvp_current`, `atr_rsi`, `atr_rsi_avwap`, and `full_v31`.
- [x] Add unit tests for long and short reopen policy behavior:
  - ATR ratio requires `ATR_current / ATR_at_breakout < 0.6`.
  - ATR declining requires the configured number of strictly declining ATR values.
  - Long RSI requires crossing up through 35.
  - Short RSI requires crossing down through 65.
  - Long AVWAP requires reclaim from below.
  - Short AVWAP requires touch/reject from above.
  - `avwapEnabled=false` bypasses only AVWAP.
- [x] Wire policy output into `supervisor.ts`, replacing only the reopen heuristic while preserving current entry behavior.
- [x] Store reopen diagnostics in `AdaptiveEvent.detailsJson` through the existing `ComboSupervisorEvent` path for UI/debugging.
- [x] Add supervisor/state-machine coverage proving stopped sides do not reopen until selected policy diagnostics are all true.
- [x] Replace fixed tier auto-advance with v3.1 containment state:
  - Tier 1 reopens at 25%.
  - Tier 2 requires at least 80% of the last 24 closes inside the frozen/reopen containment band.
  - Tier 3 requires 12 additional valid containment candles.
  - Reset containment history on SL, hibernation, fresh breakout, and new Tier 1 reopen.
- [x] Add tier regression tests for no two-candle auto-advance, 80%/24 containment, 12-candle Tier 3 hold, and SL reset behavior.
- [x] Align v3.1 default side config in UI defaults, supervisor fallback defaults, API/schema defaults if needed, test fixtures, and Optuna seed/search ranges:
  - Long: depth 5, `1.5% + ATR x 1.0`, floor/cap `2% / 6%`.
  - Short: depth 2, `0.8% + ATR x 0.7`, floor/cap `1.5% / 4%`.
  - Shared leverage remains 5x; allocation remains 60/40.
  - Treat cooldown/hibernation as 5m candles; leave hibernation at 288 unless we intentionally choose the spec's 24-candle behavior.
- [x] Add deterministic combo ablation runner/reporting over cached candle windows with policy variants and AVWAP on/off.
- [x] Report per side: stop-outs, reopen attempts, successful reopens, false reopens, cooldown time, hibernation time, realized/unrealized P&L, max drawdown, funding cost, slippage cost, trade count, and stitched fitness.
- [x] Add research harness tests for deterministic output, AVWAP on/off config isolation, clear missing-data failure, and stable 12m/3m/3m fold boundaries.
- [~] Refine Optuna only after policy diagnostics and ablation metrics are stable; search ranges now center v3.1 defaults, +/-10% perturbation stability remains a later optimizer phase.
- [~] Add UI reopen-stack diagnostics and policy/ablation selectors only after backend metrics are stable. Reopen-stack diagnostics are wired; policy/ablation selectors are deferred to avoid expanding UI scope before using the harness on real cached BTC/ETH windows.
- [x] Run verification after implementation milestones: `npm test`, `npx tsc --noEmit`, and `npm run build`.
- [x] Add a review section here with changed files, behavior summary, verification results, and remaining limitations.

## Approval Gate

Implementation will not start until you confirm this plan.

## Review — Implementation Complete

- Added `src/lib/combo/reopenPolicy.ts` with pure policy evaluation for `mvp_current`, `atr_rsi`, `atr_rsi_avwap`, and `full_v31`. The exact policies expose `atrRatioOk`, `atrDecliningOk`, `rsiCrossOk`, and `avwapOk`.
- Supervisor reopen logic now uses the policy result instead of the old coiled-RSI heuristic. Entry logic remains unchanged. Reopen diagnostics are persisted in `detailsJson` on emitted combo events.
- State-machine tier progression no longer auto-advances after two candles. Tier 2 requires 80% containment over a 24-close frozen reopen band; Tier 3 requires 12 additional valid containment closes and then returns the side to normal `RUNNING` at full size instead of forcing a market close.
- v3.1 defaults are aligned in supervisor fallback config, UI defaults, Prisma long-side defaults, DB runner default policy, and Optuna search ranges: long `1.5% + ATR x 1.0` with `2%/6%`; short `0.8% + ATR x 0.7` with `1.5%/4%`; leverage 5x and allocation 60/40 preserved.
- Added `src/lib/optimizer/comboAblation.ts`, a deterministic pure ablation runner over supplied 5m candles. It evaluates policy variants and AVWAP on/off, returning per-side lifecycle/P&L/cost/trade metrics plus stitched fitness.
- UI derivation now reads stored reopen diagnostics for the reopen-stack lights instead of hardcoded approximations. Policy/ablation selectors remain deferred until real BTC/ETH cached-window runs confirm the backend metrics are the right shape.
- Tests added/updated in `src/__tests__/combo.test.ts` and `src/__tests__/comboAblation.test.ts` for policy diagnostics, containment tiering, deterministic ablation output, AVWAP isolation, missing-candle failure, and fold boundary stability.
- Verification: `npm test` passes (154 tests / 8 files), `npx tsc --noEmit` passes, and `npm run build` passes.

### Remaining limitations

- `slippageCost` is present in the ablation report shape but remains `0` because existing fills do not retain an un-slipped reference price. Tracking exact slippage attribution needs a small fill/accounting extension.
- The Prisma schema can only express one default row shape, so the schema defaults are long-side defaults; normal UI/API creation stores explicit long and short side config rows.

---

# Active Plan — Candle Cache Gap-Fill + Error Wording (Phase 1)

**Status:** Implemented. Verified.

**Reference:** `~/.claude/plans/cached-giggling-cookie.md` for the full structured plan.

## Todo

- [x] Replace 90%-of-expected hit rule in `src/lib/data/candleCache.ts` with exact gap-detection (`computeMissingGaps`, exported) using `Math.ceil(startMs/tfMs)` and `Math.floor((endMs-1)/tfMs)` bucket math.
- [x] Short-circuit `computeMissingGaps` to `[]` for `endMs <= startMs` or sub-bucket ranges; `getOrFetchCandles` skips Binance.
- [x] After per-gap fetch + store, re-query the cache once and run a final coverage check; throw an actionable error with ISO-formatted unresolved range if any gap remains.
- [x] Add empty-candles 404 guard to `src/app/api/simulations/[id]/replay/route.ts`.
- [x] Update error strings (context-aware) in `engine.ts:58`, `walk-forward/route.ts:31`, `combo/supervisorRunner.ts:66`, `simulations/route.ts:120`, `simulate/route.ts:41`.
- [x] Write `src/__tests__/candleCache.test.ts` with pure helper unit tests + `getOrFetchCandles` integration tests (mock `../lib/prisma` and `../lib/data/binanceApi`; sequential `findMany.mockResolvedValueOnce`).
- [x] Verify: `npx tsc --noEmit`, `npm test`, `npm run build`.
- [x] Add review section here when done.

## Review — Implementation Complete

**Behavior change:**
- `getOrFetchCandles` no longer re-pulls the entire range when the cache drops below 90% coverage. It now: (1) reads cached rows, (2) computes the precise list of missing `[gapStart, gapEnd)` bucket-aligned windows via the new exported `computeMissingGaps`, (3) fetches each gap from Binance and stores it, (4) re-queries the cache so the returned array reflects what's now persisted, (5) runs a final coverage check and throws with an ISO-formatted unresolved range if Binance returned nothing for a gap (delisted symbol, pre-listing range, transient API miss).
- Bucket math is exact and matches the cache query's half-open `[startMs, endMs)` convention with strict `openTime >= startMs` / `openTime < endMs`: `firstExpectedMs = Math.ceil(startMs / tfMs) * tfMs`, `lastExpectedMs = Math.floor((endMs - 1) / tfMs) * tfMs`.
- `computeMissingGaps` short-circuits to `[]` for `endMs <= startMs` and for sub-bucket ranges (range narrower than one bucket), so callers like the DataManager date picker (which can produce same-day ranges) don't accidentally trigger Binance traffic.
- Replay route now returns 404 with an actionable error when the cache is empty for a sim's range, instead of slicing an empty array silently.
- Error strings across all five candle-fetch sites are now context-aware: cache-only consumers get "Use the Data Manager to download"; the auto-fetching DCA route says "Binance returned no klines"; the optimizer's mixed-input route says "Provide candles or download via the Data Manager".

**Files changed:**
- `src/lib/data/candleCache.ts` — added exported `computeMissingGaps`; rewrote `getOrFetchCandles` decision logic with re-query + final coverage check.
- `src/app/api/simulations/[id]/replay/route.ts` — added empty-array 404 guard.
- `src/lib/simulation/engine.ts`, `src/app/api/walk-forward/route.ts`, `src/lib/combo/supervisorRunner.ts`, `src/app/api/simulations/route.ts`, `src/app/api/simulate/route.ts` — error string improvements only.

**Files added:**
- `src/__tests__/candleCache.test.ts` — first test file in the repo to use `vi.mock`. Mocks `../lib/prisma` and `../lib/data/binanceApi` (not sibling exports of `candleCache.ts`), and uses sequential `findMany.mockResolvedValueOnce(initial).mockResolvedValueOnce(final)` so the post-store re-query observes the would-be-inserted rows.

**Test coverage added (16 cases):**
- `computeMissingGaps`: empty cache → full-range gap; full coverage → []; head-only / tail-only / mid / two-disjoint gaps; off-grid `startMs` ceils forward (12:33 → 12:35); off-grid `endMs` floors backward; `endMs <= startMs` → []; sub-bucket range → [].
- `getOrFetchCandles`: cache full → no Binance call; cache empty → one fetch over the full range; mid hole → exactly one fetch covering only the hole; head + tail holes → exactly two fetches with correct ranges; Binance returns nothing for a gap → throws ISO-formatted error containing both endpoints; malformed range → returns `[]` without calling Binance.

**Verification results:**
- `npx tsc --noEmit` — passes (no output).
- `npm test` — 181 tests pass across 9 files (165 existing + 16 new). No regressions.
- `npm run build` — Next.js production build succeeds.

**No changes to:** strategies, indicators, aggregator, Prisma schema, UI components, optimizer search loops, walk-forward fitness. Strategy outputs are bit-for-bit unchanged, so existing backtests remain reproducible.

### Remaining limitations / deferred to future plans

- **D — Indicator warmup pre-roll.** First N candles still produce NaN indicators; effective trade start drifts forward of `startDate` for indicators with long lookbacks. Fixing this changes first-day trade behavior and requires backtest re-baselining.
- **E — Aggregator wall-clock alignment.** `aggregate5mTo` still anchors group boundaries at array index 0, not at exchange-aligned UTC boundaries. Indicator values therefore differ slightly from TradingView's. Fixing it changes every existing 1H/4H indicator value → guaranteed test breakage and a deliberate reproducibility break.
- **F — DataManager progress bar.** The `onProgress` callback is plumbed through `getOrFetchCandles` but `/api/candles` discards it. Wiring it to the UI needs SSE or a chunked response.
- **G — UTC vs local date display.** `new Date('YYYY-MM-DD').toISOString()` interprets the picker as midnight UTC, which can confuse users in non-UTC timezones.

## Out of scope

- Indicator warmup pre-roll (D), aggregator wall-clock alignment (E), DataManager progress bar (F), UTC date display (G). Each will be a separate plan.
- Current walk-forward is still the existing single-parameter-set stitched OOS runner. Nested train-optimize/blind-OOS and +/-10% perturbation stability remain intentionally deferred.

---

## Combo v3.1 Follow-Up Fix Pass — 2026-05-07

**Status:** Complete.

### Fixes shipped

- **Step 1 — ATR reopen reference refreshed on every SL.** `BotState` now carries `atrAtLastSL`. The state machine writes it inside `enterCooldownFromSL` (so both wick-SL and `forceStopLoss` paths capture it) and clears it on `hibernation_exit`. The supervisor passes `atrAtLastSL ?? atrAtPhaseEntry` into `evaluateReopenPolicy` so the ratio gate compares against the most recent shock, not the original breakout.
- **Step 2 — Truthful slippage cost.** Added `longSlippageCost`, `shortSlippageCost`, `totalSlippageCost` to `ComboSimulationResult`. The supervisor now records cost at all four `applySlippage` sites (regular grid fill, market entry, market close, forced/post-fill SL). The ablation runner reads those fields instead of hardcoding zero.
- **Step 3 — Uniform diagnostics.** `reopenPolicy.ts` always computes the four exact diagnostic booleans (`computeDiagnostics`); only the `allowed` combination differs by policy. `mvp_current` keeps its legacy allow logic but now exposes honest, comparable lights.
- **Step 4 — Diagnostics gated to COOLDOWN ticks.** Supervisor only evaluates `evaluateReopenPolicy` while the side phase is COOLDOWN. Events outside that phase (`breakout_entered`, `position_opened`, `sl_triggered`, `cooldown_entered`) carry `undefined` reopen diagnostics; cooldown-tick events (`retry_incremented`, `tier1_reopen`, `hibernation_entered`) carry the four-boolean object.
- **Step 5 — Optuna policy categorical.** `optimizer/optuna_driver.py` sweeps `reopen_policy` ∈ {`full_v31`, `atr_rsi_avwap`, `atr_rsi`, `mvp_current`} alongside `avwap_enabled`. `PHASE7_RUNBOOK.md` Step 5 updated.

### Tests added

- `combo.test.ts` — `atrAtLastSL` capture on SL; reset on hibernation_exit; uniform diagnostics under `mvp_current`; legacy-compatible `mvp_current` allow.
- `comboAblation.test.ts` — finite/non-negative `slippageCost` field on every run; nonzero slippage cost when fills occur.
- `comboSupervisor.test.ts` — diagnostics persisted only on cooldown-driven events; absent on breakout/position/SL events.

### Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **161 / 161** tests pass across 8 files (was 154 before this pass; +7).
- `npm run build` — green; `/` route 92.4 kB / 180 kB First Load JS.

### Files touched

- `src/lib/types.ts` — `BotState.atrAtLastSL`.
- `src/lib/combo/stateMachine.ts` — capture/reset `atrAtLastSL`.
- `src/lib/combo/supervisor.ts` — slippage accumulators, four `recordSlippage(...)` instrumentations, COOLDOWN-only policy gate, `atrAtLastSL` reference, three new fields on `ComboSimulationResult`.
- `src/lib/combo/reopenPolicy.ts` — uniform `computeDiagnostics`, separated `mvpAllow`.
- `src/lib/optimizer/comboAblation.ts` — wires `result.long/shortSlippageCost` into per-side metrics.
- `optimizer/optuna_driver.py` — `reopen_policy` categorical.
- `PHASE7_RUNBOOK.md` — Step 5 rewritten.
- `src/__tests__/combo.test.ts`, `src/__tests__/comboSupervisor.test.ts`, `src/__tests__/comboAblation.test.ts` — new tests as listed above.

### Remaining intentional deferrals

- Containment-band ATR multiplier stays hardcoded at ±1 ATR until ablation results justify a knob.
- UI policy/ablation selector remains deferred; reopen-stack lights are now backed by uniform diagnostics so adding the selector is a small follow-up.
- `cycle_complete` event is still defined on the type union though the new tier-3 path bypasses it; left in place as a forward-compat hook.

---

## Combo v3.1 Follow-Up Review Plan — 2026-05-07

**Status:** Review complete.

- [x] Read the relevant implementation files for ATR reopen reference, slippage accounting, reopen diagnostics, ablation reporting, and Optuna policy selection.
- [x] Read the relevant regression tests and compare them against the requested follow-up test coverage.
- [x] Run the verification commands: `npm test`, `npx tsc --noEmit`, and `npm run build`.
- [x] Record findings and add a review summary here.

### Review Summary

- Verification passed: `npm test` reports 161/161 tests passing, `npx tsc --noEmit` is clean, and `npm run build` completes successfully.
- No blocking implementation bugs found in the five requested follow-up areas.
- Main residual risk: the requested supervisor regression for "latest SL ATR reference is passed into reopen policy" is only indirectly covered. The state machine captures `atrAtLastSL`, and supervisor code uses `atrAtLastSL ?? atrAtPhaseEntry`, but no integration test proves the supervisor-level policy gate consumes that newer ATR reference across two SL cycles.
- Secondary residual risk: slippage reporting is nonzero and plumbed into ablation, but the nonzero ablation test is conditional on fills existing. The fixture currently produces fills, but an unconditional assertion with a fixture that guarantees slipped fills would be stronger.

---

## Combo v3.1 Follow-Up Review Fixes — 2026-05-07

**Status:** Complete.

### Fixes shipped

- **AVWAP diagnostic is now honest, not a bypass flag.** `computeDiagnostics` in `src/lib/combo/reopenPolicy.ts` no longer short-circuits `avwapOk` to `true` when AVWAP is disabled. It always reports the exact reclaim/rejection boolean. A new `avwapRequired` boolean — added to `ReopenDiagnostics` in `src/lib/types.ts` — reports whether the active policy + config actually consumes `avwapOk` for the `allowed` decision. `evaluateReopenPolicy` adds `avwapOk` to the gate only when `avwapRequired` is true, so AVWAP-off ablation rows now stay comparable to AVWAP-on rows on every diagnostic field.
- **UI consumes the new field.** `src/components/combo/derive.ts` returns `avwapAligned: null` when `avwapRequired === false`, and `src/components/combo/ComboBotDeck.tsx` skips rendering the AVWAP light when null. Light still renders red/green honestly when AVWAP is required.
- **Supervisor latest-SL ATR is now exercised in supervisor tests.** Two new tests in `src/__tests__/comboSupervisor.test.ts`: a `vi.spyOn(reopenPolicy, 'evaluateReopenPolicy')` integration test that proves the supervisor passes a finite `atrAtBreakout` on every COOLDOWN tick after an SL (i.e. it never silently drops the captured `atrAtLastSL`); and a focused unit test that calls `evaluateReopenPolicy` twice with different `atrAtBreakout` values and asserts the diagnostic flips, proving the contract that supervisor.ts:469's `atrAtLastSL ?? atrAtPhaseEntry` is meaningful.
- **Ablation slippage test is now unconditional.** `src/__tests__/comboAblation.test.ts:119` no longer wraps its assertion in `if (totalFills > 0)`. The fixture is engineered (long warmup, sustained trend, relaxed RSI thresholds) to reliably produce a market-entry fill, so the test fails loudly if the fixture drifts to zero fills.

### Tests added/updated

- `combo.test.ts` — three updated/new AVWAP cases: honest `avwapOk` when disabled and no reclaim (`avwapRequired=false`, `allowed=true`); honest `avwapOk` when disabled and reclaim does hold; AVWAP-on with no reclaim blocks `allowed`. `avwapRequired=false` assertion added to the mvp_current diagnostics test.
- `comboSupervisor.test.ts` — extended the persisted-diagnostics shape check to include `avwapRequired` boolean. Added the spy-based supervisor integration test and the focused unit test described above.
- `comboAblation.test.ts` — fixture engineered to guarantee fills; assertion is now unconditional.

### Verification

- `npm test` — **165 / 165** tests pass across 8 files (was 161 before this pass; +4 tests).
- `npx tsc --noEmit` — clean.
- `npm run build` — green; `/` route still 92.4 kB / 180 kB First Load JS.

### Files touched

- `src/lib/types.ts` — `ReopenDiagnostics` gains `avwapRequired: boolean`.
- `src/lib/combo/reopenPolicy.ts` — `computeDiagnostics` always computes exact AVWAP boolean; `evaluateReopenPolicy` consults `avwapRequired` to decide whether AVWAP enters the gate.
- `src/components/combo/types.ts` — `ReopenLights.avwapAligned` widened to `boolean | null`.
- `src/components/combo/derive.ts` — passes `null` for `avwapAligned` when AVWAP not required by the active policy/config.
- `src/components/combo/ComboBotDeck.tsx` — conditionally renders the AVWAP light.
- `src/__tests__/combo.test.ts` — AVWAP test cases updated; new AVWAP-on-no-reclaim case added.
- `src/__tests__/comboSupervisor.test.ts` — `avwapRequired` shape check; spy-based latest-SL ATR test; focused unit test for the policy ATR-reference contract.
- `src/__tests__/comboAblation.test.ts` — guaranteed-fill fixture, unconditional slippage assertion.

### Remaining intentional deferrals

- Containment-band ATR multiplier knob (still hardcoded at ±1 ATR).
- UI policy/ablation selector (still deferred per the 2026-05-07 review).
- A two-SL integration test asserting the *value* of `atrAtBreakout` flips between the first and second SL is not in scope; the spy test confirms the wiring is exercised on every cooldown tick after the first SL, and the unit test confirms a different ATR reference yields a different diagnostic — together they cover the contract.

---

## Combo v3.1 — Tighten Supervisor Latest-SL ATR Test — 2026-05-07

**Status:** Complete.

### What changed

The earlier spy test `"supervisor passes atrAtLastSL (when set) into evaluateReopenPolicy after an SL"` only asserted `atrAtBreakout` was finite. That left the regression gap open: had `supervisor.ts:469` been rewritten to drop `atrAtLastSL ??` and use `atrAtPhaseEntry` forever, the test would still pass because `atrAtPhaseEntry` is finite after breakout. The test has been replaced by `"supervisor passes the most-recent-SL ATR into evaluateReopenPolicy, not the original breakout ATR"`, which asserts the value, not just finiteness.

### How

- The test re-runs `AdaptiveEngine` independently on the same candles, mirroring `supervisor.ts:309-317` (full explicit config, not just defaults) and the supervisor's `<=`-pointer-advance loop at `supervisor.ts:411-412` (because `aggregate5mTo` stamps each aggregated candle with its first 5m candle's timestamp). It records `signals.atr` at every candle index.
- It scans `result.events` for the breakout and SL candle indices and reads `atrPerCandle` at each — these are the supervisor's view of `atrAtPhaseEntry` and `atrAtLastSL` respectively.
- A hard `expect(slEvents).toHaveLength(1)` sanity assertion guarantees the per-call equality below is well-defined; with multiple SLs the expected ATR would shift mid-stream.
- A second sanity assertion `atrAtSLExpected > atrAtBreakoutExpected * 2` confirms the fixture deliberately diverges the two values, so the equality check has discriminating power.
- Every spy call's `atrAtBreakout` is asserted equal to `atrAtSLExpected` within `1e-9`, AND explicitly NOT equal to `atrAtBreakoutExpected`. Because the supervisor gates `evaluateReopenPolicy` to COOLDOWN, every spy call fires post-SL and shares the same expected value.

### Fixture redesign

The original fixture (warmup → trend → sharp drop → recovery) put breakout and SL within the same 4H bar, so the 4H ATR didn't change between them and the test had no discriminating power. The new fixture is: warmup → gentle trend → long high-volatility chop with wide intra-candle wicks → sharp drop. A wide-SL side-config override (`slBasePercent: 0.20`, `slCap: 0.20`) prevents the chop from accidentally triggering SL. With this fixture: `atrAtBreakoutExpected ≈ 66`, `atrAtSLExpected ≈ 185` (≈2.8× ratio).

### Sanity check

Temporarily edited `supervisor.ts:469` to drop `atrAtLastSL ??` (use `atrAtPhaseEntry` only) — the test failed loudly with `expected 119.29... to be less than 1e-9` (value mismatch). Reverted.

### Verification

- `npm test` — **165 / 165** pass.
- `npx tsc --noEmit` — clean.
- `npm run build` — green; `/` route 92.4 kB / 180 kB First Load JS.

### Files touched

- `src/__tests__/comboSupervisor.test.ts` — added `AdaptiveEngine`/`DEFAULT_ADAPTIVE_CONFIG` import; replaced the spy test body with the value-equality version; redesigned the fixture for ATR divergence.
