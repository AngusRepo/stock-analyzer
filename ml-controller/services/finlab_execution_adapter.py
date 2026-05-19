"""FinLab execution preview adapter contract for StockVision V4.

This module is intentionally preview-only. It normalizes FinLab execution
preview responses into a StockVision-safe contract, but it never submits live
orders and never writes paper-trade lifecycle rows.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal


FinLabExecutionPreviewStatus = Literal["pass", "blocked", "warning", "error"]

SCHEMA_VERSION = "finlab-execution-preview-v1"
ALLOWED_STATUSES: list[FinLabExecutionPreviewStatus] = [
    "pass",
    "blocked",
    "warning",
    "error",
]


@dataclass(frozen=True)
class FinLabExecutionPreview:
    schema_version: str
    allowed_use: str
    symbol: str
    side: str
    status: FinLabExecutionPreviewStatus
    submit_decision: str
    can_submit_real_order: bool
    visible_reason: str
    blocked_reasons: list[str]
    warnings: list[str]
    raw_status: str | None
    audit_event: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def build_finlab_execution_preview_policy() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "preview_first",
        "allowed_statuses": ALLOWED_STATUSES,
        "live_submit_enabled": False,
        "requires_explicit_real_order_approval": True,
        "adapter_surfaces": [
            "OrderExecutor.preview",
            "PortfolioSyncManager.preview",
        ],
        "blocked_behavior": "do_not_submit_and_surface_reason",
        "allowed_use": "execution_preview_only",
    }


def _normalize_key(value: str) -> str:
    chars: list[str] = []
    for char in value:
        if char.isupper() and chars:
            chars.append("_")
        chars.append(char.lower() if char.isalnum() else "_")
    return "".join(chars).strip("_")


def _iter_payload_entries(value: Any):
    if isinstance(value, dict):
        for key, item in value.items():
            yield _normalize_key(str(key)), item
            yield from _iter_payload_entries(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_payload_entries(item)


def _append_once(values: list[str], value: str) -> None:
    if value and value not in values:
        values.append(value)


def validate_finlab_execution_preview_contract(payload: dict[str, Any] | None) -> list[str]:
    errors: list[str] = []
    for key, value in _iter_payload_entries(payload or {}):
        if key in {"submit", "submitted", "live_submit", "order_submitted"} and bool(value):
            _append_once(errors, "finlab_execution_preview_must_not_submit_live_order")
        if key in {"order_id", "broker_order_id", "submitted_order_id", "live_order_id"}:
            _append_once(errors, "finlab_execution_preview_must_not_return_live_order_id")
    return errors


def _canonical_status(raw: dict[str, Any]) -> tuple[FinLabExecutionPreviewStatus, str | None]:
    raw_status = raw.get("status") or raw.get("state") or raw.get("result")
    if raw_status is not None:
        normalized = str(raw_status).strip().lower()
        if normalized in ALLOWED_STATUSES:
            return normalized, normalized  # type: ignore[return-value]

    if raw.get("error"):
        return "error", str(raw.get("error"))

    for key in ("approved", "can_order", "can_submit", "ok", "success"):
        if key not in raw:
            continue
        if raw[key] is True:
            return "pass", key
        if raw[key] is False:
            return "blocked", key

    return "error", None


def _visible_reason(
    raw: dict[str, Any],
    status: FinLabExecutionPreviewStatus,
    raw_status: str | None,
) -> str:
    if status == "error" and raw_status is None and not raw.get("error"):
        return "finlab_preview_status_unknown"
    for key in ("reason", "message", "error", "note"):
        value = raw.get(key)
        if value:
            return str(value)
    if status == "error":
        return "finlab_preview_status_unknown"
    return f"finlab_preview_{status}"


def _warnings(raw: dict[str, Any], status: FinLabExecutionPreviewStatus, visible_reason: str) -> list[str]:
    values: list[str] = []
    raw_warnings = raw.get("warnings")
    if isinstance(raw_warnings, list):
        values.extend(str(item) for item in raw_warnings if item)
    elif raw_warnings:
        values.append(str(raw_warnings))
    if status == "warning":
        _append_once(values, visible_reason)
    return values


def _audit_detail(raw: dict[str, Any], raw_status: str | None) -> dict[str, Any]:
    detail: dict[str, Any] = {"previewOnly": True}
    raw_detail = raw.get("detail")
    if isinstance(raw_detail, dict):
        detail.update(raw_detail)
    for key in ("estimated_fee", "estimated_tax", "cash_shortfall", "buying_power"):
        if key in raw:
            detail[key] = raw[key]
    if raw_status is not None:
        detail["raw_status"] = raw_status
    return detail


def normalize_finlab_execution_preview(
    raw: dict[str, Any] | None,
    *,
    symbol: str,
    side: str,
) -> FinLabExecutionPreview:
    payload = raw or {}
    status, raw_status = _canonical_status(payload)
    visible_reason = _visible_reason(payload, status, raw_status)
    blocked_reasons = [visible_reason] if status in {"blocked", "error"} else []
    submit_decision = (
        "manual_or_separate_confirm_required"
        if status == "pass"
        else "do_not_submit"
    )

    return FinLabExecutionPreview(
        schema_version=SCHEMA_VERSION,
        allowed_use="execution_preview_only",
        symbol=symbol,
        side=side,
        status=status,
        submit_decision=submit_decision,
        can_submit_real_order=False,
        visible_reason=visible_reason,
        blocked_reasons=blocked_reasons,
        warnings=_warnings(payload, status, visible_reason),
        raw_status=raw_status,
        audit_event={
            "event_type": "finlab_execution_preview",
            "symbol": symbol,
            "side": side,
            "status": status,
            "reason": visible_reason,
            "detail": _audit_detail(payload, raw_status),
            "source": "finlab_execution_preview",
        },
    )
