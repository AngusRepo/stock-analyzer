from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from app.prep_lineage import (
    attach_prep_lineage_aliases,
    collect_prep_lineage,
    validate_prep_lineage_for_registration,
)


class _Blob:
    def __init__(self, name: str, *, text: str | None = None, updated: str | None = None, size: int | None = None):
        self.name = name
        self.text = text
        self.updated = datetime.fromisoformat(updated.replace("Z", "+00:00")) if updated else None
        self.size = size

    def exists(self) -> bool:
        return True

    def download_as_text(self) -> str:
        assert self.text is not None
        return self.text


class _Bucket:
    def __init__(self, blobs: dict[str, _Blob]):
        self.blobs = blobs

    def blob(self, key: str):
        return self.blobs[key]

    def list_blobs(self, prefix: str):
        return [blob for key, blob in self.blobs.items() if key.startswith(prefix)]


def test_collect_prep_lineage_records_timestamp_dates_rows_and_feature_hash():
    bucket = _Bucket({
        "universal/prep/batch_0.npz": _Blob(
            "universal/prep/batch_0.npz",
            updated="2026-06-05T17:02:00Z",
            size=100,
        ),
        "universal/prep/batch_1.npz": _Blob(
            "universal/prep/batch_1.npz",
            updated="2026-06-05T17:04:00Z",
            size=125,
        ),
        "universal/prep/feature_names.json": _Blob(
            "universal/prep/feature_names.json",
            text=json.dumps(["rsi14", "macd"]),
            updated="2026-06-05T17:03:00Z",
            size=20,
        ),
    })

    lineage = collect_prep_lineage(
        bucket,
        gcs_prefix="universal",
        batch_count=2,
        rows=3,
        dates=["2026-06-03", "2026-06-04", "2026-06-04"],
    )

    assert lineage["prep_timestamp"] == "2026-06-05T17:04:00Z"
    assert lineage["date_min"] == "2026-06-03"
    assert lineage["date_max"] == "2026-06-04"
    assert lineage["rows"] == 3
    assert lineage["feature_count"] == 2
    assert lineage["feature_hash"].startswith("sha256:")
    assert lineage["prep_objects"] == 2
    assert lineage["prep_bytes"] == 225


def test_validate_prep_lineage_blocks_stale_registration():
    lineage = {
        "prep_timestamp": "2026-05-17T17:04:00Z",
        "date_max": "2026-05-17",
        "rows": 100,
        "feature_count": 106,
        "prep_objects": 5,
    }

    with pytest.raises(RuntimeError) as exc:
        validate_prep_lineage_for_registration(
            lineage,
            as_of_date="2026-06-06",
            max_stale_days=3,
        )

    assert "prep_date_max_stale" in str(exc.value)
    assert "prep_timestamp_stale" in str(exc.value)


def test_attach_prep_lineage_aliases_keeps_existing_artifact_feature_count():
    metadata = {"feature_count": 45}
    lineage = {
        "prep_timestamp": "2026-06-05T17:04:00Z",
        "date_min": "2026-01-01",
        "date_max": "2026-06-04",
        "rows": 680468,
        "feature_count": 106,
        "feature_hash": "sha256:features",
        "gcs_prefix": "universal",
    }

    updated = attach_prep_lineage_aliases(metadata, lineage)

    assert updated["feature_count"] == 45
    assert updated["prep_lineage"] == lineage
    assert updated["date_max"] == "2026-06-04"
    assert updated["feature_hash"] == "sha256:features"
