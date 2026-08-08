"""Allocator expected-return fusion owner.

Canonical L4 remains the base expected-return estimator. Fusion may add only a
validated residual adjustment learned from decision-time L4/ScoreV2/market
features. Missing, rejected, or incompatible Fusion artifacts are handled by
the recommendation layer as a zero adjustment; S12 is never a serving owner.
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
from services.expected_return_cost_contract import (
    ExpectedReturnCostContractError,
    expected_return_cost_contract_blockers,
    normalize_expected_return_to_net,
)
from services.expected_return_artifact_identity import expected_return_artifact_identity
from services.fusion_market_context import market_context_feature_values
from services.pit_sector_alpha import sector_alpha_feature_values


SCHEMA_VERSION = "allocator-ev-fusion-v2"
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
        **sector_alpha_feature_values(row),
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
        "overlay_status": "rejected",
        "expected_return_owner": OWNER,
        "expected_return": None,
        "expected_return_mean": None,
        "expected_return_source": "allocator_ev_fusion:artifact_validation_failed_no_expected_return",
        "selection_feature_owner": "l4_alpha_ev",
        "base_expected_return_owner": "l4_alpha_ev",
        "base_expected_return": None,
        "fusion_residual_adjustment": 0.0,
        "final_expected_return": None,
        "fusion_adjustment_allowed": False,
        "primary_expected_return_allowed": False,
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

    artifact = dict(artifact)
    try:
        identity = expected_return_artifact_identity(artifact)
    except ValueError:
        identity = {}
    artifact.update(identity)
    guard = _dict_payload(artifact.get("runtime_forward_guard"))
    guard_matches = bool(
        guard.get("lineage_bound") is True
        and guard.get("artifact_id") == artifact.get("artifact_id")
        and guard.get("model_fingerprint") == artifact.get("model_fingerprint")
    )

    blockers: list[str] = []
    if guard_matches and guard.get("action") == "residual_bypass":
        blockers.append("serving_forward_guard_residual_bypass_active")
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
    if artifact.get("expected_return_semantic") != "l4_base_expected_return_plus_validated_residual_adjustment":
        blockers.append("policy_value_semantic_incompatible")
    if _validation_decision(artifact) not in PASS_STATES:
        blockers.append("validation_packet_not_pass")
    if _approval_state(artifact) not in APPROVED_STATES:
        blockers.append("production_approval_missing")
    residual_model = (
        artifact.get("residual_adjustment_model")
        if isinstance(artifact.get("residual_adjustment_model"), dict)
        else None
    )
    if isinstance(artifact.get("selection_model"), dict) or _coefficients(artifact):
        blockers.append("third_selection_serving_head_forbidden")
    if isinstance(artifact.get("conditional_execution_return_model"), dict) or isinstance(artifact.get("execution_probability_model"), dict):
        blockers.append("legacy_s12_serving_heads_forbidden")
    residual_coefs = _coefficients(residual_model) if residual_model and residual_model.get("status") == "fitted" else None
    if not residual_coefs:
        blockers.append("residual_adjustment_coefficients_missing")
    if int(artifact.get("policy_value_head_count") or 0) != 1:
        blockers.append("policy_value_head_count_not_one")
    if artifact.get("policy_value_heads") != ["residual_adjustment_model"]:
        blockers.append("policy_value_heads_incompatible")
    active_coefs = dict(residual_coefs or {})
    forbidden_s12_features = sorted(
        name
        for name in active_coefs
        if name.startswith("s12_") or name == "l4_s12_edge_agreement"
    )
    blockers.extend(f"candidate_time_s12_feature_forbidden:{name}" for name in forbidden_s12_features)
    residual_intercept = _float_or_none((residual_model or {}).get("intercept", 0.0))
    if residual_coefs and residual_intercept is None:
        blockers.append("residual_adjustment_intercept_invalid")
    for key in ("model_version", "feature_snapshot_version", "trained_until"):
        if not str(artifact.get(key) or "").strip():
            blockers.append(f"{key}_missing")
    if artifact.get("horizon_days") is None and artifact.get("horizon_bars") is None:
        blockers.append("horizon_missing")
    blockers.extend(expected_return_cost_contract_blockers(artifact))
    if l4_value is None:
        blockers.append("l4_base_expected_return_missing")

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

    raw_residual_adjustment = float(residual_intercept or 0.0)
    for name, coef in (residual_coefs or {}).items():
        raw_residual_adjustment += coef * values[name]
    try:
        residual_adjustment, cost_metadata = normalize_expected_return_to_net(
            raw_residual_adjustment,
            artifact,
        )
    except ExpectedReturnCostContractError as exc:
        return _rejected_payload(
            artifact,
            str(exc).split(","),
            l4_payload=l4_payload,
            feature_values=values,
        )
    clip = artifact.get("residual_output_clip") if isinstance(artifact.get("residual_output_clip"), dict) else {}
    min_value = _float_or_none(clip.get("min"))
    max_value = _float_or_none(clip.get("max"))
    if min_value is not None:
        residual_adjustment = max(min_value, residual_adjustment)
    if max_value is not None:
        residual_adjustment = min(max_value, residual_adjustment)
    base_expected_return = float(l4_value)
    final_expected_return = base_expected_return + residual_adjustment
    primary_allowed = _primary_expected_return_allowed(artifact)

    return {
        **artifact,
        "schema_version": SCHEMA_VERSION,
        **cost_metadata,
        "status": "loaded",
        "overlay_status": "applied",
        "expected_return_owner": OWNER,
        "expected_return": round(final_expected_return, 10),
        "expected_return_mean": round(final_expected_return, 10),
        "policy_value": round(final_expected_return, 10),
        "base_expected_return_owner": "l4_alpha_ev",
        "base_expected_return": round(base_expected_return, 10),
        "raw_fusion_residual_adjustment": round(raw_residual_adjustment, 10),
        "fusion_residual_adjustment": round(residual_adjustment, 10),
        "final_expected_return": round(final_expected_return, 10),
        "policy_value_head_count": 1,
        "residual_adjustment_model_applied": True,
        "fusion_adjustment_allowed": primary_allowed,
        "expected_return_source": f"allocator_ev_fusion:{method or 'l4_residual_overlay'}",
        "selection_feature_owner": "l4_alpha_ev",
        "l4_alpha_ev": l4_payload,
        "l4_expected_return": round(base_expected_return, 10),
        "l4_expected_return_source": l4_source,
        "market_heat_expected_return": round(market_heat_expected_return, 10),
        "feature_values": {key: round(value, 10) for key, value in values.items()},
        "promotion_tier": _promotion_tier(artifact),
        "primary_expected_return_allowed": primary_allowed,
        "diagnostic_role": "validated_residual_adjustment_over_canonical_l4",
        "semantic": "final_expected_return_equals_canonical_l4_plus_validated_residual_adjustment",
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
        "policy": "fusion_residual_overlay_serves_only_after_quality_and_same_contract_l4_parity",
    }
