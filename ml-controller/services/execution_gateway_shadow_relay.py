"""Google-IAM authenticated relay to the private execution gateway."""

from __future__ import annotations

import os
from typing import Any, Callable, Mapping
from urllib.parse import quote, urlparse

import httpx


METADATA_IDENTITY_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/"
    "service-accounts/default/identity"
)


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "enabled", "on"}


def _safe_gateway_url(value: str) -> str:
    base = value.strip().rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        return ""
    return base


def fetch_google_identity_token(
    audience: str,
    *,
    get_fn: Callable[..., Any] = httpx.get,
    timeout_seconds: float = 1.0,
) -> str:
    response = get_fn(
        f"{METADATA_IDENTITY_URL}?audience={quote(audience, safe='')}&format=full",
        headers={"Metadata-Flavor": "Google"},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    token = str(response.text or "").strip()
    if token.count(".") != 2:
        raise RuntimeError("google_identity_token_invalid")
    return token


def relay_execution_shadow(
    *,
    packet: Mapping[str, Any],
    signature: str | None,
    env: Mapping[str, str] | None = None,
    identity_token_provider: Callable[[str], str] | None = None,
    post_fn: Callable[..., Any] = httpx.post,
) -> dict[str, Any]:
    values = env or os.environ
    if not _truthy(values.get("EXECUTION_GATEWAY_SHADOW_RELAY_ENABLED")):
        return {
            "status": "blocked",
            "reason": "execution_gateway_shadow_relay_disabled",
            "can_submit_real_order": False,
            "live_submit_enabled": False,
        }
    gateway_url = _safe_gateway_url(str(values.get("EXECUTION_GATEWAY_URL") or ""))
    service_token = str(values.get("EXECUTION_GATEWAY_SERVICE_TOKEN") or "").strip()
    if not gateway_url or not service_token or not signature:
        return {
            "status": "blocked",
            "reason": "execution_gateway_shadow_relay_config_incomplete",
            "can_submit_real_order": False,
            "live_submit_enabled": False,
        }
    audience = str(values.get("EXECUTION_GATEWAY_IAM_AUDIENCE") or gateway_url).strip()
    try:
        provider = identity_token_provider or fetch_google_identity_token
        identity_token = provider(audience)
        timeout = max(0.25, min(float(values.get("EXECUTION_GATEWAY_SHADOW_TIMEOUT_SECONDS") or 1.75), 2.0))
        response = None
        last_error: Exception | None = None
        attempts = 0
        for attempts in (1, 2):
            try:
                response = post_fn(
                    f"{gateway_url}/v1/shadow/validate",
                    headers={
                        "X-Serverless-Authorization": f"Bearer {identity_token}",
                        "Authorization": f"Bearer {service_token}",
                        "X-Execution-Signature": signature,
                        "Content-Type": "application/json",
                    },
                    json={"packet": dict(packet)},
                    timeout=timeout,
                )
                if int(response.status_code) < 500:
                    break
            except Exception as exc:
                last_error = exc
                response = None
        if response is None:
            raise last_error or RuntimeError("execution_gateway_shadow_no_response")
        payload = response.json()
        if int(response.status_code) != 200:
            return {
                "status": "error",
                "reason": f"execution_gateway_shadow_http_{response.status_code}",
                "gateway_payload": payload if isinstance(payload, Mapping) else {},
                "relay_attempts": attempts,
                "can_submit_real_order": False,
                "live_submit_enabled": False,
            }
        result = dict(payload) if isinstance(payload, Mapping) else {"status": "error", "reason": "execution_gateway_shadow_payload_invalid"}
        result["can_submit_real_order"] = False
        result["live_submit_enabled"] = False
        result["relay_authenticated_with_google_iam"] = True
        result["relay_attempts"] = attempts
        return result
    except Exception as exc:
        return {
            "status": "unknown",
            "reason": "execution_gateway_shadow_response_unknown",
            "error_type": exc.__class__.__name__,
            "can_submit_real_order": False,
            "live_submit_enabled": False,
        }
