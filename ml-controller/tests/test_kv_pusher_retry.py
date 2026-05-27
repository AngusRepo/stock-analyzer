from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import kv_pusher  # noqa: E402


def test_push_optuna_result_retries_transient_worker_disconnect(monkeypatch) -> None:
    attempts: list[str] = []

    def fake_post(url, headers, json, timeout):  # noqa: ANN001
        attempts.append(url)
        if len(attempts) == 1:
            request = httpx.Request("POST", url)
            raise httpx.RemoteProtocolError(
                "Server disconnected without sending a response.",
                request=request,
            )
        return httpx.Response(
            200,
            json={"success": True, "updatedFields": ["market_regime_state"]},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(kv_pusher, "AUTH_TOKEN", "test-token")
    monkeypatch.setattr(kv_pusher.httpx, "post", fake_post)
    monkeypatch.setattr(kv_pusher.time, "sleep", lambda _seconds: None)

    result = kv_pusher.push_optuna_result(
        source="regime",
        params={"label": "bull_market"},
        meta={"run_date": "2026-05-27"},
        max_attempts=2,
        retry_delay_seconds=0,
    )

    assert result["success"] is True
    assert len(attempts) == 2


def test_push_optuna_result_raises_after_retry_budget(monkeypatch) -> None:
    attempts = 0

    def always_disconnect(url, headers, json, timeout):  # noqa: ANN001
        nonlocal attempts
        attempts += 1
        request = httpx.Request("POST", url)
        raise httpx.RemoteProtocolError(
            "Server disconnected without sending a response.",
            request=request,
        )

    monkeypatch.setattr(kv_pusher, "AUTH_TOKEN", "test-token")
    monkeypatch.setattr(kv_pusher.httpx, "post", always_disconnect)
    monkeypatch.setattr(kv_pusher.time, "sleep", lambda _seconds: None)

    try:
        kv_pusher.push_optuna_result(
            source="regime",
            params={"label": "bull_market"},
            max_attempts=3,
            retry_delay_seconds=0,
        )
    except RuntimeError as exc:
        assert "after 3 attempts" in str(exc)
    else:
        raise AssertionError("expected RuntimeError after retry budget")

    assert attempts == 3
