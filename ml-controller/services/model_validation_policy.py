"""Adaptive validation policy resolver for active-9 model evidence gates."""

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

_RESEARCH_STAGE_NAMES = {"research", "research_benchmark", "benchmark", "model_upgrade"}
_PROMOTION_STAGE_NAMES = {"promotion", "final_promotion", "champion_promotion"}
_KNOWN_REGIMES = {"bull", "bear", "volatile", "sideways", "unknown"}


def _as_float(value: Any, default: float | None = None) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _as_int(value: Any, default: int | None = None) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


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
    return text if text in _KNOWN_REGIMES else "unknown"


def _stage_name(stage: str | None) -> str:
    text = str(stage or "lifecycle").strip().lower()
    if text in _RESEARCH_STAGE_NAMES:
        return "research_benchmark"
    if text in _PROMOTION_STAGE_NAMES:
        return "promotion"
    return text or "lifecycle"


def _regime_risk_multiplier(regime: str) -> float:
    return {
        "bull": 0.95,
        "sideways": 1.00,
        "unknown": 1.08,
        "bear": 1.15,
        "volatile": 1.25,
    }.get(regime, 1.08)


def _family_min_rows(family: str, stage: str, sample_count: int | None) -> int:
    if stage == "research_benchmark":
        base = {
            "tree": 40,
            "tabular_neural": 40,
            "graph": 30,
            "learned_sequence": 30,
            "foundation_sequence": 30,
        }.get(family, 40)
    else:
        base = {
            "tree": 100,
            "tabular_neural": 100,
            "graph": 60,
            "learned_sequence": 90,
            "foundation_sequence": 30,
        }.get(family, 80)
    if not sample_count:
        return base
    sample_scaled = max(20, int(math.sqrt(max(1, sample_count)) * 1.5))
    return max(20, min(base, sample_scaled))


def _family_min_folds(family: str, stage: str, sample_count: int | None) -> int:
    if family == "foundation_sequence" and stage != "research_benchmark":
        return 1
    if stage == "research_benchmark":
        return 3
    if sample_count and sample_count < 300:
        return 3
    return 5


def _coverage_policy(family: str, stage: str, coverage_mode: str | None) -> dict[str, Any]:
    mode = str(coverage_mode or "").strip().lower()
    if family == "foundation_sequence":
        if mode in {"sample_complete", "sampled", "sampled_benchmark"} or stage == "research_benchmark":
            return {
                "mode": "sample_complete",
                "min_coverage": 0.80,
                "dataset_coverage_required": False,
                "dataset_coverage_metric": "informational",
            }
        return {
            "mode": "forecast_outcome",
            "min_coverage": 0.60,
            "dataset_coverage_required": False,
            "dataset_coverage_metric": "informational",
        }
    if family == "graph":
        return {
            "mode": "graph_snapshot",
            "min_coverage": 0.70,
            "node_coverage_required": True,
            "edge_coverage_required": True,
        }
    if family == "learned_sequence":
        return {
            "mode": "sequence_window",
            "min_coverage": 0.75 if stage == "research_benchmark" else 0.80,
            "dataset_coverage_required": False,
        }
    return {
        "mode": "date_symbol_panel",
        "min_coverage": 0.75 if stage == "research_benchmark" else 0.80,
        "date_coverage_required": True,
        "symbol_coverage_required": True,
    }


def _resolve_oos_ic_floor(
    *,
    family: str,
    regime: str,
    baseline_oos_ic: Any,
    champion_oos_ic: Any,
    stage: str,
) -> dict[str, Any]:
    baseline = _as_float(baseline_oos_ic)
    champion = _as_float(champion_oos_ic)
    reference_values = [value for value in (baseline, champion) if value is not None]
    reference = max(reference_values) if reference_values else 0.0
    risk = _regime_risk_multiplier(regime)
    family_buffer = {
        "tree": 0.012,
        "tabular_neural": 0.014,
        "graph": 0.016,
        "learned_sequence": 0.014,
        "foundation_sequence": 0.010,
    }.get(family, 0.012)
    evidence_buffer = round(family_buffer * risk, 6)
    if stage == "promotion" and reference > 0:
        min_oos_ic = reference
        comparison = "candidate_must_match_or_beat_current_reference"
    else:
        min_oos_ic = 0.0
        comparison = "positive_rank_ic_floor"
    if family == "foundation_sequence":
        comparison = "forecast_validation_rank_ic_floor" if reference <= 0 else comparison
    return {
        "comparison": comparison,
        "min_oos_ic_mean": round(min_oos_ic, 6),
        "weak_oos_ic_mean": round(min_oos_ic + evidence_buffer, 6),
        "strong_oos_ic_mean": round(min_oos_ic + evidence_buffer * 2.0, 6),
        "evidence_buffer": evidence_buffer,
        "baseline_oos_ic": baseline,
        "champion_oos_ic": champion,
        "regime": regime,
    }


def _resolve_live_ic_policy(
    *,
    family: str,
    regime: str,
    sample_count: int | None,
    stage: str,
) -> dict[str, Any]:
    risk = _regime_risk_multiplier(regime)
    base_samples = 80 if stage == "research_benchmark" else 150
    if family == "foundation_sequence":
        base_samples = 50 if stage == "research_benchmark" else 120
    elif family == "graph":
        base_samples = 100 if stage == "research_benchmark" else 180
    min_samples = int(math.ceil(base_samples * risk))
    ready = bool(sample_count and sample_count >= min_samples)
    return {
        "mode": "rolling_verified_rank_ic",
        "min_verified_rows": min_samples,
        "observed_rows": sample_count,
        "ready": ready,
        "windows": ["20d", "60d"],
        "regime": regime,
        "family": family,
    }


def _resolve_pbo_policy(
    *,
    family: str,
    regime: str,
    stage: str,
    search_trials: int | None,
) -> dict[str, Any]:
    trials = max(1, int(search_trials or 1))
    selection_run = trials > 1
    if family == "foundation_sequence" and not selection_run:
        return {
            "required": False,
            "reason": "single_config_foundation_forecast_validated_by_forecast_outcome_evidence",
            "method": "not_required_for_single_official_config",
            "max_pbo": None,
            "search_trials": trials,
        }
    stage_penalty = 0.08 if stage == "promotion" else 0.0
    search_penalty = min(0.22, math.log2(max(2, trials)) * 0.035)
    regime_penalty = 0.03 if regime in {"bear", "volatile"} else 0.0
    max_pbo = _clamp(0.50 - stage_penalty - search_penalty - regime_penalty, 0.20, 0.50)
    return {
        "required": True,
        "method": "cscv_rank_logit",
        "max_pbo": round(max_pbo, 6),
        "search_trials": trials,
        "selection_run": selection_run,
        "regime": regime,
    }


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


def _nested_get(source: dict[str, Any], first: str, second: str) -> Any:
    value = source.get(first)
    if isinstance(value, dict):
        return value.get(second)
    return None


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
    """Resolve dynamic model validation policy without hard-coding callsite gates.

    The returned values are adaptive defaults. Production can override any
    subtree from D1/GCS by passing ``overrides`` while preserving the same schema.
    """

    resolved_family = model_family_for(model_name, family)
    resolved_regime = _normalize_regime(regime)
    resolved_stage = _stage_name(stage)
    samples = _as_int(sample_count, None)
    folds = _as_int(fold_count, None)
    risk = _regime_risk_multiplier(resolved_regime)
    coverage = _coverage_policy(resolved_family, resolved_stage, coverage_mode)
    min_folds = _family_min_folds(resolved_family, resolved_stage, samples)
    min_rows = _family_min_rows(resolved_family, resolved_stage, samples)
    min_positive = _clamp(
        0.55 + (0.03 if resolved_regime in {"bear", "volatile"} else 0.0),
        0.50,
        0.70,
    )
    if folds and folds <= 3:
        min_positive = min(min_positive, 0.55)
    max_ic_std = _clamp(
        {
            "tree": 0.22,
            "tabular_neural": 0.24,
            "graph": 0.28,
            "learned_sequence": 0.26,
            "foundation_sequence": 0.30,
        }.get(resolved_family, 0.25)
        * risk,
        0.18,
        0.40,
    )
    oos_ic = _resolve_oos_ic_floor(
        family=resolved_family,
        regime=resolved_regime,
        baseline_oos_ic=baseline_oos_ic,
        champion_oos_ic=champion_oos_ic,
        stage=resolved_stage,
    )
    policy = {
        "schema_version": "model-validation-policy-v1",
        "policy_version": MODEL_VALIDATION_POLICY_VERSION,
        "source": "adaptive_formula",
        "model_name": model_name,
        "family": resolved_family,
        "regime": resolved_regime,
        "stage": resolved_stage,
        "sample_count": samples,
        "fold_count": folds,
        "coverage": coverage,
        "cpcv": {
            "owner": (
                "foundation_forecast_validation"
                if resolved_family == "foundation_sequence" and resolved_stage != "research_benchmark"
                else "family_specific_cpcv"
            ),
            "min_folds": min_folds,
            "min_test_rows": min_rows,
            "min_oos_ic_mean": oos_ic["min_oos_ic_mean"],
            "min_positive_fold_ratio": round(min_positive, 6),
            "max_oos_ic_std": round(max_ic_std, 6),
            "min_coverage": coverage["min_coverage"],
            "coverage_mode": coverage["mode"],
            "regime": resolved_regime,
            "family": resolved_family,
            "policy_version": MODEL_VALIDATION_POLICY_VERSION,
        },
        "pbo": _resolve_pbo_policy(
            family=resolved_family,
            regime=resolved_regime,
            stage=resolved_stage,
            search_trials=search_trials,
        ),
        "oos_ic": oos_ic,
        "live_ic": _resolve_live_ic_policy(
            family=resolved_family,
            regime=resolved_regime,
            sample_count=samples,
            stage=resolved_stage,
        ),
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
