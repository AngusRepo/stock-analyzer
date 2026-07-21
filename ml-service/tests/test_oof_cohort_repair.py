import hashlib
import json

import numpy as np
import pytest


class _Blob:
    def __init__(self):
        self.payload = b""

    def upload_from_string(self, payload, content_type=None):
        self.payload = payload

    def download_as_bytes(self):
        return self.payload


class _Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, path):
        return self.objects.setdefault(path, _Blob())


def _artifact(bucket, cohort_id, model_name):
    from app.oof_lineage import save_oof_prediction_artifact

    return save_oof_prediction_artifact(
        bucket=bucket,
        gcs_prefix="prep",
        cohort_id=cohort_id,
        fold_id="w0",
        model_name=model_name,
        artifact_version=f"{cohort_id}-w0",
        raw_scores=np.asarray([0.1, 0.2]),
        targets=np.asarray([0.01, -0.01]),
        dates=np.asarray(["2026-07-01", "2026-07-01"]),
        symbols=np.asarray(["A", "B"]),
        markets=np.asarray(["LISTED", "LISTED"]),
        label_known_dates=np.asarray(["2026-07-08", "2026-07-08"]),
        split_metadata={"method": "test"},
    )


def test_repair_failed_oof_manifest_verifies_artifacts_and_rebuilds_evidence():
    from app.oof_cohort_repair import manifest_checksum, repair_failed_oof_manifest

    bucket = _Bucket()
    cohort_id = "cohort"
    models = ["PatchTST", "iTransformer"]
    patch = _artifact(bucket, cohort_id, "PatchTST")
    itransformer = _artifact(bucket, cohort_id, "iTransformer")
    manifest = {
        "schema_version": "active8-oof-cohort-manifest-v2",
        "cohort_id": cohort_id,
        "generation_mode": "purged_oof",
        "model_set": models,
        "windows": [{
            "window_id": 0,
            "model_metrics": {
                "PatchTST": {
                    "status": "ready",
                    "oos_ic": 0.1,
                    "test_samples": 100,
                    "coverage": 0.82,
                    "coverage_gate_semantics": "sequence_window_coverage",
                    "coverage_mode": "sequence_window",
                    "oof_artifact": patch["path"],
                    "artifact_checksum": patch["payload_checksum"],
                },
                "iTransformer": {"status": "failed", "reason": "shape"},
            },
            "missing_oof_models": ["iTransformer"],
            "oof_fold_ready": False,
        }],
        "aggregate": {},
        "status": "failed",
    }
    manifest["manifest_checksum"] = manifest_checksum(manifest)
    result = repair_failed_oof_manifest(
        manifest,
        fold_id="w0",
        model_name="iTransformer",
        model_result={
            "ic_tracking": {
                "iTransformer": {
                    "oos_ic": 0.2,
                    "oos_samples": 100,
                    "model_cpcv": {
                        "coverage_gate_value": 0.75,
                        "coverage_gate_semantics": "sequence_window_coverage",
                        "policy": {"coverage_mode": "sequence_window"},
                    },
                },
            },
            "oof_artifact": {
                "path": itransformer["path"],
                "payload_checksum": itransformer["payload_checksum"],
            },
        },
        bucket=bucket,
    )

    assert result["status"] == "ready"
    assert result["aggregate"]["oof_ready_folds"] == 1
    assert result["windows"][0]["missing_oof_models"] == []
    assert result["manifest_checksum"] == manifest_checksum(result)


def test_repair_rejects_artifact_checksum_mismatch():
    from app.oof_cohort_repair import manifest_checksum, repair_failed_oof_manifest

    bucket = _Bucket()
    manifest = {
        "cohort_id": "cohort",
        "generation_mode": "purged_oof",
        "model_set": ["iTransformer"],
        "windows": [{
            "window_id": 0,
            "model_metrics": {"iTransformer": {"status": "failed"}},
        }],
        "aggregate": {},
        "status": "failed",
    }
    manifest["manifest_checksum"] = manifest_checksum(manifest)
    with pytest.raises(ValueError, match="artifact_checksum_mismatch"):
        repair_failed_oof_manifest(
            manifest,
            fold_id="w0",
            model_name="iTransformer",
            model_result={
                "ic_tracking": {
                    "iTransformer": {
                        "oos_ic": 0.2,
                        "oos_samples": 2,
                        "model_cpcv": {
                            "coverage_gate_value": 0.5,
                            "coverage_gate_semantics": "sequence_window_coverage",
                            "policy": {"coverage_mode": "sequence_window"},
                        },
                    },
                },
                "oof_artifact": {"path": "missing.npz", "payload_checksum": "0" * 64},
            },
            bucket=bucket,
        )



def test_repair_rejects_incomplete_coverage_contract():
    from app.oof_cohort_repair import manifest_checksum, repair_failed_oof_manifest

    bucket = _Bucket()
    patch = _artifact(bucket, "cohort", "PatchTST")
    itransformer = _artifact(bucket, "cohort", "iTransformer")
    manifest = {
        "cohort_id": "cohort",
        "generation_mode": "purged_oof",
        "model_set": ["PatchTST", "iTransformer"],
        "windows": [{
            "window_id": 0,
            "model_metrics": {
                "PatchTST": {
                    "status": "ready",
                    "oos_ic": 0.1,
                    "test_samples": 100,
                    "coverage": 0.82,
                    "coverage_gate_semantics": "sequence_window_coverage",
                    "oof_artifact": patch["path"],
                    "artifact_checksum": patch["payload_checksum"],
                },
                "iTransformer": {"status": "failed", "reason": "shape"},
            },
        }],
        "aggregate": {},
        "status": "failed",
    }
    manifest["manifest_checksum"] = manifest_checksum(manifest)

    result = repair_failed_oof_manifest(
        manifest,
        fold_id="w0",
        model_name="iTransformer",
        model_result={
            "ic_tracking": {
                "iTransformer": {
                    "oos_ic": 0.2,
                    "oos_samples": 100,
                    "model_cpcv": {
                        "coverage_gate_value": 0.8,
                        "coverage_gate_semantics": "sequence_window_coverage",
                        "policy": {"coverage_mode": "sequence_window"},
                    },
                },
            },
            "oof_artifact": {
                "path": itransformer["path"],
                "payload_checksum": itransformer["payload_checksum"],
            },
        },
        bucket=bucket,
    )

    assert result["status"] == "failed"
    assert result["windows"][0]["model_metrics"]["PatchTST"]["reason"] == (
        "oof_coverage_contract_incomplete"
    )


def test_oof_artifact_builds_date_market_cluster_rank_ic_evidence():
    from app.oof_lineage import (
        oof_date_cluster_rank_ic_from_bytes,
        save_oof_prediction_artifact,
    )

    bucket = _Bucket()
    rows = 20
    artifact = save_oof_prediction_artifact(
        bucket=bucket,
        gcs_prefix="prep",
        cohort_id="cohort",
        fold_id="w0",
        model_name="PatchTST",
        artifact_version="v1",
        raw_scores=np.arange(rows, dtype=float),
        targets=np.arange(rows, dtype=float),
        dates=np.asarray(["2026-07-01"] * rows),
        symbols=np.asarray([f"S{index:03d}" for index in range(rows)]),
        markets=np.asarray(["LISTED"] * rows),
        label_known_dates=np.asarray(["2026-07-08"] * rows),
        split_metadata={"method": "test"},
    )

    evidence = oof_date_cluster_rank_ic_from_bytes(
        bucket.blob(artifact["path"]).download_as_bytes()
    )

    assert evidence["schema_version"] == "oof-date-cluster-rank-ic-v1"
    assert evidence["date_cluster_count"] == 1
    assert evidence["date_cluster_ics"][0]["date"] == "2026-07-01"
    assert evidence["date_cluster_ics"][0]["rank_ic"] == pytest.approx(1.0)
    assert evidence["date_cluster_ics"][0]["test_rows"] == rows
