"""Deny-by-default identity and bounded approval policy for admin routes."""
from __future__ import annotations

import hmac
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping

from fastapi import HTTPException, Request


ADMIN_TOKEN_HEADER = "X-Admin-Token"
ADMIN_APPROVAL_ID_HEADER = "X-Admin-Approval-Id"
MAX_APPROVAL_WINDOW_SECONDS = 30 * 60


@dataclass(frozen=True)
class AdminAccessDecision:
    allowed: bool
    status_code: int = 200
    code: str = "ok"
    approval_id: str = ""


def _parse_utc(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def evaluate_admin_access(
    token: str,
    *,
    env: Mapping[str, str] | None = None,
) -> AdminAccessDecision:
    values = env or os.environ
    expected = str(values.get("ADMIN_API_TOKEN") or "").strip()
    controller_token = str(values.get("ML_CONTROLLER_SECRET") or "").strip()
    if not expected or (controller_token and hmac.compare_digest(expected, controller_token)):
        return AdminAccessDecision(False, 503, "admin_auth_not_configured_or_not_distinct")
    if not token or not hmac.compare_digest(token.strip(), expected):
        return AdminAccessDecision(False, 401, "invalid_admin_token")
    return AdminAccessDecision(True)


def evaluate_admin_mutation_approval(
    expected_scope: str,
    approval_id: str,
    *,
    env: Mapping[str, str] | None = None,
    now: datetime | None = None,
) -> AdminAccessDecision:
    values = env or os.environ
    if str(values.get("ADMIN_PRODUCTION_MUTATION_ENABLED") or "").strip() != "1":
        return AdminAccessDecision(False, 403, "admin_production_mutation_disabled")

    configured_approval_id = str(values.get("ADMIN_MUTATION_APPROVAL_ID") or "").strip()
    if not configured_approval_id:
        return AdminAccessDecision(False, 503, "admin_mutation_approval_id_not_configured")
    if not approval_id or not hmac.compare_digest(approval_id.strip(), configured_approval_id):
        return AdminAccessDecision(False, 403, "admin_mutation_approval_id_mismatch")

    scopes = {
        item.strip()
        for item in str(values.get("ADMIN_MUTATION_APPROVAL_SCOPE") or "").split(",")
        if item.strip()
    }
    if expected_scope not in scopes:
        return AdminAccessDecision(False, 403, "admin_mutation_scope_not_approved")

    expires_at = _parse_utc(str(values.get("ADMIN_MUTATION_APPROVAL_EXPIRES_AT") or ""))
    if expires_at is None:
        return AdminAccessDecision(False, 503, "admin_mutation_expiry_not_configured")
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    remaining = (expires_at - current).total_seconds()
    if remaining <= 0:
        return AdminAccessDecision(False, 403, "admin_mutation_approval_expired")
    if remaining > MAX_APPROVAL_WINDOW_SECONDS:
        return AdminAccessDecision(False, 403, "admin_mutation_approval_window_too_long")
    return AdminAccessDecision(True, approval_id=configured_approval_id)


def _raise_denied(decision: AdminAccessDecision) -> None:
    if not decision.allowed:
        raise HTTPException(status_code=decision.status_code, detail=decision.code)


async def require_admin_access(request: Request) -> None:
    _raise_denied(evaluate_admin_access(request.headers.get(ADMIN_TOKEN_HEADER, "")))


def require_admin_mutation_scope(expected_scope: str):
    async def dependency(request: Request) -> None:
        _raise_denied(
            evaluate_admin_mutation_approval(
                expected_scope,
                request.headers.get(ADMIN_APPROVAL_ID_HEADER, ""),
            )
        )

    dependency.__name__ = f"require_admin_mutation_{expected_scope}"
    return dependency
