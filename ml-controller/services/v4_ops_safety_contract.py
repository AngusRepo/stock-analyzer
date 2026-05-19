"""V4 ops and safety contract.

The contract is deliberately read-only: it evaluates whether an operation has
the required secrets, cache/rate-limit controls, audit logging, kill-switch
state, and explicit approval before any runtime owner may act.
"""

from __future__ import annotations

from typing import Any


OPS_SAFETY_SCHEMA_VERSION = "v4-ops-safety-contract-v1"

EXPLICIT_APPROVAL_REQUIRED = {
    "deploy",
    "retrain",
    "commit",
    "push",
    "real_order",
    "live_submit",
    "resource_change",
}

BACKEND_SECRET_LOCATIONS = {
    "gcp_secret_manager",
    "cloudflare_secret",
    "server_env",
}


def build_v4_ops_safety_policy() -> dict[str, Any]:
    return {
        "schema_version": OPS_SAFETY_SCHEMA_VERSION,
        "explicit_approval_required": sorted(EXPLICIT_APPROVAL_REQUIRED),
        "finlab_secret_policy": {
            "storage": ["gcp_secret_manager", "cloudflare_secret"],
            "frontend_exposure_allowed": False,
            "log_secret_allowed": False,
            "production_auth_flow": "python -m finlab login",
        },
        "external_api_policy": {
            "backend_fetch_only": True,
            "cache_required": True,
            "rate_limit_required": True,
            "audit_log_required": True,
        },
        "kill_switch": {
            "kv_key": "trading:risk_config",
            "path": "system.killSwitch",
            "blocks": ["real_order", "live_submit"],
        },
        "human_confirm": {
            "required_reviewer": "Wei",
            "required_scope": True,
        },
        "resource_change_policy": {
            "approval_required": True,
            "requires_reason": True,
            "requires_estimated_cost": True,
            "owned_fields": [
                "cloud_run_memory",
                "cloud_run_cpu",
                "cloud_run_timeout",
                "modal_cpu",
                "modal_memory",
                "modal_gpu",
                "modal_timeout",
            ],
        },
    }


def _normalized_action(request: dict[str, Any]) -> str:
    return str(request.get("action") or "").strip().lower().replace("-", "_").replace(" ", "_")


def _approval_is_valid(request: dict[str, Any]) -> bool:
    return str(request.get("approved_by") or "").strip() == "Wei" and bool(
        str(request.get("approval_scope") or "").strip()
    )


def _packet(
    request: dict[str, Any],
    *,
    generated_at: str,
    decision: str,
    failed_gates: list[str] | None = None,
    can_execute: bool = False,
) -> dict[str, Any]:
    action = _normalized_action(request)
    return {
        "schema_version": OPS_SAFETY_SCHEMA_VERSION,
        "generated_at": generated_at,
        "action": action,
        "source": str(request.get("source") or ""),
        "decision": decision,
        "can_execute": bool(can_execute),
        "failed_gates": failed_gates or [],
        "approval": {
            "approved_by": str(request.get("approved_by") or ""),
            "approval_scope": str(request.get("approval_scope") or ""),
        },
        "controls": {
            "secret_location": str(request.get("secret_location") or ""),
            "frontend_exposes_secret": bool(request.get("frontend_exposes_secret")),
            "cache_ttl_sec": int(request.get("cache_ttl_sec") or 0),
            "rate_limit_configured": bool(request.get("rate_limit_configured")),
            "audit_log_enabled": bool(request.get("audit_log_enabled")),
            "kill_switch_active": bool(request.get("kill_switch_active")),
        },
    }


def _evaluate_external_api_fetch(request: dict[str, Any], *, generated_at: str) -> dict[str, Any]:
    failed: list[str] = []
    secret_location = str(request.get("secret_location") or "")
    if secret_location not in BACKEND_SECRET_LOCATIONS:
        failed.append("secret_must_be_backend_only")
    if request.get("frontend_exposes_secret") is True:
        failed.append("frontend_secret_exposure_not_allowed")
    if int(request.get("cache_ttl_sec") or 0) <= 0:
        failed.append("cache_required")
    if request.get("rate_limit_configured") is not True:
        failed.append("rate_limit_required")
    if request.get("audit_log_enabled") is not True:
        failed.append("audit_log_required")
    return _packet(
        request,
        generated_at=generated_at,
        decision="BLOCK" if failed else "ALLOW",
        failed_gates=failed,
        can_execute=not failed,
    )


def evaluate_v4_ops_action(request: dict[str, Any], *, generated_at: str) -> dict[str, Any]:
    action = _normalized_action(request)
    if action == "external_api_fetch":
        return _evaluate_external_api_fetch(request, generated_at=generated_at)

    if action == "resource_change":
        failed: list[str] = []
        if not _approval_is_valid(request):
            failed.append("explicit_wei_approval_required")
        if not str(request.get("reason") or "").strip():
            failed.append("resource_change_reason_required")
        if request.get("estimated_monthly_cost_usd") is None:
            failed.append("estimated_cost_required")
        if request.get("audit_log_enabled") is not True:
            failed.append("audit_log_required")
        return _packet(
            request,
            generated_at=generated_at,
            decision="ALLOW_WITH_GUARDS" if not failed else "REQUIRE_APPROVAL",
            failed_gates=failed,
            can_execute=not failed,
        )

    if action in EXPLICIT_APPROVAL_REQUIRED:
        if action in {"real_order", "live_submit"} and request.get("kill_switch_active") is True:
            return _packet(
                request,
                generated_at=generated_at,
                decision="BLOCK",
                failed_gates=["kill_switch_active"],
            )
        if not _approval_is_valid(request):
            return _packet(
                request,
                generated_at=generated_at,
                decision="REQUIRE_APPROVAL",
                failed_gates=["explicit_wei_approval_required"],
            )
        if request.get("audit_log_enabled") is not True:
            return _packet(
                request,
                generated_at=generated_at,
                decision="BLOCK",
                failed_gates=["audit_log_required"],
            )
        return _packet(
            request,
            generated_at=generated_at,
            decision="ALLOW_WITH_GUARDS",
            can_execute=True,
        )

    return _packet(
        request,
        generated_at=generated_at,
        decision="BLOCK",
        failed_gates=["unknown_or_unowned_ops_action"],
    )


def validate_v4_ops_safety_packet(packet: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if packet.get("schema_version") != OPS_SAFETY_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    action = str(packet.get("action") or "")
    approval = packet.get("approval") if isinstance(packet.get("approval"), dict) else {}
    has_approval = str(approval.get("approved_by") or "").strip() == "Wei" and bool(
        str(approval.get("approval_scope") or "").strip()
    )
    if action in EXPLICIT_APPROVAL_REQUIRED and packet.get("can_execute") is True and not has_approval:
        errors.append("approval_required_action_cannot_be_forged_to_allow")
    if action in {"real_order", "live_submit"}:
        controls = packet.get("controls") if isinstance(packet.get("controls"), dict) else {}
        if packet.get("can_execute") is True and controls.get("kill_switch_active") is True:
            errors.append("kill_switch_execution_not_allowed")
    return errors
