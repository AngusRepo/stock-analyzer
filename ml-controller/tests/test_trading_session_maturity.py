from __future__ import annotations

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from services.trading_session_maturity import fifth_session_maturity_cutoff


def test_fifth_session_cutoff_uses_canonical_market_calendar() -> None:
    observed: dict[str, object] = {}

    def query(sql: str, params: list[object]) -> list[dict[str, object]]:
        observed["sql"] = sql
        observed["params"] = params
        return [
            {"session_date": value}
            for value in [
                "2026-08-25",
                "2026-08-24",
                "2026-08-21",
                "2026-08-20",
                "2026-08-19",
                "2026-08-18",
            ]
        ]

    assert fifth_session_maturity_cutoff("2026-08-25", query_fn=query) == "2026-08-18"
    assert "FROM stock_prices" in str(observed["sql"])
    assert "LIMIT 6" in str(observed["sql"])
    assert observed["params"] == ["2026-08-25"]


def test_fifth_session_cutoff_fails_closed_when_calendar_is_incomplete() -> None:
    assert fifth_session_maturity_cutoff(
        "2026-08-25",
        query_fn=lambda _sql, _params: [{"session_date": "2026-08-25"}],
    ) is None
