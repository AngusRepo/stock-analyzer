from __future__ import annotations

from datetime import date, timedelta

from services.backtest_service import _parse_formal_signals, _run_backtest_for_stock


def test_parse_formal_signals_requires_prediction_date_and_keeps_latest_row() -> None:
    signals, diagnostics = _parse_formal_signals(
        [
            {
                "prediction_date": None,
                "generated_at": "2026-07-01T13:00:00Z",
                "trade_signal": "BUY",
            },
            {
                "prediction_date": "2026-07-01",
                "generated_at": "2026-07-01T13:00:00Z",
                "trade_signal": "HOLD",
            },
            {
                "prediction_date": "2026-07-01",
                "generated_at": "2026-07-01T13:30:00Z",
                "signal_raw": "BUY",
            },
        ]
    )

    assert signals == [
        {
            "date": "2026-07-01",
            "signal": "BUY",
            "confidence": 0,
            "entry_price": None,
            "stop_loss": None,
            "target1": None,
            "target2": None,
        }
    ]
    assert diagnostics == {
        "raw_rows": 3,
        "missing_prediction_date": 1,
        "formal_rows": 1,
        "formal_buy_rows": 1,
    }


def test_formal_signal_executes_next_session_open_without_fixed_confidence_gate() -> None:
    start = date(2026, 5, 1)
    prices = []
    for offset in range(32):
        session = (start + timedelta(days=offset)).isoformat()
        prices.append(
            {
                "symbol": "2330",
                "date": session,
                "open": 100.0 if offset == 30 else 101.0,
                "high": 101.0,
                "low": 99.0,
                "close": 100.0,
            }
        )

    signals = [
        {"date": prices[29]["date"], "signal": "BUY", "confidence": 0.01},
        {"date": prices[30]["date"], "signal": "SELL", "confidence": 0.01},
    ]
    trades = _run_backtest_for_stock(prices, signals)

    assert len(trades) == 1
    assert trades[0]["entry_date"] == prices[30]["date"]
    assert trades[0]["entry_price"] == 100.5
    assert trades[0]["exit_date"] == prices[31]["date"]
    assert trades[0]["exit_price"] == 100.5
    assert "ML_SELL" in trades[0]["exit_reason"]
