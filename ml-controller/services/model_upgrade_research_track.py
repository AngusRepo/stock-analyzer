from __future__ import annotations

from copy import deepcopy
from typing import Any


MODEL_UPGRADE_RESEARCH_TRACK_VERSION = "p7-model-upgrade-track-v1"
V4_RESEARCH_CHALLENGER_REGISTRY_VERSION = "v4-research-challenger-registry-v1"

RESEARCH_BENCHMARK_MODELS: dict[str, dict[str, Any]] = {
    "LightGBM": {
        "status": "production_slot_member",
        "model_type": "tree_feature_lightgbm",
        "family": "tree",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "feature_policy", "walk_forward", "pbo", "cost_profile", "positive_ic"],
    },
    "XGBoost": {
        "status": "production_slot_member",
        "model_type": "tree_feature_xgboost",
        "family": "tree",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "feature_policy", "walk_forward", "pbo", "cost_profile", "positive_ic"],
    },
    "ExtraTrees": {
        "status": "production_slot_member",
        "model_type": "tree_feature_extratrees",
        "family": "tree",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "feature_policy", "walk_forward", "pbo", "cost_profile", "positive_ic"],
    },
    "DLinear": {
        "status": "production_slot_member",
        "model_type": "time_series_linear_current",
        "family": "time_series",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "sequence_policy", "walk_forward", "pbo", "cost_profile"],
    },
    "PatchTST": {
        "status": "production_slot_member",
        "model_type": "time_series_neuralforecast_patchtst",
        "family": "time_series",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "sequence_policy", "walk_forward", "pbo", "cost_profile"],
    },
    "TabM": {
        "status": "production_slot_member",
        "model_type": "tabular_deep_learning",
        "family": "tabular",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "feature_policy", "walk_forward", "pbo", "cost_profile", "positive_ic"],
    },
    "GNN": {
        "status": "production_slot_member",
        "model_type": "cross_stock_graphsage",
        "family": "graph",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "graph_spec", "walk_forward", "pbo", "cost_profile", "positive_ic"],
    },
    "iTransformer": {
        "status": "production_slot_member",
        "model_type": "time_series_neuralforecast_itransformer",
        "family": "time_series",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "sequence_policy", "walk_forward", "pbo", "cost_profile"],
    },
    "TimesFM": {
        "status": "production_slot_member",
        "model_type": "foundation_time_series_timesfm25",
        "family": "time_series",
        "direct_prediction": True,
        "vote_weight": 1.0,
        "promotion_state": "model_pool_lifecycle",
        "evidence_required": ["production_artifact", "timesfm_2p5_config", "forecast_validation", "walk_forward", "cost_profile", "positive_ic"],
    },
}

V4_RESEARCH_CHALLENGERS: dict[str, dict[str, Any]] = {
    "NEAT": {
        "algorithm_family": "neuroevolution",
        "default_track": "ml_pool_challenger",
        "allowed_tracks": ["ml_pool_challenger", "regime_challenger"],
        "best_use": "architecture_or_signal_search",
        "primary_risks": ["overfitting", "search_space_leakage", "unstable_seed"],
    },
    "Transformer": {
        "algorithm_family": "sequence_model",
        "default_track": "ml_pool_challenger",
        "allowed_tracks": ["ml_pool_challenger", "regime_challenger"],
        "best_use": "time_series_or_cross_sectional_sequence_benchmark",
        "primary_risks": ["lookahead", "small_sample_overfit", "latency_cost"],
    },
    "ReinforcementLearning": {
        "algorithm_family": "policy_learning",
        "default_track": "research_benchmark",
        "allowed_tracks": ["regime_challenger", "research_benchmark"],
        "best_use": "offline_policy_or_allocation_research",
        "primary_risks": ["simulator_gap", "reward_hacking", "execution_leakage"],
    },
    "GeneticProgramming": {
        "algorithm_family": "symbolic_factor_search",
        "default_track": "ml_feature_challenger",
        "allowed_tracks": ["ml_feature_challenger", "ml_pool_challenger", "regime_challenger"],
        "best_use": "interpretable_factor_or_rule_discovery",
        "primary_risks": ["data_snooping", "complexity_bloat", "multiple_testing"],
    },
    "Qlib": {
        "algorithm_family": "research_platform",
        "default_track": "ml_pool_challenger",
        "allowed_tracks": ["ml_pool_challenger"],
        "best_use": "external_ml_pipeline_benchmark",
        "primary_risks": ["universe_mismatch", "cost_assumption_mismatch", "data_alignment"],
    },
    "OpenFE": {
        "algorithm_family": "automated_feature_engineering",
        "default_track": "ml_feature_challenger",
        "allowed_tracks": ["ml_feature_challenger"],
        "best_use": "feature_discovery_shadow_pool",
        "primary_risks": ["lookahead", "freshness_drift", "feature_explosion"],
    },
}

V4_COMMON_PROMOTION_GATES = [
    "dataset_lineage",
    "schema_freshness",
    "no_lookahead",
    "walk_forward",
    "regime_split",
    "transaction_cost",
    "turnover",
    "shadow_ic",
    "paper_order_ab",
    "human_review",
]

V4_OBJECTIVE_TRACKS = {
    "single_stock_return_prediction": "ml_pool_challenger",
    "cross_sectional_ranking": "ml_pool_challenger",
    "sequence_return_prediction": "ml_pool_challenger",
    "market_regime_detection": "regime_challenger",
    "macro_regime_detection": "regime_challenger",
    "risk_on_off_detection": "regime_challenger",
    "feature_discovery": "ml_feature_challenger",
    "factor_discovery": "ml_feature_challenger",
}


def build_research_benchmark_manifest(created_at: str) -> dict[str, dict[str, Any]]:
    manifest = deepcopy(RESEARCH_BENCHMARK_MODELS)
    for name, entry in manifest.items():
        entry["created_at"] = created_at
        if entry["status"] == "benchmark_only":
            entry["approval_gate"] = "research_review_packet_required"
            entry["note"] = (
                "Benchmark-only candidate; not a model_pool challenger and never votes "
                "until promoted by a separate reviewed lifecycle path."
            )
        else:
            entry["approval_gate"] = "model_pool_lifecycle_required"
            entry["note"] = (
                f"{name} is an active production slot member. It may vote only through "
                "artifact-backed serving, lifecycle IC weighting, and the normal model_pool gates."
            )
        entry["track_version"] = MODEL_UPGRADE_RESEARCH_TRACK_VERSION
    return manifest


def build_v4_research_challenger_manifest(created_at: str) -> dict[str, dict[str, Any]]:
    manifest = deepcopy(V4_RESEARCH_CHALLENGERS)
    for name, entry in manifest.items():
        entry.update({
            "name": name,
            "created_at": created_at,
            "track_version": V4_RESEARCH_CHALLENGER_REGISTRY_VERSION,
            "status": "offline_shadow",
            "runtime_mode": "offline_shadow",
            "production_effect": "none",
            "direct_prediction": False,
            "direct_regime_effect": False,
            "direct_recommendation_effect": False,
            "allowed_to_write_orders": False,
            "vote_weight": 0.0,
            "promotion_state": "research_benchmark",
            "approval_gate": "v4_research_promotion_packet_required",
            "promotion_gates": list(V4_COMMON_PROMOTION_GATES),
            "note": (
                "V4 research challenger only. It can produce offline evidence for "
                "ML-pool, feature, or regime challenger review, but it cannot vote, "
                "modify recommendations, change regime, or write orders before a "
                "separate promotion packet passes."
            ),
        })
    return manifest


def route_v4_research_challenger(
    manifest: dict[str, dict[str, Any]],
    name: str,
    *,
    objective: str,
) -> dict[str, Any]:
    entry = deepcopy(manifest[name])
    target_track = V4_OBJECTIVE_TRACKS.get(objective, entry["default_track"])
    blocking_reasons: list[str] = []

    if name == "ReinforcementLearning" and objective == "execution_policy":
        target_track = "research_benchmark"
        blocking_reasons.append("rl_execution_policy_not_a_v4_execution_owner")
    elif target_track not in set(entry.get("allowed_tracks") or []):
        target_track = entry["default_track"]
        blocking_reasons.append("objective_track_not_allowed_for_algorithm")

    return {
        "name": name,
        "objective": objective,
        "target_track": target_track,
        "runtime_mode": "offline_shadow",
        "status": "offline_shadow",
        "production_effect": "none",
        "allowed_to_write_predictions": False,
        "allowed_to_write_regime": False,
        "allowed_to_write_recommendations": False,
        "allowed_to_write_orders": False,
        "promotion_gate": entry["approval_gate"],
        "blocking_reasons": blocking_reasons,
    }


def validate_v4_research_challenger_manifest(manifest: dict[str, dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    required = set(V4_RESEARCH_CHALLENGERS)
    missing = sorted(required - set(manifest))
    if missing:
        errors.append(f"missing_challengers:{','.join(missing)}")
    for name, entry in manifest.items():
        if entry.get("track_version") != V4_RESEARCH_CHALLENGER_REGISTRY_VERSION:
            errors.append(f"{name}:track_version_invalid")
        if entry.get("status") != "offline_shadow":
            errors.append(f"{name}:status_must_be_offline_shadow")
        if entry.get("production_effect") != "none":
            errors.append(f"{name}:production_effect_must_be_none")
        if entry.get("direct_prediction") is not False:
            errors.append(f"{name}:direct_prediction_must_be_false")
        if entry.get("direct_regime_effect") is not False:
            errors.append(f"{name}:direct_regime_effect_must_be_false")
        if entry.get("direct_recommendation_effect") is not False:
            errors.append(f"{name}:direct_recommendation_effect_must_be_false")
        if entry.get("allowed_to_write_orders") is not False:
            errors.append(f"{name}:allowed_to_write_orders_must_be_false")
        if entry.get("vote_weight") != 0.0:
            errors.append(f"{name}:vote_weight_must_be_zero")
        if entry.get("promotion_state") != "research_benchmark":
            errors.append(f"{name}:promotion_state_must_be_research_benchmark")
        gates = set(entry.get("promotion_gates") or [])
        for gate in ("no_lookahead", "walk_forward", "shadow_ic"):
            if gate not in gates:
                errors.append(f"{name}:promotion_gate_missing:{gate}")
    return errors
