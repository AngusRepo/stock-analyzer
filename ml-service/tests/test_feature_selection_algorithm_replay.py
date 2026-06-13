from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_replay_module():
    script = Path(__file__).resolve().parent.parent / "scripts" / "feature_selection_algorithm_replay.py"
    spec = importlib.util.spec_from_file_location("feature_selection_algorithm_replay", script)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_summarize_pipeline_result_extracts_decision_metrics():
    replay = _load_replay_module()

    summary = replay.summarize_pipeline_result(
        {
            "algorithm_profile": "candidate_v2",
            "feature_pool": {"tree_active": ["a", "b"], "reserve": ["c"]},
            "algorithm_evidence": {
                "algorithm_profile": "candidate_v2",
                "k_sweep": {
                    "sampler": "motpe",
                    "objective_mode": "purged_rolling_ic",
                    "best_ic": 0.12,
                },
            },
            "final_oos_audit": {"stable_count": 8, "total": 10, "used_for_selection": False},
            "signal_gate": {"passed": True, "p_value": 0.01},
        },
        elapsed_s=1.23456,
    )

    assert summary["algorithm_profile"] == "candidate_v2"
    assert summary["active_count"] == 2
    assert summary["reserve_count"] == 1
    assert summary["k_sweep"]["objective_mode"] == "purged_rolling_ic"
    assert summary["final_oos_audit"]["stable_count"] == 8
    assert summary["signal_gate"]["passed"] is True


def test_profile_comparison_passes_with_noncomparable_ic_when_oos_not_worse():
    replay = _load_replay_module()
    result = {
        "profiles": {
            "current": {
                "error": None,
                "algorithm_profile": "current",
                "active_count": 100,
                "k_sweep": {"objective_mode": "single_val_ic", "best_k": 100, "best_ic": 0.10},
                "final_oos_audit": {"stable_count": 7, "total": 20},
                "signal_gate": {"passed": True},
            },
            "candidate_v2": {
                "error": None,
                "algorithm_profile": "candidate_v2",
                "active_count": 120,
                "k_sweep": {"objective_mode": "purged_rolling_ic", "best_k": 120, "best_ic": 0.08},
                "final_oos_audit": {"stable_count": 8, "total": 20},
                "signal_gate": {"passed": True},
            },
        }
    }

    comparison = replay.build_profile_comparison(result, max_active_growth_ratio=1.25)

    assert comparison["promotion_ready"] is True
    assert comparison["objective_comparable"] is False
    assert comparison["recommendation"] == "candidate_replay_passed_with_noncomparable_ic"
    assert comparison["deltas"]["final_oos_stable_count"] == 1
    assert comparison["checks"]["active_growth_within_limit"] is True
    assert comparison["missing_evidence"] == []
    assert comparison["caveats"] == [
        "k_sweep_best_ic_objective_differs; use final_oos_audit for promotion gate"
    ]


def test_profile_comparison_fails_on_active_pool_bloat():
    replay = _load_replay_module()
    result = {
        "profiles": {
            "current": {
                "error": None,
                "algorithm_profile": "current",
                "active_count": 100,
                "k_sweep": {"objective_mode": "single_val_ic", "best_k": 100, "best_ic": 0.10},
                "final_oos_audit": {"stable_count": 7, "total": 20},
                "signal_gate": {"passed": True},
            },
            "candidate_v2": {
                "error": None,
                "algorithm_profile": "candidate_v2",
                "active_count": 180,
                "k_sweep": {"objective_mode": "purged_rolling_ic", "best_k": 180, "best_ic": 0.08},
                "final_oos_audit": {"stable_count": 8, "total": 20},
                "signal_gate": {"passed": True},
            },
        }
    }

    comparison = replay.build_profile_comparison(result, max_active_growth_ratio=1.25)

    assert comparison["promotion_ready"] is False
    assert comparison["recommendation"] == "candidate_replay_failed"
    assert comparison["checks"]["active_growth_within_limit"] is False


def test_profile_comparison_blocks_when_evidence_is_incomplete():
    replay = _load_replay_module()
    result = {
        "profiles": {
            "current": {
                "error": None,
                "algorithm_profile": "current",
                "active_count": 100,
                "k_sweep": {"objective_mode": "single_val_ic", "best_k": 100, "best_ic": 0.10},
                "final_oos_audit": {"stable_count": 7, "total": 20},
                "signal_gate": {"passed": True},
            },
            "candidate_v2": {
                "error": None,
                "active_count": 120,
                "k_sweep": {"objective_mode": "purged_rolling_ic", "best_ic": 0.08},
                "final_oos_audit": {"stable_count": 8},
                "signal_gate": {"passed": None},
            },
        }
    }

    comparison = replay.build_profile_comparison(result)

    assert comparison["promotion_ready"] is False
    assert comparison["recommendation"] == "blocked"
    assert comparison["missing_evidence"] == [
        "candidate_profile_matches",
        "candidate_signal_gate_passed",
        "k_sweep_evidence_complete",
        "final_oos_evidence_complete",
    ]
