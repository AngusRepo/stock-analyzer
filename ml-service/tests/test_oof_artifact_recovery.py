from __future__ import annotations

import hashlib
import io
import json

import numpy as np
import pytest

from app.oof_artifact_recovery import (
    MODEL_SLUGS,
    OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION,
    TREE_MODELS,
    recover_completed_oof_windows,
)
from app.oof_lineage import OOF_PREDICTION_SCHEMA_VERSION, OOF_TARGET_SEMANTIC_VERSION


class _Blob:
    def __init__(self, objects: dict[str, bytes], path: str):
        self.objects = objects
        self.path = path

    def exists(self) -> bool:
        return self.path in self.objects

    def download_as_bytes(self) -> bytes:
        return self.objects[self.path]


class _Bucket:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects

    def blob(self, path: str) -> _Blob:
        return _Blob(self.objects, path)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _fixture() -> tuple[_Bucket, list[str], str, str]:
    objects: dict[str, bytes] = {}
    cohort = "active8-oof-v6-test"
    prefix = "universal/canonical/test"
    models = list(MODEL_SLUGS)
    dates = np.asarray(["2026-07-08", "2026-07-08", "2026-07-09"], dtype=object)
    known = np.asarray(["2026-07-15", "2026-07-15", "2026-07-16"], dtype=object)
    for model in models:
        slug = MODEL_SLUGS[model]
        version = f"{cohort}-w0"
        source = f"{prefix}/frozen_models/{slug}/{version}.joblib" if model in TREE_MODELS else f"universal/{slug}/{version}.bin"
        source_raw = f"weights:{model}".encode()
        objects[source] = source_raw
        cpcv = {
            "coverage_gate_value": 1.0,
            "coverage_gate_semantics": "predicted_rows_over_eligible_rows",
            "policy": {"coverage_mode": "date_symbol_panel"},
        }
        metadata = {
            "version": version,
            "model_pool_version": version,
            "model_name": model,
            "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
            "model_cpcv": cpcv,
            "artifact_path": source,
            "checksum": f"sha256:{_sha(source_raw)}",
            "artifact_checksum": f"sha256:{_sha(source_raw)}",
        }
        metadata_path = (
            f"{prefix}/frozen_models/{slug}/metadata_{version}.json"
            if model in TREE_MODELS
            else f"universal/{slug}/metadata_{version}.json"
        )
        objects[metadata_path] = json.dumps(metadata).encode()
        artifact_metadata = {
            "schema_version": OOF_PREDICTION_SCHEMA_VERSION,
            "generation_mode": "purged_oof",
            "cohort_id": cohort,
            "fold_id": "w0",
            "model_name": model,
            "artifact_version": version,
            "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
            "split_metadata": {
                "train_range": ["2026-04-01", "2026-07-07"],
                "test_range": ["2026-07-08", "2026-07-22"],
            },
        }
        buf = io.BytesIO()
        np.savez_compressed(
            buf,
            metadata=np.asarray(json.dumps(artifact_metadata)),
            rank_scores=np.asarray([0.1, 0.8, 0.4]),
            targets=np.asarray([-0.1, 0.2, 0.1]),
            dates=dates,
            symbols=np.asarray(["1101", "1102", "1103"], dtype=object),
            markets=np.asarray(["LISTED", "LISTED", "OTC"], dtype=object),
            label_known_dates=known,
        )
        objects[f"{prefix}/oof/{cohort}/w0/{slug}.npz"] = buf.getvalue()
    return _Bucket(objects), models, cohort, prefix


def _recover(bucket: _Bucket, models: list[str], cohort: str, prefix: str):
    return recover_completed_oof_windows(
        bucket=bucket,
        requested_windows=[{
            "window_id": 0,
            "train_start": "2026-04-01",
            "train_end": "2026-07-07",
            "test_start": "2026-07-08",
            "test_end": "2026-07-22",
        }],
        models=models,
        cohort_id=cohort,
        prep_prefix=prefix,
        prep_manifest_checksum="a" * 64,
        sequence_prefix="universal/sequence_long/test",
        sequence_manifest_checksum="b" * 64,
        model_coverage={"active8_models": models},
    )


def test_recover_completed_oof_windows_verifies_all_eight_models() -> None:
    bucket, models, cohort, prefix = _fixture()
    recovered = _recover(bucket, models, cohort, prefix)
    assert recovered[0]["oof_fold_ready"] is True
    assert set(recovered[0]["model_metrics"]) == set(models)
    assert recovered[0]["forward_source_contract"]["ready"] is True
    assert recovered[0]["model_metrics"]["DLinear"]["coverage"] == 1.0


def test_recover_completed_oof_windows_rejects_lookahead_lineage() -> None:
    bucket, models, cohort, prefix = _fixture()
    path = f"{prefix}/oof/{cohort}/w0/xgboost.npz"
    artifact = np.load(io.BytesIO(bucket.objects[path]), allow_pickle=True)
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        **{key: artifact[key] for key in artifact.files if key != "label_known_dates"},
        label_known_dates=np.asarray(["2026-07-08", "2026-07-15", "2026-07-16"], dtype=object),
    )
    bucket.objects[path] = buf.getvalue()
    with pytest.raises(ValueError, match="lookahead_contract_invalid"):
        _recover(bucket, models, cohort, prefix)


def test_recovery_skips_fold_when_sequence_validation_evidence_is_missing() -> None:
    bucket, models, cohort, prefix = _fixture()
    for model in ("PatchTST", "iTransformer"):
        version = f"{cohort}-w0"
        del bucket.objects[f"universal/{MODEL_SLUGS[model]}/metadata_{version}.json"]
    assert _recover(bucket, models, cohort, prefix) == {}


def test_recovery_accepts_immutable_sequence_fold_evidence_without_serving_weights() -> None:
    bucket, models, cohort, prefix = _fixture()
    for model in ("PatchTST", "iTransformer"):
        slug = MODEL_SLUGS[model]
        version = f"{cohort}-w0"
        del bucket.objects[f"universal/{slug}/metadata_{version}.json"]
        oof_path = f"{prefix}/oof/{cohort}/w0/{slug}.npz"
        evidence = {
            "schema_version": OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION,
            "generation_mode": "purged_oof",
            "cohort_id": cohort,
            "fold_id": "w0",
            "model_name": model,
            "version": version,
            "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
            "model_cpcv": {
                "coverage_gate_value": 1.0,
                "coverage_gate_semantics": "predicted_rows_over_eligible_rows",
                "policy": {"coverage_mode": "date_symbol_panel"},
            },
            "oos_ic": 0.1,
            "oos_samples": 3,
            "oos_dates": 2,
            "oof_artifact": oof_path,
            "oof_artifact_checksum": _sha(bucket.objects[oof_path]),
            "split_metadata": {},
        }
        unsigned = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        evidence["evidence_checksum"] = _sha(unsigned)
        path = f"{prefix}/oof/{cohort}/w0/{slug}.evidence.json"
        bucket.objects[path] = json.dumps(evidence).encode()
    recovered = _recover(bucket, models, cohort, prefix)
    assert recovered[0]["oof_fold_ready"] is True
    assert recovered[0]["model_metrics"]["PatchTST"]["status"] == "ready"
