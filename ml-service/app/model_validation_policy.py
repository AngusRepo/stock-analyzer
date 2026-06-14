"""Adaptive validation policy resolver for Modal model evidence."""

from __future__ import annotations

import math
import json
import os
from typing import Any


MODEL_VALIDATION_POLICY_VERSION = "family-regime-adaptive-validation-policy-v1"

MODEL_FAMILY_BY_NAME: dict[str, str] = {
    "LightGBM": "tree",
    "XGBoost": "tree",
    "ExtraTrees": "tree",
    "TabM": "tabular_neural",
    "GNN": "graph",
    "DLinear": "learned_sequence",
    "PatchTST": "learned_sequence",
    "iTransformer": "learned_sequence",
    "TimesFM": "foundation_sequence",
}


def _as_int(value: Any, default: int | None = None) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _as_float(value: Any, default: float | None = None) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def model_family_for(model_name: str, family: str | None = None) -> str:
    if family:
        normalized = family.lower()
        if normalized in {"time_series", "time_series_linear_current", "time_series_transformer_neuralforecast"}:
            return "learned_sequence"
        if normalized in {"foundation_time_series", "foundation_time_series_timesfm25"}:
            return "foundation_sequence"
        if normalized in {"tabular", "tabular_deep_learning", "tabular_deep"}:
            return "tabular_neural"
        if normalized in {"tree", "tree_feature_lightgbm", "tree_feature_xgboost", "tree_feature_extratrees"}:
            return "tree"
        if normalized in {"gnn", "graph", "cross_stock_graphsage"}:
            return "graph"
        return normalized
    return MODEL_FAMILY_BY_NAME.get(model_name, "unknown")


def _normalize_regime(regime: Any) -> str:
    text = str(regime or "unknown").strip().lower()
    if "vol" in text:
        return "volatile"
    if "bear" in text or "risk_off" in text:
        return "bear"
    if "bull" in text or "risk_on" in text:
        return "bull"
    if "side" in text or "range" in text:
        return "sideways"
    return text if text in {"bull", "bear", "volatile", "sideways", "unknown"} else "unknown"


def _stage_name(stage: str | None) -> str:
    text = str(stage or "lifecycle").strip().lower()
    if text in {"research", "research_benchmark", "benchmark", "model_upgrade"}:
        return "research_benchmark"
    if text in {"promotion", "final_promotion", "champion_promotion"}:
        return "promotion"
    return text or "lifecycle"


def _risk(regime: str) -> float:
    return {"bull": 0.95, "sideways": 1.0, "unknown": 1.08, "bear": 1.15, "volatile": 1.25}.get(regime, 1.08)


def _min_rows(family: str, stage: str, sample_count: int | None) -> int:
    if stage == "research_benchmark":
        base = {"tree": 40, "tabular_neural": 40, "graph": 30, "learned_sequence": 30, "foundation_sequence": 30}.get(family, 40)
    else:
        base = {"tree": 100, "tabular_neural": 100, "graph": 60, "learned_sequence": 90, "foundation_sequence": 30}.get(family, 80)
    if not sample_count:
        return base
    return max(20, min(base, int(math.sqrt(max(1, sample_count)) * 1.5)))


def _coverage(family: str, stage: str, coverage_mode: str | None) -> dict[str, Any]:
    mode = str(coverage_mode or "").strip().lower()
    if family == "foundation_sequence":
        if mode in {"sample_complete", "sampled", "sampled_benchmark"} or stage == "research_benchmark":
            return {"mode": "sample_complete", "min_coverage": 0.80, "dataset_coverage_required": False}
        return {"mode": "forecast_outcome", "min_coverage": 0.60, "dataset_coverage_required": False}
    if family == "graph":
        return {"mode": "graph_snapshot", "min_coverage": 0.70, "node_coverage_required": True, "edge_coverage_required": True}
    if family == "learned_sequence":
        return {"mode": "sequence_window", "min_coverage": 0.75 if stage == "research_benchmark" else 0.80}
    return {"mode": "date_symbol_panel", "min_coverage": 0.75 if stage == "research_benchmark" else 0.80}


def _deep_merge(base: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(overrides, dict):
        return base
    merged = dict(base)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _nested_get(source: dict[str, Any], first: str, second: str) -> Any:
    value = source.get(first)
    if isinstance(value, dict):
        return value.get(second)
    return None


def _policy_override_layers(
    *,
    model_name: str,
    family: str,
    regime: str,
    stage: str,
) -> dict[str, Any] | None:
    raw = os.getenv("MODEL_VALIDATION_POLICY_OVERRIDES_JSON")
    path = os.getenv("MODEL_VALIDATION_POLICY_OVERRIDES_PATH")
    if path and not raw:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except OSError:
            raw = None
    if not raw:
        return None
    try:
        config = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(config, dict):
        return None
    merged: dict[str, Any] = {}
    for layer in (
        config.get("global"),
        _nested_get(config, "families", family),
        _nested_get(config, "models", model_name),
        _nested_get(config, "stages", stage),
        _nested_get(config, "regimes", regime),
    ):
        if isinstance(layer, dict):
            merged = _deep_merge(merged, layer)
    return merged or None


def resolve_model_validation_policy(
    *,
    model_name: str,
    family: str | None = None,
    regime: Any = None,
    stage: str | None = None,
    sample_count: int | None = None,
    fold_count: int | None = None,
    search_trials: int | None = None,
    coverage_mode: str | None = None,
    baseline_oos_ic: Any = None,
    champion_oos_ic: Any = None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_family = model_family_for(model_name, family)
    resolved_regime = _normalize_regime(regime)
    resolved_stage = _stage_name(stage)
    samples = _as_int(sample_count, None)
    folds = _as_int(fold_count, None)
    risk = _risk(resolved_regime)
    coverage = _coverage(resolved_family, resolved_stage, coverage_mode)
    min_folds = 1 if resolved_family == "foundation_sequence" and resolved_stage != "research_benchmark" else 3 if resolved_stage == "research_benchmark" or (samples and samples < 300) else 5
    min_positive = _clamp(0.55 + (0.03 if resolved_regime in {"bear", "volatile"} else 0.0), 0.50, 0.70)
    if folds and folds <= 3:
        min_positive = min(min_positive, 0.55)
    max_ic_std = _clamp({"tree": 0.22, "tabular_neural": 0.24, "graph": 0.28, "learned_sequence": 0.26, "foundation_sequence": 0.30}.get(resolved_family, 0.25) * risk, 0.18, 0.40)
    reference_values = [v for v in (_as_float(baseline_oos_ic), _as_float(champion_oos_ic)) if v is not None]
    reference = max(reference_values) if reference_values else 0.0
    min_ic = reference if resolved_stage == "promotion" and reference > 0 else 0.0
    buffer = round({"tree": 0.012, "tabular_neural": 0.014, "graph": 0.016, "learned_sequence": 0.014, "foundation_sequence": 0.010}.get(resolved_family, 0.012) * risk, 6)
    trials = max(1, int(search_trials or 1))
    pbo_required = not (resolved_family == "foundation_sequence" and trials <= 1)
    max_pbo = None
    if pbo_required:
        max_pbo = round(_clamp(0.50 - (0.08 if resolved_stage == "promotion" else 0.0) - min(0.22, math.log2(max(2, trials)) * 0.035) - (0.03 if resolved_regime in {"bear", "volatile"} else 0.0), 0.20, 0.50), 6)
    policy = {
        "schema_version": "model-validation-policy-v1",
        "policy_version": MODEL_VALIDATION_POLICY_VERSION,
        "source": "adaptive_formula",
        "model_name": model_name,
        "family": resolved_family,
        "regime": resolved_regime,
        "stage": resolved_stage,
        "coverage": coverage,
        "cpcv": {
            "owner": "foundation_forecast_validation" if resolved_family == "foundation_sequence" and resolved_stage != "research_benchmark" else "family_specific_cpcv",
            "min_folds": min_folds,
            "min_test_rows": _min_rows(resolved_family, resolved_stage, samples),
            "min_oos_ic_mean": round(min_ic, 6),
            "min_positive_fold_ratio": round(min_positive, 6),
            "max_oos_ic_std": round(max_ic_std, 6),
            "min_coverage": coverage["min_coverage"],
            "coverage_mode": coverage["mode"],
            "regime": resolved_regime,
            "family": resolved_family,
            "policy_version": MODEL_VALIDATION_POLICY_VERSION,
        },
        "pbo": {
            "required": pbo_required,
            "method": "cscv_rank_logit" if pbo_required else "not_required_for_single_official_config",
            "max_pbo": max_pbo,
            "search_trials": trials,
            "regime": resolved_regime,
        },
        "oos_ic": {
            "min_oos_ic_mean": round(min_ic, 6),
            "weak_oos_ic_mean": round(min_ic + buffer, 6),
            "strong_oos_ic_mean": round(min_ic + buffer * 2.0, 6),
            "evidence_buffer": buffer,
        },
    }
    env_overrides = _policy_override_layers(
        model_name=model_name,
        family=resolved_family,
        regime=resolved_regime,
        stage=resolved_stage,
    )
    if env_overrides:
        policy = _deep_merge(policy, env_overrides)
        policy["source"] = "adaptive_formula+external_override"
    return _deep_merge(policy, overrides)
