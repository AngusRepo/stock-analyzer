from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.patchtst_research_gate import evaluate_fixed_config_repeated_seed_gate  # noqa: E402


def _run(window_id: int, seed: int, ic: float) -> dict:
    return {
        "window_id": window_id,
        "seed": seed,
        "oos_ic": ic,
        "oos_samples": 100,
        "allowed_use": "research_only",
        "production_effect": False,
        "oof_artifact": None,
    }


def test_fixed_config_gate_requires_cross_window_and_cross_seed_stability():
    means = [0.01, -0.01, 0.02, 0.03, 0.04]
    runs = [_run(window_id, seed, value) for window_id, value in enumerate(means) for seed in (42, 314, 2718)]
    by_window = {str(index): {"mean_ic": value} for index, value in enumerate(means)}

    receipt = evaluate_fixed_config_repeated_seed_gate(
        runs,
        by_window,
        baseline_fold_ic=(-0.01, -0.02, -0.03, -0.01, -0.01),
    )

    assert receipt["passed"] is True
    assert receipt["positive_window_share"] == 0.8
    assert receipt["interpretation"].endswith("not_configuration_selection_pbo")


def test_repeated_seed_gate_fails_when_any_seed_is_negative_on_average():
    runs = []
    for window_id in range(5):
        runs.extend((_run(window_id, 42, 0.03), _run(window_id, 314, 0.02), _run(window_id, 2718, -0.08)))
    by_window = {str(index): {"mean_ic": -0.01} for index in range(5)}

    receipt = evaluate_fixed_config_repeated_seed_gate(
        runs,
        by_window,
        baseline_fold_ic=(-0.10,) * 5,
    )

    assert receipt["passed"] is False
    assert receipt["checks"]["all_seed_means_non_negative"] is False
