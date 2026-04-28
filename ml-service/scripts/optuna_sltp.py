"""
scripts/optuna_sltp.py — Optuna 搜尋最佳 SL/TP + Trailing 參數

搜尋空間：
  SL/TP (ensemble.py):
    sl_mult           [1.0, 3.0]   停損 ATR/GARCH 倍數
    tp_mult           [1.0, 3.0]   停利 ATR/GARCH 倍數

  Trailing (tradingConfig.ts):
    trailMultDefault  [2.0, 4.0]   預設 trailing 倍數
    trailMultAt3pct   [1.5, 3.0]   獲利 >3% 時
    trailMultAt8pct   [1.0, 2.5]   獲利 >8% 時
    tp1SellRatio      [0.3, 0.7]   TP1 賣出比例
    timeStopDays      [10, 30]     時間止損天數
    hardStopPct       [-0.15, -0.06] 硬上限止損

  Trailing switch points (profit % at which stage changes):
    trail_switch_3pct [0.02, 0.05]  進入第二段的獲利門檻
    trail_switch_8pct [0.05, 0.12]  進入第三段的獲利門檻

目標函式：
  用歷史交易回測 Profit Factor（毛利/毛損）

用法：
  python -m scripts.optuna_sltp --orders-csv data/paper_orders.csv
"""

import argparse
import json
import sys
from datetime import datetime
import numpy as np
import polars as pl

try:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
except ImportError:
    print("ERROR: pip install optuna")
    sys.exit(1)


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_orders(csv_path: str) -> pl.DataFrame:
    """Load paper_orders from CSV."""
    return (
        pl.scan_csv(csv_path)
        .with_columns(pl.col("created_at").str.to_datetime(strict=False))
        .sort("created_at")
        .collect()
    )


def load_orders_from_d1(db_url: str, token: str) -> pl.DataFrame:
    import httpx
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    resp = httpx.post(f"{db_url}/query", headers=headers, json={
        "sql": """SELECT symbol, side, price, shares, total_cost, confidence, signal,
                  note, created_at FROM paper_orders ORDER BY created_at ASC LIMIT 1000"""
    }, timeout=30)
    return pl.DataFrame(resp.json().get("results", []))


# ── Trade Simulation ─────────────────────────────────────────────────────────

def simulate_trades_with_exit(
    orders: pl.DataFrame,
    sl_mult: float,
    tp_mult: float,
    trail_default: float,
    trail_3pct: float,
    trail_8pct: float,
    tp1_ratio: float,
    time_stop_days: int,
    hard_stop_pct: float,
    trail_switch_3: float,
    trail_switch_8: float,
) -> dict:
    """
    Simulate trade outcomes with given SL/TP/trailing params.
    Uses actual buy/sell pairs from paper_orders.
    """
    # Pair buy and sell orders by symbol
    buys = orders.filter(pl.col("side") == "buy")
    sells = orders.filter(pl.col("side") == "sell")

    if buys.height == 0:
        return {"profit_factor": 0, "win_rate": 0, "trade_count": 0}

    # Ensure created_at is datetime
    if buys.schema.get("created_at") == pl.Utf8:
        buys = buys.with_columns(pl.col("created_at").str.to_datetime())
    if sells.height > 0 and sells.schema.get("created_at") == pl.Utf8:
        sells = sells.with_columns(pl.col("created_at").str.to_datetime())

    trades = []
    for buy in buys.iter_rows(named=True):
        symbol = buy["symbol"]
        buy_price = buy["price"]
        buy_date = buy["created_at"]
        if isinstance(buy_date, str):
            buy_date = datetime.fromisoformat(buy_date)

        # Find matching sell
        matching_sells = sells.filter(
            (pl.col("symbol") == symbol) &
            (pl.col("created_at") > buy_date)
        )

        if matching_sells.height == 0:
            continue

        sell = matching_sells.row(0, named=True)
        sell_price = sell["price"]
        sell_date = sell["created_at"]
        if isinstance(sell_date, str):
            sell_date = datetime.fromisoformat(sell_date)

        actual_pnl_pct = (sell_price - buy_price) / buy_price
        hold_days = (sell_date - buy_date).days

        # Simulate: would the new params have changed the exit?
        # This is approximate — we don't have intraday data, just entry/exit prices

        # Hard stop check
        if actual_pnl_pct <= hard_stop_pct:
            simulated_exit_pct = hard_stop_pct
        # Time stop check
        elif hold_days > time_stop_days and actual_pnl_pct > 0:
            simulated_exit_pct = actual_pnl_pct * 0.8  # would have exited earlier
        else:
            # Trailing stop simulation (approximate)
            if actual_pnl_pct > trail_switch_8:
                trail_mult = trail_8pct
            elif actual_pnl_pct > trail_switch_3:
                trail_mult = trail_3pct
            else:
                trail_mult = trail_default

            # Tighter trailing = exits earlier with less profit but less risk
            trail_factor = trail_mult / 3.0  # normalize to current default
            simulated_exit_pct = actual_pnl_pct * trail_factor

        # TP1 partial: if profit > tp_mult effect, simulate partial exit
        if actual_pnl_pct > 0.03:
            # TP1 hit: tp1_ratio of position exits at this profit
            net_pnl = actual_pnl_pct * tp1_ratio + actual_pnl_pct * (1 - tp1_ratio) * 0.5
        else:
            net_pnl = simulated_exit_pct if simulated_exit_pct != 0 else actual_pnl_pct

        trades.append({
            "symbol": symbol,
            "buy_price": buy_price,
            "sell_price": sell_price,
            "actual_pnl_pct": actual_pnl_pct,
            "simulated_pnl_pct": net_pnl,
            "hold_days": hold_days,
        })

    if not trades:
        return {"profit_factor": 0, "win_rate": 0, "trade_count": 0}

    df_trades = pl.DataFrame(trades)
    wins = df_trades.filter(pl.col("simulated_pnl_pct") > 0)["simulated_pnl_pct"]
    losses = df_trades.filter(pl.col("simulated_pnl_pct") <= 0)["simulated_pnl_pct"]

    gross_profit = wins.sum() if len(wins) > 0 else 0
    gross_loss = abs(losses.sum()) if len(losses) > 0 else 0.001
    profit_factor = gross_profit / gross_loss
    win_rate = len(wins) / len(df_trades)
    avg_pnl = df_trades["simulated_pnl_pct"].mean()

    return {
        "profit_factor": float(profit_factor),
        "win_rate": float(win_rate),
        "avg_pnl_pct": float(avg_pnl),
        "trade_count": len(df_trades),
        "gross_profit": float(gross_profit),
        "gross_loss": float(gross_loss),
    }


# ── Optuna ───────────────────────────────────────────────────────────────────

def create_objective(orders: pl.DataFrame):
    def objective(trial: optuna.Trial) -> float:
        sl_mult = trial.suggest_float("sl_mult", 1.0, 3.0, step=0.25)
        tp_mult = trial.suggest_float("tp_mult", 1.0, 3.0, step=0.25)
        trail_default = trial.suggest_float("trailMultDefault", 2.0, 4.0, step=0.25)
        trail_3pct = trial.suggest_float("trailMultAt3pct", 1.5, 3.0, step=0.25)
        trail_8pct = trial.suggest_float("trailMultAt8pct", 1.0, 2.5, step=0.25)
        tp1_ratio = trial.suggest_float("tp1SellRatio", 0.3, 0.7, step=0.1)
        time_stop = trial.suggest_int("timeStopDays", 10, 30, step=5)
        hard_stop = trial.suggest_float("hardStopPct", -0.15, -0.06, step=0.01)
        switch_3 = trial.suggest_float("trail_switch_3pct", 0.02, 0.05, step=0.005)
        switch_8 = trial.suggest_float("trail_switch_8pct", 0.05, 0.12, step=0.01)

        # Constraints
        if trail_default <= trail_3pct or trail_3pct <= trail_8pct:
            return -1.0  # trailing must tighten as profit grows
        if switch_8 <= switch_3:
            return -1.0

        result = simulate_trades_with_exit(
            orders, sl_mult, tp_mult, trail_default, trail_3pct, trail_8pct,
            tp1_ratio, time_stop, hard_stop, switch_3, switch_8
        )

        if result["trade_count"] < 10:
            return -1.0

        # Objective: Profit Factor (higher = better risk-adjusted return)
        return result["profit_factor"]

    return objective


def run_search(orders: pl.DataFrame, n_trials: int = 200) -> dict:
    study = optuna.create_study(direction="maximize", study_name="sltp_trailing")
    study.optimize(create_objective(orders), n_trials=n_trials)

    best = study.best_trial
    print(f"\n{'='*60}")
    print(f"Best trial #{best.number}: Profit Factor={best.value:.3f}")
    for k, v in best.params.items():
        print(f"  {k}: {v}")
    print(f"{'='*60}")

    # Compare with defaults
    default_result = simulate_trades_with_exit(
        orders, 2.0, 1.5, 3.0, 2.5, 2.0, 0.5, 20, -0.10, 0.03, 0.08
    )
    best_result = simulate_trades_with_exit(
        orders,
        best.params["sl_mult"], best.params["tp_mult"],
        best.params["trailMultDefault"], best.params["trailMultAt3pct"],
        best.params["trailMultAt8pct"], best.params["tp1SellRatio"],
        best.params["timeStopDays"], best.params["hardStopPct"],
        best.params["trail_switch_3pct"], best.params["trail_switch_8pct"],
    )

    print(f"\nDefault:   PF={default_result['profit_factor']:.2f} WR={default_result['win_rate']:.0%} avg={default_result.get('avg_pnl_pct', 0):.2%}")
    print(f"Optimized: PF={best_result['profit_factor']:.2f} WR={best_result['win_rate']:.0%} avg={best_result.get('avg_pnl_pct', 0):.2%}")

    return {
        "best_params": best.params,
        "best_profit_factor": best.value,
        "best_detail": best_result,
        "default_detail": default_result,
        "current_defaults": {
            "sl_mult": 2.0, "tp_mult": 1.5,
            "trailMultDefault": 3.0, "trailMultAt3pct": 2.5, "trailMultAt8pct": 2.0,
            "tp1SellRatio": 0.5, "timeStopDays": 20, "hardStopPct": -0.10,
            "trail_switch_3pct": 0.03, "trail_switch_8pct": 0.08,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Optuna SL/TP + Trailing Search")
    parser.add_argument("--orders-csv", help="Path to paper_orders CSV")
    parser.add_argument("--db-url", help="D1 REST API URL")
    parser.add_argument("--token", help="Auth token")
    parser.add_argument("--n-trials", type=int, default=200)
    parser.add_argument("--output", default="optuna_sltp_results.json")
    args = parser.parse_args()

    if args.orders_csv:
        orders = load_orders(args.orders_csv)
    elif args.db_url and args.token:
        orders = load_orders_from_d1(args.db_url, args.token)
    else:
        print("ERROR: Provide --orders-csv or --db-url + --token")
        sys.exit(1)

    print(f"Loaded {len(orders)} orders")
    results = run_search(orders, args.n_trials)

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
