from __future__ import annotations

import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import payload_builder  # noqa: E402


def test_market_symbol_price_loader_splits_core_identity_from_market_prices(monkeypatch):
    calls: list[tuple[str, str, list]] = []

    def core_query(sql, params, **_kwargs):
        calls.append(("core", sql, list(params)))
        return [
            {"id": 100, "symbol": "TAIEX"},
            {"id": 50, "symbol": "0050"},
        ]

    def market_query(sql, params, **_kwargs):
        calls.append(("market", sql, list(params)))
        return [
            {"stock_id": 100, "date": "2026-08-24", "close": 25000.0},
            {"stock_id": 50, "date": "2026-08-24", "close": 200.0},
        ]

    monkeypatch.setattr(payload_builder.CORE_D1_CLIENT, "query", core_query)
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, "query", market_query)

    rows = payload_builder._load_market_symbol_price_rows(
        ["TAIEX", "0050"],
        "2026-08-24",
        limit=520,
    )

    assert [row["symbol"] for row in rows] == ["TAIEX", "0050"]
    assert "FROM stocks" in calls[0][1]
    assert "FROM stock_prices" in calls[1][1]
    assert "JOIN stocks" not in calls[1][1]
    assert calls[1][2] == [100, 50, "2026-08-24", 520]


def test_model_accuracy_reads_learning_owner(monkeypatch):
    calls: list[tuple[str, list]] = []

    def learning_query(sql, params, **_kwargs):
        calls.append((sql, list(params)))
        return []

    monkeypatch.setattr(payload_builder.LEARNING_D1_CLIENT, "query", learning_query)

    assert payload_builder._bulk_load_accuracies([7]) == ({7: {}}, {7: {}})
    assert len(calls) == 1
    assert "FROM model_accuracy" in calls[0][0]
    assert calls[0][1] == [7]


def test_payload_builder_has_no_direct_legacy_d1_query_path():
    source = inspect.getsource(payload_builder)
    assert "d1_client.query(" not in source
    assert "CORE_D1_CLIENT.query(" in source
    assert "MARKET_D1_CLIENT.query(" in source
    assert "LEARNING_D1_CLIENT.query(" in source
