import asyncio

from routers.research_benchmark import (
    AlphaAgentEvoEvolutionRunRequest,
    research_alpha_agent_evo_evolve_dry_run,
)
from services.alpha_agent_evo_runtime import run_alpha_agent_evo_evolution


def _synthetic_rows():
    returns_by_date = {
        "2026-05-01": {"AAA": 0.030, "BBB": 0.004, "CCC": -0.020, "DDD": -0.010},
        "2026-05-04": {"AAA": 0.025, "BBB": 0.006, "CCC": -0.018, "DDD": -0.006},
        "2026-05-05": {"AAA": 0.020, "BBB": 0.002, "CCC": -0.010, "DDD": -0.004},
        "2026-05-06": {"AAA": 0.018, "BBB": 0.005, "CCC": -0.012, "DDD": -0.002},
        "2026-05-07": {"AAA": 0.022, "BBB": 0.003, "CCC": -0.016, "DDD": -0.008},
    }
    rows = []
    for date, returns in returns_by_date.items():
        for symbol, realized_return in returns.items():
            ml_edge = {"AAA": 24, "BBB": 16, "CCC": 2, "DDD": 6}[symbol]
            score = {"AAA": 45, "BBB": 65, "CCC": 80, "DDD": 55}[symbol]
            rows.append({
                "date": date,
                "symbol": symbol,
                "score": score,
                "confidence": 0.72,
                "realized_return": realized_return,
                "score_components": {
                    "version": "score_v2",
                    "finalScore": score,
                    "components": {
                        "mlEdge": ml_edge,
                        "chipFlow": {"AAA": 12, "BBB": 14, "CCC": 20, "DDD": 8}[symbol],
                        "technicalStructure": {"AAA": 18, "BBB": 14, "CCC": 10, "DDD": 6}[symbol],
                        "fundamentalQuality": 10,
                        "newsTheme": 1,
                    },
                },
            })
    return rows


def test_alpha_agent_evo_runtime_builds_multi_turn_self_evolving_trajectory():
    report = run_alpha_agent_evo_evolution(
        recommendation_rows=_synthetic_rows(),
        seed_expressions=[
            {
                "candidate_id": "seed-score-v2",
                "expression": "score_v2",
                "terms": [{"feature": "score_v2", "weight": 1.0}],
            }
        ],
        feature_catalog=["ml_edge", "chip_flow", "technical_structure"],
        generations=3,
        offspring_per_parent=4,
        survivors_per_generation=2,
        top_k=1,
        min_evaluation_days=4,
        min_sharpe_delta=0.1,
        max_mdd_delta=0.02,
    )

    assert report["schema_version"] == "alpha-agent-evo-runtime-v1"
    assert report["decision_effect"] == "research_evidence"
    assert report["baseline"]["candidate_id"] == "seed-score-v2"
    assert report["champion"]["candidate_id"] != "seed-score-v2"
    assert report["champion"]["generation"] >= 1
    assert report["decision"]["eligible_to_replace_baseline"] is True
    assert report["decision"]["production_mutation_allowed"] is False
    assert len(report["trajectory"]) >= 3
    assert all(turn["offspring"] for turn in report["trajectory"][1:])
    assert report["replay_buffer"]["size"] >= 3
    assert report["policy_state"]["operator_weights"]["add_feature"] > 1.0
    assert "ml_edge" in report["champion"]["expression"]


def test_alpha_agent_evo_runtime_fails_closed_when_champion_does_not_beat_baseline():
    rows = _synthetic_rows()
    report = run_alpha_agent_evo_evolution(
        recommendation_rows=rows,
        seed_expressions=[
            {
                "candidate_id": "seed-ml-edge",
                "expression": "ml_edge",
                "terms": [{"feature": "ml_edge", "weight": 1.0}],
            }
        ],
        feature_catalog=["score_v2", "chip_flow"],
        generations=2,
        offspring_per_parent=3,
        top_k=1,
        min_evaluation_days=4,
        min_sharpe_delta=0.1,
        max_mdd_delta=0.02,
    )

    assert report["baseline"]["candidate_id"] == "seed-ml-edge"
    assert report["decision"]["eligible_to_replace_baseline"] is False
    assert "champion_does_not_improve_sharpe" in report["decision"]["blockers"]
    assert report["decision"]["production_mutation_allowed"] is False


def test_alpha_agent_evo_runtime_route_is_non_mutating():
    response = asyncio.run(research_alpha_agent_evo_evolve_dry_run(
        AlphaAgentEvoEvolutionRunRequest(
            recommendation_rows=_synthetic_rows(),
            seed_expressions=[
                {
                    "candidate_id": "seed-score-v2",
                    "expression": "score_v2",
                    "terms": [{"feature": "score_v2", "weight": 1.0}],
                }
            ],
            feature_catalog=["ml_edge", "chip_flow"],
            generations=2,
            offspring_per_parent=3,
            top_k=1,
            dry_run=True,
            mutation_allowed=False,
        )
    ))

    assert response["schema_version"] == "alpha-agent-evo-runtime-v1"
    assert response["decision"]["production_mutation_allowed"] is False
