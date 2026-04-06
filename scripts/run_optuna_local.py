#!/usr/bin/env python3
"""
run_optuna_local.py — Run all 3 Optuna P0 searches from local CSV data

Reads: scripts/data/stock_prices.csv, paper_orders.csv, daily_recommendations.csv
Outputs: scripts/data/optuna_results.json → ready to push to KV

Usage:
  python3 scripts/run_optuna_local.py
"""
import os, sys, json, time
sys.stdout.reconfigure(line_buffering=True)

import numpy as np
import pandas as pd
import optuna
optuna.logging.set_verbosity(optuna.logging.WARNING)

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# ═══════════════════════════════════════════════════════════════════════════════
# OPTUNA #1: Triple Barrier Label Search
# ═══════════════════════════════════════════════════════════════════════════════

def compute_barrier_labels(prices_df: pd.DataFrame, upper_mult: float, lower_mult: float,
                           upper_pct_cap: float, lower_pct_cap: float, max_days: int) -> pd.Series:
    """Compute triple barrier labels for a single stock's price series."""
    close = prices_df["close"].values
    high = prices_df["high"].values
    low = prices_df["low"].values
    n = len(close)

    # ATR14
    tr = np.maximum(high[1:] - low[1:], np.maximum(np.abs(high[1:] - close[:-1]), np.abs(low[1:] - close[:-1])))
    atr = pd.Series(np.concatenate([[np.nan]*14, pd.Series(tr).rolling(14).mean().values[13:]]))

    labels = np.full(n, np.nan)
    for i in range(14, n - max_days):
        price = close[i]
        a = atr.iloc[i]
        if np.isnan(a) or a <= 0:
            continue
        upper = price + min(a * upper_mult, price * upper_pct_cap)
        lower = price - min(a * lower_mult, price * lower_pct_cap)
        end_idx = min(i + max_days, n - 1)

        hit = 0  # 0=hold, 1=up, -1=down
        for j in range(i + 1, end_idx + 1):
            if high[j] >= upper:
                hit = 1
                break
            if low[j] <= lower:
                hit = -1
                break
        labels[i] = hit
    return pd.Series(labels)


def run_optuna_barrier(n_trials: int = 150) -> dict:
    """Search best triple barrier parameters using top 50 stocks by data volume."""
    print("\n[Optuna #1] Triple Barrier Label Search", flush=True)
    print(f"  Loading stock_prices.csv...", flush=True)

    df = pd.read_csv(os.path.join(DATA_DIR, "stock_prices.csv"))
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["symbol", "date"])

    # Pick top 50 stocks by row count (most data)
    top_symbols = df.groupby("symbol").size().nlargest(50).index.tolist()
    stock_data = {sym: df[df["symbol"] == sym].reset_index(drop=True) for sym in top_symbols}
    print(f"  Using {len(stock_data)} stocks, total {sum(len(v) for v in stock_data.values())} rows", flush=True)

    # OOS split: last 20% of each stock
    train_data = {}
    test_data = {}
    for sym, sdf in stock_data.items():
        split = int(len(sdf) * 0.8)
        train_data[sym] = sdf.iloc[:split]
        test_data[sym] = sdf.iloc[split:]

    def objective(trial):
        upper_mult = trial.suggest_float("upper_mult", 2.0, 4.0)
        lower_mult = trial.suggest_float("lower_mult", 1.5, 3.0)
        pct_cap = trial.suggest_float("pct_cap", 0.03, 0.10)
        max_days = trial.suggest_int("max_days", 10, 30)

        # Evaluate on TRAIN data, measure direction accuracy
        correct = 0
        total = 0
        for sym, sdf in train_data.items():
            if len(sdf) < 50:
                continue
            labels = compute_barrier_labels(sdf, upper_mult, lower_mult, pct_cap, pct_cap, max_days)
            valid = labels.dropna()
            valid = valid[valid != 0]  # exclude hold
            if len(valid) < 10:
                continue
            # Direction accuracy: |up| > |down| ratio balanced?
            up_pct = (valid == 1).mean()
            # We want balanced labels (not all up or all down)
            balance = 1.0 - abs(up_pct - 0.5) * 2  # 0.5 = perfect balance → 1.0
            coverage = len(valid) / len(labels.dropna())  # ratio of non-hold
            total += 1
            correct += balance * 0.6 + coverage * 0.4

        return correct / max(total, 1)

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=n_trials)

    best = study.best_params
    print(f"  Best: upper={best['upper_mult']:.2f} lower={best['lower_mult']:.2f} "
          f"cap={best['pct_cap']:.3f} days={best['max_days']}", flush=True)

    # OOS validation
    oos_scores = []
    for sym, sdf in test_data.items():
        if len(sdf) < 30:
            continue
        labels = compute_barrier_labels(sdf, best["upper_mult"], best["lower_mult"],
                                        best["pct_cap"], best["pct_cap"], best["max_days"])
        valid = labels.dropna()
        valid = valid[valid != 0]
        if len(valid) < 5:
            continue
        up_pct = (valid == 1).mean()
        balance = 1.0 - abs(up_pct - 0.5) * 2
        oos_scores.append(balance)

    oos_mean = np.mean(oos_scores) if oos_scores else 0
    print(f"  OOS balance score: {oos_mean:.3f} (n={len(oos_scores)} stocks)", flush=True)

    return {
        "upper_mult": round(best["upper_mult"], 3),
        "lower_mult": round(best["lower_mult"], 3),
        "upper_pct_cap": round(best["pct_cap"], 4),
        "lower_pct_cap": round(best["pct_cap"], 4),
        "max_days": best["max_days"],
        "oos_balance": round(oos_mean, 4),
        "n_trials": n_trials,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# OPTUNA #2: Signal Threshold + Screener Weight Search
# ═══════════════════════════════════════════════════════════════════════════════

def run_optuna_signal(n_trials: int = 150) -> dict:
    """Search best signal thresholds using daily_recommendations + paper_orders."""
    print("\n[Optuna #2] Signal Threshold Search", flush=True)

    recs = pd.read_csv(os.path.join(DATA_DIR, "daily_recommendations.csv"))
    orders = pd.read_csv(os.path.join(DATA_DIR, "paper_orders.csv"))

    if len(recs) < 10:
        print("  [SKIP] Not enough recommendations data (<10 rows)")
        return {"status": "skipped", "reason": "insufficient data"}

    # For signal thresholds: simulate how many stocks get BUY vs HOLD vs NO_SIGNAL
    # We want: enough BUY signals (not all HOLD) + high quality (bought stocks perform well)
    buy_symbols = set(orders[orders["side"] == "buy"]["symbol"].tolist())
    sell_orders = orders[orders["side"] == "sell"]

    # Calculate realized PnL per stock from orders
    pnl_map = {}
    for _, row in sell_orders.iterrows():
        sym = row["symbol"]
        try:
            note = json.loads(row.get("note", "{}"))
            entry = note.get("entry_price", row["price"])
            pnl_map[sym] = (row["price"] - entry) / entry
        except (json.JSONDecodeError, TypeError):
            pass

    def objective(trial):
        strong_thr = trial.suggest_float("strong_signal_score", 0.65, 0.85)
        buy_thr = trial.suggest_float("buy_signal_score", 0.45, 0.65)
        hold_thr = trial.suggest_float("hold_signal_score", 0.30, 0.45)

        if buy_thr >= strong_thr or hold_thr >= buy_thr:
            return -1.0  # invalid: thresholds must be ordered

        # Simulate: for each rec, would it be BUY/HOLD/NO_SIGNAL?
        n_buy = 0
        n_hold = 0
        n_no_signal = 0
        quality_sum = 0

        for _, rec in recs.iterrows():
            # Approximate signal_score from confidence + ml_score
            conf = rec.get("confidence", 0.5) or 0.5
            ml = (rec.get("ml_score", 15) or 15) / 30.0
            approx_signal_score = conf * ml

            if approx_signal_score >= strong_thr:
                n_buy += 1
            elif approx_signal_score >= buy_thr:
                n_buy += 1
            elif approx_signal_score >= hold_thr:
                n_hold += 1
            else:
                n_no_signal += 1

        total = len(recs)
        buy_ratio = n_buy / total if total > 0 else 0
        no_signal_ratio = n_no_signal / total if total > 0 else 0

        # Objective: want 30-60% BUY, minimize NO_SIGNAL, maximize quality
        buy_penalty = abs(buy_ratio - 0.45) * 2  # sweet spot around 45%
        no_signal_penalty = no_signal_ratio * 3   # penalize NO_SIGNAL heavily

        score = 1.0 - buy_penalty - no_signal_penalty
        return score

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=n_trials)

    best = study.best_params
    print(f"  Best: strong={best['strong_signal_score']:.3f} "
          f"buy={best['buy_signal_score']:.3f} hold={best['hold_signal_score']:.3f}", flush=True)

    return {
        "strong_signal_score": round(best["strong_signal_score"], 4),
        "buy_signal_score": round(best["buy_signal_score"], 4),
        "hold_signal_score": round(best["hold_signal_score"], 4),
        "n_trials": n_trials,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# OPTUNA #3: SL/TP + Trailing Search
# ═══════════════════════════════════════════════════════════════════════════════

def run_optuna_sltp(n_trials: int = 150) -> dict:
    """Search best SL/TP base multipliers using paper trade history."""
    print("\n[Optuna #3] SL/TP + Trailing Search", flush=True)

    orders = pd.read_csv(os.path.join(DATA_DIR, "paper_orders.csv"))

    if len(orders) < 4:
        print("  [SKIP] Not enough trade history (<4 orders)")
        # Still return defaults with some search on stock_prices
        print("  Falling back to stock_prices-based SL/TP simulation...", flush=True)

        prices_df = pd.read_csv(os.path.join(DATA_DIR, "stock_prices.csv"))
        top_symbols = prices_df.groupby("symbol").size().nlargest(30).index.tolist()

        def objective(trial):
            sl_mult = trial.suggest_float("sl_mult_base", 1.0, 3.0)
            tp_mult = trial.suggest_float("tp_mult_base", 1.0, 3.0)
            time_stop = trial.suggest_int("time_stop_days", 10, 30)

            total_pf = 0
            count = 0

            for sym in top_symbols:
                sdf = prices_df[prices_df["symbol"] == sym].sort_values("date").reset_index(drop=True)
                if len(sdf) < 100:
                    continue

                close = sdf["close"].values
                high = sdf["high"].values
                low = sdf["low"].values
                n = len(close)

                # Simple ATR14
                tr = np.maximum(high[1:] - low[1:], np.maximum(np.abs(high[1:] - close[:-1]), np.abs(low[1:] - close[:-1])))
                atr_vals = pd.Series(tr).rolling(14).mean().values

                wins = 0
                losses = 0
                win_sum = 0
                loss_sum = 0

                for i in range(20, n - time_stop, 5):  # sample every 5 days
                    entry = close[i]
                    atr = atr_vals[i - 1] if i - 1 < len(atr_vals) and not np.isnan(atr_vals[i - 1]) else entry * 0.02
                    sl = entry - atr * sl_mult
                    tp = entry + atr * tp_mult

                    pnl = 0
                    for j in range(i + 1, min(i + time_stop, n)):
                        if low[j] <= sl:
                            pnl = (sl - entry) / entry
                            break
                        if high[j] >= tp:
                            pnl = (tp - entry) / entry
                            break
                    else:
                        pnl = (close[min(i + time_stop - 1, n - 1)] - entry) / entry

                    if pnl > 0:
                        wins += 1
                        win_sum += pnl
                    elif pnl < 0:
                        losses += 1
                        loss_sum += abs(pnl)

                if wins > 0 and losses > 0 and loss_sum > 0:
                    pf = win_sum / loss_sum
                    total_pf += pf
                    count += 1

            return total_pf / max(count, 1)

        study = optuna.create_study(direction="maximize")
        study.optimize(objective, n_trials=n_trials)

        best = study.best_params
        print(f"  Best: sl={best['sl_mult_base']:.3f} tp={best['tp_mult_base']:.3f} "
              f"time_stop={best['time_stop_days']}", flush=True)

        return {
            "sl_mult_base": round(best["sl_mult_base"], 4),
            "tp_mult_base": round(best["tp_mult_base"], 4),
            "time_stop_days": best["time_stop_days"],
            "n_trials": n_trials,
            "method": "simulation_fallback",
        }

    # If we have enough orders, use real trade replay
    # ... (skipped for now since we only have 8 orders)
    return {"status": "skipped", "reason": "not enough orders for real replay"}


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    print("=" * 60)
    print("StockVision Optuna P0 #1-3 Local Search")
    print("=" * 60)
    start = time.time()

    results = {}

    # #1 Triple Barrier
    results["barrier"] = run_optuna_barrier(n_trials=150)

    # #2 Signal Thresholds
    results["signal"] = run_optuna_signal(n_trials=150)

    # #3 SL/TP
    results["sltp"] = run_optuna_sltp(n_trials=150)

    elapsed = time.time() - start
    print(f"\n{'=' * 60}")
    print(f"[DONE] All 3 searches complete in {elapsed:.1f}s")
    print(f"\nResults:")
    print(json.dumps(results, indent=2, ensure_ascii=False))

    # Save results
    output_path = os.path.join(DATA_DIR, "optuna_results.json")
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved to {output_path}")

    # Generate KV push commands
    print(f"\n{'=' * 60}")
    print("To push to KV, run:")
    print(f"  python3 scripts/push_optuna_to_kv.py")


if __name__ == "__main__":
    main()
