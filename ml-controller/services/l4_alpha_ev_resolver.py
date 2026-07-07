"""Validated L4 alpha expected-return owner contract.

This module does not estimate alpha from scores. It only accepts a production
alpha EV payload emitted by a trained/calibrated resolver with validation
evidence, then normalizes it for allocation.
"""
from __future__ import annotations

import json
import math
from typing import Any


SCHEMA_VERSION = "l4-alpha-ev-v1"
OWNER = "l4_alpha_ev"
APPROVED_STATES = {"production_approved", "approved_for_production", "live"}
PASS_STATES = {"PASS", "PASSED", "PRODUCTION_APPROVED"}
EMPIRICAL_ONLY_METHODS = {
    "empirical",
    "empirical_bucket",
    "empirical_rank_bins",
    "peer_empirical_bucket",
}


def _float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _dict_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _first_dict(*values: Any) -> dict[str, Any] | None:
    for value in values:
        if isinstance(value, dict):
            return value
    return None


def _validation_decision(payload: dict[str, Any]) -> str:
    packet = _first_dict(
        payload.get("validation_packet"),
        payload.get("validation_evidence"),
        payload.get("validation"),
    ) or {}
    return str(packet.get("decision") or packet.get("status") or "").strip().upper()


def _approval_state(payload: dict[str, Any]) -> str:
    return str(
        payload.get("approval_state")
        or payload.get("promotion_state")
        or payload.get("deployment_state")
        or payload.get("status")
        or ""
    ).strip().lower()


def _resolver_method(payload: dict[str, Any]) -> str:
    return str(
        payload.get("resolver_method")
        or payload.get("model_family")
        or payload.get("method")
        or payload.get("source")
        or ""
    ).strip().lower()


def _expected_return_value(payload: dict[str, Any]) -> float | None:
    for key in (
        "expected_return_mean",
        "expected_return_net_pct",
        "expected_return",
        "alpha_expected_return_net_pct",
    ):
        value = _float_or_none(payload.get(key))
        if value is not None:
            return value
    return None


def resolve_l4_alpha_ev(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Return a normalized L4 alpha EV payload, fail-closed on weak evidence."""
    if not isinstance(payload, dict):
        return {
            "schema_version": SCHEMA_VERSION,
            "status": "missing",
            "expected_return_owner": OWNER,
            "expected_return": None,
            "expected_return_source": "l4_alpha_ev_missing_no_expected_return",
            "blockers": ["l4_alpha_ev_missing"],
        }

    blockers: list[str] = []
    value = _expected_return_value(payload)
    if value is None:
        blockers.append("expected_return_missing")

    owner = str(payload.get("expected_return_owner") or payload.get("owner") or OWNER).strip()
    if owner != OWNER:
        blockers.append("expected_return_owner_not_l4_alpha_ev")

    source = str(payload.get("expected_return_source") or payload.get("source") or OWNER).strip()
    if "forecast" in source.lower() and OWNER not in source.lower():
        blockers.append("forecast_source_not_selection_alpha_ev")

    approval_state = _approval_state(payload)
    if approval_state not in APPROVED_STATES:
        blockers.append("production_approval_missing")

    validation_decision = _validation_decision(payload)
    if validation_decision not in PASS_STATES:
        blockers.append("validation_packet_not_pass")

    method = _resolver_method(payload)
    if method in EMPIRICAL_ONLY_METHODS:
        blockers.append("empirical_bucket_not_production_alpha_ev_owner")

    for key in ("model_version", "feature_snapshot_version", "trained_until"):
        if not str(payload.get(key) or "").strip():
            blockers.append(f"{key}_missing")

    if payload.get("horizon_days") is None and payload.get("horizon_bars") is None:
        blockers.append("horizon_missing")
    if payload.get("cost_model_bps") is None:
        blockers.append("cost_model_bps_missing")

    status = "loaded" if not blockers else "rejected"
    if status != "loaded":
        source = f"{source}_validation_failed_no_expected_return"
        value = None

    normalized = {
        **payload,
        "schema_version": payload.get("schema_version") or SCHEMA_VERSION,
        "status": status,
        "expected_return_owner": OWNER,
        "expected_return": None if value is None else round(float(value), 10),
        "expected_return_source": source,
        "semantic": "selection_alpha_expected_return_not_s12_execution_trade_ev",
        "selection_alpha_owner": OWNER,
        "approval_state": approval_state or None,
        "validation_decision": validation_decision or None,
        "resolver_method": method or None,
        "blockers": blockers,
    }
    return normalized


def extract_l4_alpha_ev(row: dict[str, Any]) -> tuple[float | None, str, dict[str, Any] | None]:
    """Extract and validate L4 alpha EV from row or nested forecast payload."""
    payload = _first_dict(
        row.get("l4_alpha_ev"),
        row.get("alpha_ev"),
        row.get("alpha_ev_prediction"),
    )

    ev2 = row.get("ensemble_v2") if isinstance(row.get("ensemble_v2"), dict) else {}
    if payload is None:
        payload = _first_dict(ev2.get("l4_alpha_ev"), ev2.get("alpha_ev"))

    forecast_data = _dict_payload(row.get("forecast_data"))
    if payload is None:
        payload = _first_dict(
            forecast_data.get("l4_alpha_ev"),
            forecast_data.get("alpha_ev"),
            forecast_data.get("alpha_ev_prediction"),
        )
    fd_ev2 = forecast_data.get("ensemble_v2") if isinstance(forecast_data.get("ensemble_v2"), dict) else {}
    if payload is None:
        payload = _first_dict(fd_ev2.get("l4_alpha_ev"), fd_ev2.get("alpha_ev"))

    if payload is None:
        return None, "l4_alpha_ev_missing_no_expected_return", None

    normalized = resolve_l4_alpha_ev(payload)
    if normalized["status"] != "loaded":
        return None, str(normalized["expected_return_source"]), normalized
    return (
        float(normalized["expected_return"]),
        str(normalized["expected_return_source"]),
        normalized,
    )
