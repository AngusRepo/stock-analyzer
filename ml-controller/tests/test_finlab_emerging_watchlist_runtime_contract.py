from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_emerging_watchlist import (  # noqa: E402
    build_finlab_emerging_watchlist_manifest,
    validate_finlab_emerging_watchlist_manifest,
)


def test_runtime_emerging_watchlist_manifest_uses_feature_lake_rotc_lanes():
    feature_lake = json.loads((ROOT / "data" / "finlab_research" / "feature_lake_manifest.json").read_text(encoding="utf-8"))

    manifest = build_finlab_emerging_watchlist_manifest(
        feature_lake,
        generated_at="2026-05-16T00:00:00+00:00",
    )

    sources = {source["source_dataset"]: source for source in manifest["source_contracts"]}

    assert manifest["source_feature_lake_checksum"] == feature_lake["checksum"]
    assert manifest["summary"]["source_count"] == 3
    assert manifest["summary"]["field_count_total"] == 20
    assert sources["rotc_price"]["source_family"] == "finlab/diversity/emerging_price_diversity/feature_lake"
    assert sources["rotc_monthly_revenue"]["source_family"] == "finlab/diversity/emerging_revenue_diversity/feature_lake"
    assert sources["rotc_broker_transactions"]["source_family"] == "finlab/diversity/emerging_chip_diversity/feature_lake"
    assert validate_finlab_emerging_watchlist_manifest(manifest) == []
