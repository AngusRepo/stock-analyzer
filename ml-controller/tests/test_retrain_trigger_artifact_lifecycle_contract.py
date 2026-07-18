from pathlib import Path
import hashlib
import json
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import retrain_trigger  # noqa: E402


def test_universal_retrain_request_forwards_artifact_lifecycle_fields():
    source = (Path(__file__).resolve().parents[1] / "routers" / "retrain_trigger.py").read_text(
        encoding="utf-8"
    )

    assert "artifact_lifecycle_targets: list[str] = Field(default_factory=list)" in source
    assert "artifact_lifecycle_contracts: dict[str, str] = Field(default_factory=dict)" in source
    assert "artifact_lifecycle_only: bool = False" in source
    assert "require_exact_dataset_snapshot: bool" in source
    assert "sequence_gcs_prefix: str | None" in source
    assert "patchtst_seq_len: int | None" in source
    assert "itransformer_seq_len: int | None" in source
    assert '"artifact_lifecycle_targets": req.artifact_lifecycle_targets' in source
    assert '"artifact_lifecycle_contracts": req.artifact_lifecycle_contracts' in source
    assert '"artifact_lifecycle_only": req.artifact_lifecycle_only' in source
    assert '"sequence_gcs_prefix"] = sequence_gcs_prefix' in source
    assert "**sequence_contract" in source
    assert '@router.post("/universal/run")' in source


def test_sequence_batch_count_from_long_history_manifest():
    manifest = {
        "batch_size": 512,
        "lane_reports": [
            {"sequence_records": 2441},
            {"sequence_records": 629},
        ],
        "summary": {"symbols": 3070},
    }

    assert retrain_trigger._sequence_batch_count_from_manifest(manifest, fallback=1) == 6


def _snapshot_maps(*, business_date: str, components: list[str]) -> tuple:
    return ({}, {}, {}, {}, {}, {
        "snapshot_id": f"snapshot:{business_date}",
        "business_date": business_date,
        "components": components,
    })


def test_exact_snapshot_accepts_matching_date_and_canonical_fundamentals():
    rejection = retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=_snapshot_maps(
            business_date="2026-07-09",
            components=["prices", "canonical_fundamentals"],
        ),
    )

    assert rejection is None


def test_exact_snapshot_rejects_missing_snapshot_component_or_wrong_date():
    assert retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=None,
    ) == {
        "reason": "exact_dataset_snapshot_missing",
        "required_business_date": "2026-07-09",
    }
    assert retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=_snapshot_maps(
            business_date="2026-07-08",
            components=["prices", "canonical_fundamentals"],
        ),
    )["reason"] == "exact_dataset_snapshot_business_date_mismatch"
    assert retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=_snapshot_maps(
            business_date="2026-07-09",
            components=["prices"],
        ),
    )["reason"] == "exact_dataset_snapshot_feature_component_missing"

def test_prebuilt_canonical_prep_requires_verified_manifest_and_batches():
    prefix = "universal/canonical_adjusted_v4/test"
    batches = {
        f"{prefix}/prep/batch_0.npz": b"batch-zero",
        f"{prefix}/prep/batch_1.npz": b"batch-one",
    }
    manifest = {
        "schema_version": "active8-canonical-adjusted-prep-v1",
        "status": "ready",
        "output_gcs_prefix": prefix,
        "sequence_gcs_prefix": "universal/sequence_long/canonical-v4",
        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        "roundtrip_cost_bps": 18.0,
        "output_rows": 11000,
        "batch_rows": [6000, 5000],
        "output_checksums": {
            path: hashlib.sha256(raw).hexdigest() for path, raw in batches.items()
        },
    }
    checksum = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode("utf-8")).hexdigest()
    manifest["manifest_checksum"] = checksum
    blobs = {
        **batches,
        f"{prefix}/prep/manifest.json": json.dumps(manifest).encode("utf-8"),
    }

    class Blob:
        def __init__(self, raw):
            self.raw = raw

        def download_as_text(self):
            return self.raw.decode("utf-8")

        def download_as_bytes(self):
            return self.raw

    class Bucket:
        def blob(self, path):
            return Blob(blobs[path])

    verified = retrain_trigger._verify_prebuilt_canonical_prep(
        bucket=Bucket(),
        prefix=prefix,
        expected_manifest_checksum=checksum,
        expected_target_semantic_version=manifest["target_semantic_version"],
    )
    assert verified["batch_count"] == 2
    assert verified["total_rows"] == 11000
    assert verified["manifest_checksum"] == checksum

    blobs[f"{prefix}/prep/batch_1.npz"] = b"tampered"
    with pytest.raises(ValueError, match="batch_checksum_mismatch"):
        retrain_trigger._verify_prebuilt_canonical_prep(
            bucket=Bucket(),
            prefix=prefix,
            expected_manifest_checksum=checksum,
            expected_target_semantic_version=manifest["target_semantic_version"],
        )

def test_prebuilt_sequence_prep_requires_manifest_and_all_batch_checksums():
    prefix = "universal/sequence_long/canonical-v4"
    target = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
    manifest = {
        "schema_version": "finlab-long-history-sequence-prep-v2",
        "contract": "sequence_records_v3",
        "target_semantic_version": target,
        "output_gcs_prefix": prefix,
    }
    manifest_raw = json.dumps(manifest, sort_keys=True).encode("utf-8")
    batches = {
        f"{prefix}/prep/batch_0.npz": b"sequence-zero",
        f"{prefix}/prep/batch_1.npz": b"sequence-one",
    }
    checksums = {path: hashlib.sha256(raw).hexdigest() for path, raw in batches.items()}
    blobs = {
        **batches,
        f"{prefix}/prep/sequence_manifest.json": manifest_raw,
    }

    class Blob:
        def __init__(self, raw):
            self.raw = raw

        def download_as_bytes(self):
            return self.raw

    class Bucket:
        def blob(self, path):
            return Blob(blobs[path])

    verified = retrain_trigger._verify_prebuilt_sequence_prep(
        bucket=Bucket(),
        prefix=prefix,
        expected_manifest_checksum=hashlib.sha256(manifest_raw).hexdigest(),
        expected_batch_checksums=checksums,
        expected_target_semantic_version=target,
    )
    assert verified["batch_count"] == 2
    assert verified["batch_checksums"] == checksums

    blobs[f"{prefix}/prep/batch_0.npz"] = b"tampered"
    with pytest.raises(ValueError, match="sequence_batch_checksum_mismatch"):
        retrain_trigger._verify_prebuilt_sequence_prep(
            bucket=Bucket(),
            prefix=prefix,
            expected_manifest_checksum=hashlib.sha256(manifest_raw).hexdigest(),
            expected_batch_checksums=checksums,
            expected_target_semantic_version=target,
        )
