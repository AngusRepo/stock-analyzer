#!/usr/bin/env python3
"""
Run local backtest + Monte Carlo + PBO with Polars/NumPy.

Input:
  scripts/data/stock_prices.csv
  scripts/data/optuna_results.json

Output:
  scripts/data/verification_results.json
"""

from __future__ import annotations

import argparse
import json
import time
from itertools import combinations
from pathlib import Path

import numpy as np
import polars as pl


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "scripts" / "data"
BUY_FEE = 0.001425
SELL_FEE = 0.001425 + 0.003


def rolling_mean(values: np.ndarray, window: int) -> np.ndarray:
    out = np.full(len(values), np.nan, dtype=np.float64)
    if len(values) < window:
        return out
    cumsum = np.cumsum(np.insert(values.astype(np.float64), 0, 0.0))
    out[window - 1 :] = (cumsum[window:] - cumsum[:-window]) / window
    return out


def load_prices(csv_path: Path) -> pl.DataFrame:
    return (
        pl.scan_csv(csv_path, try_parse_dates=True)
        .select("symbol", "date", "high", "low", "close", "volume")
        .with_columns(
            pl.col("symbol").cast(pl.Utf8),
            pl.col("date").cast(pl.Date),
            pl.col("high").cast(pl.Float64),
            pl.col("low").cast(pl.Float64),
            pl.col("close").cast(pl.Float64),
            pl.col("volume").cast(pl.Float64),
        )
        .drop_nulls(["symbol", "date", "high", "low", "close", "volume"])
        .sort(["symbol", "date"])
        .collect()
    )


def load_optuna(path: Path) -> tuple[float, float, int]:
    if not path.exists():
        return 1.68, 2.96, 30
    optuna = json.loads(path.read_text(encoding="utf-8"))
    sltp = optuna.get("sltp", {})
    params = sltp.get("best_params", sltp)
    return (
        float(params.get("sl_mult_base", params.get("sl_mult", 1.68))),
        float(params.get("tp_mult_base", params.get("tp_mult", 2.96))),
        int(params.get("time_stop_days", params.get("timeStopDays", 30))),
    )


def simulate_symbol(symbol: str, frame: pl.DataFrame, sl_mult: float, tp_mult: float, time_stop: int) -> list[dict]:
    if frame.height < 60:
        return []

    close = frame["close"].to_numpy()
    high = frame["high"].to_numpy()
    low = frame["low"].to_numpy()
    volume = frame["volume"].to_numpy()
    dates = [str(value) for value in frame["date"].to_list()]
    n = len(close)

    true_range = np.maximum(
        high[1:] - low[1:],
        np.maximum(np.abs(high[1:] - close[:-1]), np.abs(low[1:] - close[:-1])),
    )
    atr14 = rolling_mean(true_range, 14)
    ma20 = rolling_mean(close, 20)
    vol_ma20 = rolling_mean(volume, 20)

    trades: list[dict] = []
    i = 30
    while i < n - time_stop:
        if close[i] <= ma20[i] or volume[i] < vol_ma20[i] * 1.2:
            i += 1
            continue

        entry_price = float(close[i])
        atr_idx = i - 1
        atr = atr14[atr_idx] if atr_idx < len(atr14) and np.isfinite(atr14[atr_idx]) else entry_price * 0.02
        stop_price = entry_price - atr * sl_mult
        target_price = entry_price + atr * tp_mult
        exit_price = float(close[min(i + time_stop - 1, n - 1)])
        exit_date = dates[min(i + time_stop - 1, n - 1)]
        exit_reason = "time_stop"
        exit_index = min(i + time_stop - 1, n - 1)

        for j in range(i + 1, min(i + time_stop, n)):
            if low[j] <= entry_price * 0.88:
                exit_price = entry_price * 0.88
                exit_date = dates[j]
                exit_reason = "hard_stop"
                exit_index = j
                break
            if low[j] <= stop_price:
                exit_price = stop_price
                exit_date = dates[j]
                exit_reason = "stop_loss"
                exit_index = j
                break
            if high[j] >= target_price:
                exit_price = target_price
                exit_date = dates[j]
                exit_reason = "take_profit"
                exit_index = j
                break

        pnl_pct = (exit_price - entry_price) / entry_price - BUY_FEE - SELL_FEE
        trades.append(
            {
                "symbol": symbol,
                "entry_date": dates[i],
                "exit_date": exit_date,
                "entry_price": round(entry_price, 2),
                "exit_price": round(exit_price, 2),
                "pnl_pct": round(float(pnl_pct), 4),
                "exit_reason": exit_reason,
            }
        )
        i = exit_index + 5

    return trades


def run_backtest(prices: pl.DataFrame, sl_mult: float, tp_mult: float, time_stop: int) -> tuple[dict, list[dict]]:
    all_trades: list[dict] = []
    skipped = 0
    for (symbol,), frame in prices.group_by("symbol", maintain_order=True):
        trades = simulate_symbol(symbol, frame, sl_mult, tp_mult, time_stop)
        if not trades and frame.height < 60:
            skipped += 1
        all_trades.extend(trades)

    if not all_trades:
        return {"status": "failed", "error": "No trades generated"}, []

    trades_df = pl.DataFrame(all_trades)
    returns = trades_df["pnl_pct"].to_numpy().astype(np.float64)
    wins = returns[returns > 0]
    losses = returns[returns <= 0]

    equity = np.cumprod(1 + returns)
    peak = np.maximum.accumulate(equity)
    drawdown = (equity - peak) / peak
    max_dd = float(drawdown.min())
    mean = float(returns.mean())
    std = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    downside_std = float(losses.std(ddof=1)) if len(losses) > 1 else 0.0
    first_date = trades_df["entry_date"].min()
    last_date = trades_df["exit_date"].max()
    years = max((np.datetime64(last_date) - np.datetime64(first_date)).astype("timedelta64[D]").astype(int) / 365.25, 0.1)
    total_return = float(equity[-1] - 1)
    cagr = (1 + total_return) ** (1 / years) - 1

    gross_profit = float(wins.sum()) if len(wins) else 0.0
    gross_loss = abs(float(losses.sum())) if len(losses) else 0.0
    results = {
        "status": "ok",
        "total_trades": len(all_trades),
        "stocks": prices["symbol"].n_unique(),
        "stocks_skipped": skipped,
        "win_rate": round(len(wins) / len(returns) * 100, 1),
        "avg_win": round(float(wins.mean()) * 100, 2) if len(wins) else 0,
        "avg_loss": round(float(losses.mean()) * 100, 2) if len(losses) else 0,
        "profit_factor": round(gross_profit / gross_loss, 2) if gross_loss else float("inf"),
        "expectancy": round(mean * 100, 3),
        "sharpe": round((mean / std) * np.sqrt(252 / 15), 2) if std > 0 else 0,
        "sortino": round((mean / downside_std) * np.sqrt(252 / 15), 2) if downside_std > 0 else 0,
        "max_drawdown": round(max_dd * 100, 1),
        "cagr": round(cagr * 100, 1),
        "calmar": round(cagr / abs(max_dd), 2) if max_dd else 0,
        "period": f"{first_date} ~ {last_date}",
        "params": {"sl_mult": sl_mult, "tp_mult": tp_mult, "time_stop": time_stop},
    }
    return results, all_trades


def run_monte_carlo(trades: list[dict], n_simulations: int = 1000) -> dict:
    returns = np.array([trade["pnl_pct"] for trade in trades], dtype=np.float64)
    mdds = []
    for _ in range(n_simulations):
        equity = np.cumprod(1 + np.random.permutation(returns))
        peak = np.maximum.accumulate(equity)
        mdds.append(((equity - peak) / peak).min())
    mdds_arr = np.array(mdds)
    p95 = float(np.percentile(mdds_arr, 5)) * 100
    return {
        "n_simulations": n_simulations,
        "mdd_median": round(float(np.percentile(mdds_arr, 50)) * 100, 1),
        "mdd_95th": round(p95, 1),
        "mdd_99th": round(float(np.percentile(mdds_arr, 1)) * 100, 1),
        "verdict": "PASS" if p95 > -20 else ("CAUTION" if p95 > -30 else "FAIL"),
    }


def run_pbo(trades: list[dict], n_partitions: int = 10) -> dict:
    returns = np.array([trade["pnl_pct"] for trade in trades], dtype=np.float64)
    partition_size = len(returns) // n_partitions
    if partition_size < 5:
        return {"status": "insufficient_data", "n_trades": len(returns)}

    partitions = [
        returns[i * partition_size : (i + 1) * partition_size if i < n_partitions - 1 else len(returns)]
        for i in range(n_partitions)
    ]
    half = n_partitions // 2
    combos = list(combinations(range(n_partitions), half))
    oos_losses = 0
    for combo in combos:
        oos_indices = [i for i in range(n_partitions) if i not in combo]
        in_sample = np.concatenate([partitions[i] for i in combo])
        out_sample = np.concatenate([partitions[i] for i in oos_indices])
        if in_sample.mean() > 0 and out_sample.mean() < 0:
            oos_losses += 1
    pbo = oos_losses / len(combos)
    return {
        "pbo": round(pbo, 3),
        "n_combinations": len(combos),
        "oos_losses": oos_losses,
        "verdict": "PASS" if pbo < 0.5 else "FAIL",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local StockVision backtest verification")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output", type=Path, default=DATA_DIR / "verification_results.json")
    parser.add_argument("--mc-runs", type=int, default=1000)
    args = parser.parse_args()

    start = time.time()
    data_dir = args.data_dir.resolve()
    prices_path = data_dir / "stock_prices.csv"
    if not prices_path.exists():
        raise FileNotFoundError(prices_path)

    sl_mult, tp_mult, time_stop = load_optuna(data_dir / "optuna_results.json")
    prices = load_prices(prices_path)
    backtest, trades = run_backtest(prices, sl_mult, tp_mult, time_stop)
    if backtest.get("status") != "ok":
        print(json.dumps(backtest, indent=2), flush=True)
        return 1

    monte_carlo = run_monte_carlo(trades, args.mc_runs)
    pbo = run_pbo(trades)
    results = {
        "backtest": backtest,
        "monte_carlo": monte_carlo,
        "pbo": pbo,
        "go_live": monte_carlo["verdict"] in ("PASS", "CAUTION") and pbo.get("verdict") == "PASS",
        "elapsed_seconds": round(time.time() - start, 2),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(results, indent=2, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
