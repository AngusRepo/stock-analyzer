from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest
from fastapi import HTTPException


def _load_proxy_main():
    path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("shioaji_proxy_main_chips", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def proxy(monkeypatch):
    module = _load_proxy_main()
    monkeypatch.setattr(module, "SERVICE_TOKEN", "unit-proxy-token")
    monkeypatch.setattr(module, "ENVIRONMENT", "production")
    return module


def test_verify_token_constant_time_paths(proxy):
    proxy.verify_token("Bearer unit-proxy-token")
    for header in (None, "", "unit-proxy-token", "Bearer wrong", "Bearer unit-proxy-tokené"):
        with pytest.raises(HTTPException) as exc_info:
            proxy.verify_token(header)
        assert exc_info.value.status_code == 401


def test_verify_token_production_without_secret_is_500(proxy, monkeypatch):
    monkeypatch.setattr(proxy, "SERVICE_TOKEN", "")
    with pytest.raises(HTTPException) as exc_info:
        proxy.verify_token("Bearer anything")
    assert exc_info.value.status_code == 500


@pytest.mark.parametrize("route", ["twse_chips", "tpex_chips"])
def test_chips_routes_require_bearer_before_upstream(proxy, monkeypatch, route):
    import httpx

    def _no_upstream(*_args, **_kwargs):
        raise AssertionError("upstream contacted before auth")

    monkeypatch.setattr(httpx, "AsyncClient", _no_upstream)
    handler = getattr(proxy, route)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(handler(proxy.ChipsRequest(date="2026-11-24"), authorization=None))
    assert exc_info.value.status_code == 401
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(handler(proxy.ChipsRequest(date="2026-11-24"), authorization="Bearer wrong"))
    assert exc_info.value.status_code == 401


@pytest.mark.parametrize("route", ["twse_chips", "tpex_chips"])
@pytest.mark.parametrize("bad_date", ["20261124", "2026-13-01", "2026-02-30", "2026-11-24&x=1", "../etc", "２０２６-11-24"])
def test_chips_routes_reject_malformed_dates(proxy, monkeypatch, route, bad_date):
    import httpx

    def _no_upstream(*_args, **_kwargs):
        raise AssertionError("upstream contacted with a malformed date")

    monkeypatch.setattr(httpx, "AsyncClient", _no_upstream)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(getattr(proxy, route)(proxy.ChipsRequest(date=bad_date), authorization="Bearer unit-proxy-token"))
    assert exc_info.value.status_code == 422


def test_valid_date_is_accepted(proxy):
    assert proxy._validated_chips_date("2026-11-24") == "2026-11-24"
