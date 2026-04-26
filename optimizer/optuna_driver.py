#!/usr/bin/env python3
"""
Bayesian (TPE) hyperparameter search for the Combo Bot via Optuna.

One trial = one POST to /api/walk-forward, which runs the combo supervisor across
every OOS fold with the trial's parameter set and returns a stitched-OOS fitness
score. Optuna maximizes that fitness.

Usage:
    # Start the Next.js dev server first:
    #   npm run dev
    # Seed ETH 5m candles + funding rates for your target window via the existing
    # /api/candles POST endpoint.

    python optimizer/optuna_driver.py \\
        --study combo-eth-202604 \\
        --n-trials 200 \\
        --symbol ETHUSDT \\
        --start 2022-01-01 \\
        --end   2026-04-24 \\
        --train-candles 103680 \\
        --oos-candles   25920 \\
        --step-candles  25920 \\
        --total-capital 10000 \\
        --fee-rate      0.0004

Storage:
    SQLite study file at `./optimizer/optuna_studies/{study}.db` — resumable across runs.
"""

from __future__ import annotations
import argparse
import os
import sys
from pathlib import Path

try:
    import optuna
    import requests
except ImportError:
    sys.stderr.write(
        "Missing dependencies. Install with:\n"
        "    pip install -r optimizer/requirements.txt\n"
    )
    sys.exit(2)


def build_combo_cfg(trial: "optuna.Trial") -> dict:
    """Search space for the Combo Bot v3.1 parameters."""
    long_side = {
        "averagingDepth":    trial.suggest_int("long_avg_depth", 3, 8),
        "slBasePercent":     trial.suggest_float("long_sl_base", 0.005, 0.03),
        "slAtrMultiplier":   trial.suggest_float("long_sl_atr_mult", 0.5, 3.0),
        "slFloor":           0.005,
        "slCap":             0.05,
        "tier1Size":         trial.suggest_float("long_tier1", 0.15, 0.35),
        "tier2Size":         trial.suggest_float("long_tier2", 0.35, 0.65),
        "tier3Size":         1.0,
        "cooldownCandles":   trial.suggest_int("long_cooldown", 6, 24),
        "retryCap":          trial.suggest_int("long_retry_cap", 2, 4),
        "hibernationCandles": trial.suggest_int("long_hibernation", 144, 576),
    }
    short_side = {
        "averagingDepth":    trial.suggest_int("short_avg_depth", 2, 5),
        "slBasePercent":     trial.suggest_float("short_sl_base", 0.005, 0.03),
        "slAtrMultiplier":   trial.suggest_float("short_sl_atr_mult", 0.5, 3.0),
        "slFloor":           0.005,
        "slCap":             0.05,
        "tier1Size":         trial.suggest_float("short_tier1", 0.15, 0.35),
        "tier2Size":         trial.suggest_float("short_tier2", 0.35, 0.65),
        "tier3Size":         1.0,
        "cooldownCandles":   trial.suggest_int("short_cooldown", 6, 24),
        "retryCap":          trial.suggest_int("short_retry_cap", 2, 4),
        "hibernationCandles": trial.suggest_int("short_hibernation", 144, 576),
    }
    return {
        "enabled":           True,
        "mode":              trial.suggest_categorical("mode", ["dual", "long", "short"]),
        "leverage":          trial.suggest_int("leverage", 3, 10),
        "allocationLong":    trial.suggest_float("allocation_long", 0.5, 0.75),
        "avwapEnabled":      trial.suggest_categorical("avwap_enabled", [True, False]),
        "longSide":          long_side,
        "shortSide":         short_side,
        "atrPeriod":         trial.suggest_int("atr_period", 7, 21),
        "erLookback":        trial.suggest_int("er_lookback", 5, 20),
        "erSmoothingLength": trial.suggest_int("er_smoothing", 2, 6),
        "erRegimeThreshold": trial.suggest_float("er_regime_threshold", 0.4, 0.75),
        "rsiLongThreshold":  trial.suggest_float("rsi_long", 25, 45),
        "rsiShortThreshold": trial.suggest_float("rsi_short", 55, 75),
    }


def objective_factory(args: argparse.Namespace):
    url = f"{args.api_base}/api/walk-forward"

    def objective(trial: "optuna.Trial") -> float:
        combo_cfg = build_combo_cfg(trial)
        payload = {
            "symbol":       args.symbol,
            "startTime":    args.start,
            "endTime":      args.end,
            "trainCandles": args.train_candles,
            "oosCandles":   args.oos_candles,
            "stepCandles":  args.step_candles,
            "comboCfg":     combo_cfg,
            "totalCapital": args.total_capital,
            "feeRate":      args.fee_rate,
        }
        try:
            resp = requests.post(url, json=payload, timeout=args.timeout)
        except requests.exceptions.RequestException as e:
            print(f"[trial {trial.number}] request failed: {e}", file=sys.stderr)
            raise optuna.TrialPruned()

        if resp.status_code != 200:
            print(f"[trial {trial.number}] HTTP {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
            raise optuna.TrialPruned()

        data = resp.json()
        stitched = data.get("stitched", {})
        fitness = float(stitched.get("fitness", 0.0))
        trial.set_user_attr("primary",       float(stitched.get("primary", 0.0)))
        trial.set_user_attr("usedPSR",       bool(stitched.get("usedPSR", False)))
        trial.set_user_attr("stability",     float(stitched.get("stability", 0.0)))
        trial.set_user_attr("maxDrawdownPct", float(stitched.get("maxDrawdownPct", 0.0)))
        trial.set_user_attr("nTradesTotal",  int(stitched.get("nTradesTotal", 0)))
        trial.set_user_attr("foldCount",     len(data.get("folds", [])))
        return fitness

    return objective


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Combo Bot Bayesian search via Optuna")
    p.add_argument("--study",         required=True)
    p.add_argument("--n-trials",      type=int, default=200)
    p.add_argument("--symbol",        required=True)
    p.add_argument("--start",         required=True)
    p.add_argument("--end",           required=True)
    p.add_argument("--train-candles", type=int, required=True)
    p.add_argument("--oos-candles",   type=int, required=True)
    p.add_argument("--step-candles",  type=int, required=True)
    p.add_argument("--total-capital", type=float, default=10000)
    p.add_argument("--fee-rate",      type=float, default=0.0004)
    p.add_argument("--api-base",      default="http://localhost:3000")
    p.add_argument("--timeout",       type=int, default=300)
    p.add_argument("--storage-dir",   default="./optimizer/optuna_studies")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    storage_dir = Path(args.storage_dir)
    storage_dir.mkdir(parents=True, exist_ok=True)
    storage_url = f"sqlite:///{storage_dir}/{args.study}.db"

    study = optuna.create_study(
        study_name=args.study,
        storage=storage_url,
        direction="maximize",
        sampler=optuna.samplers.TPESampler(n_startup_trials=20, multivariate=True),
        load_if_exists=True,
    )
    study.optimize(objective_factory(args), n_trials=args.n_trials, show_progress_bar=True)

    print("\n=== Best trial ===")
    print(f"  fitness: {study.best_value:.6f}")
    for k, v in study.best_params.items():
        print(f"  {k}: {v}")
    if study.best_trial.user_attrs:
        print("  attrs:")
        for k, v in study.best_trial.user_attrs.items():
            print(f"    {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
