# Phase 7 — End-to-end ETH acceptance runbook

The earlier phases ship tooling; Phase 7 is the live operation that validates the combo bot on ETH. The four network-dependent steps below must be run against a live dev server with internet access to Binance.

## Prerequisites

1. Dev server running: `npm run dev`
2. Python ≥ 3.10 with: `pip install -r optimizer/requirements.txt`
3. Free disk: ETH 5m from 2022 is ~40 MB of candles; funding rates are negligible.

---

## Step 1 — Seed data (option A: full 2022 → today window)

```bash
# In a second terminal, with `npm run dev` already running:
npx tsx scripts/seed-eth.ts
```

This POSTs to `/api/candles` and `/api/funding` which use the existing cache layers. Expect ~30–60 seconds for candles and ~5 seconds for funding rates.

To seed only the Jan 2026 → today single-fold view, add `--ytd`:

```bash
npx tsx scripts/seed-eth.ts --ytd
```

## Step 2 — Single-fold ETH YTD backtest (sanity check)

Open the app in a browser, enable the **Combo Bot (v3.1)** accordion, pick mode **Dual** (or Long-only / Short-only), set the window to **2026-01-01 → today**, and click **Run**.

The ComboPane renders when the resulting simulation has `comboBotEnabled = true`:
- Status strip shows mode + session + leverage + allocation
- Chart shows the candlestick series (combo overlays toggle independently — rendering hooks are an extension point, see Phase 6 note)
- Event timeline + event feed populate from `AdaptiveEvent` rows
- Bot deck reflects final per-side phase; P&L card shows realized/unrealized per side

Repeat with **Long-only** and **Short-only** modes to produce the three focused YTD reports the plan called for.

## Step 3 — Walk-forward + Bayesian optimizer

```bash
python optimizer/optuna_driver.py \
    --study combo-eth-2022-2026 \
    --n-trials 200 \
    --symbol ETHUSDT \
    --start 2022-01-01 \
    --end   2026-04-24 \
    --train-candles 103680 \
    --oos-candles   25920 \
    --step-candles  25920
```

Each trial posts to `/api/walk-forward` which runs the combo supervisor on every OOS window with the trial's parameter set and returns the stitched fitness. Expect **~60–120 minutes** for 200 trials on modest hardware; the TPE sampler converges well before trial 200.

SQLite study at `./optimizer/optuna_studies/combo-eth-2022-2026.db` is resumable — re-running the command picks up where the previous run left off.

## Step 4 — Acceptance verification

Per the plan's "End-to-end acceptance" section:

- [ ] 4.1 Best-trial stitched OOS Sharpe / PSR is reported (check `optuna_driver.py` output)
- [ ] 4.2 Fold-stability score is reasonable (>= 0.5 on the best trial)
- [ ] 4.3 At least one fold's `AdaptiveEvent` log contains all six lifecycle phases (IDLE → BREAKOUT → RUNNING → COOLDOWN → REOPENING → IDLE, plus hibernation if retries cap)
- [ ] 4.4 PSR is used (not plain Sharpe) when stitched N_trades ≥ 30
- [ ] 4.5 Max drawdown on stitched OOS curve is within spec expectations (< 25% ideally)
- [ ] 4.6 In the UI: load one fold's simulation; phase transitions match the AdaptiveEvent log; AVWAP anchors at the first ER > 0.6 candle; 4-light reopen board turns all green exactly at Tier 1 entry

## Step 5 — AVWAP ablation (spec §11 q.2)

Run the Optuna study a second time with `--study combo-eth-ablation` and toggle `avwap_enabled` to `False` in the search space (edit `optuna_driver.py` line that does `suggest_categorical('avwap_enabled', [True, False])` to fix it to `False`). Compare:

- Best trial fitness with AVWAP
- Best trial fitness without AVWAP

If AVWAP contributes meaningfully, the with-AVWAP fitness should be materially higher. This answers spec §11 q.2 (is AVWAP worth keeping?).

## Step 6 — Known scope limits

- **Entry/reopen conditions** in the supervisor are currently derived from adaptive signals using simple heuristics (see `supervisor.ts:evaluateConditions`). The full user-configurable `ConditionEvaluator` wiring is a follow-up scope item.
- **Grid orders underneath the combo supervisor** are synthetic market entries (`openMarketPosition` in `supervisor.ts`) — a single position per cycle, sized by tier. Real grid laddering underneath the combo layer is a follow-up (Phase 3d material).
- **Wallet-level liquidation** is not modeled; leverage is a P&L multiplier only (per Phase 0.3 decision).
- **Overlay chart primitives** — the overlay checkboxes in the ComboPane persist state but the TradingChart primitives that read that state (AVWAP line drawing, ATR band rendering, phase-transition vertical lines as primitives) are deliberately scoped as an extension point. The panel and state management ship complete.

These are honest caveats — the pipeline runs and produces stitched OOS fitness numbers; the fidelity ceiling follows the plan's "50–70% of backtest Sharpe in live" calibration.

---

## Troubleshooting

- **`POST /api/candles` returns a small count** → Binance may throttle; re-run the script, the cache is additive.
- **Optuna trials all return `fitness = 0`** → ensure `npm run dev` is running and `/api/walk-forward` is reachable. Test with: `curl -X POST http://localhost:3000/api/walk-forward -H 'Content-Type: application/json' -d '{"symbol":"ETHUSDT","startTime":"2024-01-01","endTime":"2024-02-01","trainCandles":5760,"oosCandles":1440,"stepCandles":1440,"comboCfg":{...},"totalCapital":10000,"feeRate":0.0004}'`
- **`prisma generate` needed** → run it any time the schema changes. Already done in earlier phases.
