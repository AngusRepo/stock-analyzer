from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_sector_flow_shadow import (  # noqa: E402
    build_finlab_sector_flow_shadow_manifest,
    validate_finlab_sector_flow_shadow_manifest,
)


def test_runtime_sector_flow_shadow_manifest_uses_feature_lake_taxonomy_contract():
    feature_lake = json.loads((ROOT / "data" / "finlab_research" / "feature_lake_manifest.json").read_text(encoding="utf-8"))

    manifest = build_finlab_sector_flow_shadow_manifest(
        feature_lake,
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert manifest["source_feature_lake_checksum"] == feature_lake["checksum"]
    assert manifest["summary"]["layer_count"] == 4
    assert manifest["summary"]["taxonomy_sidecar_fields"] == 1
    assert manifest["summary"]["chip_sidecar_fields"] == 53
    assert validate_finlab_sector_flow_shadow_manifest(manifest) == []
