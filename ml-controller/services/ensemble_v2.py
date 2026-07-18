from __future__ import annotations

import math

from services.active_model_policy import (
    ACTIVE_ALPHA_MODELS,
    CORE_CROSS_SECTIONAL_ALPHA_MODELS,
    OPTIONAL_SEQUENCE_ALPHA_MODELS,
)
from services.ev_lineage_contract import build_model_set_signature, is_known_artifact_version
from services.active8_score_semantics import (
    MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
    MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION,
)


_SRC_KEY_MODEL = (
    ("dlinear", "DLinear"),
    ("patchtst", "PatchTST"),
    ("itransformer", "iTransformer"),
)
_FORMAL_ALPHA_MODELS = ACTIVE_ALPHA_MODELS
_DIRECT_ALPHA_BLOCKED_MODELS = {"TimesFM"}
_MODEL_STATUS_ALLOWED = {"active", "degraded", "challenger", "retired"}
ENSEMBLE_V2_SCHEMA_VERSION = "ensemble-v2-payload-v3"
ENSEMBLE_V2_SEMANTIC_VERSION = "active8-ic-weighted-rank-v4"


def _ensemble_lineage_fields(
    *,
    formal_contract: dict,
    weights: dict[str, float],
    ev2_cfg: dict | None,
) -> dict:
    contributing = sorted(name for name, weight in weights.items() if weight > 0)
    configured_versions = (ev2_cfg or {}).get("activeArtifactVersions") or {}
    versions = configured_versions if isinstance(configured_versions, dict) else {}
    artifact_versions = {
        name: str(versions.get(name) or "").strip()
        for name in contributing
        if is_known_artifact_version(versions.get(name))
    }
    missing_versions = [name for name in contributing if name not in artifact_versions]
    signature = build_model_set_signature(artifact_versions, contributing)
    return {
        "schema_version": ENSEMBLE_V2_SCHEMA_VERSION,
        "semantic_version": ENSEMBLE_V2_SEMANTIC_VERSION,
        "input_contract_version": formal_contract.get("schema_version"),
        "artifact_versions": artifact_versions,
        "model_set_signature": signature,
        "lineage_status": "complete" if signature else "incomplete",
        "lineage_blockers": [f"artifact_version_missing:{name}" for name in missing_versions],
    }


def _finite_rank(value: object) -> float | None:
    try:
        rank = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(rank):
        return None
    return max(0.0, min(1.0, rank))


def _finite_number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _formal_model_scores(pred: dict) -> dict[str, float]:
    rank_scores = pred.get("rank_scores") if isinstance(pred.get("rank_scores"), dict) else {}
    scores: dict[str, float] = {}
    for model_name in ACTIVE_ALPHA_MODELS:
        rank = _finite_rank(rank_scores.get(model_name))
        if rank is not None:
            scores[model_name] = rank
    return scores


def build_formal_model_input_contract(pred: dict | None) -> dict:
    """Require the five cross-sectional models and mask unavailable sequence outputs.

    This matches the chronological OOF stacker: sequence models contribute when
    point-in-time history and artifact evidence exist, while their absence is an
    observed feature rather than a reason to discard the symbol.
    """
    prediction = pred if isinstance(pred, dict) else {}
    scores = _formal_model_scores(prediction)
    lineage = prediction.get("model_score_lineage") if isinstance(prediction.get("model_score_lineage"), dict) else {}
    available = [name for name in ACTIVE_ALPHA_MODELS if name in scores]
    missing = [name for name in ACTIVE_ALPHA_MODELS if name not in scores]
    missing_core = [name for name in CORE_CROSS_SECTIONAL_ALPHA_MODELS if name not in scores]
    missing_optional = [name for name in OPTIONAL_SEQUENCE_ALPHA_MODELS if name not in scores]
    lineage_blockers: list[str] = []
    if lineage.get("schema_version") != MODEL_SCORE_LINEAGE_SCHEMA_VERSION:
        lineage_blockers.append("score_lineage_schema_mismatch")
    if lineage.get("semantic_version") != MODEL_SCORE_SEMANTIC_VERSION:
        lineage_blockers.append("score_semantic_mismatch")
    if lineage.get("target_semantic_version") != MODEL_TARGET_SEMANTIC_VERSION:
        lineage_blockers.append("target_semantic_mismatch")
    if lineage.get("complete") is not True:
        lineage_blockers.extend(str(value) for value in (lineage.get("blockers") or []))
    return {
        "schema_version": "formal-layer3-active8-input-contract-v3",
        "active_models": list(ACTIVE_ALPHA_MODELS),
        "required_models": list(CORE_CROSS_SECTIONAL_ALPHA_MODELS),
        "optional_sequence_models": list(OPTIONAL_SEQUENCE_ALPHA_MODELS),
        "available_models": available,
        "missing_models": missing,
        "missing_core_models": missing_core,
        "missing_optional_models": missing_optional,
        "model_availability": {name: name in scores for name in ACTIVE_ALPHA_MODELS},
        "full_active8_coverage": not missing,
        "complete": not missing_core and not lineage_blockers,
        "coverage_policy": "core5-required_sequence-missingness-aware-oof-parity-v1",
        "finite_scores_required": True,
        "score_semantic_version": lineage.get("semantic_version"),
        "target_semantic_version": lineage.get("target_semantic_version"),
        "lineage_blockers": list(dict.fromkeys(lineage_blockers)),
    }

def _rank_confidence(avg_rank: float) -> float:
    return round(0.5 + abs(avg_rank - 0.5), 4)


def _calibrated_forecast_pct(avg_rank: float, ev2_cfg: dict | None = None) -> tuple[float | None, str, dict]:
    """Map ensemble rank to expected return only when verified calibration exists."""
    calibration = (ev2_cfg or {}).get("expectedReturnCalibration") or {}
    bins = calibration.get("bins") if isinstance(calibration, dict) else None
    min_samples = int(calibration.get("minSamples", 1) or 1) if isinstance(calibration, dict) else 1
    base_meta = {
        "forecast_calibration_method": calibration.get("method") if isinstance(calibration, dict) else None,
        "forecast_calibration_status": (
            calibration.get("status") if isinstance(calibration, dict) and calibration
            else (ev2_cfg or {}).get("expectedReturnCalibrationRuntime", {}).get("status")
            if isinstance((ev2_cfg or {}).get("expectedReturnCalibrationRuntime"), dict)
            else "missing"
        ),
        "forecast_calibration_source": calibration.get("source") if isinstance(calibration, dict) else None,
        "forecast_calibration_sample_count": calibration.get("sampleCount") if isinstance(calibration, dict) else None,
    }
    if isinstance(bins, list):
        valid_bins: list[dict] = []
        for row in bins:
            if not isinstance(row, dict):
                continue
            try:
                low = float(row.get("rankLow", row.get("rank_low")))
                high = float(row.get("rankHigh", row.get("rank_high")))
                samples = int(row.get("samples") or 0)
                mean_return = float(
                    row.get("meanReturn", row.get("mean_return", row.get("medianReturn", row.get("median_return"))))
                )
            except (TypeError, ValueError):
                continue
            if samples < min_samples:
                continue
            valid_bins.append({
                "low": low,
                "high": high,
                "samples": samples,
                "mean_return": mean_return,
            })
        valid_bins.sort(key=lambda item: (item["low"], item["high"]))
        for idx, row in enumerate(valid_bins):
            low = row["low"]
            high = row["high"]
            samples = row["samples"]
            mean_return = row["mean_return"]
            upper_ok = avg_rank <= high if idx == len(valid_bins) - 1 or high >= 1.0 else avg_rank < high
            if samples >= min_samples and avg_rank >= low and upper_ok:
                return round(mean_return, 6), "calibrated_rank_bin", {
                    **base_meta,
                    "forecast_calibration_method": base_meta["forecast_calibration_method"] or "empirical_rank_bins",
                    "forecast_calibration_status": base_meta["forecast_calibration_status"] or "configured",
                    "forecast_calibration_bin_samples": samples,
                    "forecast_calibration_bin": {"rankLow": low, "rankHigh": high},
                    "forecast_calibration_ood": False,
                }
        if valid_bins:
            first = valid_bins[0]
            last = valid_bins[-1]
            if avg_rank < first["low"]:
                clamp_bin = first
                side = "below_min_rank"
                distance = first["low"] - avg_rank
            elif avg_rank > last["high"]:
                clamp_bin = last
                side = "above_max_rank"
                distance = avg_rank - last["high"]
            else:
                clamp_bin = min(
                    valid_bins,
                    key=lambda item: min(abs(avg_rank - item["low"]), abs(avg_rank - item["high"])),
                )
                side = "rank_bin_gap"
                distance = min(abs(avg_rank - clamp_bin["low"]), abs(avg_rank - clamp_bin["high"]))
            dampening = calibration.get("tailDampening", calibration.get("tail_dampening", 0.5))
            try:
                dampening = max(0.0, min(1.0, float(dampening)))
            except (TypeError, ValueError):
                dampening = 0.5
            clamped = float(clamp_bin["mean_return"]) * dampening
            if side == "below_min_rank":
                clamped = min(0.0, clamped)
            return round(clamped, 6), "calibrated_rank_tail_clamp", {
                **base_meta,
                "forecast_calibration_method": base_meta["forecast_calibration_method"] or "empirical_rank_bins",
                "forecast_calibration_status": base_meta["forecast_calibration_status"] or "configured",
                "forecast_calibration_bin_samples": clamp_bin["samples"],
                "forecast_calibration_bin": {"rankLow": clamp_bin["low"], "rankHigh": clamp_bin["high"]},
                "forecast_calibration_ood": True,
                "forecast_calibration_ood_side": side,
                "forecast_calibration_tail_distance": round(distance, 6),
                "forecast_calibration_tail_policy": "conservative_empirical_bin_clamp",
                "forecast_calibration_tail_dampening": dampening,
            }
    return None, "uncalibrated_rank_score", base_meta


def _forecast_fields(avg_rank: float, ev2_cfg: dict | None = None) -> dict:
    forecast, source, meta = _calibrated_forecast_pct(avg_rank, ev2_cfg)
    return {
        "forecast_pct": forecast,
        "forecast_pct_source": source,
        "forecast_return_5bar": forecast,
        "forecast_return_5bar_source": source,
        "forecast_return_5bar_owner": "ensemble_v2_calibrated_5bar_close_forecast",
        "forecast_horizon_bars": 5,
        "expected_return": None,
        "expected_return_source": "s12_trade_ev_required",
        "expected_return_owner": "s12_trade_ev",
        "trade_expected_return_net_pct": None,
        "trade_expected_return_source": "s12_trade_ev_missing",
        **meta,
    }


def _compute_lifecycle_weight(status: str, ic_value: float, degraded_dampening: float) -> float:
    base = max(0.0, float(ic_value or 0.0))
    if status in ("retired", "challenger"):
        return 0.0
    if status == "degraded":
        return base * max(0.0, degraded_dampening)
    return base


def _contrarian_policy_from_cfg(ev2_cfg: dict | None) -> dict:
    raw = (ev2_cfg or {}).get("contrarianPolicy") or (ev2_cfg or {}).get("inverseIcPolicy") or {}
    return raw if isinstance(raw, dict) else {}


def _contrarian_policy_approved(policy: dict) -> bool:
    status = str(policy.get("status") or policy.get("approval_status") or "").lower()
    approved_level = str(policy.get("approved_level") or policy.get("level") or "").upper()
    return bool(policy.get("enabled")) and (
        policy.get("approved") is True
        or status in {"approved", "production_approved", "capped_production_approved"}
        or approved_level in {"L3", "L4"}
    )


def _contrarian_allowed_models(policy: dict) -> set[str] | None:
    raw = policy.get("allowedModels") or policy.get("allowed_models") or policy.get("models")
    if raw is None:
        return None
    if not isinstance(raw, list):
        return set()
    return {str(item) for item in raw if str(item or "").strip()}


def _build_weighted_model_inputs(
    *,
    merged: dict[str, float],
    model_status: dict,
    ic_weights: dict,
    degraded_dampening: float,
    ev2_cfg: dict | None,
) -> tuple[dict[str, float], dict[str, float], dict]:
    """Apply lifecycle weighting and explicit inverse-edge policy.

    Negative IC is not silently trusted. It is either rejected as a zero-weight
    model, or inverted only when an approved contrarian policy explicitly
    allows that model and the absolute IC clears the policy floor.
    """
    policy = _contrarian_policy_from_cfg(ev2_cfg)
    approved = _contrarian_policy_approved(policy)
    allowed_models = _contrarian_allowed_models(policy)
    try:
        min_abs_ic = abs(float(policy.get("minAbsIc", policy.get("min_abs_ic", 0.0)) or 0.0))
    except (TypeError, ValueError):
        min_abs_ic = 0.0
    try:
        max_weight = abs(float(policy.get("maxWeight", policy.get("max_weight", 0.05)) or 0.05))
    except (TypeError, ValueError):
        max_weight = 0.05
    max_weight = max(0.0, min(0.25, max_weight))

    transformed: dict[str, float] = {}
    weights: dict[str, float] = {}
    model_states: dict[str, dict] = {}
    inverted: list[str] = []
    rejected_inverse: list[str] = []

    for name, rank in merged.items():
        status = _weight_status(model_status, name)
        try:
            ic_value = float(ic_weights.get(name, 0.0) or 0.0)
        except (TypeError, ValueError):
            ic_value = 0.0
        transformed[name] = rank
        transform = "identity"
        reject_reason = None
        if ic_value < 0:
            model_allowed = allowed_models is None or name in allowed_models
            can_invert = (
                approved
                and model_allowed
                and abs(ic_value) >= min_abs_ic
                and status not in {"retired", "challenger"}
            )
            if can_invert:
                transformed[name] = 1.0 - rank
                base = min(abs(ic_value), max_weight)
                weight = base * (max(0.0, degraded_dampening) if status == "degraded" else 1.0)
                transform = "contrarian_inverse_rank"
                inverted.append(name)
            else:
                weight = 0.0
                reject_reason = (
                    "negative_ic_contrarian_policy_not_approved"
                    if not approved
                    else "negative_ic_contrarian_gate_failed"
                )
                rejected_inverse.append(name)
        else:
            weight = _compute_lifecycle_weight(status, ic_value, degraded_dampening)
        weights[name] = max(0.0, weight)
        model_states[name] = {
            "ic_value": round(ic_value, 6),
            "status": status,
            "transform": transform,
            "weight": round(max(0.0, weight), 6),
            "reject_reason": reject_reason,
        }

    return transformed, weights, {
        "schema_version": "ensemble-v2-contrarian-policy-v1",
        "enabled": bool(policy.get("enabled")),
        "approved": approved,
        "policy_id": policy.get("policy_id") or policy.get("id"),
        "min_abs_ic": min_abs_ic,
        "max_weight": max_weight,
        "inverted_models": sorted(inverted),
        "rejected_inverse_models": sorted(rejected_inverse),
        "model_states": model_states,
        "production_effect": bool(inverted),
    }


def _weight_status(model_status: dict, model_name: str) -> str:
    status = str((model_status or {}).get(model_name) or "retired").strip()
    return status if status in _MODEL_STATUS_ALLOWED else "retired"


def _has_observed_ic(merged: dict[str, float], ic_weights: dict) -> bool:
    for name in merged:
        try:
            if abs(float(ic_weights.get(name, 0.0) or 0.0)) > 1e-12:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _cold_start_weight(status: str, degraded_dampening: float) -> float:
    if status in ("retired", "challenger"):
        return 0.0
    if status == "degraded":
        return max(0.0, float(degraded_dampening))
    return 1.0


def _allocator_policy_from_cfg(ev2_cfg: dict | None) -> dict:
    cfg = ev2_cfg or {}
    policy = cfg.get("allocatorPolicy") or cfg.get("modelAllocatorPolicy") or {}
    return policy if isinstance(policy, dict) else {}


def _allocator_learning_policy_from_cfg(ev2_cfg: dict | None) -> dict:
    cfg = ev2_cfg or {}
    policy = (
        cfg.get("allocatorLearningPolicy")
        or cfg.get("modelAllocatorLearningPolicy")
        or cfg.get("learningPolicy")
        or {}
    )
    if isinstance(policy, dict):
        return policy
    allocator_policy = _allocator_policy_from_cfg(cfg)
    nested = allocator_policy.get("learning_weight_policy") if isinstance(allocator_policy, dict) else None
    return nested if isinstance(nested, dict) else {}


def _allocator_policy_approved(policy: dict) -> bool:
    status = str(policy.get("status") or policy.get("approval_status") or "").lower()
    effect = str(policy.get("production_effect") or policy.get("effect") or "").lower()
    approved_level = str(policy.get("approved_level") or policy.get("level") or "").upper()
    return (
        policy.get("approved") is True
        or status in {"approved", "production_approved", "capped_production_approved"}
        or approved_level in {"L3", "L4"}
    ) and effect in {"capped", "capped_production_effect", "capped_production", "true", "1"}


def _allocator_policy_multipliers(policy: dict) -> dict[str, float]:
    raw = (
        policy.get("model_weight_multipliers")
        or policy.get("multipliers")
        or policy.get("modelMultipliers")
        or {}
    )
    return raw if isinstance(raw, dict) else {}


def _allocator_learning_multipliers(policy: dict) -> dict[str, float]:
    raw = (
        policy.get("model_learning_multipliers")
        or policy.get("learning_weight_multipliers")
        or policy.get("modelLearningMultipliers")
        or {}
    )
    return raw if isinstance(raw, dict) else {}


def _apply_allocator_policy(weights: dict[str, float], ev2_cfg: dict | None) -> tuple[dict[str, float], dict]:
    policy = _allocator_policy_from_cfg(ev2_cfg)
    if not policy:
        return weights, {"applied": False, "reason": "missing_allocator_policy"}
    if not _allocator_policy_approved(policy):
        return weights, {"applied": False, "reason": "allocator_policy_not_approved_for_capped_production"}
    try:
        cap = abs(float(policy.get("production_cap", policy.get("model_multiplier_cap", 0.15)) or 0.15))
    except (TypeError, ValueError):
        cap = 0.15
    cap = max(0.0, min(0.15, cap))
    low = 1.0 - cap
    high = 1.0 + cap
    multipliers = _allocator_policy_multipliers(policy)
    adjusted: dict[str, float] = {}
    applied: dict[str, float] = {}
    for name, weight in weights.items():
        try:
            raw_mult = float(multipliers.get(name, 1.0))
        except (TypeError, ValueError):
            raw_mult = 1.0
        mult = max(low, min(high, raw_mult))
        adjusted[name] = max(0.0, float(weight or 0.0) * mult)
        if abs(mult - 1.0) > 1e-12:
            applied[name] = round(mult, 6)
    return adjusted, {
        "applied": bool(applied),
        "effect": "capped_production_effect",
        "cap": cap,
        "multipliers": applied,
        "policy_id": policy.get("policy_id") or policy.get("id"),
        "source": policy.get("source") or "adaptive_params.model_allocator",
    }


def _build_allocator_learning_ledger(
    *,
    merged: dict[str, float],
    model_status: dict,
    ic_weights: dict,
    base_weights: dict[str, float],
    production_weights: dict[str, float],
    allocator_policy_effect: dict,
    ev2_cfg: dict | None,
) -> dict:
    cfg = ev2_cfg or {}
    learning_policy = _allocator_learning_policy_from_cfg(cfg)
    learning_multipliers = _allocator_learning_multipliers(learning_policy)
    try:
        learning_cap = abs(float(learning_policy.get("learning_weight_cap", 0.50) or 0.50))
    except (TypeError, ValueError):
        learning_cap = 0.50
    learning_cap = max(0.0, min(1.0, learning_cap))
    low = 1.0 - learning_cap
    high = 1.0 + learning_cap
    try:
        learning_floor = float(cfg.get("learningWeightFloor", 0.01) or 0.01)
    except (TypeError, ValueError):
        learning_floor = 0.01
    learning_floor = max(0.0, min(0.05, learning_floor))

    models = list(dict.fromkeys([*_FORMAL_ALPHA_MODELS, *merged.keys(), *_DIRECT_ALPHA_BLOCKED_MODELS]))
    states: dict[str, dict] = {}
    applied_learning: dict[str, float] = {}
    for name in models:
        status = _weight_status(model_status, name)
        rank_score = merged.get(name)
        production_weight = max(0.0, float(production_weights.get(name, 0.0) or 0.0))
        base_weight = max(0.0, float(base_weights.get(name, 0.0) or 0.0))
        blocked_direct_alpha = name in _DIRECT_ALPHA_BLOCKED_MODELS
        if blocked_direct_alpha:
            learning_weight = 0.0
            state = "rejected"
            reject_reason = "direct_alpha_blocked_sidecar_only"
        elif production_weight > 0:
            learning_weight = production_weight
            state = "production"
            reject_reason = None
        elif status == "retired":
            learning_weight = 0.0
            state = "rejected"
            reject_reason = "retired_model_status"
        elif rank_score is None:
            learning_weight = 0.0
            state = "rejected"
            reject_reason = "missing_model_evidence"
        else:
            learning_weight = max(learning_floor, base_weight)
            state = "learning_only"
            reject_reason = "no_positive_production_weight"

        try:
            raw_multiplier = float(learning_multipliers.get(name, 1.0))
        except (TypeError, ValueError):
            raw_multiplier = 1.0
        multiplier = max(low, min(high, raw_multiplier))
        if learning_weight > 0 and abs(multiplier - 1.0) > 1e-12:
            learning_weight *= multiplier
            applied_learning[name] = round(multiplier, 6)

        try:
            observed_ic = float(ic_weights.get(name)) if ic_weights.get(name) is not None else None
        except (TypeError, ValueError):
            observed_ic = None

        states[name] = {
            "state": state,
            "model_status": status,
            "production_weight": round(production_weight, 6),
            "learning_weight": round(max(0.0, learning_weight), 6),
            "reject_reason": reject_reason,
            "rank_score": None if rank_score is None else round(float(rank_score), 6),
            "observed_ic": None if observed_ic is None else round(observed_ic, 6),
            "direct_alpha_blocked": blocked_direct_alpha,
        }

    return {
        "schema_version": "model-allocator-learning-ledger-v1",
        "source": "ensemble_v2",
        "scope": "model_allocator_candidate_allocator_exposure_allocator_learning_ledger",
        "model_states": states,
        "production_weight_total": round(sum(row["production_weight"] for row in states.values()), 6),
        "learning_weight_total": round(sum(row["learning_weight"] for row in states.values()), 6),
        "production_policy_effect": allocator_policy_effect,
        "learning_policy_effect": {
            "applied": bool(applied_learning),
            "effect": "learning_weight_only",
            "cap": learning_cap,
            "multipliers": applied_learning,
            "policy_id": learning_policy.get("policy_id") or learning_policy.get("id"),
            "source": learning_policy.get("source") or "adaptive_params.model_allocator.learning_weight_policy",
            "production_effect": False,
        },
        "regime_context": cfg.get("regimeContext") or cfg.get("regime_context") or {},
    }


def attach_ensemble_v2(
    pred: dict,
    model_status: dict,
    ic_weights: dict,
    degraded_dampening: float,
    ev2_cfg: dict | None = None,
) -> None:
    formal_contract = build_formal_model_input_contract(pred)
    pred["formal_layer3_contract"] = formal_contract
    if not formal_contract["complete"]:
        pred["ensemble_v2_error"] = "formal_layer3_contract_incomplete"
        return
    merged = _formal_model_scores(pred)
    if not merged:
        return

    observed_ic_models = set((ev2_cfg or {}).get("observedIcModels") or [])
    merged, base_weights, contrarian_policy_effect = _build_weighted_model_inputs(
        merged=merged,
        model_status=model_status,
        ic_weights=ic_weights,
        degraded_dampening=degraded_dampening,
        ev2_cfg=ev2_cfg,
    )
    weights, allocator_policy_effect = _apply_allocator_policy(base_weights, ev2_cfg)
    allocator_learning_ledger = _build_allocator_learning_ledger(
        merged=merged,
        model_status=model_status,
        ic_weights=ic_weights,
        base_weights=base_weights,
        production_weights=weights,
        allocator_policy_effect=allocator_policy_effect,
        ev2_cfg=ev2_cfg,
    )
    weight_total = sum(weights.values())

    if weight_total <= 0:
        allow_cold_start = bool((ev2_cfg or {}).get("allowColdStartEqualWeight", False))
        if allow_cold_start and not (_has_observed_ic(merged, ic_weights) or (set(merged) & observed_ic_models)):
            weights = {
                name: _cold_start_weight(_weight_status(model_status, name), degraded_dampening)
                for name in merged
            }
            weights, allocator_policy_effect = _apply_allocator_policy(weights, ev2_cfg)
            allocator_learning_ledger = _build_allocator_learning_ledger(
                merged=merged,
                model_status=model_status,
                ic_weights=ic_weights,
                base_weights=base_weights,
                production_weights=weights,
                allocator_policy_effect=allocator_policy_effect,
                ev2_cfg=ev2_cfg,
            )
            weight_total = sum(weights.values())
        if weight_total > 0:
            avg = sum(merged[name] * weights[name] for name in merged) / weight_total
            cfg = ev2_cfg or {}
            sb_th = float(cfg.get("strongBuyThreshold", 0.85))
            b_th = float(cfg.get("buyThreshold", 0.70))
            ss_th = float(cfg.get("strongSellThreshold", 0.15))
            s_th = float(cfg.get("sellThreshold", 0.30))

            if avg >= sb_th:
                label = "STRONG_BUY"
            elif avg >= b_th:
                label = "BUY"
            elif avg <= ss_th:
                label = "STRONG_SELL"
            elif avg <= s_th:
                label = "SELL"
            else:
                label = "HOLD"

            pred["ensemble_v2"] = {
                **_ensemble_lineage_fields(
                    formal_contract=formal_contract,
                    weights=weights,
                    ev2_cfg=ev2_cfg,
                ),
                "avg_rank": round(avg, 4),
                "signal": label,
                "confidence": _rank_confidence(avg),
                "signal_source": "ensemble_v2",
                "contributing_models": sorted([name for name, weight in weights.items() if weight > 0]),
                "weights": {k: round(v, 6) for k, v in weights.items()},
                "weight_total": round(weight_total, 6),
                "reason": "cold_start_equal_weight",
                "weight_formula": "cold_start_equal_weight_until_ic_available",
                "allocator_policy_effect": allocator_policy_effect,
                "allocator_learning_ledger": allocator_learning_ledger,
                "contrarian_policy_effect": contrarian_policy_effect,
                "formal_model_input_contract": formal_contract,
                **_forecast_fields(avg, ev2_cfg),
            }
            return
        pred["ensemble_v2"] = {
            **_ensemble_lineage_fields(
                formal_contract=formal_contract,
                weights=weights,
                ev2_cfg=ev2_cfg,
            ),
            "avg_rank": 0.5,
            "signal": "HOLD",
            "confidence": 0.5,
            "forecast_pct": None,
            "forecast_pct_source": "no_positive_lifecycle_weight",
            "forecast_return_5bar": None,
            "forecast_return_5bar_source": "no_positive_lifecycle_weight",
            "forecast_return_5bar_owner": "ensemble_v2_calibrated_5bar_close_forecast",
            "forecast_horizon_bars": 5,
            "expected_return": None,
            "expected_return_source": "no_positive_lifecycle_weight",
            "expected_return_owner": "s12_trade_ev",
            "trade_expected_return_net_pct": None,
            "trade_expected_return_source": "s12_trade_ev_missing",
            "signal_source": "ensemble_v2",
            "contributing_models": [],
            "weights": {k: round(v, 6) for k, v in weights.items()},
            "weight_total": 0.0,
            "reason": "no_positive_lifecycle_weight",
            "weight_formula": "max(0,shrunk_ic) or approved_contrarian_inverse_edge * status_filter * dampening_if_degraded",
            "allocator_policy_effect": allocator_policy_effect,
            "allocator_learning_ledger": allocator_learning_ledger,
            "contrarian_policy_effect": contrarian_policy_effect,
            "formal_model_input_contract": formal_contract,
        }
        return

    avg = sum(merged[name] * weights[name] for name in merged) / weight_total
    cfg = ev2_cfg or {}
    sb_th = float(cfg.get("strongBuyThreshold", 0.85))
    b_th = float(cfg.get("buyThreshold", 0.70))
    ss_th = float(cfg.get("strongSellThreshold", 0.15))
    s_th = float(cfg.get("sellThreshold", 0.30))

    if avg >= sb_th:
        label = "STRONG_BUY"
    elif avg >= b_th:
        label = "BUY"
    elif avg <= ss_th:
        label = "STRONG_SELL"
    elif avg <= s_th:
        label = "SELL"
    else:
        label = "HOLD"

    pred["ensemble_v2"] = {
        **_ensemble_lineage_fields(
            formal_contract=formal_contract,
            weights=weights,
            ev2_cfg=ev2_cfg,
        ),
        "avg_rank": round(avg, 4),
        "signal": label,
        "confidence": _rank_confidence(avg),
        "signal_source": "ensemble_v2",
        "contributing_models": sorted([name for name, weight in weights.items() if weight > 0]),
        "weights": {k: round(v, 6) for k, v in weights.items()},
        "weight_total": round(weight_total, 6),
        "weight_formula": "max(0,shrunk_ic) or approved_contrarian_inverse_edge * status_filter * dampening_if_degraded * capped_allocator_multiplier",
        "allocator_policy_effect": allocator_policy_effect,
        "allocator_learning_ledger": allocator_learning_ledger,
        "contrarian_policy_effect": contrarian_policy_effect,
        "formal_model_input_contract": formal_contract,
        **_forecast_fields(avg, ev2_cfg),
    }
