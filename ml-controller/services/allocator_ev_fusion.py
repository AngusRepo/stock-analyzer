"""Allocator expected-return fusion owner.

This owner estimates the net value of handing an evening candidate to the
next-session S12 execution policy. Serving uses only decision-time L4/ScoreV2/
market features. S12 affects the learned target through historical replay
outcomes; candidate-time S12 state is never a serving input or EV owner.
"""
from __future__ import annotations

import json
import math
from typing import Any

from services.evidence_contracts import (
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
    ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
    LABEL_SCHEMA_VERSION,
    SUPPORTED_ALLOCATOR_EV_FEATURE_SEMANTICS,
    SUPPORTED_ALLOCATOR_EV_SERVING_CONTRACT_PAIRS,
)
from services.fusion_market_context import market_context_feature_values


SCHEMA_VERSION = "allocator-ev-fusion-v1"
OWNER = "allocator_ev_fusion"
APPROVED_STATES = {
    "production_primary",
}
PASS_STATES = {"PASS", "PASSED", "PRODUCTION_APPROVED"}
POLICY_KEYS = (
    "allocator_ev_fusion",
    "allocatorEvFusion",
    "allocatorEVFusion",
    "allocationEvFusion",
)
REQUIRED_FEATURE_PREFIXES = {
    "l4": ("l4_expected_return", "l4_"),
}
REQUIRED_ARTIFACT_CONTRACT_VERSION = ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION
REQUIRED_FEATURE_SEMANTIC_VERSION = ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION
REQUIRED_LABEL_SCHEMA_VERSION = LABEL_SCHEMA_VERSION


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


def policy_artifact(policy: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(policy, dict):
        return None
    candidates: list[Any] = []
    candidates.extend(policy.get(key) for key in POLICY_KEYS)
    ev2 = policy.get("ensemble_v2") if isinstance(policy.get("ensemble_v2"), dict) else {}
    candidates.extend(ev2.get(key) for key in POLICY_KEYS)
    allocation = policy.get("allocation") if isinstance(policy.get("allocation"), dict) else {}
    candidates.extend(allocation.get(key) for key in POLICY_KEYS)
    for candidate in candidates:
        if isinstance(candidate, dict):
            return candidate.get("artifact") if isinstance(candidate.get("artifact"), dict) else candidate
    return None


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


def _promotion_tier(artifact: dict[str, Any]) -> str:
    tier = str(artifact.get("promotion_tier") or "").strip().lower()
    if tier in {"primary", "shadow"}:
        return tier
    state = _approval_state(artifact)
    if state == "production_primary":
        return "primary"
    return "shadow"


def _primary_expected_return_allowed(artifact: dict[str, Any]) -> bool:
    if artifact.get("primary_expected_return_allowed") is False:
        return False
    if artifact.get("primary_expected_return_allowed") is True:
        return True
    return _promotion_tier(artifact) == "primary"


def _resolver_method(artifact: dict[str, Any]) -> str:
    return str(
        artifact.get("resolver_method")
        or artifact.get("model_family")
        or artifact.get("method")
        or artifact.get("source")
        or ""
    ).strip().lower()


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


def _feature_values(
    *,
    l4_value: float | None,
    market_heat_expected_return: float,
    row: dict[str, Any],
) -> dict[str, float]:
    """Materialize only information legally known at the evening decision time."""
    dispersion = row.get("_expected_return_uncertainty_adjustment")
    if not isinstance(dispersion, dict):
        forecast_data = _dict_payload(row.get("forecast_data"))
        dispersion = forecast_data.get("dispersion_diagnostics")
    dispersion_multiplier = _float_or_none((dispersion or {}).get("multiplier")) if isinstance(dispersion, dict) else None
    score_components = _dict_payload(row.get("score_components"))
    components = score_components.get("components") if isinstance(score_components.get("components"), dict) else {}
    forecast_data = _dict_payload(row.get("forecast_data"))
    ev2 = forecast_data.get("ensemble_v2") if isinstance(forecast_data.get("ensemble_v2"), dict) else {}
    final_score = _float_or_none(score_components.get("finalScore") or score_components.get("total") or row.get("score"))
    ml_edge = _float_or_none(components.get("mlEdge"))
    fundamental = _float_or_none(components.get("fundamentalQuality"))
    chip = _float_or_none(components.get("chipFlow"))
    technical = _float_or_none(components.get("technicalStructure"))
    avg_rank = _float_or_none(ev2.get("avg_rank"))
    score_values = (final_score, ml_edge, fundamental, chip, technical)
    return {
        "l4_expected_return": l4_value if l4_value is not None else 0.0,
        "l4_available": 1.0 if l4_value is not None else 0.0,
        "market_heat_expected_return": market_heat_expected_return,
        "dispersion_multiplier": dispersion_multiplier if dispersion_multiplier is not None else 1.0,
        "ml_edge_norm": (ml_edge / 25.0) if ml_edge is not None else 0.0,
        "fundamental_quality_norm": (fundamental / 25.0) if fundamental is not None else 0.0,
        "chip_flow_norm": (chip / 25.0) if chip is not None else 0.0,
        "technical_structure_norm": (technical / 25.0) if technical is not None else 0.0,
        "ensemble_directional_margin": (avg_rank - 0.5) if avg_rank is not None else 0.0,
        "score_v2_available": 1.0 if all(value is not None for value in score_values) else 0.0,
        "ensemble_rank_available": 1.0 if avg_rank is not None else 0.0,
        **market_context_feature_values(
            row,
            l4_value=l4_value,
        ),
    }

def _rejected_payload(
    artifact: dict[str, Any],
    blockers: list[str],
    *,
    l4_payload: dict[str, Any] | None = None,
    feature_values: dict[str, float] | None = None,
) -> dict[str, Any]:
    return {
        **artifact,
        "schema_version": SCHEMA_VERSION,
        "status": "rejected",
        "expected_return_owner": OWNER,
        "expected_return": None,
        "expected_return_mean": None,
        "expected_return_source": "allocator_ev_fusion:artifact_validation_failed_no_expected_return",
        "selection_feature_owner": "l4_alpha_ev",
        "execution_policy_owner": "s12_intraday_structure_v1",
        "execution_policy_label_source": "s12_replay_trade_outcomes",
        "l4_alpha_ev": l4_payload,
        "feature_values": feature_values or {},
        "blockers": list(dict.fromkeys(blockers)),
    }


def materialize_allocator_ev_fusion(
    row: dict[str, Any],
    *,
    l4_value: float | None,
    l4_source: str,
    l4_payload: dict[str, Any] | None,
    market_heat_expected_return: float,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    artifact = policy_artifact(policy)
    if artifact is None:
        return None

    blockers: list[str] = []
    contract_version = str(artifact.get("artifact_contract_version") or "").strip()
    label_version = str(artifact.get("label_schema_version") or "").strip()
    supported_contract_versions = {pair[0] for pair in SUPPORTED_ALLOCATOR_EV_SERVING_CONTRACT_PAIRS}
    supported_label_versions = {pair[1] for pair in SUPPORTED_ALLOCATOR_EV_SERVING_CONTRACT_PAIRS}
    if contract_version not in supported_contract_versions:
        blockers.append("artifact_contract_version_incompatible")
    if label_version not in supported_label_versions:
        blockers.append("label_schema_version_incompatible")
    if (
        contract_version in supported_contract_versions
        and label_version in supported_label_versions
        and (contract_version, label_version) not in SUPPORTED_ALLOCATOR_EV_SERVING_CONTRACT_PAIRS
    ):
        blockers.append("artifact_label_contract_pair_incompatible")
    expected_feature_semantic = SUPPORTED_ALLOCATOR_EV_FEATURE_SEMANTICS.get(contract_version)
    if str(artifact.get("feature_semantic_version") or "").strip() != expected_feature_semantic:
        blockers.append("feature_semantic_version_incompatible")
    method = _resolver_method(artifact)
    if artifact.get("expected_return_semantic") != "execution_probability_times_conditional_replay_net_return":
        blockers.append("policy_value_semantic_incompatible")
    if _validation_decision(artifact) not in PASS_STATES:
        blockers.append("validation_packet_not_pass")
    if _approval_state(artifact) not in APPROVED_STATES:
        blockers.append("production_approval_missing")
    execution_model = artifact.get("conditional_execution_return_model") if isinstance(artifact.get("conditional_execution_return_model"), dict) else None
    execution_probability_model = (
        artifact.get("execution_probability_model")
        if isinstance(artifact.get("execution_probability_model"), dict)
        else None
    )
    if isinstance(artifact.get("selection_model"), dict) or _coefficients(artifact):
        blockers.append("third_selection_serving_head_forbidden")
    execution_coefs = _coefficients(execution_model) if execution_model and execution_model.get("status") == "fitted" else None
    execution_probability_coefs = (
        _coefficients(execution_probability_model)
        if execution_probability_model and execution_probability_model.get("status") == "fitted"
        else None
    )
    if execution_model and execution_model.get("status") == "fitted" and not execution_coefs:
        blockers.append("execution_learned_coefficients_missing")
    if (
        execution_probability_model
        and execution_probability_model.get("status") == "fitted"
        and not execution_probability_coefs
    ):
        blockers.append("execution_probability_coefficients_missing")
    if not execution_coefs:
        blockers.append("execution_learned_coefficients_missing")
    if not execution_probability_coefs:
        blockers.append("execution_probability_coefficients_missing")
    active_coefs = {**(execution_coefs or {}), **(execution_probability_coefs or {})}
    for label, prefixes in REQUIRED_FEATURE_PREFIXES.items():
        if not any(name == prefixes[0] or name.startswith(prefixes[1]) for name in active_coefs):
            blockers.append(f"required_{label}_feature_missing_from_policy_value_heads")
    forbidden_s12_features = sorted(
        name
        for name in active_coefs
        if name.startswith("s12_") or name == "l4_s12_edge_agreement"
    )
    blockers.extend(f"candidate_time_s12_feature_forbidden:{name}" for name in forbidden_s12_features)
    execution_intercept = _float_or_none((execution_model or {}).get("intercept", 0.0))
    if execution_coefs and execution_intercept is None:
        blockers.append("execution_intercept_invalid")
    execution_probability_intercept = _float_or_none((execution_probability_model or {}).get("intercept", 0.0))
    if execution_probability_coefs and execution_probability_intercept is None:
        blockers.append("execution_probability_intercept_invalid")
    for key in ("model_version", "feature_snapshot_version", "trained_until"):
        if not str(artifact.get(key) or "").strip():
            blockers.append(f"{key}_missing")
    if artifact.get("horizon_days") is None and artifact.get("horizon_bars") is None:
        blockers.append("horizon_missing")
    if artifact.get("cost_model_bps") is None:
        blockers.append("cost_model_bps_missing")

    values = _feature_values(
        l4_value=l4_value,
        market_heat_expected_return=market_heat_expected_return,
        row=row,
    )
    missing_features = [
        name for name in active_coefs
        if name not in values or _float_or_none(values.get(name)) is None
    ]
    blockers.extend(f"feature_missing:{name}" for name in sorted(missing_features))
    if blockers:
        return _rejected_payload(
            artifact,
            blockers,
            l4_payload=l4_payload,
            feature_values=values,
        )

    execution_residual_adjustment = 0.0
    execution_model_applied = bool(execution_coefs)
    execution_probability = 1.0 if execution_model_applied else 0.0
    raw_execution_residual = 0.0
    if execution_model_applied:
        raw_execution_residual = float(execution_intercept or 0.0)
        for name, coef in (execution_coefs or {}).items():
            raw_execution_residual += coef * values[name]
        if execution_probability_coefs:
            execution_probability = float(execution_probability_intercept or 0.0)
            for name, coef in execution_probability_coefs.items():
                execution_probability += coef * values[name]
            if str((execution_probability_model or {}).get("link_function") or "").lower() == "logit":
                execution_probability = 1.0 / (1.0 + math.exp(-max(-40.0, min(40.0, execution_probability))))
            else:
                execution_probability = max(0.0, min(1.0, execution_probability))
        execution_residual_adjustment = execution_probability * raw_execution_residual
    expected_return = execution_residual_adjustment
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

    return {
        **artifact,
        "schema_version": SCHEMA_VERSION,
        "status": "loaded",
        "expected_return_owner": OWNER,
        "expected_return": round(expected_return, 10),
        "expected_return_mean": round(expected_return, 10),
        "policy_value": round(execution_residual_adjustment, 10),
        "conditional_execution_return": round(raw_execution_residual, 10),
        "policy_value_head_count": 2,
        "execution_probability": round(execution_probability, 10),
        "conditional_execution_return_model_applied": execution_model_applied,
        "expected_return_source": f"allocator_ev_fusion:{method or 'formal_meta_calibrator'}",
        "selection_feature_owner": "l4_alpha_ev",
        "execution_policy_owner": "s12_intraday_structure_v1",
        "execution_policy_label_source": "s12_replay_trade_outcomes",
        "l4_alpha_ev": l4_payload,
        "l4_expected_return": None if l4_value is None else round(l4_value, 10),
        "l4_expected_return_source": l4_source,
        "market_heat_expected_return": round(market_heat_expected_return, 10),
        "feature_values": {key: round(value, 10) for key, value in values.items()},
        "promotion_tier": _promotion_tier(artifact),
        "primary_expected_return_allowed": _primary_expected_return_allowed(artifact),
        "diagnostic_role": "primary_expected_return_owner",
        "semantic": "evening_policy_value_equals_s12_execution_probability_times_conditional_net_return_using_day_t_causal_features",
        "blockers": [],
    }


def assess_allocator_ev_fusion_policy(policy: dict[str, Any] | None) -> dict[str, Any]:
    """Validate the configured Fusion owner once before row materialization."""
    artifact = policy_artifact(policy)
    if artifact is None:
        blockers = ["artifact_missing"]
        payload: dict[str, Any] = {}
    else:
        payload = materialize_allocator_ev_fusion(
            {},
            l4_value=0.0,
            l4_source="preflight",
            l4_payload={"status": "loaded"},
            market_heat_expected_return=0.0,
            policy=policy,
        ) or {}
        blockers = list(payload.get("blockers") or [])
        if payload.get("status") != "loaded" and not blockers:
            blockers.append("artifact_not_loadable")
        if payload.get("primary_expected_return_allowed") is not True:
            blockers.append("primary_expected_return_not_allowed")
        blockers = list(dict.fromkeys(blockers))
    return {
        "schema_version": "allocator-ev-fusion-policy-cutover-readiness-v1",
        "ready": not blockers,
        "configured": artifact is not None,
        "artifact_model_version": (artifact or {}).get("model_version"),
        "artifact_contract_version": (artifact or {}).get("artifact_contract_version"),
        "feature_semantic_version": (artifact or {}).get("feature_semantic_version"),
        "label_schema_version": (artifact or {}).get("label_schema_version"),
        "blockers": blockers,
        "policy": "fusion_serves_only_after_owner_quality_parity_and_current_contract_pass",
    }
