"""Research-only stability gate for one fixed PatchTST configuration."""

from __future__ import annotations

import statistics
from typing import Any, Iterable


def evaluate_fixed_config_repeated_seed_gate(
    runs: list[dict[str, Any]],
    by_window: dict[str, dict[str, Any]],
    *,
    baseline_fold_ic: Iterable[float],
) -> dict[str, Any]:
    """Evaluate outer-OOF robustness without mislabelling seeds as PBO trials."""

    baseline_values = [float(value) for value in baseline_fold_ic]
    ordered_windows = [by_window[str(index)] for index in range(len(baseline_values))]
    no_write = all(
        row.get("allowed_use") == "research_only"
        and row.get("production_effect") is False
        and row.get("oof_artifact") is None
        and int(row.get("oos_samples") or 0) > 0
        for row in runs
    )
    all_values = [float(row["oos_ic"]) for row in runs]
    seed_values: dict[str, list[float]] = {}
    for row in runs:
        seed_values.setdefault(str(row["seed"]), []).append(float(row["oos_ic"]))
    per_seed_mean = {seed: statistics.mean(values) for seed, values in seed_values.items()}
    window_means = [float(row["mean_ic"]) for row in ordered_windows]
    tail_values = window_means[-3:]
    overall_mean = statistics.mean(all_values)
    baseline_mean = statistics.mean(baseline_values)
    positive_window_share = sum(value > 0.0 for value in window_means) / max(1, len(window_means))
    tail_positive_share = sum(value > 0.0 for value in tail_values) / max(1, len(tail_values))
    checks = {
        "research_only_no_write": no_write,
        "overall_mean_ic_positive": overall_mean > 0.0,
        "all_seed_means_non_negative": bool(per_seed_mean) and min(per_seed_mean.values()) >= 0.0,
        "positive_window_share_at_least_60pct": positive_window_share >= 0.60,
        "tail_three_mean_ic_positive": statistics.mean(tail_values) > 0.0,
        "tail_three_positive_share_at_least_two_thirds": tail_positive_share >= (2.0 / 3.0),
        "mean_ic_improves_v9": overall_mean > baseline_mean,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "overall_mean_ic": overall_mean,
        "v9_mean_ic": baseline_mean,
        "mean_delta_vs_v9": overall_mean - baseline_mean,
        "positive_window_share": positive_window_share,
        "tail_three_mean_ic": statistics.mean(tail_values),
        "tail_three_positive_share": tail_positive_share,
        "per_seed_mean_ic": per_seed_mean,
        "interpretation": "fixed_config_repeated_seed_outer_oof_not_configuration_selection_pbo",
    }
