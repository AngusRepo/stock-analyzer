from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.execution_gateway_shadow_relay import relay_execution_shadow  # noqa: E402


class Response:
    status_code = 200

    def json(self):
        return {"status": "partial", "reason": "broker_truth_shadow_disabled"}


def test_relay_uses_google_iam_and_app_auth_on_shadow_endpoint() -> None:
    captured = {}

    def post(url, headers, json, timeout):
        captured.update(url=url, headers=headers, json=json, timeout=timeout)
        return Response()

    result = relay_execution_shadow(
        packet={"idempotency_key": "shadow-1234567890"},
        signature="signed",
        env={
            "EXECUTION_GATEWAY_SHADOW_RELAY_ENABLED": "1",
            "EXECUTION_GATEWAY_URL": "https://gateway.invalid/",
            "EXECUTION_GATEWAY_SERVICE_TOKEN": "app-token",
        },
        identity_token_provider=lambda audience: "header.payload.signature",
        post_fn=post,
    )
    assert captured["url"] == "https://gateway.invalid/v1/shadow/validate"
    assert captured["headers"]["X-Serverless-Authorization"] == "Bearer header.payload.signature"
    assert captured["headers"]["Authorization"] == "Bearer app-token"
    assert captured["headers"]["X-Execution-Signature"] == "signed"
    assert result["relay_authenticated_with_google_iam"] is True
    assert result["relay_attempts"] == 1
    assert result["can_submit_real_order"] is False


def test_relay_disabled_makes_no_network_call() -> None:
    called = False

    def post(*args, **kwargs):
        nonlocal called
        called = True
        return Response()

    result = relay_execution_shadow(packet={}, signature="x", env={}, post_fn=post)
    assert result["reason"] == "execution_gateway_shadow_relay_disabled"
    assert called is False


def test_relay_rejects_non_https_gateway() -> None:
    result = relay_execution_shadow(
        packet={},
        signature="x",
        env={
            "EXECUTION_GATEWAY_SHADOW_RELAY_ENABLED": "1",
            "EXECUTION_GATEWAY_URL": "http://gateway.invalid",
            "EXECUTION_GATEWAY_SERVICE_TOKEN": "token",
        },
    )
    assert result["reason"] == "execution_gateway_shadow_relay_config_incomplete"


def test_relay_retries_one_transient_failure() -> None:
    calls = 0

    def post(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("transient")
        return Response()

    result = relay_execution_shadow(
        packet={"idempotency_key": "shadow-1234567890"},
        signature="signed",
        env={
            "EXECUTION_GATEWAY_SHADOW_RELAY_ENABLED": "1",
            "EXECUTION_GATEWAY_URL": "https://gateway.invalid",
            "EXECUTION_GATEWAY_SERVICE_TOKEN": "app-token",
        },
        identity_token_provider=lambda audience: "header.payload.signature",
        post_fn=post,
    )
    assert result["status"] == "partial"
    assert result["relay_attempts"] == 2
    assert calls == 2
