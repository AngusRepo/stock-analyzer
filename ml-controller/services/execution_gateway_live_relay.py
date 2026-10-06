"""One-shot IAM relay for signed live execution packets and read-only status."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from urllib.parse import quote

import httpx

from services.broker_execution_contract import parse_time, signature_valid
from services.execution_gateway_shadow_relay import _safe_gateway_url, _truthy, fetch_google_identity_token


def _config(env: Mapping[str, str]) -> tuple[str, str, str]:
    url = _safe_gateway_url(str(env.get("EXECUTION_GATEWAY_URL") or ""))
    token = str(env.get("EXECUTION_GATEWAY_SERVICE_TOKEN") or "").strip()
    audience = str(env.get("EXECUTION_GATEWAY_IAM_AUDIENCE") or url).strip()
    return url, token, audience


def _headers(identity_token: str, service_token: str, signature: str | None = None) -> dict[str, str]:
    headers = {
        "X-Serverless-Authorization": f"Bearer {identity_token}",
        "Authorization": f"Bearer {service_token}",
    }
    if signature is not None:
        headers["X-Execution-Signature"] = signature
        headers["Content-Type"] = "application/json"
    return headers


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
        return {"status": "blocked", "reason": "execution_gateway_live_relay_disabled"}
    if not allow_live_submit:
        return {"status": "blocked", "reason": "allow_live_submit_required"}
    url, service_token, audience = _config(values)
    secret = str(values.get("LIVE_EXECUTION_HMAC_SECRET") or "")
    if not url or not service_token or not secret:
        return {"status": "blocked", "reason": "execution_gateway_live_relay_config_incomplete"}
    if not signature_valid(packet, signature, secret):
        return {"status": "blocked", "reason": "execution_packet_signature_invalid"}
    approval = packet.get("approval") if isinstance(packet.get("approval"), Mapping) else {}
    scope = str(values.get("LIVE_TRADING_APPROVAL_SCOPE") or "").strip()
    expiry = parse_time(values.get("LIVE_TRADING_APPROVAL_EXPIRES_AT"))
    if not scope or approval.get("scope") != scope or expiry is None or expiry <= datetime.now(timezone.utc):
        return {"status": "blocked", "reason": "live_trading_approval_unavailable"}
    try:
        identity_token = (identity_token_provider or fetch_google_identity_token)(audience)
        timeout = max(0.25, min(float(values.get("EXECUTION_GATEWAY_LIVE_TIMEOUT_SECONDS") or 3.5), 4.5))
        # Never retry this POST: a timeout or 5xx can follow a successful broker order.
        response = post_fn(
            f"{url}/v1/execute",
            headers=_headers(identity_token, service_token, signature),
            json={"packet": dict(packet), "allow_live_submit": True},
            timeout=timeout,
        )
        if int(response.status_code) >= 500:
            return {"status": "unknown", "reason": "execution_gateway_response_unknown_reconciliation_required"}
        payload = response.json()
        if int(response.status_code) != 200:
            return {"status": "error", "reason": f"execution_gateway_http_{response.status_code}"}
        if not isinstance(payload, Mapping):
            return {"status": "unknown", "reason": "execution_gateway_response_invalid_reconciliation_required"}
        return dict(payload)
    except Exception as exc:
        return {
            "status": "unknown",
            "reason": "execution_gateway_response_unknown_reconciliation_required",
            "error_type": exc.__class__.__name__,
        }


def relay_execution_live_status(
    idempotency_key: str,
    *,
    env: Mapping[str, str] | None = None,
    identity_token_provider: Callable[[str], str] | None = None,
    get_fn: Callable[..., Any] = httpx.get,
) -> dict[str, Any]:
    """Read-only recovery remains available after the submit switch is closed."""
    values = env or os.environ
    url, service_token, audience = _config(values)
    if not url or not service_token or not 16 <= len(idempotency_key.strip()) <= 200:
        return {"status": "blocked", "reason": "execution_gateway_live_status_config_incomplete"}
    try:
        identity_token = (identity_token_provider or fetch_google_identity_token)(audience)
        response = get_fn(
            f"{url}/v1/intents/{quote(idempotency_key.strip(), safe='')}",
            headers=_headers(identity_token, service_token),
            timeout=2.5,
        )
        payload = response.json()
        if int(response.status_code) != 200:
            return {"status": "error", "reason": f"execution_gateway_status_http_{response.status_code}"}
        return dict(payload) if isinstance(payload, Mapping) else {"status": "unknown", "reason": "execution_gateway_status_invalid"}
    except Exception as exc:
        return {"status": "unknown", "reason": "execution_gateway_status_unavailable", "error_type": exc.__class__.__name__}
