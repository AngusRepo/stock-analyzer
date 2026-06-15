from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import payload_builder  # noqa: E402
from services import active9_dataset_policy  # noqa: E402


def test_active9_dataset_policy_defaults_match_core_windows(monkeypatch):
    monkeypatch.delenv("STOCKVISION_DAILY_PRICE_LOOKBACK_YEARS", raising=False)
    monkeypatch.delenv("STOCKVISION_DAILY_PRICE_HISTORY_LIMIT", raising=False)
    monkeypatch.delenv("STOCKVISION_DAILY_SEQUENCE_TARGET_POINTS", raising=False)
    monkeypatch.delenv("STOCKVISION_GNN_RETURN_HISTORY_LOOKBACK", raising=False)

    assert active9_dataset_policy.daily_price_lookback_years() == 5
    assert active9_dataset_policy.daily_price_history_limit() == 1280
    assert active9_dataset_policy.daily_sequence_target_points() == 1024
    assert active9_dataset_policy.gnn_return_history_lookback() == 252


def test_payload_builder_uses_policy_lookback_and_truncates_explicit_limit(monkeypatch):
    captured: dict = {}

    def fake_query(sql, params, timeout=120.0):
        captured["sql"] = sql
        captured["params"] = params
        return [
            {
                "stock_id": 1,
                "date": f"2026-01-{idx:02d}",
                "open": idx,
                "high": idx,
                "low": idx,
                "close": idx,
                "volume": idx,
                "adj_close": idx,
                "avg_price": idx,
            }
            for idx in range(1, 8)
        ]

    monkeypatch.delenv("STOCKVISION_DAILY_PRICE_LOOKBACK_YEARS", raising=False)
    monkeypatch.setattr(payload_builder.d1_client, "query", fake_query)

    rows = payload_builder._bulk_load_prices([1], limit=3)

    assert "date('now','-5 years')" in captured["sql"]
    assert captured["params"] == [1]
    assert [row["close"] for row in rows[1]] == [5, 6, 7]


def test_payload_builder_chunks_d1_in_clause_loads(monkeypatch):
    calls: list[list[int]] = []

    def fake_query(sql, params, timeout=120.0):
        calls.append(list(params))
        assert sql.count("?") == len(params)
        assert len(params) <= payload_builder.D1_IN_CLAUSE_CHUNK_SIZE
        return [
            {
                "stock_id": sid,
                "date": "2026-06-15",
                "open": 1,
                "high": 1,
                "low": 1,
                "close": sid,
                "volume": 100,
                "adj_close": sid,
                "avg_price": sid,
            }
            for sid in params
        ]

    monkeypatch.setattr(payload_builder.d1_client, "query", fake_query)

    rows = payload_builder._bulk_load_prices(list(range(1, 166)), limit=3)

    assert [len(call) for call in calls] == [80, 80, 5]
    assert len(rows) == 165
    assert rows[165][0]["close"] == 165
