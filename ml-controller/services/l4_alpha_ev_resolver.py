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
SNAPSHOT_BACKFILL_USAGE_SCOPE = "allocator_ev_feature_snapshot_backfill"
SNAPSHOT_BACKFILL_SOURCE = "allocator_ev_asof_backfill_v2"
SNAPSHOT_BACKFILL_AS_OF_GUARD = (
    "prediction_before_next_executable_session_open;exact_active8_artifact_lineage;"
    "l4_trained_before_snapshot;s12_samples_before_run"
)
SNAPSHOT_BACKFILL_APPROVAL_STATE = "snapshot_backfill_only"
PURGED_OOF_USAGE_SCOPE = "purged_oof_evidence"
PURGED_OOF_APPROVAL_STATE = "purged_oof_evidence_only"
PURGED_OOF_LINEAGE_SCHEMA_VERSION = "l4-point-in-time-prediction-lineage-v1"
PURGED_OOF_AS_OF_GUARD = "label_known_date_strictly_before_prediction_date"
PURGED_OOF_ARTIFACT_CONTRACT_VERSION = "l4-alpha-ev-contract-v4"
PURGED_OOF_FEATURE_SEMANTIC_VERSION = "l4-directional-score-components-v2-lineage-bound"
PURGED_OOF_LABEL_SCHEMA_VERSION = (
    "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
)
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


def _snapshot_backfill_allowed(payload: dict[str, Any], usage_scope: str) -> bool:
    if usage_scope != SNAPSHOT_BACKFILL_USAGE_SCOPE:
        return False
    packet = _first_dict(
        payload.get("validation_packet"),
        payload.get("validation_evidence"),
        payload.get("validation"),
    ) or {}
    fit_blockers = {
        str(value).strip()
        for value in (payload.get("fit_blockers") or [])
        if str(value).strip()
    }
    return (
        payload.get("snapshot_backfill_only") is True
        and payload.get("snapshot_backfill_fit_eligible") is True
        and payload.get("fitted") is True
        and not fit_blockers
        and str(payload.get("snapshot_backfill_usage_scope") or "").strip()
        == SNAPSHOT_BACKFILL_USAGE_SCOPE
        and _approval_state(payload) == SNAPSHOT_BACKFILL_APPROVAL_STATE
    )


def _purged_oof_allowed(payload: dict[str, Any], usage_scope: str) -> bool:
    if usage_scope != PURGED_OOF_USAGE_SCOPE:
        return False
    lineage = (
        payload.get("point_in_time_prediction_lineage")
        if isinstance(payload.get("point_in_time_prediction_lineage"), dict)
        else {}
    )
    prediction_date = str(lineage.get("prediction_date") or "")[:10]
    lineage_trained_until = str(lineage.get("trained_until") or "")[:10]
    payload_trained_until = str(payload.get("trained_until") or "")[:10]
    return (
        str(payload.get("generation_mode") or "").strip() == "purged_oof"
        and payload.get("schema_version") == SCHEMA_VERSION
        and payload.get("artifact_contract_version") == PURGED_OOF_ARTIFACT_CONTRACT_VERSION
        and payload.get("feature_snapshot_version") == PURGED_OOF_FEATURE_SEMANTIC_VERSION
        and payload.get("label_schema_version") == PURGED_OOF_LABEL_SCHEMA_VERSION
        and payload.get("output_is_net_of_costs") is True
        and int(payload.get("horizon_days") or 0) == 5
        and _float_or_none(payload.get("cost_model_bps")) is not None
        and _approval_state(payload) == PURGED_OOF_APPROVAL_STATE
        and payload.get("purged_oof_evidence_only") is True
        and str(payload.get("cohort_id") or "").strip() != ""
        and str(payload.get("fold_id") or "").strip() != ""
        and str(payload.get("source_manifest_checksum") or "").strip() != ""
        and lineage.get("schema_version") == PURGED_OOF_LINEAGE_SCHEMA_VERSION
        and lineage.get("as_of_guard") == PURGED_OOF_AS_OF_GUARD
        and str(lineage.get("cohort_id") or "").strip() == str(payload.get("cohort_id") or "").strip()
        and str(lineage.get("fold_id") or "").strip() == str(payload.get("fold_id") or "").strip()
        and str(lineage.get("source_manifest_checksum") or "").strip()
        == str(payload.get("source_manifest_checksum") or "").strip()
        and lineage.get("feature_semantic_version") == PURGED_OOF_FEATURE_SEMANTIC_VERSION
        and lineage_trained_until == payload_trained_until
        and len(str(payload.get("source_manifest_checksum") or "").strip()) == 64
        and bool(prediction_date)
        and bool(lineage_trained_until)
        and lineage_trained_until < prediction_date
    )

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


def resolve_l4_alpha_ev(
    payload: dict[str, Any] | None,
    *,
    usage_scope: str = "production",
) -> dict[str, Any]:
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

    snapshot_backfill_allowed = _snapshot_backfill_allowed(payload, usage_scope)
    purged_oof_allowed = _purged_oof_allowed(payload, usage_scope)
    approval_state = _approval_state(payload)
    if (
        approval_state not in APPROVED_STATES
        and not snapshot_backfill_allowed
        and not purged_oof_allowed
    ):
        blockers.append("production_approval_missing")

    validation_decision = _validation_decision(payload)
    if (
        validation_decision not in PASS_STATES
        and not snapshot_backfill_allowed
        and not purged_oof_allowed
    ):
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
    if payload.get("output_is_net_of_costs") is not True:
        blockers.append("materialized_expected_return_not_net_of_costs")

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
        "usage_scope": usage_scope,
        "production_eligible": (
            status == "loaded"
            and not snapshot_backfill_allowed
            and not purged_oof_allowed
        ),
        "snapshot_backfill_eligible": status == "loaded" and snapshot_backfill_allowed,
        "purged_oof_evidence_eligible": status == "loaded" and purged_oof_allowed,
        "blockers": blockers,
    }
    return normalized


def extract_l4_alpha_ev(
    row: dict[str, Any],
    *,
    usage_scope: str = "production",
) -> tuple[float | None, str, dict[str, Any] | None]:
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

    normalized = resolve_l4_alpha_ev(payload, usage_scope=usage_scope)
    if normalized["status"] != "loaded":
        return None, str(normalized["expected_return_source"]), normalized
    return (
        float(normalized["expected_return"]),
        str(normalized["expected_return_source"]),
        normalized,
    )
