from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

from services.active_model_policy import (
    ACTIVE_ALPHA_MODELS,
    CORE_CROSS_SECTIONAL_ALPHA_MODELS,
    OPTIONAL_SEQUENCE_ALPHA_MODELS,
)
from services.ev_lineage_contract import build_model_set_signature, is_known_artifact_version


MODEL_SCORE_SEMANTIC_VERSION = "active8-daily-market-cross-sectional-percentile-v1"
MODEL_TARGET_SEMANTIC_VERSION = "next-session-open-to-fifth-session-close-v2"
MODEL_SCORE_LINEAGE_SCHEMA_VERSION = "active8-model-score-lineage-v2"

_SEQUENCE_SOURCE_KEYS = {
    "DLinear": "dlinear",
    "PatchTST": "patchtst",
    "iTransformer": "itransformer",
}


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _market_segment(prediction: dict[str, Any]) -> str | None:
    meta = prediction.get("stock_meta") if isinstance(prediction.get("stock_meta"), dict) else {}
    value = str(meta.get("market_segment") or meta.get("market") or "").strip().upper()
    if value in {"TWSE", "TSE", "LISTED"}:
        return "LISTED"
    if value in {"TPEX", "OTC"}:
        return "OTC"
    if value in {"ESB", "EMERGING"}:
        return "EMERGING"
    return None


def _raw_model_score(prediction: dict[str, Any], model_name: str) -> float | None:
    source_key = _SEQUENCE_SOURCE_KEYS.get(model_name)
    if source_key:
        signal = prediction.get(source_key) if isinstance(prediction.get(source_key), dict) else {}
        return _finite(signal.get("forecast_pct"))
    scores = prediction.get("rank_scores") if isinstance(prediction.get("rank_scores"), dict) else {}
    return _finite(scores.get(model_name))


def _percentile_by_average_rank(values: list[tuple[str, float]]) -> dict[str, float]:
    ordered = sorted(values, key=lambda row: (row[1], row[0]))
    count = len(ordered)
    if count < 2:
        return {}
    out: dict[str, float] = {}
    index = 0
    while index < count:
        end = index + 1
        while end < count and ordered[end][1] == ordered[index][1]:
            end += 1
        average_zero_based_rank = ((index + end - 1) / 2.0)
        percentile = average_zero_based_rank / (count - 1)
        for symbol, _ in ordered[index:end]:
            out[symbol] = percentile
        index = end
    return out


def normalize_active8_cross_sectional_scores(
    predictions: dict[str, dict[str, Any]],
    *,
    artifact_versions: dict[str, str],
    artifact_target_semantics: dict[str, str],
    run_date: str,
    min_cross_section: int = 3,
) -> dict[str, Any]:
    """Replace incomparable model outputs with same-run market percentiles.

    Sequence forecasts remain raw forecasts in their model payloads. This
    function only creates the rank used by the ensemble and records enough
    lineage to reproduce that transform.
    """
    raw_by_group: dict[tuple[str, str], list[tuple[str, float]]] = defaultdict(list)
    raw_by_symbol: dict[str, dict[str, float]] = defaultdict(dict)
    for symbol, prediction in predictions.items():
        segment = _market_segment(prediction)
        if not segment:
            continue
        for model_name in ACTIVE_ALPHA_MODELS:
            raw = _raw_model_score(prediction, model_name)
            if raw is None:
                continue
            raw_by_group[(segment, model_name)].append((symbol, raw))
            raw_by_symbol[symbol][model_name] = raw

    ranks_by_symbol: dict[str, dict[str, float]] = defaultdict(dict)
    group_sizes: dict[tuple[str, str], int] = {}
    for key, values in raw_by_group.items():
        group_sizes[key] = len(values)
        if len(values) < min_cross_section:
            continue
        for symbol, rank in _percentile_by_average_rank(values).items():
            ranks_by_symbol[symbol][key[1]] = rank

    complete = 0
    blockers: dict[str, int] = defaultdict(int)
    normalized_versions = {
        model_name: str(artifact_versions.get(model_name) or "").strip()
        for model_name in ACTIVE_ALPHA_MODELS
        if is_known_artifact_version(artifact_versions.get(model_name))
    }
    normalized_target_semantics = {
        model_name: str(artifact_target_semantics.get(model_name) or "").strip()
        for model_name in ACTIVE_ALPHA_MODELS
    }
    for symbol, prediction in predictions.items():
        segment = _market_segment(prediction)
        ranks = ranks_by_symbol.get(symbol, {})
        prediction["raw_model_scores"] = dict(raw_by_symbol.get(symbol, {}))
        prediction["rank_scores"] = dict(ranks)
        available_models = [name for name in ACTIVE_ALPHA_MODELS if name in ranks]
        missing_scores = [name for name in ACTIVE_ALPHA_MODELS if name not in ranks]
        missing_core_scores = [name for name in CORE_CROSS_SECTIONAL_ALPHA_MODELS if name not in ranks]
        optional_missing_models = [name for name in OPTIONAL_SEQUENCE_ALPHA_MODELS if name not in ranks]
        missing_versions = [name for name in available_models if name not in normalized_versions]
        invalid_target_semantics = [
            name
            for name in available_models
            if normalized_target_semantics.get(name) != MODEL_TARGET_SEMANTIC_VERSION
        ]
        row_blockers = [f"rank_missing:{name}" for name in missing_core_scores]
        row_blockers.extend(f"artifact_version_missing:{name}" for name in missing_versions)
        row_blockers.extend(
            f"artifact_target_semantic_mismatch:{name}:{normalized_target_semantics.get(name) or 'missing'}"
            for name in invalid_target_semantics
        )
        if not segment:
            row_blockers.append("market_segment_missing")
        signature = build_model_set_signature(normalized_versions, available_models)
        if signature is None:
            row_blockers.append("model_set_signature_unresolvable")
        for blocker in row_blockers:
            blockers[blocker] += 1
        if not row_blockers:
            complete += 1
        prediction["model_score_lineage"] = {
            "schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
            "semantic_version": MODEL_SCORE_SEMANTIC_VERSION,
            "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
            "run_date": run_date,
            "market_segment": segment,
            "transform": "average_tie_percentile_(rank-1)/(n-1)",
            "minimum_cross_section": min_cross_section,
            "cross_section_sizes": {
                name: group_sizes.get((segment, name), 0) if segment else 0
                for name in ACTIVE_ALPHA_MODELS
            },
            "artifact_versions": {
                name: normalized_versions[name]
                for name in available_models
                if name in normalized_versions
            },
            "artifact_target_semantics": {
                name: normalized_target_semantics.get(name)
                for name in available_models
            },
            "available_models": available_models,
            "model_availability": {
                name: name in available_models
                for name in ACTIVE_ALPHA_MODELS
            },
            "required_core_models": list(CORE_CROSS_SECTIONAL_ALPHA_MODELS),
            "optional_sequence_models": list(OPTIONAL_SEQUENCE_ALPHA_MODELS),
            "optional_missing_models": optional_missing_models,
            "full_active8_coverage": not missing_scores,
            "coverage_policy": "core5-required_sequence-missingness-aware-oof-parity-v1",
            "model_set_signature": signature,
            "raw_scores": dict(raw_by_symbol.get(symbol, {})),
            "complete": not row_blockers,
            "blockers": row_blockers,
        }

    return {
        "schema_version": "active8-cross-sectional-normalization-summary-v1",
        "semantic_version": MODEL_SCORE_SEMANTIC_VERSION,
        "symbols": len(predictions),
        "complete_symbols": complete,
        "blocked_symbols": len(predictions) - complete,
        "blockers": dict(sorted(blockers.items())),
    }
