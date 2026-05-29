from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_upgrade_research_track import (
    MODEL_UPGRADE_RESEARCH_TRACK_VERSION,
    build_research_benchmark_manifest,
)


def test_p7_manifest_tracks_formal_layer3_slots_without_voting():
    manifest = build_research_benchmark_manifest("2026-05-05")

    assert set(manifest) == {"TabM", "GNN", "iTransformer", "TimesFM"}
    for name, entry in manifest.items():
        assert entry["status"] == "formal_slot_pending_artifact", name
        assert entry["direct_prediction"] is False, name
        assert entry["vote_weight"] == 0.0, name
        assert entry["promotion_state"] == "artifact_required", name
        assert entry["approval_gate"] == "artifact_review_packet_required", name
        assert entry["track_version"] == MODEL_UPGRADE_RESEARCH_TRACK_VERSION, name
        assert "walk_forward" in entry["evidence_required"], name
        assert "Formal Layer 3 slot" in entry["note"], name
