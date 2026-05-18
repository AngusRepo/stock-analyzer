from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_upgrade_research_track import (  # noqa: E402
    V4_RESEARCH_CHALLENGER_REGISTRY_VERSION,
    build_v4_research_challenger_manifest,
    route_v4_research_challenger,
    validate_v4_research_challenger_manifest,
)


def test_v4_research_challenger_manifest_covers_requested_algorithm_families():
    manifest = build_v4_research_challenger_manifest("2026-05-16")

    assert set(manifest) == {
        "NEAT",
        "Transformer",
        "ReinforcementLearning",
        "GeneticProgramming",
        "Qlib",
        "OpenFE",
    }
    for name, entry in manifest.items():
        assert entry["track_version"] == V4_RESEARCH_CHALLENGER_REGISTRY_VERSION, name
        assert entry["status"] == "offline_shadow", name
        assert entry["production_effect"] == "none", name
        assert entry["direct_prediction"] is False, name
        assert entry["direct_regime_effect"] is False, name
        assert entry["direct_recommendation_effect"] is False, name
        assert entry["vote_weight"] == 0.0, name
        assert entry["promotion_state"] == "research_benchmark", name
        assert entry["approval_gate"] == "v4_research_promotion_packet_required", name
        assert "walk_forward" in entry["promotion_gates"], name
        assert "no_lookahead" in entry["promotion_gates"], name
        assert validate_v4_research_challenger_manifest(manifest) == []


def test_research_challenger_routes_objective_to_ml_pool_or_regime_track():
    manifest = build_v4_research_challenger_manifest("2026-05-16")

    transformer = route_v4_research_challenger(
        manifest,
        "Transformer",
        objective="single_stock_return_prediction",
    )
    neat_regime = route_v4_research_challenger(
        manifest,
        "NEAT",
        objective="market_regime_detection",
    )
    openfe = route_v4_research_challenger(
        manifest,
        "OpenFE",
        objective="feature_discovery",
    )

    assert transformer["target_track"] == "ml_pool_challenger"
    assert transformer["runtime_mode"] == "offline_shadow"
    assert neat_regime["target_track"] == "regime_challenger"
    assert neat_regime["runtime_mode"] == "offline_shadow"
    assert openfe["target_track"] == "ml_feature_challenger"
    assert openfe["runtime_mode"] == "offline_shadow"


def test_reinforcement_learning_is_research_only_and_cannot_route_to_execution():
    manifest = build_v4_research_challenger_manifest("2026-05-16")

    route = route_v4_research_challenger(
        manifest,
        "ReinforcementLearning",
        objective="execution_policy",
    )

    assert route["target_track"] == "research_benchmark"
    assert route["runtime_mode"] == "offline_shadow"
    assert route["allowed_to_write_orders"] is False
    assert "rl_execution_policy_not_a_v4_execution_owner" in route["blocking_reasons"]


def test_validator_rejects_challengers_with_live_or_recommendation_effects():
    manifest = build_v4_research_challenger_manifest("2026-05-16")
    manifest["Qlib"]["direct_recommendation_effect"] = True
    manifest["Transformer"]["vote_weight"] = 0.25
    manifest["NEAT"]["production_effect"] = "score_modifier"

    errors = validate_v4_research_challenger_manifest(manifest)

    assert "Qlib:direct_recommendation_effect_must_be_false" in errors
    assert "Transformer:vote_weight_must_be_zero" in errors
    assert "NEAT:production_effect_must_be_none" in errors
