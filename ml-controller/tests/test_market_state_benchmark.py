import asyncio

import pytest

from routers.research_benchmark import (
    MarketStateBenchmarkRequest,
    research_market_state_benchmark_dry_run,
)
from services.market_state_benchmark import build_market_state_benchmark_report


def _realized_labels():
    return [
        {"label_date": "2026-05-01", "realized_label": "bull"},
        {"label_date": "2026-05-02", "realized_label": "bull"},
        {"label_date": "2026-05-03", "realized_label": "volatile"},
        {"label_date": "2026-05-04", "realized_label": "volatile"},
        {"label_date": "2026-05-05", "realized_label": "bear"},
        {"label_date": "2026-05-06", "realized_label": "bear"},
    ]


def _baseline_regime_rows():
    return [
        {"as_of_date": "2026-05-01", "label_date": "2026-05-01", "regime_label": "bull"},
        {"as_of_date": "2026-05-02", "label_date": "2026-05-02", "regime_label": "bull"},
        {"as_of_date": "2026-05-03", "label_date": "2026-05-03", "regime_label": "bull"},
        {"as_of_date": "2026-05-04", "label_date": "2026-05-04", "regime_label": "volatile"},
        {"as_of_date": "2026-05-05", "label_date": "2026-05-05", "regime_label": "bear"},
        {"as_of_date": "2026-05-06", "label_date": "2026-05-06", "regime_label": "sideways"},
    ]


def _jepa_state_rows():
    return [
        {
            "as_of_date": "2026-05-01",
            "feature_end_date": "2026-05-01",
            "label_date": "2026-05-01",
            "latent_state": "state_0",
            "state_label": "bull",
            "probabilities": {"bull": 0.82, "volatile": 0.08, "bear": 0.03, "sideways": 0.07},
        },
        {
            "as_of_date": "2026-05-02",
            "feature_end_date": "2026-05-02",
            "label_date": "2026-05-02",
            "latent_state": "state_0",
            "state_label": "bull",
            "probabilities": {"bull": 0.79, "volatile": 0.10, "bear": 0.04, "sideways": 0.07},
        },
        {
            "as_of_date": "2026-05-03",
            "feature_end_date": "2026-05-03",
            "label_date": "2026-05-03",
            "latent_state": "state_2",
            "state_label": "volatile",
            "probabilities": {"bull": 0.12, "volatile": 0.71, "bear": 0.10, "sideways": 0.07},
        },
        {
            "as_of_date": "2026-05-04",
            "feature_end_date": "2026-05-04",
            "label_date": "2026-05-04",
            "latent_state": "state_2",
            "state_label": "volatile",
            "probabilities": {"bull": 0.08, "volatile": 0.78, "bear": 0.09, "sideways": 0.05},
        },
        {
            "as_of_date": "2026-05-05",
            "feature_end_date": "2026-05-05",
            "label_date": "2026-05-05",
            "latent_state": "state_3",
            "state_label": "bear",
            "probabilities": {"bull": 0.05, "volatile": 0.12, "bear": 0.74, "sideways": 0.09},
        },
        {
            "as_of_date": "2026-05-06",
            "feature_end_date": "2026-05-06",
            "label_date": "2026-05-06",
            "latent_state": "state_3",
            "state_label": "bear",
            "probabilities": {"bull": 0.04, "volatile": 0.10, "bear": 0.80, "sideways": 0.06},
        },
    ]


def test_jepa_market_state_benchmark_requires_measured_improvement_before_fusion():
    report = build_market_state_benchmark_report(
        current_regime_rows=_baseline_regime_rows(),
        candidate_state_rows=_jepa_state_rows(),
        realized_rows=_realized_labels(),
        min_accuracy_delta=0.20,
        min_transition_recall_delta=0.10,
    )

    assert report["schema_version"] == "market-state-benchmark-v1"
    assert report["baseline"]["method"] == "current_market_regime_state"
    assert report["challenger"]["method"] == "jepa_latent_market_state"
    assert report["baseline"]["metrics"]["accuracy"] == pytest.approx(4 / 6)
    assert report["challenger"]["metrics"]["accuracy"] == pytest.approx(1.0)
    assert report["decision"]["accuracy_delta"] == pytest.approx(1 / 3)
    assert report["decision"]["transition_recall_delta"] > 0
    assert report["decision"]["eligible_to_fuse"] is True
    assert report["decision"]["production_mutation_allowed"] is False


def test_jepa_market_state_benchmark_blocks_future_leakage():
    leaky = _jepa_state_rows()
    leaky[2] = {
        **leaky[2],
        "as_of_date": "2026-05-04",
        "feature_end_date": "2026-05-04",
        "label_date": "2026-05-03",
    }

    report = build_market_state_benchmark_report(
        current_regime_rows=_baseline_regime_rows(),
        candidate_state_rows=leaky,
        realized_rows=_realized_labels(),
    )

    assert report["status"] == "blocked"
    assert "future_leakage_detected" in report["blockers"]
    assert report["decision"]["eligible_to_fuse"] is False


def test_market_state_benchmark_research_route_is_non_mutating():
    response = asyncio.run(research_market_state_benchmark_dry_run(
        MarketStateBenchmarkRequest(
            current_regime_rows=_baseline_regime_rows(),
            candidate_state_rows=_jepa_state_rows(),
            realized_rows=_realized_labels(),
        )
    ))

    assert response["decision_effect"] == "benchmark_gate_only"
    assert response["decision"]["production_mutation_allowed"] is False
