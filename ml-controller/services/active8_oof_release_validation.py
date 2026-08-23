"""Release and cohort-selection evidence for Active-8 OOF base rankers."""

from __future__ import annotations

import math
from collections import defaultdict
from itertools import combinations
from typing import Any

COHORT_SELECTION_MAX_PBO = 0.50
LABEL_HORIZON_SESSIONS = 5
ACTIVE8_OOF_RELEASE_VALIDATION_SCHEMA_VERSION = (
    "active8-oof-base-ranker-release-validation-v3"
)
ACTIVE8_OOF_RELEASE_VALIDATION_BUNDLE_SCHEMA_VERSION = (
    "active8-oof-base-ranker-release-validation-bundle-v3"
)
COHORT_SELECTION_METHOD = "label_interval_purged_cscv_rank_logit"
COHORT_SELECTION_POLICY_VERSION = "active8-cohort-selection-pbo-v2"


def _rank_percentile(score: float, all_scores: list[float]) -> float:
    ordered = sorted(float(value) for value in all_scores)
    ranks = [index + 1 for index, value in enumerate(ordered) if value == float(score)]
    return (sum(ranks) / len(ranks)) / (len(ordered) + 1)


def _contiguous_ranges(indices: set[int]) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for index in sorted(indices):
        if not ranges or index > ranges[-1][1] + 1:
            ranges.append((index, index))
        else:
            ranges[-1] = (ranges[-1][0], index)
    return ranges


def _label_intervals_overlap(left: int, right: int, *, horizon: int) -> bool:
    left_start, left_end = left + 1, left + horizon
    right_start, right_end = right + 1, right + horizon
    return left_start <= right_end and right_start <= left_end


def _purged_train_indices(
    train_indices: set[int],
    test_indices: set[int],
    *,
    horizon: int,
) -> tuple[list[int], int, int]:
    purged = {
        train_index
        for train_index in train_indices
        if any(
            _label_intervals_overlap(train_index, test_index, horizon=horizon)
            for test_index in test_indices
        )
    }
    embargoed: set[int] = set()
    for _start, end in _contiguous_ranges(test_indices):
        embargoed.update(
            index
            for index in range(end + 1, end + horizon + 1)
            if index in train_indices
        )
    valid = sorted(train_indices - purged - embargoed)
    return valid, len(purged), len(embargoed)


def _run_label_aware_selection_pbo(
    spreads_by_model: dict[str, dict[str, float]],
    *,
    common_dates: list[str],
    partition_count: int,
    label_horizon_sessions: int,
) -> dict[str, Any]:
    date_count = len(common_dates)
    partition_by_index = {
        index: min(partition_count - 1, index * partition_count // date_count)
        for index in range(date_count)
    }
    partition_indices = list(range(partition_count))
    half = partition_count // 2
    selected_is_spreads: list[float] = []
    selected_oos_spreads: list[float] = []
    rank_percentiles: list[float] = []
    logit_values: list[float] = []
    selected_model_counts: dict[str, int] = defaultdict(int)
    purged_total = 0
    embargoed_total = 0
    skipped_combinations = 0
    identifiable_combinations = 0

    for train_partitions in combinations(partition_indices, half):
        train_partition_set = set(train_partitions)
        train_indices = {
            index
            for index, partition in partition_by_index.items()
            if partition in train_partition_set
        }
        test_indices = set(range(date_count)) - train_indices
        valid_train, purged_count, embargoed_count = _purged_train_indices(
            train_indices,
            test_indices,
            horizon=label_horizon_sessions,
        )
        purged_total += purged_count
        embargoed_total += embargoed_count
        if not valid_train or not test_indices:
            skipped_combinations += 1
            continue

        is_scores = {
            model_name: sum(
                spreads_by_model[model_name][common_dates[index]]
                for index in valid_train
            )
            / len(valid_train)
            for model_name in spreads_by_model
        }
        oos_scores = {
            model_name: sum(
                spreads_by_model[model_name][common_dates[index]]
                for index in test_indices
            )
            / len(test_indices)
            for model_name in spreads_by_model
        }
        if max(oos_scores.values()) - min(oos_scores.values()) > 1e-12:
            identifiable_combinations += 1
        selected_model = max(is_scores, key=lambda name: (is_scores[name], name))
        percentile = _rank_percentile(
            oos_scores[selected_model],
            list(oos_scores.values()),
        )
        bounded_percentile = min(max(percentile, 1e-12), 1.0 - 1e-12)
        selected_model_counts[selected_model] += 1
        selected_is_spreads.append(is_scores[selected_model])
        selected_oos_spreads.append(oos_scores[selected_model])
        rank_percentiles.append(percentile)
        logit_values.append(math.log(bounded_percentile / (1.0 - bounded_percentile)))

    if not logit_values:
        raise ValueError("active8_oof_release_pbo_no_valid_purged_combinations")
    pbo = sum(value < 0.0 for value in logit_values) / len(logit_values)
    oos_mean = sum(selected_oos_spreads) / len(selected_oos_spreads)
    is_mean = sum(selected_is_spreads) / len(selected_is_spreads)
    identifiability_ratio = identifiable_combinations / len(logit_values)
    passed = (
        pbo < COHORT_SELECTION_MAX_PBO
        and oos_mean > 0.0
        and identifiability_ratio >= 0.75
    )
    return {
        "method": COHORT_SELECTION_METHOD,
        "n_partitions": partition_count,
        "n_combinations": len(logit_values),
        "n_dates": date_count,
        "pbo": pbo,
        "n_oos_rank_below_median": sum(value < 0.0 for value in logit_values),
        "oos_mean_spread": oos_mean,
        "is_mean_spread": is_mean,
        "degradation": is_mean - oos_mean,
        "go_live_verdict": "PASS" if passed else "FAIL",
        "verdict_reason": (
            "PBO, selected OOS top-minus-bottom spread, and candidate identifiability passed"
            if passed
            else "PBO exceeds policy, OOS spread is non-positive, or candidate ranks are not identifiable"
        ),
        "label_interval": "[prediction_session+1,prediction_session+5]",
        "purge_horizon_sessions": label_horizon_sessions,
        "embargo_horizon_sessions": label_horizon_sessions,
        "purged_train_observations": purged_total,
        "embargoed_train_observations": embargoed_total,
        "skipped_combinations": skipped_combinations,
        "identifiable_combinations": identifiable_combinations,
        "selection_identifiability_ratio": identifiability_ratio,
        "selected_model_counts": dict(sorted(selected_model_counts.items())),
        "oos_rank_percentiles": rank_percentiles,
        "logit_values": logit_values,
    }


def build_active8_oof_release_validation(
    prediction_rows: list[dict[str, Any]],
    *,
    eligible_models: list[str],
    cohort_id: str,
    source_manifest_checksum: str,
    top_fraction: float = 0.20,
    partition_count: int = 10,
) -> dict[str, Any]:
    """Build base-artifact evidence plus label-aware cohort selection PBO.

    Individual outer-purged OOF owns base-artifact legality. This packet only
    governs automatic champion selection and ensemble weighting. DSR and Monte
    Carlo MDD remain owned by the final allocator/execution portfolio.
    """
    eligible_set = set(eligible_models)
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
        if model_name in eligible_set and prediction_date and market_segment:
            grouped[(model_name, prediction_date, market_segment)].append(
                (rank_score, target_return)
            )

    segment_spreads: dict[tuple[str, str], list[float]] = defaultdict(list)
    for (model_name, prediction_date, _segment), values in grouped.items():
        values.sort(key=lambda item: item[0], reverse=True)
        selected_count = max(1, math.ceil(len(values) * top_fraction))
        if len(values) < selected_count * 2:
            continue
        top = values[:selected_count]
        bottom = values[-selected_count:]
        top_mean = sum(value for _score, value in top) / selected_count
        bottom_mean = sum(value for _score, value in bottom) / selected_count
        segment_spreads[(model_name, prediction_date)].append(top_mean - bottom_mean)

    daily_spreads: dict[str, dict[str, float]] = defaultdict(dict)
    for (model_name, prediction_date), values in segment_spreads.items():
        daily_spreads[model_name][prediction_date] = sum(values) / len(values)
    missing_models = [name for name in eligible_models if name not in daily_spreads]
    if missing_models:
        raise ValueError(f"active8_oof_release_model_missing:{','.join(missing_models)}")
    search_models = sorted(eligible_models)
    if len(search_models) < 2:
        raise ValueError("active8_oof_release_pbo_requires_multiple_models")
    common_dates = sorted(
        set.intersection(*(set(daily_spreads[name]) for name in search_models))
    )
    partitions = min(max(4, partition_count), len(common_dates))
    if len(common_dates) < 20 or partitions < 4:
        raise ValueError("active8_oof_release_pbo_dates_insufficient")

    pbo = _run_label_aware_selection_pbo(
        {name: daily_spreads[name] for name in search_models},
        common_dates=common_dates,
        partition_count=partitions,
        label_horizon_sessions=LABEL_HORIZON_SESSIONS,
    )
    cohort_decision = "PASS" if pbo["go_live_verdict"] == "PASS" else "FAIL"
    cohort_selection = {
        **pbo,
        "scope": "cohort_model_selection_process",
        "decision": cohort_decision,
        "failed_gates": (
            [] if cohort_decision == "PASS" else ["cohort_model_selection_pbo"]
        ),
        "max_pbo": COHORT_SELECTION_MAX_PBO,
        "target_portfolio": "same-market-top-minus-bottom-five-session-oof-spread",
        "effect": "automatic_champion_selection_and_ensemble_weighting_only",
        "policy_version": COHORT_SELECTION_POLICY_VERSION,
        "policy_owner": "active8_oof_cohort_selection",
    }
    by_model: dict[str, dict[str, Any]] = {}
    for model_name in eligible_models:
        model_spreads = [daily_spreads[model_name][date] for date in common_dates]
        by_model[model_name] = {
            "schema_version": ACTIVE8_OOF_RELEASE_VALIDATION_SCHEMA_VERSION,
            "validation_role": "base_ranker",
            "decision": "PASS",
            "failed_gates": [],
            "base_artifact_authority": {
                "decision": "PASS",
                "owner": "individual_outer_purged_oof",
                "effect": "base_artifact_release_only",
            },
            "selection_authority": dict(cohort_selection),
            "cohort_id": cohort_id,
            "source_manifest_checksum": source_manifest_checksum,
            "target_portfolio": "same-market-top-minus-bottom-five-session-oof-spread",
            "overlapping_label_policy": {
                "selection_pbo": "label_interval_purge_and_five_session_embargo",
                "dsr": "owned_by_final_non_overlapping_portfolio",
                "monte_carlo_mdd": "owned_by_final_allocator_execution_path",
            },
            "pbo": dict(cohort_selection),
            "diagnostics": {
                "common_dates": len(common_dates),
                "partition_count": partitions,
                "search_models": search_models,
                "mean_top_minus_bottom_oof_spread": sum(model_spreads) / len(model_spreads),
                "positive_spread_date_ratio": (
                    sum(value > 0 for value in model_spreads) / len(model_spreads)
                ),
            },
        }
    return {
        "schema_version": ACTIVE8_OOF_RELEASE_VALIDATION_BUNDLE_SCHEMA_VERSION,
        "cohort_id": cohort_id,
        "source_manifest_checksum": source_manifest_checksum,
        "cohort_selection_validation": cohort_selection,
        "search_models": search_models,
        "common_dates": len(common_dates),
        "partition_count": partitions,
        "by_model": by_model,
    }
