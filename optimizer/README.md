# Combo Bot — Bayesian optimizer (Optuna)

Python sidecar that performs TPE hyperparameter search against the Combo Bot by calling the Next.js app's `/api/walk-forward` endpoint.

## Why a separate Python process?

- Optuna's TPE sampler (multivariate, mature) is a much better fit than GA for expensive, 15-parameter, mixed continuous/discrete search.
- The app's simulation core stays in TypeScript. The Python driver is a thin client: each trial = one POST, one stitched-OOS fitness value.
- Studies are persisted to SQLite so runs are resumable.

## Prerequisites

```
python3 -m pip install -r optimizer/requirements.txt
```

You must have already:

1. Cached candles for your symbol/window via the existing `POST /api/candles` endpoint.
2. Cached funding rates via `POST /api/funding`.
3. Started the Next.js dev server (`npm run dev`) so the walk-forward endpoint is reachable.

## Typical run (ETH, 2022–2026)

```
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

Windowing:

- 5m candles: 12 per hour × 24 × 30 ≈ 8 640 / month
- 12-month train window ≈ 103 680 candles
- 3-month OOS window ≈ 25 920 candles
- Step 3 months ≈ 25 920 — overlapping folds

## What the driver optimizes

Fitness (`src/lib/optimizer/stitchedFitness.ts`):

```
fitness = primary * stability − λ * worstFoldMaxDrawdown
```

- `primary`: PSR if stitched trades ≥ 30, else plain Sharpe (critique point #5)
- `stability`: `1 − normalized_variance(per_fold_sharpes)`
- `λ = 0.2`

## Resuming studies

Rerun with the same `--study` name and Optuna picks up where it left off. Best trial so far is always available via:

```python
import optuna
study = optuna.load_study(study_name="...", storage="sqlite:///./optimizer/optuna_studies/....db")
print(study.best_params, study.best_value)
```

## Caveats

- Backtest fidelity ceiling: slippage and funding are modeled, but not liquidation cascades / ADL / insurance-fund dynamics. Expect 50–70% of backtest Sharpe in live (plan §Concerns).
- Fold-stability score ≠ parameter stability. This runner keeps one parameter set and measures consistency across OOS regimes. Classic per-fold inner optimization is not performed here.
- The `avwap_enabled` categorical dimension doubles as the v3.1 ablation knob (spec §11 q.2).
