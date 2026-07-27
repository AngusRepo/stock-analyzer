from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.intraday_prediction_batch import load_latest_ensemble_predictions  # noqa: E402


def test_intraday_prediction_loader_batches_d1_queries_and_deduplicates_symbols():
    calls: list[tuple[str, list[object]]] = []

    def query_fn(sql: str, params: list[object]) -> list[dict]:
        calls.append((sql, params))
        return [
            {
                "symbol": symbol,
                "direction_accuracy": 0.7,
                "trade_signal": "buy",
                "generated_at": "2026-07-27T01:00:00Z",
            }
            for symbol in params
        ]

    symbols = [f"{index:04d}" for index in range(161)] + ["0001", ""]
    result = load_latest_ensemble_predictions(symbols, query_fn)

    assert [len(params) for _, params in calls] == [80, 80, 1]
    assert len(result) == 161
    assert all("ROW_NUMBER() OVER" in sql for sql, _ in calls)
    assert all("s.symbol IN" in sql for sql, _ in calls)
    assert result["0001"]["trade_signal"] == "buy"
