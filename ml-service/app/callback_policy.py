"""Server-owned callback destination and credential registry.

Payloads may select a registered capability, but cannot introduce a destination
or credential.  This prevents privileged SSRF and credential forwarding while
preserving every existing callback flow.
"""
from __future__ import annotations

import os
import time
import ipaddress
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit


class CallbackPolicyError(RuntimeError):
    pass


@dataclass(frozen=True)
class CallbackTarget:
    capability: str
    url: str
    headers: dict[str, str] = field(repr=False)


@dataclass(frozen=True)
class _CapabilitySpec:
    base_envs: tuple[str, ...]
    path: str
    token_envs: tuple[str, ...]
    header_names: tuple[str, ...]


_CAPABILITIES: dict[str, _CapabilitySpec] = {
    "pipeline_prediction": _CapabilitySpec(
        ("ML_CONTROLLER_PUBLIC_URL", "ML_CONTROLLER_URL"),
        "/pipeline/v2/modal-prediction/callback",
        ("ML_CONTROLLER_SECRET",),
        ("X-Controller-Token",),
    ),
    "retrain_followup": _CapabilitySpec(
        ("ML_CONTROLLER_PUBLIC_URL", "ML_CONTROLLER_URL", "RETRAIN_FOLLOWUP_URL"),
        "/retrain/followup",
        ("ML_CONTROLLER_SECRET",),
        ("X-Controller-Token",),
    ),
    "state_space_shadow": _CapabilitySpec(
        ("STOCKVISION_WORKER_URL",),
        "/api/internal/state-space-shadow/callback",
        ("STOCKVISION_AUTH_TOKEN",),
        ("Authorization",),
    ),
    "finlab_controller": _CapabilitySpec(
        ("ML_CONTROLLER_PUBLIC_URL", "ML_CONTROLLER_URL"),
        "/finlab/backfill/callback",
        ("ML_CONTROLLER_SECRET",),
        ("X-Controller-Token",),
    ),
    "finlab_worker": _CapabilitySpec(
        ("STOCKVISION_WORKER_URL",),
        "/api/admin/scheduler-callback",
        ("STOCKVISION_AUTH_TOKEN",),
        ("Authorization",),
    ),
    "finlab_d1_query": _CapabilitySpec(
        ("ML_CONTROLLER_PUBLIC_URL", "ML_CONTROLLER_URL"),
        "/finlab/backfill/d1/query",
        ("ML_CONTROLLER_SECRET",),
        ("X-Controller-Token",),
    ),
    "finlab_d1_batch": _CapabilitySpec(
        ("ML_CONTROLLER_PUBLIC_URL", "ML_CONTROLLER_URL"),
        "/finlab/backfill/d1/batch",
        ("ML_CONTROLLER_SECRET",),
        ("X-Controller-Token",),
    ),
}


def _first_env(names: tuple[str, ...]) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _is_explicit_local() -> bool:
    return (
        os.environ.get("ENVIRONMENT", "").strip().lower() in {"development", "local", "test"}
        and not (os.environ.get("K_SERVICE") or os.environ.get("K_REVISION"))
    )


def _canonical_base(raw: str, *, capability: str) -> str:
    parsed = urlsplit(raw)
    local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (_is_explicit_local() and local_http):
        raise CallbackPolicyError(f"{capability}: callback base must use HTTPS")
    if not parsed.hostname or parsed.username or parsed.password:
        raise CallbackPolicyError(f"{capability}: invalid callback authority")
    hostname = parsed.hostname.lower()
    if (
        hostname == "metadata.google.internal"
        or hostname.endswith((".internal", ".local"))
        or (hostname == "localhost" and not _is_explicit_local())
    ):
        raise CallbackPolicyError(f"{capability}: private or metadata callback forbidden")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
        if not (_is_explicit_local() and address.is_loopback):
            raise CallbackPolicyError(f"{capability}: private or metadata callback forbidden")
    if parsed.query or parsed.fragment:
        raise CallbackPolicyError(f"{capability}: callback base cannot contain query or fragment")
    path = parsed.path.rstrip("/")
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def resolve_callback_target(
    capability: str,
    *,
    supplied_url: str | None = None,
) -> CallbackTarget:
    """Resolve an exact server-owned target and reject payload destination drift."""
    spec = _CAPABILITIES.get(capability)
    if spec is None:
        raise CallbackPolicyError(f"unknown callback capability: {capability}")
    raw_base = _first_env(spec.base_envs)
    if not raw_base:
        raise CallbackPolicyError(f"{capability}: callback base is not configured")

    base = _canonical_base(raw_base, capability=capability)
    if base.endswith(spec.path):
        expected_url = base
    else:
        expected_url = f"{base.rstrip('/')}{spec.path}"

    supplied = str(supplied_url or "").strip()
    if supplied and supplied.rstrip("/") != expected_url.rstrip("/"):
        raise CallbackPolicyError(f"{capability}: payload callback URL does not match registered target")

    token = _first_env(spec.token_envs)
    if not token:
        raise CallbackPolicyError(f"{capability}: callback credential is not configured")
    headers = {"Content-Type": "application/json"}
    for header_name in spec.header_names:
        headers[header_name] = f"Bearer {token}" if header_name == "Authorization" else token
    return CallbackTarget(capability=capability, url=expected_url, headers=headers)


def post_json_callback(
    capability: str,
    payload: dict[str, Any],
    *,
    supplied_url: str | None = None,
    timeout_seconds: float = 60.0,
    attempts: int = 3,
) -> dict[str, Any]:
    """POST to a registered callback without following redirects."""
    import httpx

    target = resolve_callback_target(capability, supplied_url=supplied_url)
    last_error = "callback_failed"
    for attempt in range(1, max(1, attempts) + 1):
        try:
            response = httpx.post(
                target.url,
                json=payload,
                headers=target.headers,
                timeout=httpx.Timeout(timeout_seconds, connect=min(15.0, timeout_seconds)),
                follow_redirects=False,
            )
            if 300 <= response.status_code < 400:
                raise CallbackPolicyError(
                    f"{capability}: redirects are forbidden (HTTP {response.status_code})"
                )
            if not 200 <= response.status_code < 300:
                raise CallbackPolicyError(f"{capability}: callback returned HTTP {response.status_code}")
            return {
                "status": "ok",
                "status_code": response.status_code,
                "attempt": attempt,
                "capability": capability,
            }
        except (httpx.HTTPError, CallbackPolicyError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < attempts:
                time.sleep(min(attempt * 2, 5))
    raise CallbackPolicyError(last_error)
