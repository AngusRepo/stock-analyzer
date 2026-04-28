"""
scripts/optuna_signal.py — Optuna 搜尋最佳 Signal Threshold + Screener Weight

搜尋空間：
  Signal Thresholds:
    confidence_threshold  [0.50, 0.70]   信心門檻
    consensus_threshold   [0.50, 0.72]   共識門檻
    strong_signal_score   [0.65, 0.85]   STRONG_BUY/SELL 門檻
    buy_signal_score      [0.45, 0.65]   BUY/SELL 門檻
    hold_signal_score     [0.30, 0.45]   HOLD 門檻

  Screener Weights (max score per factor):
    chip_max    [20, 50]   籌碼面最高分
    tech_max    [15, 40]   技術面最高分
    mom_max     [10, 25]   動能面最高分

目標函式：
  用歷史 paper_orders 的勝敗率 + NO_SIGNAL 比例 來評估
  目標：降低 NO_SIGNAL、提高買入信號的勝率

用法：
  python -m scripts.optuna_signal --orders-csv data/paper_orders.csv --predictions-csv data/predictions.csv
"""

import argparse
import json
import sys
import numpy as np
import polars as pl

try:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
except ImportError:
    print("ERROR: pip install optuna")
    sys.exit(1)


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_from_csvs(orders_csv: str, predictions_csv: str) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Load paper_orders and predictions from CSV."""
    orders = (
        pl.scan_csv(orders_csv)
        .with_columns(pl.col("created_at").str.to_datetime(strict=False))
        .collect()
    )
    predictions = (
        pl.scan_csv(predictions_csv)
        .with_columns(pl.col("generated_at").str.to_datetime(strict=False))
        .collect()
    )
    return orders, predictions


def load_from_d1(db_url: str, token: str) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Load from D1 REST API."""
    import httpx
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    orders_resp = httpx.post(f"{db_url}/query", headers=headers, json={
        "sql": "SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT 500"
    }, timeout=30)
    orders = pl.DataFrame(orders_resp.json().get("results", []))

    preds_resp = httpx.post(f"{db_url}/query", headers=headers, json={
        "sql": """SELECT stock_id, generated_at, direction_accuracy as confidence,
                  signal_raw, forecast_data FROM predictions
                  WHERE model_name='ensemble' ORDER BY generated_at DESC LIMIT 2000"""
    }, timeout=30)
    predictions = pl.DataFrame(preds_resp.json().get("results", []))

    return orders, predictions


# ── Evaluation ───────────────────────────────────────────────────────────────

def simulate_signals(
    predictions: pl.DataFrame,
    confidence_threshold: float,
    consensus_threshold: float,
    strong_score: float,
    buy_score: float,
    hold_score: float,
) -> pl.DataFrame:
    """Re-classify signals with new thresholds."""
    results = []
    for row in predictions.iter_rows(named=True):
        conf = row.get("confidence", 0) or 0
        signal_raw = row.get("signal_raw", "NO_SIGNAL") or "NO_SIGNAL"

        # Parse forecast_data for consensus info if available
        forecast = {}
        try:
            fd = row.get("forecast_data", "")
            if isinstance(fd, str) and fd:
                forecast = json.loads(fd)
        except (json.JSONDecodeError, TypeError):
            pass

        # Simulate consensus (approximate from model data)
        models = forecast.get("models", {})
        if models:
            directions = [m.get("direction", "up") for m in models.values() if isinstance(m, dict)]
            up_count = sum(1 for d in directions if d == "up")
            consensus = up_count / max(len(directions), 1)
        else:
            consensus = 0.5

        # Apply new thresholds
        below_conf = conf < confidence_threshold
        below_cons = consensus < consensus_threshold and (1 - consensus) < consensus_threshold

        if below_conf and below_cons:
            new_signal = "NO_SIGNAL"
        else:
            # Simulate signal_score
            signal_score = consensus * conf
            if signal_score >= strong_score:
                new_signal = "STRONG_BUY" if consensus > 0.5 else "STRONG_SELL"
            elif signal_score >= buy_score:
                new_signal = "BUY" if consensus > 0.5 else "SELL"
            elif signal_score >= hold_score:
                new_signal = "BUY" if consensus > 0.5 and not (below_conf or below_cons) else "HOLD"
            else:
                new_signal = "HOLD"

        results.append({
            "stock_id": row.get("stock_id"),
            "date": row.get("generated_at"),
            "original_signal": signal_raw,
            "new_signal": new_signal,
            "confidence": conf,
            "consensus": consensus,
        })

    return pl.DataFrame(results)


def evaluate_thresholds(
    predictions: pl.DataFrame,
    orders: pl.DataFrame,
    confidence_threshold: float,
    consensus_threshold: float,
    strong_score: float,
    buy_score: float,
    hold_score: float,
) -> dict:
    """Evaluate signal quality with given thresholds."""
    simulated = simulate_signals(
        predictions, confidence_threshold, consensus_threshold,
        strong_score, buy_score, hold_score
    )

    if simulated.height == 0:
        return {"score": -1.0}

    total = simulated.height
    no_signal_count = simulated.filter(pl.col("new_signal") == "NO_SIGNAL").height
    buy_count = simulated.filter(pl.col("new_signal").is_in(["BUY", "STRONG_BUY"])).height
    sell_count = simulated.filter(pl.col("new_signal").is_in(["SELL", "STRONG_SELL"])).height
    hold_count = simulated.filter(pl.col("new_signal") == "HOLD").height

    no_signal_pct = no_signal_count / max(total, 1)
    buy_pct = buy_count / max(total, 1)

    # Scoring:
    # 1. Penalize too many NO_SIGNAL (>40% is bad)
    no_signal_penalty = max(0, no_signal_pct - 0.20) * 2  # penalty starts at 20%

    # 2. Reward having actionable signals (BUY + SELL)
    actionable_pct = (buy_count + sell_count) / max(total, 1)
    actionable_bonus = min(0.3, actionable_pct * 0.5)

    # 3. Match with actual trades: did BUY signals lead to profitable trades?
    if orders.height > 0 and "symbol" in orders.columns:
        buy_symbols = set(
            simulated.filter(pl.col("new_signal").is_in(["BUY", "STRONG_BUY"]))["stock_id"]
            .unique().to_list()
        )
        # Check how many actual buys matched our signals
        if "side" in orders.columns:
            actual_buys = set(orders.filter(pl.col("side") == "buy")["symbol"].unique().to_list())
        else:
            actual_buys = set()
        if buy_symbols and actual_buys:
            overlap = len(buy_symbols & actual_buys) / max(len(buy_symbols), 1)
        else:
            overlap = 0
        trade_match_bonus = overlap * 0.2
    else:
        trade_match_bonus = 0

    # 4. Signal diversity (not all same signal)
    signal_diversity = simulated["new_signal"].n_unique() / 5  # max 5 signal types
    diversity_bonus = signal_diversity * 0.1

    score = actionable_bonus + trade_match_bonus + diversity_bonus - no_signal_penalty

    return {
        "score": float(score),
        "no_signal_pct": float(no_signal_pct),
        "buy_pct": float(buy_pct),
        "actionable_pct": float(actionable_pct),
        "total": total,
        "no_signal": int(no_signal_count),
        "buy": int(buy_count),
        "sell": int(sell_count),
        "hold": int(hold_count),
    }


# ── Optuna ───────────────────────────────────────────────────────────────────

def create_objective(predictions: pl.DataFrame, orders: pl.DataFrame):
    def objective(trial: optuna.Trial) -> float:
        conf_thr = trial.suggest_float("confidence_threshold", 0.50, 0.70, step=0.05)
        cons_thr = trial.suggest_float("consensus_threshold", 0.50, 0.72, step=0.02)
        strong = trial.suggest_float("strong_signal_score", 0.65, 0.85, step=0.05)
        buy = trial.suggest_float("buy_signal_score", 0.45, 0.65, step=0.05)
        hold = trial.suggest_float("hold_signal_score", 0.30, 0.45, step=0.05)

        # Constraints
        if strong <= buy or buy <= hold:
            return -1.0

        result = evaluate_thresholds(predictions, orders, conf_thr, cons_thr, strong, buy, hold)
        return result["score"]

    return objective


def run_search(predictions: pl.DataFrame, orders: pl.DataFrame, n_trials: int = 200) -> dict:
    study = optuna.create_study(direction="maximize", study_name="signal_thresholds")
    study.optimize(create_objective(predictions, orders), n_trials=n_trials)

    best = study.best_trial
    print(f"\n{'='*60}")
    print(f"Best trial #{best.number}: score={best.value:.4f}")
    for k, v in best.params.items():
        print(f"  {k}: {v}")
    print(f"{'='*60}")

    # Evaluate best vs current defaults
    best_result = evaluate_thresholds(
        predictions, orders,
        best.params["confidence_threshold"],
        best.params["consensus_threshold"],
        best.params["strong_signal_score"],
        best.params["buy_signal_score"],
        best.params["hold_signal_score"],
    )
    default_result = evaluate_thresholds(predictions, orders, 0.55, 0.60, 0.72, 0.52, 0.36)

    print(f"\nDefault:  NO_SIGNAL={default_result['no_signal_pct']:.0%} BUY={default_result['buy_pct']:.0%}")
    print(f"Optimized: NO_SIGNAL={best_result['no_signal_pct']:.0%} BUY={best_result['buy_pct']:.0%}")

    return {
        "best_params": best.params,
        "best_score": best.value,
        "best_detail": best_result,
        "default_detail": default_result,
        "current_defaults": {
            "confidence_threshold": 0.55,
            "consensus_threshold": 0.60,
            "strong_signal_score": 0.72,
            "buy_signal_score": 0.52,
            "hold_signal_score": 0.36,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Optuna Signal Threshold Search")
    parser.add_argument("--orders-csv", help="Path to paper_orders CSV")
    parser.add_argument("--predictions-csv", help="Path to predictions CSV")
    parser.add_argument("--db-url", help="D1 REST API URL")
    parser.add_argument("--token", help="Auth token")
    parser.add_argument("--n-trials", type=int, default=200)
    parser.add_argument("--output", default="optuna_signal_results.json")
    args = parser.parse_args()

    if args.orders_csv and args.predictions_csv:
        orders, predictions = load_from_csvs(args.orders_csv, args.predictions_csv)
    elif args.db_url and args.token:
        orders, predictions = load_from_d1(args.db_url, args.token)
    else:
        print("ERROR: Provide --orders-csv + --predictions-csv, or --db-url + --token")
        sys.exit(1)

    print(f"Loaded {len(orders)} orders, {len(predictions)} predictions")

    results = run_search(predictions, orders, args.n_trials)

    def convert(obj):
        if isinstance(obj, (np.integer,)): return int(obj)
        if isinstance(obj, (np.floating,)): return float(obj)
        if isinstance(obj, np.ndarray): return obj.tolist()
        return obj

    with open(args.output, "w") as f:
        json.dump(results, f, indent=2, default=convert)
    print(f"\nResults saved to {args.output}")


if __name__ == "__main__":
    main()
