"""Compatibility helpers for historical namespaced prediction rows."""

from __future__ import annotations

LEGACY_MODEL_CANDIDATE_SUFFIX = "::challenger"
MODEL_NAMESPACE_SEPARATOR = "::"
LEGACY_BATCH_CANDIDATE_RANK_SCORES_KEY = "challenger_rank_scores"
LEGACY_BATCH_CANDIDATE_ERRORS_KEY = "challenger_errors"


def legacy_model_candidate_name(model_name: str) -> str:
    return f"{model_name}{LEGACY_MODEL_CANDIDATE_SUFFIX}"


def is_legacy_model_candidate_name(model_name: str) -> bool:
    return str(model_name or "").endswith(LEGACY_MODEL_CANDIDATE_SUFFIX)


def base_model_name(model_name: str) -> str:
    value = str(model_name or "")
    if is_legacy_model_candidate_name(value):
        return value[: -len(LEGACY_MODEL_CANDIDATE_SUFFIX)]
    return value


def strip_legacy_candidate_prediction_fields(row: dict) -> None:
    row.pop(LEGACY_BATCH_CANDIDATE_RANK_SCORES_KEY, None)
    row.pop(LEGACY_BATCH_CANDIDATE_ERRORS_KEY, None)
