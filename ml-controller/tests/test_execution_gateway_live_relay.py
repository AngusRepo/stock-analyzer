from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.execution_gateway_live_relay import (  # noqa: E402
    relay_execution_intent_status,
    relay_execution_live_submit,
)


class Response:
    def __init__(self, status_code: int = 200, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {"status": "submitted", "intent_id": "intent-1"}

    def json(self) -> dict:
        return self._payload


def _env() -> dict[str, str]:
    return {
        "EXECUTION_GATEWAY_LIVE_RELAY_ENABLED": "1",
        "EXECUTION_GATEWAY_URL": "https://gateway.invalid",
        "EXECUTION_GATEWAY_IAM_AUDIENCE": "https://gateway.invalid",
        "EXECUTION_GATEWAY_SERVICE_TOKEN": "app-token",
    }


def test_live_relay_uses_google_iam_and_never_retries_submit() -> None:
    captured: dict = {}
    calls = 0

    def post(url, headers, json, timeout):
        nonlocal calls
        calls += 1
        captured.update(url=url, headers=headers, json=json, timeout=timeout)
        return Response()

    result = relay_execution_live_submit(
        packet={"idempotency_key": "live-relay-1234567890"},
        signature="signed",
        allow_live_submit=True,
        env=_env(),
        identity_token_provider=lambda audience: "header.payload.signature",
        post_fn=post,
    )
    assert calls == 1
    assert captured["url"] == "https://gateway.invalid/v1/execute"
    assert captured["headers"]["X-Serverless-Authorization"] == "Bearer header.payload.signature"
    assert captured["headers"]["Authorization"] == "Bearer app-token"
    assert captured["headers"]["X-Execution-Signature"] == "signed"
    assert captured["json"]["allow_live_submit"] is True
    assert result["status"] == "submitted"
    assert result["relay_attempts"] == 1


def test_live_relay_failure_is_unknown_without_automatic_retry() -> None:
    calls = 0

    def post(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise TimeoutError("ambiguous response")

    result = relay_execution_live_submit(
        packet={"idempotency_key": "live-relay-1234567890"},
        signature="signed",
        allow_live_submit=True,
        env=_env(),
        identity_token_provider=lambda audience: "header.payload.signature",
        post_fn=post,
    )
    assert calls == 1
    assert result["status"] == "unknown"
    assert result["relay_attempts"] == 1
    assert "reconciliation_required" in result["reason"]


def test_live_relay_disabled_makes_no_request() -> None:
    called = False

    def post(*args, **kwargs):
        nonlocal called
        called = True
        return Response()

    result = relay_execution_live_submit(
        packet={},
        signature="signed",
        allow_live_submit=True,
        env={},
        post_fn=post,
    )
    assert result["reason"] == "execution_gateway_live_relay_disabled"
    assert called is False


def test_production_live_relay_rejects_unallowlisted_or_non_origin_url() -> None:
    base = {
        **_env(),
        "ENVIRONMENT": "production",
        "EXECUTION_GATEWAY_RELAY_ALLOWED_HOSTS": "gateway.invalid",
    }
    wrong_host = relay_execution_live_submit(
        packet={"idempotency_key": "live-relay-1234567890"},
        signature="signed",
        allow_live_submit=True,
        env={**base, "EXECUTION_GATEWAY_URL": "https://other.invalid"},
    )
    assert wrong_host["reason"] == "execution_gateway_live_relay_config_incomplete"
    path_injection = relay_execution_live_submit(
        packet={"idempotency_key": "live-relay-1234567890"},
        signature="signed",
        allow_live_submit=True,
        env={**base, "EXECUTION_GATEWAY_URL": "https://gateway.invalid/attacker?next=x"},
    )
    assert path_injection["reason"] == "execution_gateway_live_relay_config_incomplete"


def test_intent_status_relay_encodes_key_and_uses_both_auth_layers() -> None:
    captured: dict = {}

    def get(url, headers, timeout):
        captured.update(url=url, headers=headers, timeout=timeout)
        return Response(payload={"status": "ok", "legs": []})

    result = relay_execution_intent_status(
        idempotency_key="live/relay key-1234567890",
        env=_env(),
        identity_token_provider=lambda audience: "header.payload.signature",
        get_fn=get,
    )
    assert captured["url"].endswith("/v1/intents/live%2Frelay%20key-1234567890")
    assert captured["headers"]["X-Serverless-Authorization"] == "Bearer header.payload.signature"
    assert captured["headers"]["Authorization"] == "Bearer app-token"
    assert result["status"] == "ok"
