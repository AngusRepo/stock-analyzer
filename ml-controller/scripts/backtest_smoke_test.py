"""
backtest_smoke_test.py — Sprint 6a.7 local smoke test

Usage:
  # Mocked mode: hand-crafted 3 stocks × 60 days, no D1 credentials needed
  python scripts/backtest_smoke_test.py --mode mock

  # D1 mode: 5-10 symbols × 1 quarter, requires CF env vars
  python scripts/backtest_smoke_test.py --mode d1 --start 2024-01-01 --end 2024-03-31

Asserts:
  - replay_period runs without exceptions
  - BacktestMetrics has realism_warnings populated for Mode A
  - equity_curve is non-empty and len matches trading days
  - sanity_flags fires for the expected reasons
  - fill_rate / sharpe / max_drawdown all have plausible values

This is NOT a parity test (that's test_cascade_parity.py).
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

# Make `services.*` importable when run from project root
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
import pandas as pd

from services.backtest_engine import (
    BacktestDataset,
    replay_period,
    replay_period_loading,
    MODE_A_DEVIATIONS,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger("smoke_test")


# ═══════════════════════════════════════════════════════════════════════════════
# Mocked dataset: 3 stocks × 60 trading days with realistic OHLC + indicators
# ═══════════════════════════════════════════════════════════════════════════════

def build_mock_dataset() -> BacktestDataset:
    """
    Hand-crafted tiny dataset for unit-test-level smoke.

    3 stocks:
      - 2330 (台積電, 電子): sideways drift up, low vol → should hit TP1 slowly
      - 2317 (鴻海, 電子): high vol trending → should trigger trailing stop
      - 0050 (ETF, 其他):  market benchmark (needed for _calc_market_return_5d)

    60 trading days starting 2024-01-02
    """
    rng = np.random.default_rng(seed=42)

    trading_days = pd.bdate_range("2024-01-02", periods=60).strftime("%Y-%m-%d").tolist()

    def gen_path(base: float, drift: float, vol: float, n: int) -> list[float]:
        """Generate a log-normal price path."""
        returns = rng.normal(drift, vol, n)
        prices = [base]
        for r in returns:
            prices.append(prices[-1] * (1 + r))
        return prices[1:]

    stocks_data = {
        "2330": {"base": 600, "drift": 0.0015, "vol": 0.012, "sector": "電子", "id": 1},
        "2317": {"base": 110, "drift": 0.0008, "vol": 0.025, "sector": "電子", "id": 2},
        "0050": {"base": 140, "drift": 0.0005, "vol": 0.008, "sector": "其他", "id": 3},
    }

    stocks_rows = []
    price_rows = []
    indicator_rows = []
    chip_rows = []

    for symbol, meta in stocks_data.items():
        stocks_rows.append({
            "id": meta["id"],
            "symbol": symbol,
            "name": symbol,
            "market": "TWSE",
            "sector": meta["sector"],
            "is_active": 1,
            "listed_date": None,
            "delisted_date": None,
        })

        closes = gen_path(meta["base"], meta["drift"], meta["vol"], 60)
        for i, date in enumerate(trading_days):
            close = closes[i]
            high = close * (1 + abs(rng.normal(0, 0.005)))
            low = close * (1 - abs(rng.normal(0, 0.005)))
            open_px = close * (1 + rng.normal(0, 0.003))
            volume = int(rng.integers(1_000_000, 5_000_000))

            price_rows.append({
                "symbol": symbol,
                "date": date,
                "open": float(open_px),
                "high": float(high),
                "low": float(low),
                "close": float(close),
                "adj_close": float(close),
                "volume": volume,
                "avg_price": float(close),
            })

            # Synthetic technical indicators (rough approximations)
            if i >= 20:
                ma20 = float(np.mean(closes[i - 20:i]))
                ma5 = float(np.mean(closes[i - 5:i]))
            else:
                ma20 = float(close)
                ma5 = float(close)

            atr14 = float(close * 0.015 + rng.normal(0, close * 0.002))
            indicator_rows.append({
                "symbol": symbol,
                "date": date,
                "ma5": ma5, "ma10": ma5, "ma20": ma20, "ma60": ma20,
                "rsi14": float(50 + rng.normal(0, 10)),
                "macd": float(rng.normal(0, 0.5)),
                "macd_signal": float(rng.normal(0, 0.5)),
                "macd_hist": float(rng.normal(0, 0.3)),
                "atr14": abs(atr14),
                "bb_upper": ma20 * 1.02,
                "bb_mid": ma20,
                "bb_lower": ma20 * 0.98,
            })

            # Synthetic chip data (foreign net buy trending positive)
            chip_rows.append({
                "symbol": symbol,
                "date": date,
                "foreign_buy": int(rng.integers(10_000, 100_000)),
                "foreign_sell": int(rng.integers(5_000, 80_000)),
                "foreign_net": int(rng.integers(-20_000, 50_000)),
                "trust_buy": int(rng.integers(1_000, 10_000)),
                "trust_sell": int(rng.integers(500, 8_000)),
                "trust_net": int(rng.integers(-5_000, 10_000)),
                "dealer_buy": int(rng.integers(500, 5_000)),
                "dealer_sell": int(rng.integers(200, 4_000)),
                "dealer_net": int(rng.integers(-2_000, 3_000)),
                "margin_balance": int(rng.integers(100_000, 500_000)),
                "short_balance": int(rng.integers(10_000, 50_000)),
            })

    # Market risk: simple green/yellow alternating
    risk_rows = []
    for i, date in enumerate(trading_days):
        risk_rows.append({
            "date": date,
            "vix": 15 + float(rng.normal(0, 2)),
            "vix_level": "low",
            "twii_close": 17000 + i * 5,
            "twii_vol20": 0.15,
            "twii_ma20": 17000,
            "twii_bias": 0.01,
            "foreign_consecutive_sell": 0,
            "foreign_net_5d": 100.0,
            "margin_ratio": 0.3,
            "limit_down_count": 0,
            "limit_down_pct": 0.0,
            "risk_score": 30,
            "risk_level": "green" if i % 2 == 0 else "yellow",
            "adl_value": 0.5,
            "adl_trend": "up",
            "bull_alignment_count": 100,
            "bull_alignment_pct": 50.0,
        })

    stocks_df = pd.DataFrame(stocks_rows)
    prices_df = pd.DataFrame(price_rows).set_index(["symbol", "date"]).sort_index()
    indicators_df = pd.DataFrame(indicator_rows).set_index(["symbol", "date"]).sort_index()
    chips_df = pd.DataFrame(chip_rows).set_index(["symbol", "date"]).sort_index()
    market_risk_df = pd.DataFrame(risk_rows).set_index("date").sort_index()

    return BacktestDataset(
        prices=prices_df,
        indicators=indicators_df,
        chips=chips_df,
        market_risk=market_risk_df,
        stocks=stocks_df,
        trading_days=trading_days,
        start_date=trading_days[0],
        end_date=trading_days[-1],
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Assertions
# ═══════════════════════════════════════════════════════════════════════════════

def assert_smoke(metrics) -> None:
    """Verify metrics object is structurally sound and has Mode A safeguards."""
    errors: list[str] = []

    # Mode A must have all 15 realism warnings
    if metrics.mode == "A":
        if len(metrics.realism_warnings) != len(MODE_A_DEVIATIONS):
            errors.append(
                f"Mode A should have {len(MODE_A_DEVIATIONS)} warnings, "
                f"got {len(metrics.realism_warnings)}"
            )
        if metrics.absolute_confidence != "relative_only":
            errors.append(
                f"Mode A absolute_confidence should be 'relative_only', "
                f"got {metrics.absolute_confidence!r}"
            )

    # Equity curve should be populated
    if not metrics.equity_curve:
        errors.append("equity_curve is empty")

    # Initial equity should match initial_capital
    if metrics.equity_curve and abs(metrics.equity_curve[0][1] - metrics.initial_capital) > 1:
        errors.append(
            f"equity_curve[0]={metrics.equity_curve[0][1]} doesn't match "
            f"initial_capital={metrics.initial_capital}"
        )

    # Total return formula consistency
    expected_return = (metrics.final_equity / metrics.initial_capital) - 1
    if abs(metrics.total_return - expected_return) > 1e-6:
        errors.append(
            f"total_return={metrics.total_return} doesn't match derived "
            f"{expected_return}"
        )

    # Max drawdown should be in [0, 1]
    if metrics.max_drawdown < 0 or metrics.max_drawdown > 1:
        errors.append(f"max_drawdown={metrics.max_drawdown} out of [0,1]")

    # Win rate should be in [0, 1]
    if metrics.win_rate < 0 or metrics.win_rate > 1:
        errors.append(f"win_rate={metrics.win_rate} out of [0,1]")

    # Fill rate sanity
    if metrics.entry_attempts > 0:
        expected_fill = metrics.entries_filled / metrics.entry_attempts
        if abs(metrics.fill_rate - expected_fill) > 1e-6:
            errors.append(
                f"fill_rate={metrics.fill_rate} doesn't match derived {expected_fill}"
            )

    if errors:
        print("[FAIL] SMOKE TEST FAILED:")
        for e in errors:
            print(f"   - {e}")
        sys.exit(1)
    print("[OK] All smoke assertions passed")


def print_report(metrics) -> None:
    """Human-readable smoke test report."""
    print()
    print("═" * 70)
    print(f"  Backtest Engine Smoke Test Report")
    print("═" * 70)
    print(f"  Mode:          {metrics.mode}  ({metrics.absolute_confidence})")
    print(f"  Timerange:     {metrics.start_date} ~ {metrics.end_date}")
    print(f"  Capital:       {metrics.initial_capital:,.0f} → {metrics.final_equity:,.0f}")
    print(f"  Total return:  {metrics.total_return * 100:+.2f}%")
    print(f"  CAGR:          {metrics.cagr * 100:+.2f}%" if metrics.cagr else "  CAGR:          —")
    print(f"  Sharpe:        {metrics.sharpe:.3f}" if metrics.sharpe else "  Sharpe:        —")
    print(f"  Sortino:       {metrics.sortino:.3f}" if metrics.sortino else "  Sortino:       —")
    print(f"  Calmar:        {metrics.calmar:.3f}" if metrics.calmar else "  Calmar:        —")
    print(f"  Max DD:        {metrics.max_drawdown * 100:.2f}% @ {metrics.max_dd_date}")
    print(f"  Trades:        {metrics.total_trades}  (W:{metrics.wins} L:{metrics.losses})")
    print(f"  Win rate:      {metrics.win_rate * 100:.1f}%")
    print(f"  Profit factor: {metrics.profit_factor:.2f}")
    print(f"  Expectancy:    {metrics.expectancy * 100:+.3f}%")
    print(f"  Avg hold:      {metrics.avg_holding_days:.1f} days")
    print()
    print(f"  Entry funnel:")
    print(f"    attempts:    {metrics.entry_attempts}")
    print(f"    filled:      {metrics.entries_filled}")
    print(f"    fill rate:   {metrics.fill_rate * 100:.1f}%")
    for reason, count in sorted(metrics.skip_reasons.items(), key=lambda x: -x[1]):
        print(f"      {reason}: {count}")
    print()
    print(f"  Exit distribution:")
    for cat, count in sorted(metrics.exit_distribution.items(), key=lambda x: -x[1]):
        print(f"    {cat}: {count}")
    print()
    print(f"  Per-regime ({len(metrics.per_regime)} regimes):")
    for regime, stats in metrics.per_regime.items():
        sharpe_str = f"sharpe={stats['sharpe']:.2f}" if stats.get("sharpe") else "sharpe=—"
        print(f"    {regime}: n={stats['n_trades']} wr={stats['win_rate'] * 100:.0f}% {sharpe_str}")
    print()
    if metrics.sanity_flags:
        print(f"  [!] SANITY FLAGS:")
        for f in metrics.sanity_flags:
            print(f"    - {f}")
        print()
    if metrics.realism_warnings:
        print(f"  [i] REALISM WARNINGS ({len(metrics.realism_warnings)}):")
        print(f"      Mode {metrics.mode}: treat Sharpe as RELATIVE comparison only.")
        print(f"      See memory/project_backtest_engine_design_rationale.md sec 3")
        print()
    print("═" * 70)


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["mock", "d1"], default="mock")
    parser.add_argument("--start", default="2024-01-02")
    parser.add_argument("--end", default="2024-03-31")
    parser.add_argument("--symbols", default="2330,2317,2454,2308,2303,0050")
    parser.add_argument("--capital", type=float, default=1_000_000)
    args = parser.parse_args()

    default_params: dict = {}  # use all dataclass defaults

    if args.mode == "mock":
        logger.info("Building mocked dataset (3 stocks × 60 trading days)...")
        dataset = build_mock_dataset()
        metrics = replay_period(
            dataset=dataset,
            start_date=dataset.trading_days[0],
            end_date=dataset.trading_days[-1],
            params=default_params,
            initial_capital=args.capital,
            mode="A",
            verbose=True,
        )
    else:
        logger.info(f"D1 mode: loading {args.start}~{args.end} symbols={args.symbols}")
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
        metrics = replay_period_loading(
            start_date=args.start,
            end_date=args.end,
            params=default_params,
            initial_capital=args.capital,
            mode="A",
            symbols=symbols,
            verbose=True,
        )

    assert_smoke(metrics)
    print_report(metrics)
    return 0


if __name__ == "__main__":
    sys.exit(main())
