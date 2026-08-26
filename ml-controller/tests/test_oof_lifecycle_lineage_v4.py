from __future__ import annotations

import hashlib
import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


class _Blob:
    def __init__(self, raw: bytes):
        self.raw = raw

    def download_as_bytes(self) -> bytes:
        return self.raw


class _Bucket:
    def __init__(self, blobs: dict[str, bytes]):
        self.blobs = blobs

    def blob(self, path: str) -> _Blob:
        return _Blob(self.blobs[path])


def _prediction_npz(dates: list[str]) -> bytes:
    buffer = io.BytesIO()
    np.savez_compressed(buffer, dates=np.asarray(dates, dtype=object))
    return buffer.getvalue()


def test_physical_oof_coverage_exposes_declared_manifest_gap():
    from routers.walk_forward import _oof_manifest_observed_core_dates
    from services.active8_oof_stacker import CORE_CROSS_SECTIONAL_MODELS

    blobs: dict[str, bytes] = {}
    metrics = {}
    for model in CORE_CROSS_SECTIONAL_MODELS:
        path = f"oof/{model}.npz"
        raw = _prediction_npz(["2026-07-06", "2026-07-07"])
        blobs[path] = raw
        metrics[model] = {
            "oof_artifact": path,
            "artifact_checksum": hashlib.sha256(raw).hexdigest(),
        }
    dates, evidence = _oof_manifest_observed_core_dates(
        _Bucket(blobs),
        {
            "end_date": "2026-07-09",
            "windows": [{
                "window_id": 4,
                "test_range": ["2026-06-26", "2026-07-09"],
                "model_metrics": metrics,
            }],
        },
    )

    assert dates == ["2026-07-06", "2026-07-07"]
    assert evidence["max_date"] == "2026-07-07"
    assert evidence["declared_end_date"] == "2026-07-09"
    assert evidence["declared_end_matches_physical"] is False


def test_v4_manifest_requires_per_fold_immutable_input_lineage():
    from services.active8_oof_cohort_materializer import (
        ACTIVE8_MODELS,
        TARGET_SEMANTIC_VERSION,
        _manifest_checksum,
        load_verified_oof_manifest,
    )

    manifest = {
        "schema_version": "active8-oof-cohort-manifest-v4",
        "cohort_id": "cohort-v4",
        "generation_mode": "purged_oof",
        "status": "ready",
        "model_set": list(ACTIVE8_MODELS),
        "prep_manifest": {
            "manifest_checksum": "a" * 64,
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
            "roundtrip_cost_bps": 18.0,
            "batch_count": 1,
        },
        "sequence_manifest": {
            "artifact_checksum": "b" * 64,
            "contract": "sequence_records_v3",
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
            "batch_count": 1,
            "batch_checksums": {"batch": "c" * 64},
        },
        "windows": [{"window_id": 0}],
    }
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    raw = json.dumps(manifest).encode("utf-8")

    with pytest.raises(ValueError, match="active8_oof_fold_input_lineage_invalid"):
        load_verified_oof_manifest(
            "manifest.json",
            bucket=_Bucket({"manifest.json": raw}),
        )


def test_lifecycle_uses_latest_prep_as_maturity_owner():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text()

    latest = source.index("_latest_canonical_prep_prefix(bucket) or")
    calendar = source.index("dates, calendar_evidence = _oof_lifecycle_calendar(")
    assert latest < calendar
    assert 'prep_gcs_prefix = "" if exact_producer_source_sha else' in source
    assert "expected_producer_source_sha=exact_producer_source_sha" in source
    assert 'calendar_evidence.get("sequence_gcs_prefix")' in source
    assert "parent_physical_coverage" in source
    assert "cross_prep_resume" in source
