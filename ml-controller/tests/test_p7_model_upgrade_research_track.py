import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_upgrade_research_track import (
    MODEL_UPGRADE_RESEARCH_TRACK_VERSION,
    build_research_benchmark_manifest,
)


def test_p7_benchmark_manifest_separates_production_slots_from_benchmarks():
    manifest = build_research_benchmark_manifest("2026-05-05")

    assert set(manifest) == {
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "DLinear",
        "PatchTST",
        "TabM",
        "GNN",
        "iTransformer",
        "TimesFM",
        "TimesFM25",
    }

    for name in ("LightGBM", "XGBoost", "ExtraTrees", "DLinear", "PatchTST", "TabM", "GNN", "iTransformer", "TimesFM"):
        entry = manifest[name]
        assert entry["status"] == "production_slot_member", name
        assert entry["direct_prediction"] is True, name
        assert entry["vote_weight"] == 1.0, name
        assert entry["promotion_state"] == "model_pool_lifecycle", name
        assert entry["approval_gate"] == "model_pool_lifecycle_required", name
        assert entry["track_version"] == MODEL_UPGRADE_RESEARCH_TRACK_VERSION, name
        assert "production_artifact" in entry["evidence_required"], name
        assert "active production slot member" in entry["note"], name

    for name in ("TimesFM25",):
        entry = manifest[name]
        assert entry["status"] == "benchmark_only", name
        assert entry["direct_prediction"] is False, name
        assert entry["vote_weight"] == 0.0, name
        assert entry["promotion_state"] == "not_challenger", name
        assert entry["approval_gate"] == "research_review_packet_required", name
        assert entry["track_version"] == MODEL_UPGRADE_RESEARCH_TRACK_VERSION, name
        assert "walk_forward" in entry["evidence_required"], name
        assert "not a model_pool challenger" in entry["note"], name
