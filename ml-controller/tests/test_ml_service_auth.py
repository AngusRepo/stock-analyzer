"""controller -> ml-service calls carry X-Service-Token; production without it fails closed."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

from services import modal_client
from services.ml_service_auth import MlServiceTokenMissing, ml_service_headers

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("ML_SERVICE_SECRET", raising=False)
    monkeypatch.delenv("ENVIRONMENT", raising=False)


def test_headers_carry_token_when_configured(monkeypatch):
    monkeypatch.setenv("ML_SERVICE_SECRET", " unit-token \n")
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert ml_service_headers() == {"Content-Type": "application/json", "X-Service-Token": "unit-token"}
    assert modal_client._ml_headers()["X-Service-Token"] == "unit-token"


def test_production_without_token_fails_closed(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(MlServiceTokenMissing):
        ml_service_headers()
    with pytest.raises(MlServiceTokenMissing):
        modal_client._ml_headers()


def test_development_without_token_omits_header():
    assert ml_service_headers() == {"Content-Type": "application/json"}


def test_http_fallback_posts_send_the_token(monkeypatch):
    monkeypatch.setenv("ML_SERVICE_SECRET", "unit-token")
    monkeypatch.setattr(modal_client, "_USE_MODAL", False)
    monkeypatch.setattr(modal_client, "_ML_SERVICE_URL", "https://ml.invalid")
    seen = []

    class _Resp:
        status_code = 200

        def json(self):
            return {"ok": True}

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None, headers=None):
            seen.append((url, headers))
            return _Resp()

    monkeypatch.setattr(modal_client.httpx, "AsyncClient", _Client)
    asyncio.run(modal_client.prep_universal_batch({"batch_index": 0}))
    asyncio.run(modal_client.breeze2_reason_generation({}))
    asyncio.run(modal_client._http_batch("/predict/v2", [{"symbol": "2330"}]))
    assert [url for url, _ in seen] == [
        "https://ml.invalid/retrain/universal/prep",
        "https://ml.invalid/breeze2/reason-generation",
        "https://ml.invalid/predict/v2",
    ]
    assert all(headers.get("X-Service-Token") == "unit-token" for _, headers in seen)


def test_http_batch_without_production_token_raises_instead_of_no_signal(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(modal_client, "_USE_MODAL", False)
    monkeypatch.setattr(modal_client, "_ML_SERVICE_URL", "https://ml.invalid")

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None, headers=None):
            raise AssertionError("must not reach ml-service without a token")

    monkeypatch.setattr(modal_client.httpx, "AsyncClient", _Client)
    with pytest.raises(MlServiceTokenMissing):
        asyncio.run(modal_client._http_batch("/predict/v2", [{"symbol": "2330"}]))


def test_regime_compute_production_without_token_is_500_before_upstream(monkeypatch):
    from routers import regime

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setattr(regime, "ML_SERVICE_URL", "https://ml.invalid")

    def _must_not_load(*_args, **_kwargs):
        raise AssertionError("market env loaded before the token check")

    monkeypatch.setattr(regime, "_fetch_market_env_via_payload_builder", _must_not_load)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(regime.regime_compute(regime.RegimeComputeRequest()))
    assert exc_info.value.status_code == 500
    assert "ML_SERVICE_SECRET not configured" in str(exc_info.value.detail)


def test_regime_compute_sends_token(monkeypatch):
    from routers import regime

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ML_SERVICE_SECRET", "unit-token")
    monkeypatch.setattr(regime, "ML_SERVICE_URL", "https://ml.invalid")
    monkeypatch.setattr(regime, "_fetch_market_env_via_payload_builder", lambda _date: {
        "history": {"2026-10-02": {}}, "requested_run_date": "2026-10-02", "hmm_input_checksum": "a" * 64,
    })
    captured = {}

    async def fake_current(_client, *, headers, **_kwargs):
        captured.update(headers)
        raise HTTPException(status_code=599, detail="stop after headers")

    monkeypatch.setattr(regime, "_request_regime_current", fake_current)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(regime.regime_compute(regime.RegimeComputeRequest(run_date="2026-10-02")))
    assert exc_info.value.status_code == 599
    assert captured["X-Service-Token"] == "unit-token"


def test_controller_token_comparison_is_constant_time():
    source = (ROOT / "main.py").read_text(encoding="utf-8-sig")
    assert "hmac.compare_digest(token.encode(\"utf-8\"), _CONTROLLER_TOKEN.encode(\"utf-8\"))" in source
    assert "if token != _CONTROLLER_TOKEN" not in source
