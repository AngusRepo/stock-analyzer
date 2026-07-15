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
