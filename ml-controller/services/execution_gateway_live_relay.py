"""Fail-closed Google-IAM relay for live execution and reconciliation.

The Cloudflare Worker cannot call an IAM-private Cloud Run service with the
application bearer token alone. The general controller mints the Google ID
token with its attached service account and forwards the separately signed
execution packet. Submit is never retried because a lost response is
ambiguous; callers must reconcile by idempotency key.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Mapping
from urllib.parse import quote

import httpx

from services.execution_gateway_shadow_relay import (
    _gateway_url_from_env,
    _truthy,
    fetch_google_identity_token,
)


def _blocked(reason: str) -> dict[str, Any]:
    return {
        "status": "blocked",
        "reason": reason,
        "can_submit_real_order": False,
        "live_submit_enabled": False,
    }


def _relay_config(values: Mapping[str, str]) -> tuple[str, str, str] | None:
    gateway_url = _gateway_url_from_env(values)
    service_token = str(values.get("EXECUTION_GATEWAY_SERVICE_TOKEN") or "").strip()
    audience = str(values.get("EXECUTION_GATEWAY_IAM_AUDIENCE") or gateway_url).strip()
    if not gateway_url or not service_token or not audience:
        return None
    return gateway_url, service_token, audience


def relay_execution_live_submit(
    *,
    packet: Mapping[str, Any],
    signature: str | None,
    allow_live_submit: bool,
    env: Mapping[str, str] | None = None,
    identity_token_provider: Callable[[str], str] | None = None,
    post_fn: Callable[..., Any] = httpx.post,
) -> dict[str, Any]:
    values = env or os.environ
    if not _truthy(values.get("EXECUTION_GATEWAY_LIVE_RELAY_ENABLED")):
        return _blocked("execution_gateway_live_relay_disabled")
    config = _relay_config(values)
    if config is None or not packet or not signature or not allow_live_submit:
        return _blocked("execution_gateway_live_relay_config_incomplete")
    gateway_url, service_token, audience = config
    try:
        identity_token = (identity_token_provider or fetch_google_identity_token)(audience)
        timeout = max(1.0, min(float(values.get("EXECUTION_GATEWAY_LIVE_TIMEOUT_SECONDS") or 4.0), 8.0))
        response = post_fn(
            f"{gateway_url}/v1/execute",
            headers={
                "X-Serverless-Authorization": f"Bearer {identity_token}",
                "Authorization": f"Bearer {service_token}",
                "X-Execution-Signature": signature,
                "Content-Type": "application/json",
            },
            json={"packet": dict(packet), "allow_live_submit": True},
            timeout=timeout,
        )
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if int(response.status_code) != 200:
            return {
                "status": "unknown",
                "reason": f"execution_gateway_live_http_{response.status_code}_reconciliation_required",
                "gateway_payload": dict(payload) if isinstance(payload, Mapping) else {},
                "relay_attempts": 1,
                "can_submit_real_order": True,
                "live_submit_enabled": True,
            }
        result = dict(payload) if isinstance(payload, Mapping) else {
            "status": "unknown",
            "reason": "execution_gateway_live_payload_invalid_reconciliation_required",
        }
        result["relay_authenticated_with_google_iam"] = True
        result["relay_attempts"] = 1
        return result
    except Exception as exc:
        return {
            "status": "unknown",
            "reason": "execution_gateway_live_response_unknown_reconciliation_required",
            "error_type": exc.__class__.__name__,
            "relay_attempts": 1,
            "can_submit_real_order": True,
            "live_submit_enabled": True,
        }


def relay_execution_intent_status(
    *,
    idempotency_key: str,
    env: Mapping[str, str] | None = None,
    identity_token_provider: Callable[[str], str] | None = None,
    get_fn: Callable[..., Any] = httpx.get,
) -> dict[str, Any]:
    values = env or os.environ
    if not _truthy(values.get("EXECUTION_GATEWAY_LIVE_RELAY_ENABLED")):
        return _blocked("execution_gateway_live_relay_disabled")
    config = _relay_config(values)
    key = idempotency_key.strip()
    if config is None or len(key) < 16 or len(key) > 200:
        return _blocked("execution_gateway_intent_status_config_invalid")
    gateway_url, service_token, audience = config
    try:
        identity_token = (identity_token_provider or fetch_google_identity_token)(audience)
        timeout = max(0.5, min(float(values.get("EXECUTION_GATEWAY_STATUS_TIMEOUT_SECONDS") or 2.0), 4.0))
        response = get_fn(
            f"{gateway_url}/v1/intents/{quote(key, safe='')}",
            headers={
                "X-Serverless-Authorization": f"Bearer {identity_token}",
                "Authorization": f"Bearer {service_token}",
            },
            timeout=timeout,
        )
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if int(response.status_code) != 200:
            return {
                "status": "unknown",
                "reason": f"execution_gateway_intent_status_http_{response.status_code}",
                "gateway_payload": dict(payload) if isinstance(payload, Mapping) else {},
                "relay_authenticated_with_google_iam": True,
            }
        result = dict(payload) if isinstance(payload, Mapping) else {
            "status": "unknown",
            "reason": "execution_gateway_intent_status_payload_invalid",
        }
        result["relay_authenticated_with_google_iam"] = True
        return result
    except Exception as exc:
        return {
            "status": "unknown",
            "reason": "execution_gateway_intent_status_unavailable",
            "error_type": exc.__class__.__name__,
        }
