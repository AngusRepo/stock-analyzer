"""Candidate-scoped release evidence for Active-8 OOF base rankers."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict
from typing import Any

from services.pbo_service import _run_cscv_rank_logit_pbo

COHORT_SELECTION_MAX_PBO = 0.50


def _compound(values: list[float]) -> float:
    equity = 1.0
    for value in values:
        equity *= 1.0 + value
    return equity - 1.0


def build_active8_oof_release_validation(
    prediction_rows: list[dict[str, Any]],
    *,
    eligible_models: list[str],
    cohort_id: str,
    source_manifest_checksum: str,
    top_fraction: float = 0.20,
    partition_count: int = 10,
) -> dict[str, Any]:
    """Build CSCV PBO from same-market OOF rank portfolios.

    DSR and Monte Carlo MDD are deliberately not synthesized here: the target
    is an overlapping five-session rank label, not a realizable capital path.
    Those gates belong to the final allocator/execution portfolio.
    """
    grouped: dict[tuple[str, str, str], list[tuple[float, float]]] = defaultdict(list)
    for row in prediction_rows:
        try:
            rank_score = float(row["rank_score"])
            target_return = float(row["target_return"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(rank_score) or not math.isfinite(target_return):
            continue
        model_name = str(row.get("model_name") or "")
        prediction_date = str(row.get("prediction_date") or "")[:10]
        market_segment = str(row.get("market_segment") or "")
        if model_name and prediction_date and market_segment:
            grouped[(model_name, prediction_date, market_segment)].append(
                (rank_score, target_return)
            )

    segment_returns: dict[tuple[str, str], list[float]] = defaultdict(list)
    for (model_name, prediction_date, _segment), values in grouped.items():
        values.sort(key=lambda item: item[0], reverse=True)
        selected_count = max(1, math.ceil(len(values) * top_fraction))
        selected = values[:selected_count]
        segment_returns[(model_name, prediction_date)].append(
            sum(value for _score, value in selected) / selected_count
        )

    daily_returns: dict[str, dict[str, float]] = defaultdict(dict)
    for (model_name, prediction_date), values in segment_returns.items():
        daily_returns[model_name][prediction_date] = sum(values) / len(values)
    search_models = sorted(daily_returns)
    if len(search_models) < 2:
        raise ValueError("active8_oof_release_pbo_requires_multiple_models")
    common_dates = sorted(
        set.intersection(*(set(daily_returns[name]) for name in search_models))
    )
    partitions = min(max(4, partition_count), len(common_dates))
    if len(common_dates) < 20 or partitions < 4:
        raise ValueError("active8_oof_release_pbo_dates_insufficient")

    returns_by_partition: dict[str, list[float]] = {}
    for model_name in search_models:
        buckets: list[list[float]] = [[] for _ in range(partitions)]
        for index, prediction_date in enumerate(common_dates):
            bucket_index = min(partitions - 1, index * partitions // len(common_dates))
            buckets[bucket_index].append(daily_returns[model_name][prediction_date])
        if any(not values for values in buckets):
            raise ValueError("active8_oof_release_pbo_partition_empty")
        returns_by_partition[model_name] = [_compound(values) for values in buckets]

    pbo = asdict(_run_cscv_rank_logit_pbo(returns_by_partition))
    cohort_decision = (
        "PASS"
        if pbo.get("go_live_verdict") == "PASS"
        and pbo.get("method") == "cscv_rank_logit"
        and float(pbo.get("pbo") or 1.0) <= COHORT_SELECTION_MAX_PBO
        else "FAIL"
    )
    cohort_selection = {
        **pbo,
        "scope": "cohort_model_selection_process",
        "decision": cohort_decision,
        "max_pbo": COHORT_SELECTION_MAX_PBO,
        "policy_version": "active8-cohort-selection-pbo-v1",
        "policy_owner": "active8_oof_cohort_selection",
    }
    by_model: dict[str, dict[str, Any]] = {}
    for model_name in eligible_models:
        if model_name not in daily_returns:
            raise ValueError(f"active8_oof_release_model_missing:{model_name}")
        model_returns = [daily_returns[model_name][date] for date in common_dates]
        by_model[model_name] = {
            "schema_version": "active8-oof-base-ranker-release-validation-v2",
            "validation_role": "base_ranker",
            "decision": cohort_decision,
            "failed_gates": (
                [] if cohort_decision == "PASS" else ["cohort_model_selection_pbo"]
            ),
            "cohort_id": cohort_id,
            "source_manifest_checksum": source_manifest_checksum,
            "target_portfolio": "same-market-top-quintile-five-session-net-return",
            "overlapping_label_policy": {
                "dsr": "owned_by_final_non_overlapping_portfolio",
                "monte_carlo_mdd": "owned_by_final_allocator_execution_path",
            },
            "pbo": dict(cohort_selection),
            "diagnostics": {
                "common_dates": len(common_dates),
                "partition_count": partitions,
                "search_models": search_models,
                "mean_top_quintile_net_return": sum(model_returns) / len(model_returns),
                "positive_date_ratio": sum(value > 0 for value in model_returns) / len(model_returns),
            },
        }
    return {
        "schema_version": "active8-oof-base-ranker-release-validation-bundle-v2",
        "cohort_id": cohort_id,
        "source_manifest_checksum": source_manifest_checksum,
        "cohort_selection_validation": cohort_selection,
        "search_models": search_models,
        "common_dates": len(common_dates),
        "partition_count": partitions,
        "by_model": by_model,
    }
