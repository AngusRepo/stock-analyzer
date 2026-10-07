from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException


MODULE_PATH = Path(__file__).resolve().parents[1] / "main.py"
SPEC = importlib.util.spec_from_file_location("shioaji_research_test", MODULE_PATH)
assert SPEC and SPEC.loader
research = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(research)


class FakeStocks:
    @staticmethod
    def get(symbol: str):
        return {"code": symbol}


class FakeContracts:
    Stocks = FakeStocks()


class FakeApi:
    Contracts = FakeContracts()

    @staticmethod
    def kbars(contract, start: str, end: str):
        assert contract == {"code": "2441"}
        assert start == "2026-07-07"
        assert end == "2026-07-14"
        return {
            "ts": [datetime(2026, 7, 14, 1, 1, tzinfo=timezone.utc)],
            "Open": [143],
            "High": [145],
            "Low": [142],
            "Close": [144.5],
            "Volume": [1000],
        }

    @staticmethod
    def usage():
        return type("Usage", (), {
            "connections": 1,
            "bytes": 1000,
            "limit_bytes": 500_000_000,
            "remaining_bytes": 499_999_000,
        })()


def test_kbars_are_normalized_without_execution_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(research, "api", FakeApi())
    monkeypatch.setattr(research, "connected", True)
    rows = research.get_kbars("2441", "2026-07-07", "2026-07-14")
    assert rows == [{
        "ts": "2026-07-14T09:01:00+08:00",
        "open": 143.0,
        "high": 145.0,
        "low": 142.0,
        "close": 144.5,
        "volume": 1000.0,
    }]
    paths = {route.path for route in research.app.routes}
    assert "/kbars/{symbol}" in paths
    assert not paths.intersection({"/quote/{symbol}", "/orders", "/market-risk"})
    assert "/kbars/batch" in paths


def test_batch_kbars_preserves_per_symbol_results(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(research, "SERVICE_TOKEN", "test-token")
    calls: list[str] = []

    def fake_get(symbol: str, start: str, end: str, limit: int = 5000):
        calls.append(symbol)
        if symbol == "1785":
            raise LookupError("stock_contract_not_found:1785")
        return [{"ts": "2026-07-24T09:01:00+08:00", "close": 100.0}]

    monkeypatch.setattr(research, "get_kbars", fake_get)
    result = research.kbars_batch_endpoint(
        research.KbarsBatchRequest(
            symbols=["2441", "1785", "2441"],
            start="2026-07-17",
            end="2026-07-24",
        ),
        authorization="Bearer test-token",
    )

    assert calls == ["2441", "1785"]
    assert result["status"] == "partial"
    assert result["requested"] == 2
    assert result["succeeded"] == 1
    assert result["failed"] == 1
    assert [row["status"] for row in result["results"]] == ["ok", "error"]


def test_auth_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(research, "SERVICE_TOKEN", "")
    with pytest.raises(HTTPException) as exc:
        research.verify_token(None)
    assert exc.value.status_code == 503


def test_kbars_fail_with_explicit_bandwidth_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class ExhaustedApi(FakeApi):
        @staticmethod
        def usage():
            return type("Usage", (), {
                "connections": 1,
                "bytes": 600_000_000,
                "limit_bytes": 500_000_000,
                "remaining_bytes": -100_000_000,
            })()

    monkeypatch.setattr(research, "api", ExhaustedApi())
    monkeypatch.setattr(research, "connected", True)
    monkeypatch.setattr(research, "_usage_cache", None)
    monkeypatch.setattr(research, "_usage_cache_at", 0.0)
    with pytest.raises(HTTPException) as exc:
        research.get_kbars("2441", "2026-07-07", "2026-07-14")
    assert exc.value.status_code == 429
    assert "bandwidth_exhausted" in str(exc.value.detail)


def test_3004_sparse_tail_is_rebuilt_from_ticks_not_missing_kbars():
    rows = research.warmup_bars_from_ticks({
        "ts": ["2026-10-06T13:19:30+08:00", "2026-10-06T13:23:10+08:00",
               "2026-10-06T13:24:20+08:00", "2026-10-06T13:30:00+08:00"],
        "close": [122, 121.5, 121.5, 999], "volume": [1, 1, 7, 1000],
    }, "2026-10-06")
    assert len(rows) == 6
    assert [row["volume"] for row in rows] == [1, 0, 0, 0, 1, 7]
    assert [row["close"] for row in rows] == [122, 122, 122, 122, 121.5, 121.5]
    assert rows[-1]["ts"] == "2026-10-06T13:25:00+08:00"
    assert max(row["high"] for row in rows) == 122  # auction excluded


def test_warmup_uses_previous_real_trade_for_empty_tail_minutes():
    rows = research.warmup_bars_from_ticks({
        "ts": ["2026-10-06T13:12:00+08:00"], "close": [121], "volume": [2],
    }, "2026-10-06")
    assert all(row["volume"] == 0 and row["close"] == 121 for row in rows)


@pytest.mark.parametrize("payload,reason", [
    ({"ts": [], "close": [], "volume": []}, "seed_missing"),
    ({"ts": ["2026-10-06T13:19:00+08:00"], "close": [122], "volume": []}, "length_mismatch"),
    ({"ts": ["2026-10-06T13:19:00+08:00"], "close": [float("nan")], "volume": [1]}, "invalid_trade"),
    ({"ts": ["2026-10-06T13:19:00+08:00"], "close": [122], "volume": [-1]}, "invalid_trade"),
    ({"ts": ["2026-10-06T13:19:00+08:00"], "close": [122], "volume": [1], "simtrade": [1]}, "seed_missing"),
])
def test_warmup_never_fabricates_prices_for_bad_or_missing_ticks(payload, reason):
    with pytest.raises(HTTPException, match=reason):
        research.warmup_bars_from_ticks(payload, "2026-10-06")


def test_warmup_endpoint_requires_auth_and_a_completed_previous_session(monkeypatch):
    monkeypatch.setattr(research, "SERVICE_TOKEN", "test-token")
    with pytest.raises(HTTPException) as exc:
        research.atr_warmup_endpoint("3004", "2026-10-06", authorization="Bearer wrong")
    assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        research.atr_warmup_endpoint("3004", research.datetime.now(research.TW_TZ).date().isoformat(), authorization="Bearer test-token")
    assert exc.value.status_code == 400
