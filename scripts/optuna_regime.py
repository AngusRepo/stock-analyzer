#!/usr/bin/env python3
"""
optuna_regime.py — P3#32 Per-Regime Optuna Parameter Search

⚠️ DEPRECATED (2026-04-07) — 不要再跑這個 script

原因:
  1. 本 script 是 quantile-based 本地 HMM labelling + 本地 Optuna 搜 SL/TP，
     寫 KV `ml:regime_config`。
  2. 正確的 single source of truth 是 `ml-service/app/regime.py` (GaussianHMM)，
     見 CLAUDE.md KV/Optuna/Hardcode 規則。
  3. 未來 per-regime Optuna search 會走:
     - Sprint 6 backtest engine `engine.replay_per_regime(...)`
     - Sprint 7+ Robust Optimization (per-regime min)
     - 統一透過 `ml-controller/routers` + Worker `/api/admin/optuna-push`
  4. 本 script 直接寫本地 JSON + 人工 wrangler kv put，
     違反「Optuna script 必須直接 push KV (透過統一閘門)」的 CLAUDE.md 規則。

遷移計畫: 見 memory/project_regime_pipeline_broken.md

── 以下為原始 doc，保留供 Sprint 6+ 參考 ──

Uses HMM to label each trading day with a regime (0-3),
then searches optimal SL/TP/signal thresholds per regime.

Reads: scripts/data/stock_prices.csv (local, no D1 dependency)
Output: scripts/data/regime_params.json → push to KV ml:regime_config

Usage:
  python3 scripts/optuna_regime.py
"""
import sys as _sys
print("⚠️ DEPRECATED — 見 docstring。Sprint 6+ 會改走 ml-controller 統一閘門。", file=_sys.stderr)
print("   現階段執行中斷以避免誤污染 KV ml:regime_config。若要手動強制跑，移除此 exit。", file=_sys.stderr)
_sys.exit(1)
import os, sys, json, time
sys.stdout.reconfigure(line_buffering=True)

import numpy as np
import pandas as pd
import optuna
optuna.logging.set_verbosity(optuna.logging.WARNING)

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


# ── Simple HMM Regime Detection (standalone, no ml-service dependency) ──────

def detect_regimes(market_returns: np.ndarray, n_regimes: int = 4) -> np.ndarray:
    """
    Simple regime detection using return statistics.
    No hmmlearn dependency — uses quantile-based classification.

    Regimes:
      0: Low vol bull (return > 0, vol < median)
      1: High vol bull (return > 0, vol >= median)
      2: Choppy (|return| < threshold)
      3: Bear crisis (return < 0, vol >= median)
    """
    n = len(market_returns)
    vol = pd.Series(market_returns).rolling(20).std().values
    ret_20d = pd.Series(market_returns).rolling(20).mean().values

    vol_median = np.nanmedian(vol)
    ret_threshold = np.nanpercentile(np.abs(ret_20d[~np.isnan(ret_20d)]), 30)

    regimes = np.zeros(n, dtype=int)
    for i in range(n):
        if np.isnan(vol[i]) or np.isnan(ret_20d[i]):
            regimes[i] = 2  # default choppy
            continue

        if abs(ret_20d[i]) < ret_threshold:
            regimes[i] = 2  # choppy
        elif ret_20d[i] > 0 and vol[i] < vol_median:
            regimes[i] = 0  # low vol bull
        elif ret_20d[i] > 0 and vol[i] >= vol_median:
            regimes[i] = 1  # high vol bull
        else:
            regimes[i] = 3  # bear

    return regimes


# ── Backtest simulator (per regime) ──────────────────────────────────────────

def simulate_trades_with_regime(
    prices_df: pd.DataFrame, regimes: np.ndarray,
    sl_mult: float, tp_mult: float, time_stop: int,
    target_regime: int,
) -> list[float]:
    """Run simplified backtest, only count trades that START in target_regime."""
    BUY_FEE = 0.001425
    SELL_FEE = 0.004425

    symbols = prices_df["symbol"].unique()
    pnls = []

    for sym in np.random.choice(symbols, min(100, len(symbols)), replace=False):
        sdf = prices_df[prices_df["symbol"] == sym].reset_index(drop=True)
        if len(sdf) < 60:
            continue

        close = sdf["close"].values
        high = sdf["high"].values
        low = sdf["low"].values
        n = len(close)

        # ATR14
        tr = np.maximum(high[1:] - low[1:],
                        np.maximum(np.abs(high[1:] - close[:-1]),
                                   np.abs(low[1:] - close[:-1])))
        atr_arr = pd.Series(tr).rolling(14).mean().values

        # MA20
        ma20 = pd.Series(close).rolling(20).mean().values

        i = 30
        while i < n - time_stop:
            # Only trade in target regime
            regime_idx = min(i, len(regimes) - 1)
            if regimes[regime_idx] != target_regime:
                i += 1
                continue

            # Simple entry: close > MA20
            if close[i] <= ma20[i]:
                i += 1
                continue

            entry = close[i]
            atr = atr_arr[i - 1] if i - 1 < len(atr_arr) and not np.isnan(atr_arr[i - 1]) else entry * 0.02
            sl = entry - atr * sl_mult
            tp = entry + atr * tp_mult

            exit_price = None
            for j in range(i + 1, min(i + time_stop, n)):
                if low[j] <= sl:
                    exit_price = sl
                    break
                if high[j] >= tp:
                    exit_price = tp
                    break
            else:
                exit_price = close[min(i + time_stop - 1, n - 1)]

            if exit_price:
                pnl = (exit_price - entry) / entry - BUY_FEE - SELL_FEE
                pnls.append(pnl)

            i = (j if exit_price else i) + 5

    return pnls


# ── Optuna search per regime ─────────────────────────────────────────────────

def search_regime_params(prices_df: pd.DataFrame, regimes: np.ndarray,
                         regime_id: int, n_trials: int = 100) -> dict:
    """Search optimal SL/TP/signal for a specific regime."""

    regime_names = {0: "Low Vol Bull", 1: "High Vol Bull", 2: "Choppy", 3: "Bear Crisis"}
    regime_count = np.sum(regimes == regime_id)
    print(f"\n  Regime {regime_id} ({regime_names.get(regime_id, '?')}): {regime_count} days", flush=True)

    if regime_count < 30:
        print(f"    [SKIP] Too few days for regime {regime_id}", flush=True)
        return {"status": "skipped", "reason": f"only {regime_count} days"}

    def objective(trial):
        sl = trial.suggest_float("sl_mult", 1.0, 3.0)
        tp = trial.suggest_float("tp_mult", 1.0, 4.0)
        ts = trial.suggest_int("time_stop", 10, 30)

        pnls = simulate_trades_with_regime(prices_df, regimes, sl, tp, ts, regime_id)
        if len(pnls) < 10:
            return -1.0

        pnls = np.array(pnls)
        wins = pnls[pnls > 0]
        losses = pnls[pnls <= 0]

        if len(losses) == 0 or np.sum(np.abs(losses)) == 0:
            return float(np.mean(pnls))

        pf = np.sum(wins) / np.sum(np.abs(losses)) if len(wins) > 0 else 0
        return pf

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=n_trials)

    best = study.best_params
    print(f"    Best: sl={best['sl_mult']:.3f} tp={best['tp_mult']:.3f} time_stop={best['time_stop']}", flush=True)
    print(f"    PF: {study.best_value:.3f}", flush=True)

    return {
        "sl_mult": round(best["sl_mult"], 4),
        "tp_mult": round(best["tp_mult"], 4),
        "time_stop": best["time_stop"],
        "profit_factor": round(study.best_value, 3),
        "n_days": int(regime_count),
        "n_trials": n_trials,
    }


def main():
    print("=" * 60)
    print("P3#32 Regime-Conditional Optuna Search")
    print("=" * 60)
    start = time.time()

    print("Loading stock_prices.csv...", flush=True)
    df = pd.read_csv(os.path.join(DATA_DIR, "stock_prices.csv"))
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["date", "symbol"])

    # Market return (use average daily return across all stocks as proxy)
    daily_returns = df.groupby("date")["close"].apply(
        lambda x: x.pct_change().mean()
    ).sort_index().values
    daily_returns = np.nan_to_num(daily_returns, nan=0.0)

    print(f"Market returns: {len(daily_returns)} days", flush=True)

    # Detect regimes
    regimes = detect_regimes(daily_returns)
    for r in range(4):
        count = np.sum(regimes == r)
        pct = count / len(regimes) * 100
        print(f"  Regime {r}: {count} days ({pct:.1f}%)", flush=True)

    # Expand regimes to match per-stock rows (map date → regime)
    dates_sorted = sorted(df["date"].unique())
    date_regime_map = {d: regimes[min(i, len(regimes)-1)] for i, d in enumerate(dates_sorted)}
    stock_regimes = np.array([date_regime_map.get(d, 2) for d in df["date"]])

    # Search per regime
    results = {}
    for regime_id in range(4):
        results[str(regime_id)] = search_regime_params(df, stock_regimes, regime_id, n_trials=100)

    elapsed = time.time() - start
    print(f"\n{'=' * 60}")
    print(f"[DONE] {elapsed:.1f}s")
    print(json.dumps(results, indent=2))

    # Save
    output_path = os.path.join(DATA_DIR, "regime_params.json")
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved to {output_path}")
    print(f"\nTo push to KV:")
    print(f"  Copy the regime_params into ml:regime_config via wrangler kv put")


if __name__ == "__main__":
    main()
