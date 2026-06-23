from __future__ import annotations

import math


_SRC_KEY_MODEL = (
    ("dlinear", "DLinear"),
    ("patchtst", "PatchTST"),
    ("itransformer", "iTransformer"),
)
_FORMAL_ALPHA_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)
_DIRECT_ALPHA_BLOCKED_MODELS = {"TimesFM"}
_MODEL_STATUS_ALLOWED = {"active", "degraded", "challenger", "retired"}


def _ts_to_rank(forecast_pct: float, scale: float = 12.0) -> float:
    x = max(-50.0, min(50.0, forecast_pct * scale))
    return 1.0 / (1.0 + math.exp(-x))


def _rank_confidence(avg_rank: float) -> float:
    return round(0.5 + abs(avg_rank - 0.5), 4)


def _calibrated_forecast_pct(avg_rank: float, ev2_cfg: dict | None = None) -> tuple[float | None, str, dict]:
    """Map ensemble rank to expected return only when verified calibration exists."""
    calibration = (ev2_cfg or {}).get("expectedReturnCalibration") or {}
    bins = calibration.get("bins") if isinstance(calibration, dict) else None
    min_samples = int(calibration.get("minSamples", 1) or 1) if isinstance(calibration, dict) else 1
    if isinstance(bins, list):
        for idx, row in enumerate(bins):
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
            upper_ok = avg_rank <= high if idx == len(bins) - 1 or high >= 1.0 else avg_rank < high
            if samples >= min_samples and avg_rank >= low and upper_ok:
                return round(mean_return, 6), "calibrated_rank_bin", {
                    "forecast_calibration_method": calibration.get("method") or "empirical_rank_bins",
                    "forecast_calibration_status": calibration.get("status") or "configured",
                    "forecast_calibration_source": calibration.get("source"),
                    "forecast_calibration_sample_count": calibration.get("sampleCount"),
                    "forecast_calibration_bin_samples": samples,
                    "forecast_calibration_bin": {"rankLow": low, "rankHigh": high},
                }
    return None, "uncalibrated_rank_score", {
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


def _forecast_fields(avg_rank: float, ev2_cfg: dict | None = None) -> dict:
    forecast, source, meta = _calibrated_forecast_pct(avg_rank, ev2_cfg)
    return {
        "forecast_pct": forecast,
        "forecast_pct_source": source,
        **meta,
    }


def _compute_lifecycle_weight(status: str, ic_value: float, degraded_dampening: float) -> float:
    base = max(0.0, float(ic_value or 0.0))
    if status in ("retired", "challenger"):
        return 0.0
    if status == "degraded":
        return base * max(0.0, degraded_dampening)
    return base


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
    feat_ranks = pred.get("rank_scores") or {}
    merged: dict[str, float] = {}
    for name, score in dict(feat_ranks).items():
        model_name = str(name)
        if model_name in _DIRECT_ALPHA_BLOCKED_MODELS:
            continue
        try:
            numeric_score = float(score)
        except (TypeError, ValueError):
            continue
        if math.isfinite(numeric_score):
            merged[model_name] = numeric_score
    for src_key, model_name in _SRC_KEY_MODEL:
        sig = pred.get(src_key) or {}
        if sig.get("forecast_pct") is None:
            continue
        merged[model_name] = _ts_to_rank(float(sig["forecast_pct"]))
    if not merged:
        return

    observed_ic_models = set((ev2_cfg or {}).get("observedIcModels") or [])
    base_weights = {
        name: _compute_lifecycle_weight(
            _weight_status(model_status, name),
            ic_weights.get(name, 0.0),
            degraded_dampening,
        )
        for name in merged
    }
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
                **_forecast_fields(avg, ev2_cfg),
            }
            return
        pred["ensemble_v2"] = {
            "avg_rank": 0.5,
            "signal": "HOLD",
            "confidence": 0.5,
            "forecast_pct": None,
            "forecast_pct_source": "no_positive_lifecycle_weight",
            "signal_source": "ensemble_v2",
            "contributing_models": [],
            "weights": {k: round(v, 6) for k, v in weights.items()},
            "weight_total": 0.0,
            "reason": "no_positive_lifecycle_weight",
            "weight_formula": "max(0,shrunk_ic) * status_filter * dampening_if_degraded",
            "allocator_policy_effect": allocator_policy_effect,
            "allocator_learning_ledger": allocator_learning_ledger,
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
        "avg_rank": round(avg, 4),
        "signal": label,
        "confidence": _rank_confidence(avg),
        "signal_source": "ensemble_v2",
        "contributing_models": sorted([name for name, weight in weights.items() if weight > 0]),
        "weights": {k: round(v, 6) for k, v in weights.items()},
        "weight_total": round(weight_total, 6),
        "weight_formula": "max(0,shrunk_ic) * status_filter * dampening_if_degraded * capped_allocator_multiplier",
        "allocator_policy_effect": allocator_policy_effect,
        "allocator_learning_ledger": allocator_learning_ledger,
        **_forecast_fields(avg, ev2_cfg),
    }
