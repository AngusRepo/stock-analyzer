from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.broker_execution_contract import sign_packet  # noqa: E402
from services.execution_gateway_live_relay import (  # noqa: E402
    relay_execution_live_status,
    relay_execution_live_submit,
)


def _env() -> dict[str, str]:
    return {
        "EXECUTION_GATEWAY_LIVE_RELAY_ENABLED": "1",
        "EXECUTION_GATEWAY_URL": "https://gateway.invalid",
        "EXECUTION_GATEWAY_SERVICE_TOKEN": "app-token",
        "LIVE_EXECUTION_HMAC_SECRET": "hmac-secret",
        "LIVE_TRADING_APPROVAL_SCOPE": "pilot-scope",
        "LIVE_TRADING_APPROVAL_EXPIRES_AT": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    }


def _packet() -> dict:
    return {"idempotency_key": "live-relay-test-001", "approval": {"approved_by": "Wei", "scope": "pilot-scope"}}


class Response:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        return self.payload


def test_disabled_relay_never_requests_iam_or_gateway() -> None:
    result = relay_execution_live_submit(
        packet=_packet(), signature="signed", allow_live_submit=True, env={},
        identity_token_provider=lambda _: (_ for _ in ()).throw(AssertionError("IAM called")),
        post_fn=lambda **_: (_ for _ in ()).throw(AssertionError("gateway called")),
    )
    assert result["reason"] == "execution_gateway_live_relay_disabled"


def test_signed_live_relay_uses_both_auth_layers_and_submits_once() -> None:
    packet, env, captured = _packet(), _env(), []

    def post(url, headers, json, timeout):
        captured.append((url, headers, json, timeout))
        return Response(200, {"status": "submitted", "intent_id": "intent-1"})

    result = relay_execution_live_submit(
        packet=packet, signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]),
        allow_live_submit=True, env=env,
        identity_token_provider=lambda audience: "header.payload.signature", post_fn=post,
    )
    assert result["status"] == "submitted"
    assert len(captured) == 1
    url, headers, body, _ = captured[0]
    assert url == "https://gateway.invalid/v1/execute"
    assert headers["X-Serverless-Authorization"] == "Bearer header.payload.signature"
    assert headers["Authorization"] == "Bearer app-token"
    assert headers["X-Execution-Signature"] == sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"])
    assert body == {"packet": packet, "allow_live_submit": True}


def test_invalid_signature_and_approval_block_before_iam() -> None:
    env = _env()
    for scope in ("pilot-scope", "wrong"):
        packet = _packet()
        packet["approval"]["scope"] = scope
        signature = "bad" if scope == "pilot-scope" else sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"])
        result = relay_execution_live_submit(
            packet=packet, signature=signature, allow_live_submit=True, env=env,
            identity_token_provider=lambda _: (_ for _ in ()).throw(AssertionError("IAM called")),
        )
        assert result["status"] == "blocked"


def test_timeout_or_server_error_is_unknown_without_retry() -> None:
    packet, env = _packet(), _env()
    for response in (TimeoutError("after broker submit"), Response(503, {})):
        calls = []

        def post(*args, **kwargs):
            calls.append(1)
            if isinstance(response, Exception):
                raise response
            return response

        result = relay_execution_live_submit(
            packet=packet, signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]),
            allow_live_submit=True, env=env,
            identity_token_provider=lambda _: "header.payload.signature", post_fn=post,
        )
        assert result["status"] == "unknown"
        assert len(calls) == 1


def test_status_recovery_remains_readable_after_submit_relay_is_disabled() -> None:
    env = _env()
    env["EXECUTION_GATEWAY_LIVE_RELAY_ENABLED"] = "0"
    captured = {}

    def get(url, headers, timeout):
        captured.update(url=url, headers=headers)
        return Response(200, {"status": "ok", "legs": [{"status": "ACKNOWLEDGED"}]})

    result = relay_execution_live_status(
        "live-relay-test-001", env=env,
        identity_token_provider=lambda _: "header.payload.signature", get_fn=get,
    )
    assert result["status"] == "ok"
    assert captured["url"] == "https://gateway.invalid/v1/intents/live-relay-test-001"
    assert captured["headers"]["Authorization"] == "Bearer app-token"
