"""Formal L4 alpha expected-return materializer.

This producer only emits allocation-grade L4 alpha EV from a production-approved
model artifact. Empirical rank buckets/calibration reports are rejected here;
they remain diagnostics, not the expected-return owner.
"""
from __future__ import annotations

import json
import math
from typing import Any

from services.l4_alpha_ev_resolver import (
    EMPIRICAL_ONLY_METHODS,
    OWNER,
    PASS_STATES,
    SNAPSHOT_BACKFILL_USAGE_SCOPE,
    resolve_l4_alpha_ev,
)


PRODUCER_SCHEMA_VERSION = "l4-alpha-ev-producer-v1"
CORE_FEATURE_FAMILIES = {"formal_ml", "fundamental", "chip", "technical", "regime"}
SCORE_RANK_FEATURE_FAMILIES = {"score_v2_composite", "formal_ml_rank", "formal_ml_confidence"}
SCORE_RANK_FEATURE_NAMES = {"score_final_norm", "ensemble_avg_rank_centered", "ensemble_confidence_centered"}
POLICY_KEYS = (
    "l4_alpha_ev",
    "l4AlphaEv",
    "l4AlphaEV",
    "alpha_ev_resolver",
    "alphaEvResolver",
    "selectionAlphaEv",
)


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


def _policy_artifact(policy: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(policy, dict):
        return None
    for key in POLICY_KEYS:
        candidate = policy.get(key)
        if isinstance(candidate, dict):
            if candidate.get("expectedReturnCalibration") is not None:
                return {
                    "status": "rejected",
                    "resolver_method": "empirical_rank_bins",
                    "blockers": ["expected_return_calibration_is_not_l4_alpha_ev_artifact"],
                }
            return candidate.get("artifact") if isinstance(candidate.get("artifact"), dict) else candidate
    if policy.get("expectedReturnCalibration") is not None:
        return {
            "status": "rejected",
            "resolver_method": "empirical_rank_bins",
            "blockers": ["expected_return_calibration_is_not_l4_alpha_ev_artifact"],
        }
    if (
        policy.get("expected_return_owner") == OWNER
        or policy.get("owner") == OWNER
        or policy.get("resolver_method")
        or policy.get("coefficients")
    ):
        return policy.get("artifact") if isinstance(policy.get("artifact"), dict) else policy
    return None


def _existing_payload(row: dict[str, Any], prediction: dict[str, Any] | None) -> dict[str, Any] | None:
    row_payload = _first_dict(row.get("l4_alpha_ev"), row.get("alpha_ev"), row.get("alpha_ev_prediction"))
    if row_payload is not None:
        return row_payload
    pred = prediction if isinstance(prediction, dict) else {}
    ev2 = pred.get("ensemble_v2") if isinstance(pred.get("ensemble_v2"), dict) else {}
    return _first_dict(
        ev2.get("l4_alpha_ev"),
        ev2.get("alpha_ev"),
        pred.get("l4_alpha_ev"),
        pred.get("alpha_ev"),
        pred.get("alpha_ev_prediction"),
    )


def _validation_decision(artifact: dict[str, Any]) -> str:
    packet = _first_dict(
        artifact.get("validation_packet"),
        artifact.get("validation_evidence"),
        artifact.get("validation"),
    ) or {}
    return str(packet.get("decision") or packet.get("status") or "").strip().upper()


def _approval_state(artifact: dict[str, Any]) -> str:
    return str(
        artifact.get("approval_state")
        or artifact.get("promotion_state")
        or artifact.get("deployment_state")
        or artifact.get("status")
        or ""
    ).strip().lower()


def _resolver_method(artifact: dict[str, Any]) -> str:
    return str(
        artifact.get("resolver_method")
        or artifact.get("model_family")
        or artifact.get("method")
        or artifact.get("source")
        or ""
    ).strip().lower()


def _feature_families(artifact: dict[str, Any]) -> set[str]:
    raw = artifact.get("feature_families") or artifact.get("featureFamilies") or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return set()
    return {str(item or "").strip().lower() for item in raw if str(item or "").strip()}


def _coefficients(artifact: dict[str, Any]) -> dict[str, float] | None:
    raw = artifact.get("coefficients") or artifact.get("feature_coefficients") or artifact.get("weights")
    features = artifact.get("feature_names") or artifact.get("features") or artifact.get("input_features")
    if isinstance(raw, dict):
        out: dict[str, float] = {}
        for key, value in raw.items():
            coef = _float_or_none(value)
            if coef is None:
                return None
            out[str(key)] = coef
        return out if out else None
    if isinstance(raw, list) and isinstance(features, list) and len(raw) == len(features):
        out = {}
        for key, value in zip(features, raw, strict=True):
            coef = _float_or_none(value)
            if coef is None:
                return None
            out[str(key)] = coef
        return out if out else None
    return None


def _component(row: dict[str, Any], name: str) -> float | None:
    score_components = _dict_payload(row.get("score_components"))
    components = score_components.get("components") if isinstance(score_components.get("components"), dict) else {}
    return _float_or_none(components.get(name))


def _alpha_context(row: dict[str, Any], prediction: dict[str, Any] | None) -> dict[str, Any]:
    row_ctx = row.get("alpha_context") if isinstance(row.get("alpha_context"), dict) else {}
    if row_ctx:
        return row_ctx
    pred = prediction if isinstance(prediction, dict) else {}
    return pred.get("alpha_context") if isinstance(pred.get("alpha_context"), dict) else {}


def _ensemble_v2(prediction: dict[str, Any] | None) -> dict[str, Any]:
    pred = prediction if isinstance(prediction, dict) else {}
    return pred.get("ensemble_v2") if isinstance(pred.get("ensemble_v2"), dict) else {}


def _feature_value(name: str, row: dict[str, Any], prediction: dict[str, Any] | None) -> float | None:
    ev2 = _ensemble_v2(prediction)
    alpha = _alpha_context(row, prediction)
    risk_overlay = alpha.get("risk_overlay") if isinstance(alpha.get("risk_overlay"), dict) else {}
    score_components = _dict_payload(row.get("score_components"))
    final_score = _float_or_none(score_components.get("finalScore") or row.get("score"))
    s12_payload = row.get("s12_trade_ev") if isinstance(row.get("s12_trade_ev"), dict) else {}
    s12_context = (
        s12_payload.get("candidate_s12_entry_context")
        if isinstance(s12_payload.get("candidate_s12_entry_context"), dict)
        else {}
    )
    if not s12_context and isinstance(s12_payload.get("s12_entry_context"), dict):
        s12_context = s12_payload["s12_entry_context"]
    values = {
        "score_final_norm": None if final_score is None else final_score / 100.0,
        "ml_edge_norm": None if _component(row, "mlEdge") is None else _component(row, "mlEdge") / 25.0,
        "fundamental_quality_norm": (
            None if _component(row, "fundamentalQuality") is None else _component(row, "fundamentalQuality") / 25.0
        ),
        "chip_flow_norm": None if _component(row, "chipFlow") is None else _component(row, "chipFlow") / 25.0,
        "technical_structure_norm": (
            None if _component(row, "technicalStructure") is None else _component(row, "technicalStructure") / 25.0
        ),
        "ensemble_avg_rank_centered": (
            None if _float_or_none(ev2.get("avg_rank")) is None else _float_or_none(ev2.get("avg_rank")) - 0.5
        ),
        "ensemble_confidence_centered": (
            None if _float_or_none(ev2.get("confidence")) is None else _float_or_none(ev2.get("confidence")) - 0.5
        ),
        "market_heat_expected_return": _float_or_none(alpha.get("market_heat_expected_return")),
        "regime_weight_minus_1": (
            None if _float_or_none(alpha.get("regime_weight")) is None else _float_or_none(alpha.get("regime_weight")) - 1.0
        ),
        "risk_overlay_penalty_norm": (
            None if _float_or_none(risk_overlay.get("penalty")) is None else _float_or_none(risk_overlay.get("penalty")) / 10.0
        ),
        "s12_context_multiplier_minus_1": (
            None
            if _float_or_none(s12_context.get("reward_confidence_multiplier")) is None
            else _float_or_none(s12_context.get("reward_confidence_multiplier")) - 1.0
        ),
    }
    return values.get(name)


def _rejected_payload(artifact: dict[str, Any], blockers: list[str]) -> dict[str, Any]:
    payload = {
        **artifact,
        "schema_version": "l4-alpha-ev-v1",
        "producer_schema_version": PRODUCER_SCHEMA_VERSION,
        "expected_return_owner": OWNER,
        "expected_return": None,
        "expected_return_mean": None,
        "expected_return_source": "l4_alpha_ev:artifact_validation_failed_no_expected_return",
        "blockers": blockers,
    }
    normalized = resolve_l4_alpha_ev(payload)
    normalized["blockers"] = list(dict.fromkeys([*normalized.get("blockers", []), *blockers]))
    return normalized


def materialize_l4_alpha_ev(
    row: dict[str, Any],
    *,
    prediction: dict[str, Any] | None = None,
    policy: dict[str, Any] | None = None,
    usage_scope: str = "production",
) -> dict[str, Any] | None:
    """Return validated row-level L4 alpha EV, or None when no producer is configured."""
    existing = _existing_payload(row, prediction)
    if existing is not None:
        return resolve_l4_alpha_ev(existing, usage_scope=usage_scope)

    artifact = _policy_artifact(policy)
    if artifact is None:
        return None

    snapshot_backfill_mode = (
        usage_scope == SNAPSHOT_BACKFILL_USAGE_SCOPE
        and artifact.get("snapshot_backfill_only") is True
        and artifact.get("snapshot_backfill_fit_eligible") is True
        and artifact.get("fitted") is True
        and not (artifact.get("fit_blockers") or [])
    )

    blockers: list[str] = []
    method = _resolver_method(artifact)
    if method in EMPIRICAL_ONLY_METHODS:
        blockers.append("empirical_bucket_not_production_alpha_ev_owner")
    if method == "empirical_rank_bins":
        blockers.append("expected_return_calibration_is_not_l4_alpha_ev_artifact")
    if _validation_decision(artifact) not in PASS_STATES and not snapshot_backfill_mode:
        blockers.append("validation_packet_not_pass")
    if (
        _approval_state(artifact) not in {"production_approved", "approved_for_production", "live"}
        and not snapshot_backfill_mode
    ):
        blockers.append("production_approval_missing")

    families = _feature_families(artifact)
    artifact_feature_names = {
        str(value).strip()
        for value in (artifact.get("feature_names") or [])
        if str(value).strip()
    }
    required_families = (
        SCORE_RANK_FEATURE_FAMILIES
        if artifact_feature_names and artifact_feature_names.issubset(SCORE_RANK_FEATURE_NAMES)
        else CORE_FEATURE_FAMILIES
    )
    missing_families = sorted(required_families - families)
    blockers.extend(f"feature_family_missing:{family}" for family in missing_families)

    coefs = _coefficients(artifact)
    if not coefs:
        blockers.append("learned_coefficients_missing")

    intercept = _float_or_none(artifact.get("intercept", 0.0))
    if intercept is None:
        blockers.append("intercept_invalid")

    for key in ("model_version", "feature_snapshot_version", "trained_until"):
        if not str(artifact.get(key) or "").strip():
            blockers.append(f"{key}_missing")
    if artifact.get("horizon_days") is None and artifact.get("horizon_bars") is None:
        blockers.append("horizon_missing")
    if artifact.get("cost_model_bps") is None:
        blockers.append("cost_model_bps_missing")

    if blockers:
        return _rejected_payload(artifact, blockers)

    feature_values: dict[str, float] = {}
    missing_features: list[str] = []
    for name in coefs or {}:
        value = _feature_value(name, row, prediction)
        if value is None:
            missing_features.append(name)
        else:
            feature_values[name] = value
    if missing_features:
        return _rejected_payload(
            artifact,
            [f"feature_missing:{name}" for name in sorted(missing_features)],
        )

    expected_return = float(intercept or 0.0)
    for name, coef in (coefs or {}).items():
        expected_return += coef * feature_values[name]

    if artifact.get("output_is_net_of_costs") is False:
        cost_bps = _float_or_none(artifact.get("cost_model_bps"))
        if cost_bps is not None:
            expected_return -= cost_bps / 10000.0

    clip = artifact.get("output_clip") if isinstance(artifact.get("output_clip"), dict) else {}
    min_value = _float_or_none(clip.get("min"))
    max_value = _float_or_none(clip.get("max"))
    if min_value is not None:
        expected_return = max(min_value, expected_return)
    if max_value is not None:
        expected_return = min(max_value, expected_return)

    payload = {
        **artifact,
        "schema_version": "l4-alpha-ev-v1",
        "producer_schema_version": PRODUCER_SCHEMA_VERSION,
        "expected_return_owner": OWNER,
        "expected_return_mean": round(expected_return, 10),
        "expected_return_source": f"l4_alpha_ev:{method or 'formal_meta_calibrator'}",
        "feature_values": {key: round(value, 10) for key, value in feature_values.items()},
        "semantic": "selection_alpha_expected_return_not_s12_execution_trade_ev",
    }
    return resolve_l4_alpha_ev(payload, usage_scope=usage_scope)
