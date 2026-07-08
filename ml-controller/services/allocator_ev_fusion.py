"""Allocator expected-return fusion owner.

This owner combines selection alpha EV (L4) and execution trade EV (S12) only
through a production-approved artifact. The service validates the artifact and
materializes row-level allocation EV; it does not hardcode alpha/S12 weights.
"""
from __future__ import annotations

import json
import math
from typing import Any


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
    if source.get("execution_ready") is False:
        return 0.0
    status = str(source.get("status") or "").strip().lower()
    if status == "setup_only":
        return 0.0
    context = _s12_context(source)
    if context.get("ready") is False:
        return 0.0
    if context.get("htf_hard_block") is True:
        return 0.0
    return 1.0


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
    return {
        "l4_expected_return": l4_value if l4_value is not None else 0.0,
        "l4_available": 1.0 if l4_value is not None else 0.0,
        "s12_trade_expected_return": s12_value if s12_value is not None else 0.0,
        "s12_available": 1.0 if s12_value is not None else 0.0,
        "s12_execution_ready": _s12_execution_ready(s12_payload),
        "s12_context_multiplier": multiplier,
        "s12_context_multiplier_minus_1": multiplier - 1.0,
        "s12_target_quality_score": _target_quality_numeric(target_state),
        "market_heat_expected_return": max(0.0, market_heat_expected_return),
        "l4_s12_edge_agreement": edge_agreement,
        "dispersion_multiplier": dispersion_multiplier if dispersion_multiplier is not None else 1.0,
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
    method = _resolver_method(artifact)
    if _validation_decision(artifact) not in PASS_STATES:
        blockers.append("validation_packet_not_pass")
    if _approval_state(artifact) not in APPROVED_STATES:
        blockers.append("production_approval_missing")
    coefs = _coefficients(artifact)
    if not coefs:
        blockers.append("learned_coefficients_missing")
    else:
        for label, prefixes in REQUIRED_FEATURE_PREFIXES.items():
            if not any(name == prefixes[0] or name.startswith(prefixes[1]) for name in coefs):
                blockers.append(f"required_{label}_feature_missing_from_artifact")
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

    values = _feature_values(
        l4_value=l4_value,
        s12_value=s12_value,
        s12_payload=s12_payload,
        market_heat_expected_return=market_heat_expected_return,
        row=row,
    )
    missing_features = [
        name for name in (coefs or {})
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

    expected_return = float(intercept or 0.0)
    for name, coef in (coefs or {}).items():
        expected_return += coef * values[name]
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
        "expected_return_source": f"allocator_ev_fusion:{method or 'formal_meta_calibrator'}",
        "selection_alpha_owner": "l4_alpha_ev",
        "execution_trade_owner": "s12_trade_ev",
        "l4_alpha_ev": l4_payload,
        "l4_expected_return": None if l4_value is None else round(l4_value, 10),
        "l4_expected_return_source": l4_source,
        "s12_trade_ev": s12_payload,
        "s12_trade_expected_return": None if s12_value is None else round(s12_value, 10),
        "s12_trade_expected_return_source": s12_source,
        "market_heat_expected_return": round(max(0.0, market_heat_expected_return), 10),
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
