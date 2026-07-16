from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from starlette.requests import Request
from starlette.responses import JSONResponse

from services.controller_auth import controller_auth_middleware, evaluate_controller_auth


def _clear(monkeypatch):
    for name in (
        "ML_CONTROLLER_SECRET",
        "ENVIRONMENT",
        "ALLOW_INSECURE_LOCAL_AUTH",
        "K_SERVICE",
        "K_REVISION",
    ):
        monkeypatch.delenv(name, raising=False)


def test_controller_missing_secret_fails_closed(monkeypatch):
    _clear(monkeypatch)
    decision = evaluate_controller_auth("")
    assert decision.allowed is False
    assert decision.status_code == 503


def test_controller_auth_accepts_only_the_configured_secret(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ML_CONTROLLER_SECRET", "secret")
    assert evaluate_controller_auth("wrong").status_code == 401
    assert evaluate_controller_auth("secret").allowed is True


def test_cloud_runtime_rejects_local_bypass(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("ALLOW_INSECURE_LOCAL_AUTH", "1")
    monkeypatch.setenv("K_SERVICE", "ml-controller")
    assert evaluate_controller_auth("").allowed is False


def _request(path: str, token: str = "") -> Request:
    headers = [] if not token else [(b"x-controller-token", token.encode())]
    return Request({"type": "http", "method": "GET", "path": path, "headers": headers})


@pytest.mark.asyncio
async def test_controller_middleware_protects_unknown_future_routes(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ML_CONTROLLER_SECRET", "secret")

    async def endpoint(_request):
        return JSONResponse({"ok": True})

    denied = await controller_auth_middleware(_request("/future-route"), endpoint)
    allowed = await controller_auth_middleware(_request("/future-route", "secret"), endpoint)
    health = await controller_auth_middleware(_request("/health"), endpoint)
    assert denied.status_code == 401
    assert allowed.status_code == 200
    assert health.status_code == 200
