from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))
sys.path.insert(0, str(ROOT / "ml-service"))

from app.features import FEATURE_COLS, FEATURE_SCHEMA  # noqa: E402
from services.finlab_feature_lake import (  # noqa: E402
    build_finlab_feature_lake_manifest,
    validate_finlab_feature_lake_manifest,
)


def test_runtime_feature_lake_manifest_preserves_current_feature_cols():
    adoption_plan = json.loads((ROOT / "data" / "finlab_research" / "adoption_plan.json").read_text(encoding="utf-8"))
    definitions_payload = json.loads((ROOT / "data" / "finlab_research" / "dagster_definitions_payload.json").read_text(encoding="utf-8"))

    manifest = build_finlab_feature_lake_manifest(
        adoption_plan,
        definitions_payload,
        canonical_features=FEATURE_COLS,
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert FEATURE_SCHEMA == "formal137"
    assert len(FEATURE_COLS) == 137
    assert manifest["summary"]["sidecar_family_count"] == 15
    assert manifest["canonical_feature_contract"]["feature_count"] == 137
    assert manifest["canonical_feature_contract"]["features"] == FEATURE_COLS
    assert validate_finlab_feature_lake_manifest(manifest) == []
