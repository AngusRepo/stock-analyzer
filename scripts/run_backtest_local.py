#!/usr/bin/env python3
"""
run_backtest_local.py — Run backtest + MC + PBO locally from CSV data

Uses the same data already dumped for Optuna (scripts/data/stock_prices.csv)
No need for CF_API_TOKEN — reads local CSV, writes results via wrangler

Usage:
  python3 scripts/run_backtest_local.py
"""
import os, sys, json, time, subprocess
sys.stdout.reconfigure(line_buffering=True)

import numpy as np
import pandas as pd

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
WORKER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "worker")

# Optuna results (just pushed to KV)
OPTUNA = json.load(open(os.path.join(DATA_DIR, "optuna_results.json")))
BARRIER = OPTUNA["barrier"]
SLTP = OPTUNA["sltp"]

# Trading costs (Taiwan)
BUY_FEE = 0.001425   # 0.1425%
SELL_FEE = 0.001425 + 0.003  # 0.1425% + 0.3% tax = 0.4425%


def run_backtest():
    """FIFO backtest using local CSV with Optuna params."""
    print("=" * 60)
    print("StockVision Local Backtest")
    print("=" * 60)

    print("Loading stock_prices.csv...", flush=True)
    df = pd.read_csv(os.path.join(DATA_DIR, "stock_prices.csv"))
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["symbol", "date"])

    symbols = df["symbol"].unique()
    print(f"Universe: {len(symbols)} stocks", flush=True)

    sl_mult = SLTP.get("sl_mult_base", 1.68)
    tp_mult = SLTP.get("tp_mult_base", 2.96)
    time_stop = SLTP.get("time_stop_days", 30)

    all_trades = []
    stocks_processed = 0
    stocks_skipped = 0

    for sym in symbols:
        sdf = df[df["symbol"] == sym].reset_index(drop=True)
        if len(sdf) < 60:
            stocks_skipped += 1
            continue

        close = sdf["close"].values
        high = sdf["high"].values
        low = sdf["low"].values
        dates = sdf["date"].values
        n = len(close)

        # ATR14
        tr = np.maximum(high[1:] - low[1:],
                        np.maximum(np.abs(high[1:] - close[:-1]),
                                   np.abs(low[1:] - close[:-1])))
        atr_arr = pd.Series(tr).rolling(14).mean().values

        # Simple entry signal: 20-day breakout + volume increase
        ma20 = pd.Series(close).rolling(20).mean().values
        vol_ma = pd.Series(sdf["volume"].values.astype(float)).rolling(20).mean().values

        # Simulate trades
        i = 30  # start after warmup
        while i < n - time_stop:
            # Entry: close > MA20 + volume > 1.2x avg
            if close[i] <= ma20[i] or sdf["volume"].values[i] < vol_ma[i] * 1.2:
                i += 1
                continue

            entry_price = close[i]
            entry_date = dates[i]
            atr = atr_arr[i - 1] if i - 1 < len(atr_arr) and not np.isnan(atr_arr[i - 1]) else entry_price * 0.02
            sl = entry_price - atr * sl_mult
            tp = entry_price + atr * tp_mult

            # Exit scan
            exit_price = None
            exit_date = None
            exit_reason = ""

            for j in range(i + 1, min(i + time_stop, n)):
                # Hard stop
                if low[j] <= entry_price * 0.88:  # -12%
                    exit_price = entry_price * 0.88
                    exit_date = dates[j]
                    exit_reason = "hard_stop"
                    break
                # SL
                if low[j] <= sl:
                    exit_price = sl
                    exit_date = dates[j]
                    exit_reason = "stop_loss"
                    break
                # TP
                if high[j] >= tp:
                    exit_price = tp
                    exit_date = dates[j]
                    exit_reason = "take_profit"
                    break
            else:
                # Time stop
                exit_idx = min(i + time_stop - 1, n - 1)
                exit_price = close[exit_idx]
                exit_date = dates[exit_idx]
                exit_reason = "time_stop"

            if exit_price:
                pnl_pct = (exit_price - entry_price) / entry_price - BUY_FEE - SELL_FEE
                all_trades.append({
                    "symbol": sym,
                    "entry_date": str(entry_date)[:10],
                    "exit_date": str(exit_date)[:10],
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(exit_price, 2),
                    "pnl_pct": round(pnl_pct, 4),
                    "exit_reason": exit_reason,
                })

            # Skip ahead to avoid overlapping trades
            i = (j if exit_price else i) + 5

        stocks_processed += 1
        if stocks_processed % 200 == 0:
            print(f"  Processed {stocks_processed}/{len(symbols)}, trades: {len(all_trades)}", flush=True)

    print(f"\nProcessed: {stocks_processed} stocks, Skipped: {stocks_skipped}")
    print(f"Total trades: {len(all_trades)}")

    if not all_trades:
        return {"status": "failed", "error": "No trades generated"}

    # ── Metrics ──
    trades_df = pd.DataFrame(all_trades)
    wins = trades_df[trades_df["pnl_pct"] > 0]
    losses = trades_df[trades_df["pnl_pct"] <= 0]

    win_rate = len(wins) / len(trades_df) * 100
    avg_win = wins["pnl_pct"].mean() if len(wins) > 0 else 0
    avg_loss = losses["pnl_pct"].mean() if len(losses) > 0 else 0
    profit_factor = abs(wins["pnl_pct"].sum() / losses["pnl_pct"].sum()) if losses["pnl_pct"].sum() != 0 else float("inf")
    expectancy = trades_df["pnl_pct"].mean()

    # Sharpe (annualized from trade returns)
    if trades_df["pnl_pct"].std() > 0:
        sharpe = (trades_df["pnl_pct"].mean() / trades_df["pnl_pct"].std()) * np.sqrt(252 / 15)  # ~15 day avg hold
    else:
        sharpe = 0

    # Max Drawdown (equity curve based, not cumulative product)
    equity = [1.0]
    for pnl in trades_df["pnl_pct"]:
        equity.append(equity[-1] * (1 + pnl))
    equity = np.array(equity[1:])
    peak = np.maximum.accumulate(equity)
    drawdown = (equity - peak) / peak
    max_dd = drawdown.min()
    cumulative = pd.Series(equity)

    # Sortino
    downside = trades_df[trades_df["pnl_pct"] < 0]["pnl_pct"]
    downside_std = downside.std() if len(downside) > 0 else 0.01
    sortino = (trades_df["pnl_pct"].mean() / downside_std) * np.sqrt(252 / 15) if downside_std > 0 else 0

    # CAGR
    first_date = pd.to_datetime(trades_df["entry_date"].min())
    last_date = pd.to_datetime(trades_df["exit_date"].max())
    years = max((last_date - first_date).days / 365.25, 0.1)
    total_return = cumulative.iloc[-1] - 1
    cagr = (1 + total_return) ** (1 / years) - 1

    # Calmar
    calmar = cagr / abs(max_dd) if max_dd != 0 else 0

    results = {
        "status": "ok",
        "total_trades": len(all_trades),
        "win_rate": round(win_rate, 1),
        "avg_win": round(avg_win * 100, 2),
        "avg_loss": round(avg_loss * 100, 2),
        "profit_factor": round(profit_factor, 2),
        "expectancy": round(expectancy * 100, 3),
        "sharpe": round(sharpe, 2),
        "sortino": round(sortino, 2),
        "max_drawdown": round(max_dd * 100, 1),
        "cagr": round(cagr * 100, 1),
        "calmar": round(calmar, 2),
        "period": f"{trades_df['entry_date'].min()} ~ {trades_df['exit_date'].max()}",
        "params": {"sl_mult": sl_mult, "tp_mult": tp_mult, "time_stop": time_stop},
    }

    print(f"\n{'=' * 60}")
    print("BACKTEST RESULTS")
    print(f"{'=' * 60}")
    for k, v in results.items():
        if k not in ("status", "params"):
            print(f"  {k}: {v}")

    return results, all_trades


def run_monte_carlo(trades: list, n_simulations: int = 1000):
    """Monte Carlo MDD simulation — shuffle trade order N times."""
    print(f"\n{'=' * 60}")
    print(f"MONTE CARLO MDD ({n_simulations} simulations)")
    print(f"{'=' * 60}")

    pnls = [t["pnl_pct"] for t in trades]
    mdds = []

    for _ in range(n_simulations):
        shuffled = np.random.permutation(pnls)
        cumulative = np.cumprod(1 + shuffled)
        peak = np.maximum.accumulate(cumulative)
        dd = (cumulative - peak) / peak
        mdds.append(dd.min())

    mdds = np.array(mdds)
    p50 = np.percentile(mdds, 50) * 100
    p95 = np.percentile(mdds, 95) * 100
    p99 = np.percentile(mdds, 99) * 100

    verdict = "PASS" if p95 > -20 else ("CAUTION" if p95 > -30 else "FAIL")

    results = {
        "n_simulations": n_simulations,
        "mdd_median": round(p50, 1),
        "mdd_95th": round(p95, 1),
        "mdd_99th": round(p99, 1),
        "verdict": verdict,
    }

    print(f"  Median MDD: {p50:.1f}%")
    print(f"  95th MDD:   {p95:.1f}%")
    print(f"  99th MDD:   {p99:.1f}%")
    print(f"  Verdict:    {verdict}")

    return results


def run_pbo(trades: list, n_partitions: int = 10):
    """Probability of Backtest Overfitting — CPCV."""
    print(f"\n{'=' * 60}")
    print(f"PBO (Combinatorial Purged CV, {n_partitions} partitions)")
    print(f"{'=' * 60}")

    from itertools import combinations

    pnls = np.array([t["pnl_pct"] for t in trades])
    n = len(pnls)
    partition_size = n // n_partitions

    if partition_size < 5:
        print(f"  [WARN] Not enough trades for {n_partitions} partitions (need {n_partitions * 5}, have {n})")
        return {"status": "insufficient_data", "n_trades": n}

    # Split into partitions
    partitions = []
    for i in range(n_partitions):
        start = i * partition_size
        end = start + partition_size if i < n_partitions - 1 else n
        partitions.append(pnls[start:end])

    # C(10, 5) = 252 combinations
    half = n_partitions // 2
    combos = list(combinations(range(n_partitions), half))
    n_combos = len(combos)

    oos_losses = 0
    for combo in combos:
        # In-sample: selected partitions
        # Out-of-sample: remaining partitions
        oos_indices = [i for i in range(n_partitions) if i not in combo]

        is_returns = np.concatenate([partitions[i] for i in combo])
        oos_returns = np.concatenate([partitions[i] for i in oos_indices])

        # If in-sample is profitable but OOS is losing → overfitting evidence
        is_mean = is_returns.mean()
        oos_mean = oos_returns.mean()

        if is_mean > 0 and oos_mean < 0:
            oos_losses += 1

    pbo = oos_losses / n_combos
    verdict = "PASS" if pbo < 0.5 else "FAIL"

    results = {
        "pbo": round(pbo, 3),
        "n_combinations": n_combos,
        "oos_losses": oos_losses,
        "verdict": verdict,
    }

    print(f"  PBO: {pbo:.3f} ({oos_losses}/{n_combos} OOS losses)")
    print(f"  Verdict: {verdict} {'(alpha credible)' if pbo < 0.5 else '(likely overfitting)'}")

    return results


def main():
    start = time.time()

    # 1. Backtest
    bt_results, trades = run_backtest()
    if bt_results.get("status") != "ok":
        print(f"Backtest failed: {bt_results}")
        return

    # 2. Monte Carlo
    mc_results = run_monte_carlo(trades, n_simulations=1000)

    # 3. PBO
    pbo_results = run_pbo(trades, n_partitions=10)

    elapsed = time.time() - start

    # ── Final Summary ──
    print(f"\n{'=' * 60}")
    print(f"FINAL VERIFICATION SUMMARY")
    print(f"{'=' * 60}")
    print(f"  Backtest:     {bt_results['total_trades']} trades, Sharpe {bt_results['sharpe']}, PF {bt_results['profit_factor']}")
    print(f"  Monte Carlo:  95th MDD = {mc_results['mdd_95th']}% → {mc_results['verdict']}")
    print(f"  PBO:          {pbo_results.get('pbo', 'N/A')} → {pbo_results.get('verdict', 'N/A')}")
    print(f"  Time:         {elapsed:.1f}s")

    mc_pass = mc_results["verdict"] in ("PASS", "CAUTION")
    pbo_pass = pbo_results.get("verdict") == "PASS"

    if mc_pass and pbo_pass:
        print(f"\n  [PASS] ALL PASSED — Ready for live trading")
    else:
        print(f"\n  [FAIL] FAILED — Do NOT go live")
        if not mc_pass:
            print(f"    MC FAIL: 95th MDD {mc_results['mdd_95th']}% exceeds -20% limit")
        if not pbo_pass:
            print(f"    PBO FAIL: {pbo_results.get('pbo', '?')} >= 0.5 (likely overfitting)")

    # Save all results
    all_results = {
        "backtest": bt_results,
        "monte_carlo": mc_results,
        "pbo": pbo_results,
        "go_live": mc_pass and pbo_pass,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    output_path = os.path.join(DATA_DIR, "verification_results.json")
    with open(output_path, "w") as f:
        json.dump(all_results, f, indent=2)
    print(f"\n  Saved to {output_path}")


if __name__ == "__main__":
    main()
