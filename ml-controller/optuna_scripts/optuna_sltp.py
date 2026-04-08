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

目標函式（Sprint 3 P0-3: Multi-Objective Pareto）：
  - Objective 1: Sharpe ratio (maximize)
  - Objective 2: Max drawdown (minimize)
  使用 NSGA-II 搜尋 Pareto front，從 frontier 挑 max-sharpe trial 當 default 推 KV

用法：
  python -m scripts.optuna_sltp --orders-csv data/paper_orders.csv
"""

import argparse
import json
import sys
import numpy as np
import pandas as pd

try:
    import optuna
    from optuna.samplers import NSGAIISampler
    optuna.logging.set_verbosity(optuna.logging.WARNING)
except ImportError:
    print("ERROR: pip install optuna")
    sys.exit(1)


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_orders(csv_path: str) -> pd.DataFrame:
    """Load paper_orders from CSV."""
    df = pd.read_csv(csv_path, parse_dates=["created_at"])
    return df.sort_values("created_at").reset_index(drop=True)


def load_orders_from_d1(db_url: str, token: str) -> pd.DataFrame:
    import httpx
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    resp = httpx.post(f"{db_url}/query", headers=headers, json={
        "sql": """SELECT symbol, side, price, shares, total_cost, confidence, signal,
                  note, created_at FROM paper_orders ORDER BY created_at ASC LIMIT 1000"""
    }, timeout=30)
    return pd.DataFrame(resp.json().get("results", []))


# ── Trade Simulation ─────────────────────────────────────────────────────────

def simulate_trades_with_exit(
    orders: pd.DataFrame,
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
    buys = orders[orders["side"] == "buy"].copy()
    sells = orders[orders["side"] == "sell"].copy()

    if buys.empty:
        return {"profit_factor": 0, "win_rate": 0, "trade_count": 0}

    trades = []
    for _, buy in buys.iterrows():
        symbol = buy["symbol"]
        buy_price = buy["price"]
        buy_date = pd.to_datetime(buy["created_at"])

        # Find matching sell
        matching_sells = sells[
            (sells["symbol"] == symbol) &
            (pd.to_datetime(sells["created_at"]) > buy_date)
        ]

        if matching_sells.empty:
            continue

        sell = matching_sells.iloc[0]
        sell_price = sell["price"]
        sell_date = pd.to_datetime(sell["created_at"])

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

    df_trades = pd.DataFrame(trades)
    wins = df_trades[df_trades["simulated_pnl_pct"] > 0]["simulated_pnl_pct"]
    losses = df_trades[df_trades["simulated_pnl_pct"] <= 0]["simulated_pnl_pct"]

    gross_profit = wins.sum() if len(wins) > 0 else 0
    gross_loss = abs(losses.sum()) if len(losses) > 0 else 0.001
    profit_factor = gross_profit / gross_loss
    win_rate = len(wins) / len(df_trades)
    avg_pnl = df_trades["simulated_pnl_pct"].mean()

    # Sprint 3 P0-3: 計算 Sharpe + Max Drawdown 給 Multi-Objective Pareto
    pnls = df_trades["simulated_pnl_pct"].values.astype(float)
    std_r = float(np.std(pnls, ddof=1)) if len(pnls) > 1 else 0.0
    mean_r = float(np.mean(pnls))
    # annualized 取 min(n, 252)；ddof=1 避免 single-trade 炸 std=0
    sharpe = (mean_r / std_r) * np.sqrt(min(len(pnls), 252)) if std_r > 1e-9 else 0.0

    # Max drawdown from cumulative equity curve
    equity = np.cumprod(1 + pnls)
    peak = np.maximum.accumulate(equity)
    dd = (peak - equity) / np.where(peak > 0, peak, 1.0)
    max_dd = float(np.max(dd)) if len(dd) > 0 else 0.0

    return {
        "profit_factor": float(profit_factor),
        "win_rate": float(win_rate),
        "avg_pnl_pct": float(avg_pnl),
        "trade_count": len(df_trades),
        "gross_profit": float(gross_profit),
        "gross_loss": float(gross_loss),
        "sharpe": float(sharpe),
        "max_dd": float(max_dd),
    }


# ── Optuna ───────────────────────────────────────────────────────────────────

def create_objective(orders: pd.DataFrame):
    # Sprint 3 P0-3: Multi-Objective (sharpe↑, max_dd↓)
    # 失敗/不可行 trial 回傳 (-1e9, 1.0) — 極差 sharpe + 極大 dd
    PENALTY = (-1e9, 1.0)

    def objective(trial: optuna.Trial):
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
            return PENALTY  # trailing must tighten as profit grows
        if switch_8 <= switch_3:
            return PENALTY

        result = simulate_trades_with_exit(
            orders, sl_mult, tp_mult, trail_default, trail_3pct, trail_8pct,
            tp1_ratio, time_stop, hard_stop, switch_3, switch_8
        )

        if result["trade_count"] < 10:
            return PENALTY

        return result["sharpe"], result["max_dd"]

    return objective


def run_search(orders: pd.DataFrame, n_trials: int = 200) -> dict:
    # Sprint 3 P0-3: Multi-Objective Pareto — sharpe maximize, max_dd minimize
    study = optuna.create_study(
        directions=["maximize", "minimize"],
        sampler=NSGAIISampler(seed=42),
        study_name="sltp_trailing_pareto",
    )
    study.optimize(create_objective(orders), n_trials=n_trials)

    # Extract Pareto front — study.best_trials 是 Pareto-optimal trials
    pareto_trials = [t for t in study.best_trials if t.values and t.values[0] > -1e8]
    if not pareto_trials:
        # All trials infeasible — raise for upstream
        raise RuntimeError("Optuna sltp: no feasible Pareto trials; check data quality / n_trials")

    # Default pick: max-sharpe trial (KV push 需要單一 best_params)
    chosen = max(pareto_trials, key=lambda t: t.values[0])
    best_sharpe, best_max_dd = chosen.values

    print(f"\n{'='*60}")
    print(f"Pareto front size: {len(pareto_trials)}")
    print(f"Chosen trial #{chosen.number}: sharpe={best_sharpe:.3f}, max_dd={best_max_dd:.3%}")
    for k, v in chosen.params.items():
        print(f"  {k}: {v}")
    print(f"{'='*60}")

    # Evaluate chosen + default for comparison
    default_result = simulate_trades_with_exit(
        orders, 2.0, 1.5, 3.0, 2.5, 2.0, 0.5, 20, -0.10, 0.03, 0.08
    )
    best_result = simulate_trades_with_exit(
        orders,
        chosen.params["sl_mult"], chosen.params["tp_mult"],
        chosen.params["trailMultDefault"], chosen.params["trailMultAt3pct"],
        chosen.params["trailMultAt8pct"], chosen.params["tp1SellRatio"],
        chosen.params["timeStopDays"], chosen.params["hardStopPct"],
        chosen.params["trail_switch_3pct"], chosen.params["trail_switch_8pct"],
    )

    print(f"\nDefault:   Sharpe={default_result.get('sharpe', 0):.2f} MaxDD={default_result.get('max_dd', 0):.1%} PF={default_result['profit_factor']:.2f} WR={default_result['win_rate']:.0%}")
    print(f"Optimized: Sharpe={best_result.get('sharpe', 0):.2f} MaxDD={best_result.get('max_dd', 0):.1%} PF={best_result['profit_factor']:.2f} WR={best_result['win_rate']:.0%}")

    # Pareto front 列表（給 Wei 檢視 trade-off）
    pareto_front = sorted(
        [
            {
                "trial_number": t.number,
                "sharpe": float(t.values[0]),
                "max_dd": float(t.values[1]),
                "params": t.params,
            }
            for t in pareto_trials
        ],
        key=lambda x: x["sharpe"],
        reverse=True,
    )

    return {
        "best_params": chosen.params,
        "best_sharpe": float(best_sharpe),
        "best_max_dd": float(best_max_dd),
        "best_profit_factor": best_result["profit_factor"],  # backward compat
        "best_detail": best_result,
        "default_detail": default_result,
        "pareto_front": pareto_front,
        "pareto_size": len(pareto_trials),
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
