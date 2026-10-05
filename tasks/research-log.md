# Strategy B Research Log

Variant cap: **40**. Every distinct strategy/parameter variant evaluated in walk-forward
gets one numbered entry. Sample-run shakedowns (defaults) are logged as V0 for context.

| # | Date | Mode | Key params (delta from default) | Stitched OOS Sharpe | OOS MaxDD | Notes |
|---|------|------|----------------------------------|---------------------|-----------|-------|
| V0 | 2026-06-11 | all 4 | defaults (bankAt .8, frac .6, unwind .25, k=8 clamp 2–8%, w=2, s=3, ER .25/.45, 21 lvls) | n/a (3-mo sample only) | B 9.3% sample | Shakedown 2025-03→06: B +1.39%, fullClose +1.34%, fullHold +1.45%, oneSided −9.56%/26% DD. B interpolates baselines on expectancy as hypothesized; differentiation must come from risk metrics at tuned params. Identical cycles across modes confirmed. |
| V1 | 2026-06-11 | all 4 | WF 6m/2m ×9, 300 samples/win, 14-dim space, select = argmax IS Sharpe (DD≤20%, ≥3 cycles) | B −0.32, FC −0.32, FH −0.30, 1S −0.56 (B&H +0.14, −21.5% ret, 63% DD) | B 12.5% | FAIL. IS ≈ 2.0 every window, OOS mean ≈ −0.3 → argmax-IS selects noise in a 14-dim space. B vs FC vs FH nearly identical (shared cycles dominate; banking rule is second-order at these params). oneSided clearly worst (−25.3%). Artifact walkforward-v1.json. Next: regularized selection + smaller space. |

| V2 | 2026-06-11 | all 4 | WF as V1 but space=core (8 dims, structural frozen), select = top-20-by-IS-⅔ validated on IS-⅓ | B −0.04, FC −0.03, FH −0.06, 1S −0.52 | B 14.3% | Better selection: B from −0.32 → −0.04 (breakeven). Dual-grid system has ~no net OOS edge after costs at this structure. Counters show derisks ≫ unwinds — aborted cycles pay taker round-trips on full inventory; that's the bleed. Artifact walkforward-v2.json. |
| V3 | 2026-06-11 | all 4 | V2 + 2 structural dials sampled: deriskSoft (cancel entries, keep TPs/stops, wind down passively) and initialFraction 0.25–1.0 (smaller arm-time inventory) | B −0.89, FC −0.90, FH −0.89, 1S −0.43 | B 18.0% | WORSE than V2. The 2 extra dims gave the optimizer more rope to overfit the 2-mo validation slice; winners show no stable preference on either dial (soft 6/9, initFrac 0.27–0.98). V2 stays best. Artifact walkforward-v3.json. |

| V4 | 2026-06-11 | all 4 | **lowChurn space** (300 samples, select=val): confirmBars 4–8, erLow 0.12–0.25, cooldownBars 24–64, deriskAfterBars 12–32, deriskSoft=1 (passive), gridLevels 7–15, atrMult 6–14, anchorMaxOffset 0.3–0.5 (plumbed through), initialFraction∈{0.5,1.0} | **B +0.85**, FC +0.84, FH +0.87, 1S −0.80 (B&H +0.14) | B **10.4%** | **BREAKTHROUGH.** +14.8% stitched OOS return at 10.4% DD — clears the ≥0.5 decision threshold. The fee-bleed thesis is confirmed: cutting cycle turnover (stricter regime entry + passive soft wind-down + coarser/central grids + longer cooldowns) is what unlocks the edge, not the banking rule. B vs FC vs FH STILL indistinguishable (Δ ≤ 0.03 Sharpe) — partial-close remains structurally inert even where the strategy is profitable. oneSided still clearly worst. Artifact walkforward-v4.json. |
| V5 | 2026-06-11 | all 4 | **noInit space** (300 samples, select=val): initialFraction=0 both legs, bankAt 0.35–0.6, otherwise core (structural frozen at defaults) | B −0.83, FC −0.83, FH −0.82, 1S −1.38 | B 13.0% | FAIL. Removing arm-time inventory entirely degrades B to baseline-(a)-like behavior with negative edge; the hedge cannot come from churn lots alone at the default (high-churn) structure. The churn reduction in V4 — not the inventory removal — is the active ingredient. Artifact walkforward-v5.json. |
| V6 | 2026-06-11 | all 4 | **lowChurn space + median-ensemble selection** (300 samples, select=median): per-parameter median of the top-20 validated candidates per window instead of argmax | B +0.07, FC +0.07, FH +0.07, 1S −0.76 | B 10.2% | Median ensemble under-performs val-selection on this space (0.07 vs V4's 0.85). Parameter averaging across diverse window winners smears out the operating point — the lowChurn edge needs coherent params, not a centroid. Low DD (10.2%) preserved but near-zero return. V4 (val) remains best. Artifact walkforward-v6.json. |

## Decision rule outcome (post-V6)
- 2026-06-11 — Best stitched OOS B Sharpe after V6 = **0.85 (V4)** ≥ 0.5 → rule permits ≤2 optional
  refinement variants (V7–V8) then Phase 4. **V7–V8 skipped** (optional under the rule): V4 already
  clears the threshold at low DD, and the central question is settled (B≈FC≈FH in every variant).
  Proceeding to Phase 4 Monte Carlo robustness on **walkforward-v4**. Variant budget used: 6 / 40.

## Diagnostics
- 2026-06-11 — **Fee decomposition** (V2 winners, fixed params over full OOS-union span, mode B):
  fees consume $1,000–2,400 per $10k per 18 months (≈8–16%/yr); funding ≈ 0 (small net credit).
  Gross (zero-fee) Sharpe mostly −0.2…+0.25 → the edge is weak even before costs; net is negative.
  The bleed is cycle turnover (taker initial inventory at every anchor + taker close at every
  derisk/stop, ~8–10 cycles/month), not the maker grid churn itself.
- 2026-06-11 — **Central question, preliminary answer:** B vs fullClose vs fullHold are
  indistinguishable in every variant and every window (Δ Sharpe ≤ 0.03, Δ maxDD ≤ 0.3pp).
  The favorable leg's remaining inventory at bank time is small relative to cycle variance,
  so the partial-close fraction is a second-order dial in this construction.

## Decisions
- 2026-06-11 — Engine arms grids at next 1m open with Pionex-style initial inventory on the
  TP side; without it the favorable leg is near-flat at bank time and Strategy B degenerates
  into baseline (a) by construction.
- 2026-06-11 — Anchor = rolling 7d Donchian midpoint; half-width k·ATR(30m,14) clamped to
  [2%, 8%] of price; anchor refused when |price − center| > 0.6·halfWidth.

---

# FINAL REPORT — Strategy B (dual-grid partial-hedge mean reversion)

**Date:** 2026-06-11 · **Variant budget used:** 6 / 40 · **Holdout:** SKIPPED (pre-registered gate;
no candidate met the robustness bar — see below). The 2026-02-11 → 2026-06-11 tail remains untouched.

## Central question — does partial-close improve risk-adjusted results vs (a) full-close, (b) full-hold, (c) one-sided?

**No. Partial-close is structurally inert.** Across every variant and every walk-forward window, Strategy B
is indistinguishable from fullClose and fullHold (Δ Sharpe ≤ 0.03, Δ maxDD ≤ 0.3pp) — including at the
*profitable* V4 operating point (B 0.85 / FC 0.84 / FH 0.87). The favorable leg's grid TPs empty its
inventory before the banking trigger fires, so the retained-hedge fraction is a second-order dial. The
one-sided baseline (c) is decisively worst everywhere (V4: −0.80 Sharpe, 45% maxDD). If anything,
full-hold is marginally best — the partial close gives up a sliver of expectancy for no risk reduction.

## Target attainment (Sharpe ≥ 1.1, maxDD ≤ 20%)

| | Stitched OOS (V4, best) | Verdict |
|---|---|---|
| Sharpe ≥ 1.1 | B 0.85 / FH 0.87 | ✗ not met on stitched OOS |
| maxDD ≤ 20% | B 10.4% | ✓ met (comfortably) |

Individual MC candidates exceed Sharpe 1.1 on the full-span single run (base 1.0–1.66), but none survives
the robustness gate. Stitched OOS — the honest, multi-window number — tops out at 0.87.

## Fee / funding decomposition and the turnover mechanism

- Funding ≈ 0 (small net credit) — not a driver.
- Fee bleed dominates: at the high-churn default structure (V0–V3) fees consumed ~8–16%/yr
  ($1,000–2,400 per $10k over 18mo), turning a near-zero gross edge net-negative.
- Mechanism: taker initial inventory opened at **every** anchor + taker close at **every** derisk/stop,
  at ~8–10 cycles/month. The maker grid churn itself is cheap; the **cycle turnover** is the cost.
- **What unlocked the edge (V4):** cutting turnover, not changing the banking rule. Stricter regime entry
  (confirmBars 4–8, erLow 0.12–0.25), passive soft wind-down (deriskSoft=1, no taker dump), longer
  cooldowns (24–64 bars), coarser/central grids (7–15 levels, anchorMaxOffset 0.3–0.5). Fewer, longer
  cycles → fee drag collapses → net edge flips positive (+14.8% at 10.4% DD). V5 (no inventory) confirms
  the inverse: removing arm-time inventory without reducing churn degrades back to negative.

## Robustness summary (Monte Carlo on walkforward-v4, 1000 boots × 40 perturbs, span 2024-08→2026-02)

- **Bootstrap (7-day block, mode-B daily returns):** central tendency is good — base full-span Sharpe
  0.57–1.66, bootstrap median 0.47–1.66. But the tail is thin: bootstrap p5 Sharpe is positive for only
  two candidates (W4 0.31, W6 0.19) and negative for the other seven.
- **Perturbation (±15% on every continuous param):** the killer. Perturbation p5 Sharpe ranges −0.72…+0.50;
  the best (W5 0.50) still misses 0.5×base by a hair. High-Sharpe peaks are parameter-fragile — a modest
  mis-specification drags the 5th-percentile negative.
- **Cross-window stability:** distances 0.38–0.51 — moderate; no single window's winner sits close to the
  cross-window median, consistent with the peaks being sharp rather than broad.
- **Pre-registered gate outcome:** rank by bootstrap p5 → discard fragile (perturbation p5 < 0.5×base OR
  bootstrap p95 maxDD > 25%) → **0 survivors.** Recommendation honored: skip the holdout.

## Limitations

Single asset (ETH/USDT perp), single timeframe (30m signal / 1m fills), ~2-year window. Deterministic
intra-candle path (1m OHLC, no tick sequence). Maker fills assumed at level touch with no queue-position
modeling (optimistic). 30-minute regime granularity. Results are an upper bound on a strategy that is, at
best, a parameter-fragile market-neutral grid whose partial-hedge feature adds nothing measurable.

## Bottom line

Strategy B's defining feature (partial close + retained hedge) does not earn its complexity: it tracks its
own baselines to within noise in every test. Churn reduction makes the *underlying dual-grid* profitable in
walk-forward (Sharpe ~0.85, DD ~10%), but that operating point is not robust to parameter perturbation and
does not reach the Sharpe ≥ 1.1 bar on honest stitched OOS. Verdict: **do not promote to a holdout / live
candidate.** The reusable wins are the diagnostic finding (turnover is the cost center) and the research
harness (anatomy / walk-forward / robustness dashboard, MC primitives) for the next strategy.

## Known caveats (pre-commit review, 2026-10-05)

- **Stop-skip bug (fixed after these runs):** the fill simulator skipped a hard stop when a leg was
  flat at the start of a 1m path segment but bought on the way down through its stop within that
  segment. The bug was optimistic, so the V0–V6 and Monte Carlo numbers above are upper bounds;
  the "do not promote" verdict stands. Artifacts were not regenerated.
- **`w` (invalidationAtrMult) is display-only.** It does not change trading behaviour; it only
  floors the stop distance (`stopAtrMult = w + …`) and draws the invalidation zone. It was still a
  searched dimension, adding overfitting room without a real lever.
- **maxDD is measured on daily-close equity**, which understates intraday drawdown vs the 20% cap.
- **Window boundaries skip fees:** each OOS window starts with positions opened during its 14-day
  warmup (entry fees charged before normalization) and ends marked-to-market (no exit fee).
- **MC full-span runs overlap IS:** each candidate's full-span base run includes the periods it was
  tuned on, so base/bootstrap Sharpes are optimistic — which only strengthens the negative verdict.
