"""
scripts/optuna_barrier.py — Optuna 搜尋最佳 Triple Barrier 參數

搜尋空間：
  upper_mult   [2.0, 4.0]   停利 ATR 倍數
  lower_mult   [1.5, 3.0]   停損 ATR 倍數
  pct_cap      [0.03, 0.10] 百分比封頂
  max_days     [10, 30]     最大持有天數

目標函式：
  OOS 20% 的 direction accuracy（防止 overfit）

用法：
  python -m scripts.optuna_barrier --db-url <D1_REST_URL> --token <AUTH_TOKEN>
  或本地測試：
  python -m scripts.optuna_barrier --csv data/sample_prices.csv
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

from app.features import compute_triple_barrier_labels


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_prices_from_csv(csv_path: str) -> pl.DataFrame:
    """Load OHLCV from local CSV (for testing)."""
    df = pl.read_csv(csv_path, try_parse_dates=True)
    df = df.sort("date")
    return df


def load_prices_from_d1(db_url: str, token: str, min_rows: int = 200) -> pl.DataFrame:
    """Load prices from D1 REST API (production)."""
    import httpx

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    resp = httpx.post(f"{db_url}/query", headers=headers, json={
        "sql": """
            SELECT s.id, s.symbol, COUNT(*) as cnt
            FROM stocks s JOIN stock_prices sp ON sp.stock_id = s.id
            WHERE s.delisted_date IS NULL
            GROUP BY s.id HAVING cnt >= ?
            ORDER BY cnt DESC LIMIT 10
        """,
        "params": [min_rows]
    }, timeout=30)
    stocks = resp.json().get("results", []) if resp.status_code == 200 else []

    if not stocks:
        print(f"WARNING: No stocks with >= {min_rows} price rows found")
        return pl.DataFrame()

    all_dfs = []
    for stock in stocks:
        resp = httpx.post(f"{db_url}/query", headers=headers, json={
            "sql": "SELECT date, open, high, low, close, volume FROM stock_prices WHERE stock_id = ? ORDER BY date ASC",
            "params": [stock["id"]]
        }, timeout=30)
        if resp.status_code == 200:
            rows = resp.json().get("results", [])
            if len(rows) >= min_rows:
                df = pl.DataFrame(rows).with_columns([
                    pl.col("date").cast(pl.Date),
                    pl.lit(stock["symbol"]).alias("symbol"),
                ])
                all_dfs.append(df)

    if not all_dfs:
        return pl.DataFrame()

    combined = pl.concat(all_dfs)
    print(f"Loaded {len(all_dfs)} stocks, {len(combined)} total rows")
    return combined


# ── ATR Calculation ──────────────────────────────────────────────────────────

def calc_atr14(df: pl.DataFrame) -> np.ndarray:
    """Calculate 14-day ATR from OHLC data. Returns numpy array."""
    h = df["high"].to_numpy().astype(np.float64)
    l = df["low"].to_numpy().astype(np.float64)
    c = df["close"].to_numpy().astype(np.float64)
    c_prev = np.roll(c, 1)
    c_prev[0] = c[0]
    tr = np.maximum(h - l, np.maximum(np.abs(h - c_prev), np.abs(l - c_prev)))
    # Simple rolling mean for ATR
    atr = np.convolve(tr, np.ones(14) / 14, mode='full')[:len(tr)]
    atr[:13] = np.nan
    return atr


# ── Objective Function ───────────────────────────────────────────────────────

def evaluate_barrier_params(
    df: pl.DataFrame,
    upper_mult: float,
    lower_mult: float,
    upper_pct_cap: float,
    lower_pct_cap: float,
    max_days: int,
    oos_ratio: float = 0.2,
) -> dict:
    """
    Evaluate triple barrier params on OOS portion.
    Returns {oos_accuracy, oos_count, is_ratio, total_labels, oos_win_rate}.
    """
    atr14 = calc_atr14(df)

    labels = compute_triple_barrier_labels(
        close=df["close"].to_numpy().astype(np.float64),
        high=df["high"].to_numpy().astype(np.float64),
        low=df["low"].to_numpy().astype(np.float64),
        atr14=atr14,
        upper_atr_mult=upper_mult,
        lower_atr_mult=lower_mult,
        upper_pct_cap=upper_pct_cap,
        lower_pct_cap=lower_pct_cap,
        max_days=max_days,
    )

    valid_mask = ~np.isnan(labels)
    valid_labels = labels[valid_mask]
    total_labels = len(valid_labels)

    if total_labels < 30:
        return {"oos_accuracy": 0, "oos_count": 0, "is_ratio": 0, "total_labels": total_labels}

    # Train/OOS split (time-based, not random)
    split_idx = int(total_labels * (1 - oos_ratio))
    is_labels = valid_labels[:split_idx]
    oos_labels = valid_labels[split_idx:]

    if len(oos_labels) < 10:
        return {"oos_accuracy": 0, "oos_count": len(oos_labels), "is_ratio": 0, "total_labels": total_labels}

    is_win_rate = float(is_labels.mean()) if len(is_labels) > 0 else 0.0
    oos_win_rate = float(oos_labels.mean())

    balance = oos_win_rate
    balance_penalty = 0 if 0.35 <= balance <= 0.65 else abs(balance - 0.5) * 0.5
    coverage = total_labels / len(df)
    coverage_penalty = max(0, 0.5 - coverage) * 0.3
    is_oos_gap = abs(is_win_rate - oos_win_rate)
    stability_penalty = is_oos_gap * 0.3

    score = coverage - balance_penalty - coverage_penalty - stability_penalty

    return {
        "oos_accuracy": float(score),
        "oos_win_rate": float(oos_win_rate),
        "is_win_rate": float(is_win_rate),
        "is_oos_gap": float(is_oos_gap),
        "coverage": float(coverage),
        "oos_count": len(oos_labels),
        "total_labels": total_labels,
    }


def create_objective(all_data: dict[str, pl.DataFrame]):
    """Create Optuna objective that evaluates across multiple stocks."""

    def objective(trial: optuna.Trial) -> float:
        upper_mult = trial.suggest_float("upper_mult", 2.0, 4.0, step=0.5)
        lower_mult = trial.suggest_float("lower_mult", 1.5, 3.0, step=0.5)
        upper_pct_cap = trial.suggest_float("upper_pct_cap", 0.03, 0.10, step=0.01)
        lower_pct_cap = trial.suggest_float("lower_pct_cap", 0.02, 0.06, step=0.005)
        max_days = trial.suggest_int("max_days", 10, 30, step=5)

        if upper_pct_cap <= lower_pct_cap:
            return -1.0

        scores = []
        for symbol, df in all_data.items():
            result = evaluate_barrier_params(
                df, upper_mult, lower_mult, upper_pct_cap, lower_pct_cap, max_days
            )
            if result["oos_count"] >= 10:
                scores.append(result["oos_accuracy"])

        if not scores:
            return -1.0

        return float(np.mean(scores))

    return objective


# ── Main ─────────────────────────────────────────────────────────────────────

def run_optuna_search(
    all_data: dict[str, pl.DataFrame],
    n_trials: int = 200,
    n_jobs: int = 1,
) -> dict:
    """Run Optuna search and return best params + results."""
    study = optuna.create_study(direction="maximize", study_name="triple_barrier")
    objective = create_objective(all_data)
    study.optimize(objective, n_trials=n_trials, n_jobs=n_jobs)

    best = study.best_trial
    print(f"\n{'='*60}")
    print(f"Best trial #{best.number}: score={best.value:.4f}")
    print(f"  upper_mult:    {best.params['upper_mult']}")
    print(f"  lower_mult:    {best.params['lower_mult']}")
    print(f"  upper_pct_cap: {best.params['upper_pct_cap']}")
    print(f"  lower_pct_cap: {best.params['lower_pct_cap']}")
    print(f"  max_days:      {best.params['max_days']}")
    print(f"{'='*60}")

    detailed = {}
    for symbol, df in all_data.items():
        result = evaluate_barrier_params(
            df,
            best.params["upper_mult"],
            best.params["lower_mult"],
            best.params["upper_pct_cap"],
            best.params["lower_pct_cap"],
            best.params["max_days"],
        )
        detailed[symbol] = result
        print(f"  {symbol}: coverage={result['coverage']:.2f} "
              f"IS_wr={result.get('is_win_rate', 0):.2f} "
              f"OOS_wr={result.get('oos_win_rate', 0):.2f} "
              f"gap={result.get('is_oos_gap', 0):.3f}")

    print(f"\n--- Current defaults comparison ---")
    for symbol, df in list(all_data.items())[:3]:
        default_result = evaluate_barrier_params(df, 3.0, 2.0, 0.07, 0.03, 20)
        optuna_result = detailed[symbol]
        print(f"  {symbol}: default coverage={default_result['coverage']:.2f} "
              f"→ optuna coverage={optuna_result['coverage']:.2f} "
              f"(Δ{optuna_result['coverage'] - default_result['coverage']:+.3f})")

    return {
        "best_params": best.params,
        "best_score": best.value,
        "n_trials": n_trials,
        "per_stock": detailed,
        "current_defaults": {"upper_mult": 3.0, "lower_mult": 2.0, "upper_pct_cap": 0.07, "lower_pct_cap": 0.03, "max_days": 20},
    }


def main():
    parser = argparse.ArgumentParser(description="Optuna Triple Barrier Parameter Search")
    parser.add_argument("--csv", help="Path to OHLCV CSV file (for local testing)")
    parser.add_argument("--db-url", help="D1 REST API URL")
    parser.add_argument("--token", help="Auth token for D1 REST API")
    parser.add_argument("--n-trials", type=int, default=200, help="Number of Optuna trials")
    parser.add_argument("--output", help="Output JSON path", default="optuna_barrier_results.json")
    args = parser.parse_args()

    if args.csv:
        raw = load_prices_from_csv(args.csv)
        if len(raw) == 0:
            print("ERROR: No data loaded from CSV")
            sys.exit(1)
        if "symbol" in raw.columns:
            all_data = {}
            for (sym,), group in raw.group_by("symbol"):
                all_data[sym] = group.sort("date")
        else:
            all_data = {"default": raw}
    elif args.db_url and args.token:
        raw = load_prices_from_d1(args.db_url, args.token)
        if len(raw) == 0:
            print("ERROR: No data loaded from D1")
            sys.exit(1)
        all_data = {}
        for (sym,), group in raw.group_by("symbol"):
            all_data[sym] = group.sort("date")
    else:
        print("ERROR: Provide --csv or --db-url + --token")
        sys.exit(1)

    print(f"Loaded {len(all_data)} stocks for optimization")

    results = run_optuna_search(all_data, n_trials=args.n_trials)

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
