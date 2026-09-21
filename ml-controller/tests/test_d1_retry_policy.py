from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import d1_client  # noqa: E402


class _FakeResponse:
    def __init__(self, status_code: int, text: str = "{}", payload: dict | None = None):
        self.status_code = status_code
        self.text = text
        self._payload = payload or {"success": True, "result": [{"results": [{"ok": 1}]}]}

    def json(self) -> dict:
        return self._payload


def test_d1_post_retries_overloaded_429(monkeypatch):
    calls: list[int] = []

    def fake_post(*_args, **_kwargs):
        calls.append(1)
        if len(calls) == 1:
            return _FakeResponse(429, '{"errors":[{"message":"D1 DB is overloaded"}]}')
        return _FakeResponse(200)

    monkeypatch.setattr(d1_client, "CF_API_TOKEN", "token")
    monkeypatch.setattr(d1_client, "CF_ACCOUNT_ID", "account")
    monkeypatch.setattr(d1_client, "CF_D1_DB_ID", "db")
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=fake_post, RequestError=Exception))
    monkeypatch.setattr(d1_client, "_sleep_before_retry", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(d1_client.time, "sleep", lambda _seconds: None)

    rows = d1_client.query("SELECT 1 AS ok")

    assert rows == [{"ok": 1}]
    assert len(calls) == 2


def test_d1_post_recovers_from_single_cloudflare_auth_10000(monkeypatch):
    calls: list[int] = []

    def fake_post(*_args, **_kwargs):
        calls.append(1)
        if len(calls) == 1:
            return _FakeResponse(
                401,
                '{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
            )
        return _FakeResponse(200)

    monkeypatch.setattr(d1_client, "CF_API_TOKEN", "token")
    monkeypatch.setattr(d1_client, "CF_ACCOUNT_ID", "account")
    monkeypatch.setattr(d1_client, "CF_D1_DB_ID", "db")
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=fake_post, RequestError=Exception))
    monkeypatch.setattr(d1_client, "_sleep_before_retry", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(d1_client.time, "sleep", lambda _seconds: None)

    rows = d1_client.query("SELECT 1 AS ok")

    assert rows == [{"ok": 1}]
    assert len(calls) == 2


def test_d1_post_persistent_auth_10000_still_fails_after_bound(monkeypatch):
    calls: list[int] = []

    def fake_post(*_args, **_kwargs):
        calls.append(1)
        return _FakeResponse(
            401,
            '{"result":null,"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
        )

    monkeypatch.setattr(d1_client, "CF_API_TOKEN", "invalid-token")
    monkeypatch.setattr(d1_client, "CF_ACCOUNT_ID", "account")
    monkeypatch.setattr(d1_client, "CF_D1_DB_ID", "db")
    monkeypatch.setattr(d1_client, "MAX_D1_RETRIES", 2)
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=fake_post, RequestError=Exception))
    monkeypatch.setattr(d1_client, "_sleep_before_retry", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(d1_client.time, "sleep", lambda _seconds: None)

    with pytest.raises(RuntimeError, match="HTTP 401"):
        d1_client.query("SELECT 1 AS ok")

    assert len(calls) == 3


@pytest.mark.parametrize("transport", ["_post", "_post_raw"])
def test_overload_recovers_after_old_retry_budget(monkeypatch, transport):
    calls, delays = [], []
    def post(*args, **kwargs):
        calls.append(kwargs["json"])
        response = _FakeResponse(429, "D1 DB is overloaded") if len(calls) <= 5 else _FakeResponse(200)
        response.headers = {"Retry-After": "9"}
        return response
    monkeypatch.setattr(d1_client, "_check_env", lambda *args: None)
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=post, RequestError=Exception))
    monkeypatch.setattr(d1_client.time, "sleep", delays.append)
    monkeypatch.setattr(d1_client.random, "uniform", lambda *args: 0)
    body = {"sql": "SELECT 1"}
    assert getattr(d1_client, transport)(body)["success"]
    assert calls == [body] * 6
    assert delays == [9, 9, 9, 16, 30]


@pytest.mark.parametrize("transport", ["_post", "_post_raw"])
def test_persistent_overload_is_bounded(monkeypatch, transport):
    calls = []
    def post(*args, **kwargs):
        calls.append(1)
        return _FakeResponse(429, "D1 DB is overloaded")
    monkeypatch.setattr(d1_client, "_check_env", lambda *args: None)
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=post, RequestError=Exception))
    monkeypatch.setattr(d1_client.time, "sleep", lambda seconds: None)
    with pytest.raises(RuntimeError, match="HTTP 429"):
        getattr(d1_client, transport)({"sql": "SELECT 1"})
    assert len(calls) == d1_client.MAX_D1_OVERLOAD_RETRIES + 1


@pytest.mark.parametrize("status", [400, 403])
def test_permanent_error_never_retries(monkeypatch, status):
    monkeypatch.setattr(d1_client, "_check_env", lambda *args: None)
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=lambda *a, **k: _FakeResponse(status), RequestError=Exception))
    monkeypatch.setattr(d1_client.time, "sleep", lambda seconds: pytest.fail("permanent error slept"))
    with pytest.raises(RuntimeError, match=f"HTTP {status}"):
        d1_client._post({"sql": "SELECT 1"})
