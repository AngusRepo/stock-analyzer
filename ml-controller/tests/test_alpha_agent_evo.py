import asyncio

from services.alpha_agent_evo import build_alpha_agent_evo_trajectory_report
from routers.research_benchmark import AlphaAgentEvoTrajectoryRequest, research_alpha_agent_evo_dry_run


def test_alpha_agent_evo_preserves_self_evolving_lineage_and_next_generation_queue():
    report = build_alpha_agent_evo_trajectory_report(
        candidates=[
            {
                "candidate_id": "alpha-g0-momentum",
                "generation": 0,
                "expression": "rank(return_20d)",
                "operator": "seed",
                "parent_ids": [],
                "metrics": {
                    "walk_forward_sharpe": 1.10,
                    "pbo": 0.18,
                    "reality_check_p": 0.04,
                    "max_drawdown": 0.11,
                    "paper_days": 45,
                },
            },
            {
                "candidate_id": "alpha-g1-momentum-volume",
                "generation": 1,
                "expression": "rank(return_20d) * rank(volume_z20)",
                "operator": "mutate",
                "parent_ids": ["alpha-g0-momentum"],
                "metrics": {
                    "walk_forward_sharpe": 1.44,
                    "pbo": 0.10,
                    "reality_check_p": 0.02,
                    "max_drawdown": 0.08,
                    "paper_days": 64,
                },
            },
        ],
        champion_id="alpha-g0-momentum",
    )

    assert report["schema_version"] == "alpha-agent-evo-trajectory-v1"
    assert report["decision_effect"] == "research_only"
    assert report["production_mutation_allowed"] is False
    child = report["trajectory"][1]
    assert child["parent_ids"] == ["alpha-g0-momentum"]
    assert child["evolution_path"] == ["alpha-g0-momentum", "alpha-g1-momentum-volume"]
    assert child["decision"] == "NEXT_GENERATION"
    assert report["next_generation_queue"] == ["alpha-g1-momentum-volume"]
    assert report["decision"]["eligible_to_replace_baseline"] is True
    assert report["decision"]["accelerated_historical_replacement_allowed"] is True


def test_alpha_agent_evo_fails_closed_without_institutional_validation_evidence():
    report = build_alpha_agent_evo_trajectory_report(
        candidates=[
            {
                "candidate_id": "alpha-g1-overfit",
                "generation": 1,
                "expression": "rank(close / close_252)",
                "operator": "mutate",
                "parent_ids": ["alpha-g0-price"],
                "metrics": {
                    "walk_forward_sharpe": 2.4,
                    "pbo": 0.38,
                    "max_drawdown": 0.42,
                    "paper_days": 10,
                },
            }
        ],
        champion_id="alpha-g0-price",
    )

    node = report["trajectory"][0]
    assert node["decision"] == "REJECT"
    assert "reality_check_missing" in node["blockers"]
    assert "pbo_too_high" in node["blockers"]
    assert "paper_trade_days_insufficient" in node["blockers"]
    assert report["decision"]["eligible_to_replace_baseline"] is False
    assert report["next_generation_queue"] == []


def test_alpha_agent_evo_accepts_historical_replay_instead_of_waiting_for_paper_days():
    report = build_alpha_agent_evo_trajectory_report(
        candidates=[
            {
                "candidate_id": "alpha-g2-history-champion",
                "generation": 2,
                "expression": "rank(return_20d) * rank(obv_temperature_60)",
                "operator": "mutate",
                "parent_ids": ["alpha-g1-volume"],
                "metrics": {
                    "walk_forward_sharpe": 1.32,
                    "pbo": 0.12,
                    "reality_check_p": 0.03,
                    "max_drawdown": 0.09,
                    "paper_days": 0,
                    "historical_replay_days": 180,
                },
            }
        ],
        champion_id="alpha-g2-history-champion",
    )

    node = report["trajectory"][0]
    assert node["blockers"] == []
    assert report["decision"]["eligible_to_replace_baseline"] is True
    assert report["decision"]["accelerated_historical_replacement_allowed"] is True


def test_alpha_agent_evo_report_documents_gap_vs_quantaalpha_gp_openfe_poc():
    report = build_alpha_agent_evo_trajectory_report(candidates=[], champion_id=None)

    gap = report["gap_vs_current_poc"]
    assert gap["quantaalpha_gp_openfe_poc"] == "single_run_candidate_mining"
    assert gap["alpha_agent_evo"] == "lineage_aware_self_evolving_trajectory"
    assert "parent_child_lineage" in gap["required_new_capabilities"]
    assert "validation_gate_per_generation" in gap["required_new_capabilities"]


def test_alpha_agent_evo_research_route_is_non_mutating():
    response = asyncio.run(research_alpha_agent_evo_dry_run(
        AlphaAgentEvoTrajectoryRequest(
            candidates=[],
            champion_id=None,
            dry_run=True,
            mutation_allowed=False,
        )
    ))

    assert response["decision_effect"] == "research_only"
    assert response["production_mutation_allowed"] is False
