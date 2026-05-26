import asyncio

import pytest

from routers.research_benchmark import PortfolioAllocationBenchmarkRequest, research_portfolio_allocation_dry_run
from services.portfolio_allocation import (
    allocate_rank_topk_equal_weight,
    allocate_sparse_tangent,
    build_portfolio_allocation_benchmark,
)


def _candidates():
    return [
        {"symbol": "NOISY", "score": 99.0, "expected_return": 0.015},
        {"symbol": "STEADY", "score": 95.0, "expected_return": 0.012},
        {"symbol": "LOWEDGE", "score": 70.0, "expected_return": 0.004},
    ]


def _return_history():
    return {
        "NOISY": [0.08, -0.10, 0.07, -0.09, 0.06, -0.08, 0.05, -0.07],
        "STEADY": [0.010, 0.011, 0.010, 0.012, 0.011, 0.010, 0.012, 0.011],
        "LOWEDGE": [0.004, 0.005, 0.004, 0.004, 0.005, 0.004, 0.005, 0.004],
    }


def test_sparse_tangent_downweights_high_volatility_rank_winner():
    weights = allocate_sparse_tangent(_candidates(), _return_history(), top_k=2, max_weight=0.70)

    assert set(weights) == {"NOISY", "STEADY"}
    assert sum(weights.values()) == pytest.approx(1.0)
    assert weights["STEADY"] > weights["NOISY"]
    assert max(weights.values()) <= 0.70


def test_portfolio_allocation_benchmark_compares_against_rank_topk_with_metrics():
    baseline = allocate_rank_topk_equal_weight(_candidates(), top_k=2)
    report = build_portfolio_allocation_benchmark(
        candidates=_candidates(),
        return_history=_return_history(),
        top_k=2,
        max_weight=0.70,
        min_sharpe_delta=0.20,
    )

    assert baseline == {"NOISY": 0.5, "STEADY": 0.5}
    assert report["baseline"]["method"] == "rank_topk_equal_weight"
    assert report["challenger"]["method"] == "sparse_tangent_inverse_risk"
    assert report["challenger"]["metrics"]["sharpe"] > report["baseline"]["metrics"]["sharpe"]
    assert report["decision"]["sharpe_delta"] > 0.20
    assert report["decision"]["eligible_to_replace_rank_topk"] is True
    assert report["decision"]["production_mutation_allowed"] is False


def test_portfolio_allocation_research_route_is_non_mutating():
    response = asyncio.run(research_portfolio_allocation_dry_run(
        PortfolioAllocationBenchmarkRequest(
            candidates=_candidates(),
            return_history=_return_history(),
            top_k=2,
            max_weight=0.70,
        )
    ))

    assert response["decision"]["production_mutation_allowed"] is False
    assert response["baseline"]["method"] == "rank_topk_equal_weight"
