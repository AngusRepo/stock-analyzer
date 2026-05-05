from __future__ import annotations

from copy import deepcopy
from typing import Any


MODEL_UPGRADE_RESEARCH_TRACK_VERSION = "p7-model-upgrade-track-v1"

RESEARCH_BENCHMARK_MODELS: dict[str, dict[str, Any]] = {
    "TabM": {
        "status": "benchmark_only",
        "model_type": "tabular_deep_learning",
        "family": "tabular",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "not_challenger",
        "evidence_required": ["feature_policy", "walk_forward", "pbo", "cost_profile"],
    },
    "iTransformer": {
        "status": "benchmark_only",
        "model_type": "time_series_transformer",
        "family": "time_series",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "not_challenger",
        "evidence_required": ["sequence_policy", "walk_forward", "pbo", "cost_profile"],
    },
    "TimesFM": {
        "status": "benchmark_only",
        "model_type": "foundation_time_series",
        "family": "time_series",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "not_challenger",
        "evidence_required": ["forecast_validation", "walk_forward", "cost_profile"],
    },
    "Moirai": {
        "status": "benchmark_only",
        "model_type": "foundation_time_series",
        "family": "time_series",
        "direct_prediction": False,
        "vote_weight": 0.0,
        "promotion_state": "not_challenger",
        "evidence_required": ["forecast_validation", "walk_forward", "cost_profile"],
    },
}


def build_research_benchmark_manifest(created_at: str) -> dict[str, dict[str, Any]]:
    manifest = deepcopy(RESEARCH_BENCHMARK_MODELS)
    for entry in manifest.values():
        entry["created_at"] = created_at
        entry["approval_gate"] = "research_review_packet_required"
        entry["note"] = (
            "Benchmark-only candidate; not a model_pool challenger and never votes "
            "until promoted by a separate reviewed lifecycle path."
        )
        entry["track_version"] = MODEL_UPGRADE_RESEARCH_TRACK_VERSION
    return manifest
