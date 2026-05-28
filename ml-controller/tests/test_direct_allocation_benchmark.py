import asyncio

from routers.research_benchmark import (
    DirectAllocationBenchmarkRequest,
    research_direct_allocation_benchmark_dry_run,
)
from services.direct_allocation_benchmark import build_direct_allocation_benchmark


def _returns_by_date():
    return {
        "2026-05-01": {"A": 0.020, "B": 0.005},
        "2026-05-02": {"A": 0.018, "B": 0.004},
        "2026-05-03": {"A": -0.030, "B": 0.010},
        "2026-05-04": {"A": -0.028, "B": 0.009},
        "2026-05-05": {"A": 0.020, "B": 0.005},
        "2026-05-06": {"A": 0.018, "B": 0.004},
        "2026-05-07": {"A": -0.030, "B": 0.010},
        "2026-05-08": {"A": -0.028, "B": 0.009},
    }


def _predict_then_optimize_weights():
    return {
        date: {"A": 0.50, "B": 0.50}
        for date in _returns_by_date()
    }


def _signature_transformer_weights():
    return {
        "2026-05-01": {"A": 0.80, "B": 0.20},
        "2026-05-02": {"A": 0.80, "B": 0.20},
        "2026-05-03": {"A": 0.20, "B": 0.80},
        "2026-05-04": {"A": 0.20, "B": 0.80},
        "2026-05-05": {"A": 0.80, "B": 0.20},
        "2026-05-06": {"A": 0.80, "B": 0.20},
        "2026-05-07": {"A": 0.20, "B": 0.80},
        "2026-05-08": {"A": 0.20, "B": 0.80},
    }


def test_direct_allocation_benchmark_compares_signature_transformer_against_predict_then_optimize():
    report = build_direct_allocation_benchmark(
        returns_by_date=_returns_by_date(),
        baseline_weights_by_date=_predict_then_optimize_weights(),
        candidate_weights_by_date=_signature_transformer_weights(),
        min_sharpe_delta=1.0,
        max_mdd_delta=0.02,
        max_turnover_delta=0.70,
    )

    assert report["schema_version"] == "direct-allocation-benchmark-v1"
    assert report["baseline"]["method"] == "predict_then_optimize"
    assert report["challenger"]["method"] == "signature_informed_transformer_direct_allocation"
    assert report["challenger"]["metrics"]["sharpe"] > report["baseline"]["metrics"]["sharpe"]
    assert report["decision"]["sharpe_delta"] >= 1.0
    assert report["decision"]["eligible_to_replace_predict_then_optimize"] is True
    assert report["decision"]["accelerated_historical_replacement_allowed"] is True
    assert report["decision"]["historical_replay_days"] == 8
    assert report["decision"]["production_mutation_allowed"] is False


def test_direct_allocation_benchmark_blocks_leaky_weight_metadata():
    report = build_direct_allocation_benchmark(
        returns_by_date=_returns_by_date(),
        baseline_weights_by_date=_predict_then_optimize_weights(),
        candidate_weights_by_date=_signature_transformer_weights(),
        candidate_metadata_by_date={
            "2026-05-03": {
                "as_of_date": "2026-05-04",
                "feature_end_date": "2026-05-04",
            }
        },
    )

    assert report["status"] == "blocked"
    assert "future_leakage_detected" in report["blockers"]
    assert report["decision"]["eligible_to_replace_predict_then_optimize"] is False


def test_direct_allocation_benchmark_research_route_is_non_mutating():
    response = asyncio.run(research_direct_allocation_benchmark_dry_run(
        DirectAllocationBenchmarkRequest(
            returns_by_date=_returns_by_date(),
            baseline_weights_by_date=_predict_then_optimize_weights(),
            candidate_weights_by_date=_signature_transformer_weights(),
        )
    ))

    assert response["decision_effect"] == "benchmark_gate_only"
    assert response["decision"]["production_mutation_allowed"] is False
