from services.model_upgrade_research_track import (
    MODEL_UPGRADE_RESEARCH_TRACK_VERSION,
    build_research_benchmark_manifest,
)


def test_p7_benchmark_manifest_is_research_only():
    manifest = build_research_benchmark_manifest("2026-05-05")

    assert set(manifest) == {"TabM", "iTransformer", "TimesFM", "Moirai"}
    for name, entry in manifest.items():
        assert entry["status"] == "benchmark_only", name
        assert entry["direct_prediction"] is False, name
        assert entry["vote_weight"] == 0.0, name
        assert entry["promotion_state"] == "not_challenger", name
        assert entry["approval_gate"] == "research_review_packet_required", name
        assert entry["track_version"] == MODEL_UPGRADE_RESEARCH_TRACK_VERSION, name
        assert "walk_forward" in entry["evidence_required"], name
        assert "not a model_pool challenger" in entry["note"], name
