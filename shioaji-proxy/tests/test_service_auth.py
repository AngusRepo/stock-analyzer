from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from fastapi import HTTPException


MODULE_PATH = Path(__file__).resolve().parents[1] / "main.py"
SPEC = importlib.util.spec_from_file_location("shioaji_proxy_auth_test", MODULE_PATH)
assert SPEC and SPEC.loader
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


def test_missing_service_token_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(proxy, "SERVICE_TOKEN", "")
    monkeypatch.setattr(proxy, "ALLOW_INSECURE_LOCAL_AUTH", False)
    with pytest.raises(HTTPException) as exc:
        proxy.verify_token(None)
    assert exc.value.status_code == 503


def test_invalid_service_token_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(proxy, "SERVICE_TOKEN", "expected")
    with pytest.raises(HTTPException) as exc:
        proxy.verify_token("Bearer wrong")
    assert exc.value.status_code == 401


def test_valid_service_token_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(proxy, "SERVICE_TOKEN", "expected")
    proxy.verify_token("Bearer expected")
