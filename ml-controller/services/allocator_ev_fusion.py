"""Allocator expected-return fusion owner.

This owner combines selection alpha EV (L4) and execution trade EV (S12) only
through a production-approved artifact. The service validates the artifact and
materializes row-level allocation EV; it does not hardcode alpha/S12 weights.
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
from services.fusion_market_context import market_context_feature_values
from services.pit_sector_alpha import sector_alpha_feature_values


SCHEMA_VERSION = "allocator-ev-fusion-v1"
OWNER = "allocator_ev_fusion"
APPROVED_STATES = {
    "production_approved",
    "approved_for_production",
    "live",
    "production_primary",
    "production_assistive",
    "shadow",
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
    "s12": ("s12_trade_expected_return", "s12_"),
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
    if tier in {"primary", "assistive", "shadow"}:
        return tier
    state = _approval_state(artifact)
    if state in {"production_primary", "production_approved", "approved_for_production", "live"}:
        return "primary"
    if state == "production_assistive":
        return "assistive"
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


def _target_quality_state(payload: dict[str, Any] | None) -> str:
    source = payload if isinstance(payload, dict) else {}
    targets = source.get("s12_structural_targets") if isinstance(source.get("s12_structural_targets"), dict) else {}
    state = str(targets.get("target_quality_state") or "").strip()
    if state:
        return state
    t1 = str(targets.get("target1_source") or "")
    t2 = str(targets.get("target2_source") or "")
    if "r_multiple_fallback" in t1 and "r_multiple_fallback" in t2:
        return "r_multiple_fallback_both"
    if "r_multiple_fallback" in t2:
        return "partial_structure_target"
    return "structure_targets" if targets else "unknown"


def _target_quality_numeric(state: str) -> float:
    return {
        "structure_targets": 1.0,
        "partial_structure_target": 0.7,
        "r_multiple_fallback_both": 0.35,
        "unknown": 0.5,
    }.get(str(state or "").strip(), 0.5)


def _s12_context(payload: dict[str, Any] | None) -> dict[str, Any]:
    source = payload if isinstance(payload, dict) else {}
    context = source.get("candidate_s12_entry_context")
    if not isinstance(context, dict):
        context = source.get("s12_entry_context")
    return context if isinstance(context, dict) else {}


def _s12_multiplier(payload: dict[str, Any] | None) -> float:
    source = payload if isinstance(payload, dict) else {}
    targets = source.get("s12_structural_targets") if isinstance(source.get("s12_structural_targets"), dict) else {}
    for value in (
        targets.get("reward_confidence_multiplier"),
        source.get("reward_confidence_multiplier"),
        (source.get("cold_start_policy") or {}).get("s12_context_multiplier")
        if isinstance(source.get("cold_start_policy"), dict)
        else None,
        _s12_context(source).get("reward_confidence_multiplier"),
        _s12_context(source).get("multiplier"),
    ):
        number = _float_or_none(value)
        if number is not None:
            return max(0.25, min(1.0, number))
    return 1.0


def _s12_execution_ready(payload: dict[str, Any] | None) -> float:
    source = payload if isinstance(payload, dict) else {}
    if not source:
        return 0.0
    if source.get("execution_ready") is False:
        return 0.0
    status = str(source.get("status") or "").strip().lower()
    if status != "loaded":
        return 0.0
    context = _s12_context(source)
    if context.get("ready") is not True:
        return 0.0
    if context.get("htf_hard_block") is True:
        return 0.0
    return 1.0


def _s12_structure_features(payload: dict[str, Any] | None) -> dict[str, float]:
    source = payload if isinstance(payload, dict) else {}
    context = _s12_context(source)
    state = str(context.get("state") or "").strip().lower()
    entry = _float_or_none(source.get("entry_price"))
    stop = _float_or_none(source.get("stop_price"))
    target1 = _float_or_none(source.get("target1_price"))
    target2 = _float_or_none(source.get("target2_price"))
    risk = (entry - stop) if entry is not None and stop is not None and entry > stop else None
    risk_pct = (risk / entry) if risk is not None and entry and entry > 0 else None
    target1_r = ((target1 - entry) / risk) if risk and target1 is not None and target1 > entry else None
    target2_r = ((target2 - entry) / risk) if risk and target2 is not None and target2 > entry else None
    mutation_score = _float_or_none(context.get("equity_mutation_score"))
    return {
        "s12_structure_available": 1.0 if context.get("detail_available") is True and risk is not None else 0.0,
        "s12_risk_pct": max(0.0, min(0.25, risk_pct)) if risk_pct is not None else 0.0,
        "s12_target1_r": max(0.0, min(10.0, target1_r)) if target1_r is not None else 0.0,
        "s12_target2_r": max(0.0, min(10.0, target2_r)) if target2_r is not None else 0.0,
        "s12_equity_mutation_score": max(0.0, min(1.0, mutation_score)) if mutation_score is not None else 0.0,
        "s12_vwap_fast_acceptance": 1.0 if context.get("vwap_fast_acceptance") is True else 0.0,
        "s12_htf_hard_block": 1.0 if context.get("htf_hard_block") is True else 0.0,
        "s12_full_reaction_ready": 1.0 if state == "reaction_ready" else 0.0,
        "s12_limited_takeover_ready": 1.0 if state == "limited_takeover_ready" else 0.0,
    }


def _feature_values(
    *,
    l4_value: float | None,
    s12_value: float | None,
    s12_payload: dict[str, Any] | None,
    market_heat_expected_return: float,
    row: dict[str, Any],
) -> dict[str, float]:
    target_state = _target_quality_state(s12_payload)
    multiplier = _s12_multiplier(s12_payload)
    dispersion = row.get("_expected_return_uncertainty_adjustment")
    if not isinstance(dispersion, dict):
        forecast_data = _dict_payload(row.get("forecast_data"))
        dispersion = forecast_data.get("dispersion_diagnostics")
    dispersion_multiplier = _float_or_none((dispersion or {}).get("multiplier")) if isinstance(dispersion, dict) else None
    edge_agreement = (
        1.0
        if l4_value is not None
        and s12_value is not None
        and ((l4_value >= 0 and s12_value >= 0) or (l4_value < 0 and s12_value < 0))
        else 0.0
    )
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
        "s12_trade_expected_return": s12_value if s12_value is not None else 0.0,
        "s12_available": 1.0 if s12_value is not None else 0.0,
        "s12_execution_ready": _s12_execution_ready(s12_payload),
        "s12_context_multiplier": multiplier,
        "s12_context_multiplier_minus_1": multiplier - 1.0,
        "s12_target_quality_score": _target_quality_numeric(target_state),
        "market_heat_expected_return": market_heat_expected_return,
        "l4_s12_edge_agreement": edge_agreement,
        "dispersion_multiplier": dispersion_multiplier if dispersion_multiplier is not None else 1.0,
        "ml_edge_norm": (ml_edge / 25.0) if ml_edge is not None else 0.0,
        "fundamental_quality_norm": (fundamental / 25.0) if fundamental is not None else 0.0,
        "chip_flow_norm": (chip / 25.0) if chip is not None else 0.0,
        "technical_structure_norm": (technical / 25.0) if technical is not None else 0.0,
        "ensemble_directional_margin": (avg_rank - 0.5) if avg_rank is not None else 0.0,
        "score_v2_available": 1.0 if all(value is not None for value in score_values) else 0.0,
        "ensemble_rank_available": 1.0 if avg_rank is not None else 0.0,
        **sector_alpha_feature_values(row),
        **_s12_structure_features(s12_payload),
        **market_context_feature_values(
            row,
            l4_value=l4_value,
            s12_value=s12_value,
        ),
    }


def _rejected_payload(
    artifact: dict[str, Any],
    blockers: list[str],
    *,
    l4_payload: dict[str, Any] | None = None,
    s12_payload: dict[str, Any] | None = None,
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
        "selection_alpha_owner": "l4_alpha_ev",
        "execution_trade_owner": "s12_trade_ev",
        "l4_alpha_ev": l4_payload,
        "s12_trade_ev": s12_payload,
        "feature_values": feature_values or {},
        "blockers": list(dict.fromkeys(blockers)),
    }


def materialize_allocator_ev_fusion(
    row: dict[str, Any],
    *,
    l4_value: float | None,
    l4_source: str,
    l4_payload: dict[str, Any] | None,
    s12_value: float | None,
    s12_source: str,
    s12_payload: dict[str, Any] | None,
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
    if _validation_decision(artifact) not in PASS_STATES:
        blockers.append("validation_packet_not_pass")
    if _approval_state(artifact) not in APPROVED_STATES:
        blockers.append("production_approval_missing")
    selection_model = artifact.get("selection_model") if isinstance(artifact.get("selection_model"), dict) else None
    execution_model = artifact.get("execution_model") if isinstance(artifact.get("execution_model"), dict) else None
    execution_probability_model = (
        artifact.get("execution_probability_model")
        if isinstance(artifact.get("execution_probability_model"), dict)
        else None
    )
    coefs = _coefficients(selection_model or artifact)
    if not coefs:
        blockers.append("learned_coefficients_missing")
    else:
        required_prefixes = {"l4": REQUIRED_FEATURE_PREFIXES["l4"]} if selection_model else REQUIRED_FEATURE_PREFIXES
        for label, prefixes in required_prefixes.items():
            if not any(name == prefixes[0] or name.startswith(prefixes[1]) for name in coefs):
                blockers.append(f"required_{label}_feature_missing_from_artifact")
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
    if execution_coefs and not any(
        name == REQUIRED_FEATURE_PREFIXES["s12"][0] or name.startswith(REQUIRED_FEATURE_PREFIXES["s12"][1])
        for name in execution_coefs
    ):
        blockers.append("required_s12_feature_missing_from_execution_artifact")
    intercept = _float_or_none((selection_model or artifact).get("intercept", 0.0))
    if intercept is None:
        blockers.append("intercept_invalid")
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
    blockers.extend(expected_return_cost_contract_blockers(artifact))

    values = _feature_values(
        l4_value=l4_value,
        s12_value=s12_value,
        s12_payload=s12_payload,
        market_heat_expected_return=market_heat_expected_return,
        row=row,
    )
    active_coefs = {**(coefs or {}), **(execution_coefs or {}), **(execution_probability_coefs or {})}
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
            s12_payload=s12_payload,
            feature_values=values,
        )

    selection_expected_return = float(intercept or 0.0)
    for name, coef in (coefs or {}).items():
        selection_expected_return += coef * values[name]
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
    direct_trade_ev = artifact.get("expected_return_semantic") == "execution_probability_times_conditional_replay_net_return"
    if direct_trade_ev and not execution_model_applied:
        return {
            **artifact,
            "schema_version": SCHEMA_VERSION,
            "status": "candidate_fallback_required",
            "expected_return_owner": OWNER,
            "expected_return": None,
            "expected_return_mean": None,
            "expected_return_source": "allocator_ev_fusion:execution_expert_unavailable_fallback_required",
            "selection_expected_return": round(selection_expected_return, 10),
            "execution_residual_adjustment": 0.0,
            "raw_execution_residual": 0.0,
            "execution_probability": None,
            "s12_execution_model_applied": False,
            "primary_expected_return_allowed": False,
            "selection_alpha_owner": "l4_alpha_ev",
            "execution_trade_owner": "s12_trade_ev",
            "l4_alpha_ev": l4_payload,
            "l4_expected_return": None if l4_value is None else round(l4_value, 10),
            "l4_expected_return_source": l4_source,
            "s12_trade_ev": s12_payload,
            "s12_trade_expected_return": None if s12_value is None else round(s12_value, 10),
            "s12_trade_expected_return_source": s12_source,
            "market_heat_expected_return": round(market_heat_expected_return, 10),
            "feature_values": {key: round(value, 10) for key, value in values.items()},
            "diagnostic_role": "artifact_execution_expert_fallback_to_canonical_l4",
            "semantic": "fusion_owner_requires_fitted_execution_expert;candidate_s12_ev_is_optional_with_availability_indicator",
            "blockers": ["execution_expert_unavailable"],
        }
    expected_return = (
        execution_residual_adjustment
        if direct_trade_ev and execution_model_applied
        else selection_expected_return + execution_residual_adjustment
    )
    try:
        expected_return, cost_metadata = normalize_expected_return_to_net(
            expected_return,
            artifact,
        )
    except ExpectedReturnCostContractError as exc:
        return _rejected_payload(
            artifact,
            str(exc).split(","),
            l4_payload=l4_payload,
            s12_payload=s12_payload,
            feature_values=values,
        )
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
        **cost_metadata,
        "status": "loaded",
        "expected_return_owner": OWNER,
        "expected_return": round(expected_return, 10),
        "expected_return_mean": round(expected_return, 10),
        "selection_expected_return": round(selection_expected_return, 10),
        "execution_residual_adjustment": round(execution_residual_adjustment, 10),
        "raw_execution_residual": round(raw_execution_residual, 10),
        "execution_probability": round(execution_probability, 10),
        "s12_execution_model_applied": execution_model_applied,
        "expected_return_source": f"allocator_ev_fusion:{method or 'formal_meta_calibrator'}",
        "selection_alpha_owner": "l4_alpha_ev",
        "execution_trade_owner": "s12_trade_ev",
        "l4_alpha_ev": l4_payload,
        "l4_expected_return": None if l4_value is None else round(l4_value, 10),
        "l4_expected_return_source": l4_source,
        "s12_trade_ev": s12_payload,
        "s12_trade_expected_return": None if s12_value is None else round(s12_value, 10),
        "s12_trade_expected_return_source": s12_source,
        "market_heat_expected_return": round(market_heat_expected_return, 10),
        "feature_values": {key: round(value, 10) for key, value in values.items()},
        "promotion_tier": _promotion_tier(artifact),
        "primary_expected_return_allowed": _primary_expected_return_allowed(artifact),
        "diagnostic_role": (
            "primary_expected_return_owner"
            if _primary_expected_return_allowed(artifact)
            else "assistive_diagnostic_not_expected_return_owner"
        ),
        "semantic": "allocation_expected_return_fuses_l4_selection_alpha_and_s12_execution_trade_ev",
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
            s12_value=0.0,
            s12_source="preflight",
            s12_payload={"status": "loaded"},
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
