"""R33 manual reruns recover completed windows only when every family carries the R33 attestation."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from app.formal_feature_contract import FEATURE131_SEMANTIC  # noqa: E402
from app.neuralforecast_sequence_runtime import (  # noqa: E402
    OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION,
    _save_immutable_oof_fold_evidence,
)
from app.oof_artifact_recovery import recover_completed_oof_windows  # noqa: E402
from app.oof_lineage import OOF_TARGET_SEMANTIC_VERSION, save_oof_prediction_artifact  # noqa: E402
from app import timexer_job  # noqa: E402

R33 = ["LightGBM", "ExtraTrees", "TabM", "GNN", "TimeXer", "PatchTST", "iTransformer"]
SHA = "c" * 40
COHORT = "active8-oof-v6-v7-r33-exo131-2026-04-01-2026-07-22-tr60-te21"
PREFIX = "universal/canonical/r33test"
VERSION = f"{COHORT}-w0"
WINDOW = {"window_id": 0, "train_start": "2026-04-01", "train_end": "2026-07-07",
          "test_start": "2026-07-08", "test_end": "2026-07-22"}
CPCV = {"coverage_gate_value": 1.0, "coverage_gate_semantics": "predicted_rows_over_eligible_rows",
        "policy": {"coverage_mode": "date_symbol_panel"}}
SLUG = {"LightGBM": "lightgbm", "ExtraTrees": "extratrees", "TabM": "tabm", "GNN": "gnn",
        "TimeXer": "timexer", "PatchTST": "patchtst", "iTransformer": "itransformer"}


class Blob:
    def __init__(self, objects, path):
        self.objects, self.path = objects, path

    def exists(self):
        return self.path in self.objects

    def download_as_bytes(self):
        return self.objects[self.path]

    def download_as_text(self):
        return self.objects[self.path].decode()

    def upload_from_string(self, raw, content_type=None, if_generation_match=None):
        if if_generation_match == 0 and self.path in self.objects:
            raise RuntimeError("precondition")
        self.objects[self.path] = raw.encode() if isinstance(raw, str) else raw


class Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, path):
        return Blob(self.objects, path)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _split(model):
    if model in ("LightGBM", "ExtraTrees", "TabM", "GNN"):
        return {"window_id": 0, "train_range": ["2026-04-01", "2026-07-07"], "test_range": ["2026-07-08", "2026-07-22"],
                "method": "walk_forward_explicit_label_purged", "train_label_known_max": "2026-07-07"}
    split = {"method": "outer_train_fixed_dense_test_purged_rank_ic", "train_start": "2026-04-01",
             "train_end": "2026-07-07", "test_start": "2026-07-08", "test_end": "2026-07-22",
             "purge_horizon": 5, "refit_inside_test": False}
    if model == "TimeXer":
        return {**split, "training_label_known_max": "2026-07-07", "source_manifest_checksum": "d" * 64}
    return {**split, "train_label_known_max": "2026-07-07", "nf_require_complete_horizon": True,
            "evaluation_row_accounting": {"label_rows": 0}}


def build_fold(monkeypatch, splits=None):
    """Write one fold exactly as the R33 trainers do; return the bucket and the fresh window."""
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", SHA)
    bucket = Bucket()
    fresh = {"window_id": 0, "test_range": [WINDOW["test_start"], WINDOW["test_end"]], "model_metrics": {}}
    for model in R33:
        slug = SLUG[model]
        oof = save_oof_prediction_artifact(
            bucket=bucket, gcs_prefix=PREFIX, cohort_id=COHORT, fold_id="w0", model_name=model,
            artifact_version=VERSION, raw_scores=np.asarray([0.1, 0.8, 0.4]), targets=np.asarray([-0.1, 0.2, 0.1]),
            dates=np.asarray(["2026-07-08", "2026-07-08", "2026-07-09"]), symbols=np.asarray(["1101", "1102", "1103"]),
            markets=np.asarray(["LISTED", "LISTED", "OTC"]),
            label_known_dates=np.asarray(["2026-07-15", "2026-07-15", "2026-07-16"]),
            split_metadata=(splits or {}).get(model, _split(model)), feature_semantic_version=FEATURE131_SEMANTIC)
        fresh["model_metrics"][model] = {"status": "ready", "oof_artifact": oof["path"],
                                         "artifact_checksum": oof["payload_checksum"]}
        weights = f"weights:{model}".encode()
        if model in ("LightGBM", "ExtraTrees"):
            source = f"{PREFIX}/frozen_models/{slug}/{VERSION}.joblib"
            bucket.objects[source] = weights
            bucket.objects[f"{PREFIX}/frozen_models/{slug}/metadata_{VERSION}.json"] = json.dumps({
                "version": VERSION, "model_name": model, "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
                "model_cpcv": CPCV, "artifact_checksum": f"sha256:{_sha(weights)}"}).encode()
        elif model in ("TabM", "GNN"):
            source = f"universal/{slug}/{VERSION}.bin"
            bucket.objects[source] = weights
            bucket.objects[f"universal/{slug}/metadata_{VERSION}.json"] = json.dumps({
                "version": VERSION, "model_name": model, "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION,
                "model_cpcv": CPCV, "artifact_path": source, "checksum": f"sha256:{_sha(weights)}"}).encode()
        elif model == "TimeXer":
            prefix = f"universal/timexer/{VERSION}/{_sha(weights)}"
            checkpoint = {"model_name": "TimeXer", "version": VERSION, "checksum": _sha(weights),
                          "artifact_path": prefix + "/model.pt", "metadata_path": prefix + "/metadata.json"}
            bucket.objects[prefix + "/model.pt"] = weights
            bucket.objects[prefix + "/metadata.json"] = json.dumps(checkpoint).encode()
            timexer_job.save_fold_evidence(
                bucket, payload={"gcs_prefix": PREFIX, "cohort_id": COHORT, "fold_id": "w0", "window_id": 0},
                version=VERSION, oof_artifact=oof, model_cpcv=CPCV, oos_ic=0.1,
                saved={"metadata_path": checkpoint["metadata_path"], "checksum": checkpoint["checksum"]},
                split_metadata=_split(model), producer_source_sha=SHA)
        else:
            _save_immutable_oof_fold_evidence(bucket, path=f"{PREFIX}/oof/{COHORT}/w0/{slug}.evidence.json", evidence={
                "schema_version": OOF_FOLD_MODEL_EVIDENCE_SCHEMA_VERSION, "generation_mode": "purged_oof",
                "cohort_id": COHORT, "fold_id": "w0", "model_name": model, "version": VERSION,
                "target_semantic_version": OOF_TARGET_SEMANTIC_VERSION, "model_cpcv": CPCV,
                "oof_artifact": oof["path"], "oof_artifact_checksum": oof["payload_checksum"]})
    return bucket, fresh


def recover(bucket, *, r33=True, models=R33, sha=SHA):
    return recover_completed_oof_windows(
        bucket=bucket, requested_windows=[WINDOW], models=list(models), cohort_id=COHORT, prep_prefix=PREFIX,
        prep_manifest_checksum="a" * 64, sequence_prefix="universal/sequence_long/test",
        sequence_manifest_checksum="b" * 64, model_coverage={"active8_models": list(models)},
        r33_lineage={"producer_source_sha": sha, "feature_semantic_version": FEATURE131_SEMANTIC} if r33 else None)


def test_recovered_window_feeds_r33_checks_exactly_like_the_fresh_fold(monkeypatch):
    from services.r33_monthly_lifecycle import fold_receipts
    bucket, fresh = build_fold(monkeypatch)
    recovered = recover(bucket)[0]
    assert recovered["oof_fold_ready"] is True and set(recovered["model_metrics"]) == set(R33)
    for model in R33:  # the artifact identity r33_oof_checks reads
        for key in ("oof_artifact", "artifact_checksum"):
            assert recovered["model_metrics"][model][key] == fresh["model_metrics"][model][key]
    manifest = {"model_set": R33}
    receipts = fold_receipts({**manifest, "windows": [recovered]}, bucket)
    assert receipts == fold_receipts({**manifest, "windows": [fresh]}, bucket)
    assert receipts[0]["train_label_known_max"] == "2026-07-07" and len(receipts[0]["per_model"]) == 7
    timexer = recovered["TimeXer_result"]
    assert timexer["status"] == "ok" and timexer["metadata"]["artifact_path"].endswith("/model.pt")
    assert recovered["source_producer_source_sha"] == SHA


def test_missing_timexer_artifact_reruns_the_window(monkeypatch):
    bucket, _ = build_fold(monkeypatch)
    del bucket.objects[f"{PREFIX}/oof/{COHORT}/w0/timexer.npz"]
    assert recover(bucket) == {}
    bucket, _ = build_fold(monkeypatch)
    del bucket.objects[f"{PREFIX}/oof/{COHORT}/w0/timexer.evidence.json"]
    assert recover(bucket) == {}


@pytest.mark.parametrize("model,patch", [
    ("PatchTST", {"nf_require_complete_horizon": None}),
    ("iTransformer", {"evaluation_row_accounting": None}),
    ("TimeXer", {"purge_horizon": 0}),
    ("TimeXer", {"training_label_known_max": "2026-07-08"}),  # not strictly before test_start
    ("LightGBM", {"train_label_known_max": None}),
    ("GNN", {"method": "date_ratio_split"}),
])
def test_attestation_gap_in_any_family_reruns_the_whole_window(monkeypatch, model, patch):
    split = {k: v for k, v in {**_split(model), **patch}.items() if v is not None}
    bucket, _ = build_fold(monkeypatch, splits={model: split})
    assert recover(bucket) == {}


def test_other_producer_or_semantic_reruns(monkeypatch):
    bucket, _ = build_fold(monkeypatch)
    assert recover(bucket, sha="e" * 40) == {}
    lineage = {"producer_source_sha": SHA, "feature_semantic_version": "formal-feature-semantic-other"}
    assert recover_completed_oof_windows(
        bucket=bucket, requested_windows=[WINDOW], models=R33, cohort_id=COHORT, prep_prefix=PREFIX,
        prep_manifest_checksum="a" * 64, sequence_prefix="s", sequence_manifest_checksum="b" * 64,
        model_coverage={"active8_models": R33}, r33_lineage=lineage) == {}


def test_non_r33_rosters_with_timexer_keep_no_recovery(monkeypatch):
    bucket, _ = build_fold(monkeypatch)
    assert recover(bucket, r33=False) == {}
