from __future__ import annotations

import math
from typing import Any


def drop_degenerate_rank_scores(
    rows_by_symbol: dict[str, dict[str, Any]],
    *,
    score_field: str = "rank_scores",
    min_samples: int = 10,
    epsilon: float = 1e-9,
) -> dict[str, dict[str, Any]]:
    """Remove model rank scores that have no cross-sectional variance.

    A model that returns the same rank for the whole slate cannot contribute to
    IC or ranking. Keeping it makes lifecycle metrics look active while adding
    no information to the ensemble.
    """
    values_by_model: dict[str, list[float]] = {}
    for row in rows_by_symbol.values():
        scores = row.get(score_field)
        if not isinstance(scores, dict):
            continue
        for model_name, raw_score in scores.items():
            try:
                score = float(raw_score)
            except (TypeError, ValueError):
                continue
            if math.isfinite(score):
                values_by_model.setdefault(str(model_name), []).append(score)

    dropped: dict[str, dict[str, Any]] = {}
    for model_name, values in values_by_model.items():
        if len(values) < min_samples:
            continue
        lo = min(values)
        hi = max(values)
        if hi - lo > epsilon:
            continue
        dropped[model_name] = {
            "n_samples": len(values),
            "constant_value": round(lo, 8),
            "score_field": score_field,
        }

    if not dropped:
        return {}

    for row in rows_by_symbol.values():
        scores = row.get(score_field)
        if not isinstance(scores, dict):
            continue
        removed = [model_name for model_name in dropped if model_name in scores]
        if not removed:
            continue
        for model_name in removed:
            scores.pop(model_name, None)
        errors = row.get("model_errors")
        if not isinstance(errors, list):
            errors = [] if errors is None else [str(errors)]
        errors.extend(
            f"{model_name}: dropped degenerate constant {score_field}"
            for model_name in removed
        )
        row["model_errors"] = errors

    return dropped
