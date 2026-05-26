import asyncio

from routers.research_benchmark import (
    ValidationLadderRequest,
    research_validation_ladder_dry_run,
)


def test_validation_ladder_research_route_is_non_mutating():
    response = asyncio.run(research_validation_ladder_dry_run(
        ValidationLadderRequest(
            candidate_id="alpha-route",
            candidate_type="alpha",
            evidence={
                "backtest": {
                    "mode": "B",
                    "total_trades": 80,
                    "sharpe": 1.0,
                    "profit_factor": 1.3,
                    "max_drawdown": 0.12,
                    "absolute_confidence": "moderate",
                }
            },
        )
    ))

    assert response["decision_effect"] == "validation_ladder_only"
    assert response["decision"]["production_mutation_allowed"] is False
