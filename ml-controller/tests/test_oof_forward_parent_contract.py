from __future__ import annotations

import hashlib
import json
import os

from routers.walk_forward import _oof_forward_parent_contract

TEST_SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567"
os.environ.setdefault("STOCKVISION_SOURCE_SHA", TEST_SOURCE_SHA)


class _Blob:
    def __init__(self, exists: bool):
        self._exists = exists

    def exists(self) -> bool:
        return self._exists


class _Bucket:
    def __init__(self, paths: set[str]):
        self.paths = paths

    def blob(self, path: str) -> _Blob:
        return _Blob(path in self.paths)


def _manifest() -> tuple[dict, set[str]]:
    cohort_id = "active8-oof-v6-test"
    window_id = 4
    version = f"{cohort_id}-w{window_id}"
    paths: set[str] = set()
    metrics = {}
    registrations = {}
    for model_name in ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN"):
        oof_path = f"oof/{model_name}.npz"
        paths.add(oof_path)
        metrics[model_name] = {
            "status": "ready",
            "oof_artifact": oof_path,
            "artifact_checksum": "a" * 64,
        }
    for model_name in ("LightGBM", "XGBoost", "ExtraTrees"):
        artifact_path = f"frozen/{model_name}.joblib"
        metadata_path = f"frozen/{model_name}.json"
        paths.update((artifact_path, metadata_path))
        registrations[model_name] = {
            "status": "shadow_source",
            "promotion_eligible": False,
            "version": version,
            "gcs_path": artifact_path,
            "metadata_path": metadata_path,
            "checksum": "sha256:" + "b" * 64,
        }
    window = {
        "window_id": window_id,
        "model_metrics": metrics,
        "tree_result": {"artifact_registrations": registrations},
    }
    for model_name in ("TabM", "GNN"):
        artifact_path = f"frozen/{model_name}.pt"
        metadata_path = f"frozen/{model_name}.json"
        paths.update((artifact_path, metadata_path))
        window[f"{model_name}_result"] = {
            "status": "ok",
            "version": version,
            "artifact_path": artifact_path,
            "metadata_path": metadata_path,
            "checksum": "sha256:" + "c" * 64,
        }
    manifest = {
        "schema_version": "active8-oof-cohort-manifest-v5",
        "status": "ready",
        "generation_mode": "purged_oof",
        "cohort_id": cohort_id,
        "target_semantic_version": (
            "next-session-canonical-adjusted-open-to-fifth-session-"
            "canonical-adjusted-close-net-v4"
        ),
        "score_semantic_version": "same-market-same-date-average-tie-percentile-rank-v2",
        "prep_manifest": {
            "feature_semantic_version": "formal137-pit-asof-source-quality-v3",
            "feature_imputation_semantic": "prior_252_row_median_then_zero_v2",
            "producer_source_sha": TEST_SOURCE_SHA,
        },
        "windows": [window],
    }
    manifest["manifest_checksum"] = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    return manifest, paths


def test_oof_parent_contract_accepts_checksum_bound_exact_latest_fold():
    manifest, paths = _manifest()
    result = _oof_forward_parent_contract(_Bucket(paths), manifest)
    assert result["ready"] is True
    assert result["reasons"] == []
    assert result["expected_version"] == "active8-oof-v6-test-w4"


def test_oof_parent_contract_rejects_legacy_fold_without_exact_tree_sources():
    manifest, paths = _manifest()
    manifest["schema_version"] = "active8-oof-cohort-manifest-v3"
    manifest["windows"][0]["tree_result"]["artifact_registrations"] = {}
    manifest["manifest_checksum"] = hashlib.sha256(
        json.dumps(
            {key: value for key, value in manifest.items() if key != "manifest_checksum"},
            sort_keys=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()
    result = _oof_forward_parent_contract(_Bucket(paths), manifest)
    assert result["ready"] is False
    assert "manifest_schema_not_exact_artifact_capable" in result["reasons"]
    assert "exact_tree_source_state_invalid:LightGBM" in result["reasons"]


def test_oof_parent_contract_rejects_legacy_tie_unsafe_score_semantic():
    manifest, paths = _manifest()
    manifest["score_semantic_version"] = "same-market-same-date-percentile-rank-v1"
    manifest["manifest_checksum"] = hashlib.sha256(
        json.dumps(
            {key: value for key, value in manifest.items() if key != "manifest_checksum"},
            sort_keys=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()
    result = _oof_forward_parent_contract(_Bucket(paths), manifest)
    assert result["ready"] is False
    assert "score_semantic_mismatch" in result["reasons"]



def _seal(value):
    value['manifest_checksum'] = hashlib.sha256(json.dumps(
        {k:v for k,v in value.items() if k != 'manifest_checksum'}, sort_keys=True, default=str).encode()).hexdigest()


def _reused():
    from copy import deepcopy
    original, paths = _manifest()
    child = deepcopy(original)
    child['cohort_id'] = 'extended-cohort'
    window = child['windows'][0]
    window.update(window_id=6, source_cohort_id=original['cohort_id'], source_fold_id='w4',
                  source_manifest_checksum=original['manifest_checksum'], reused_from_parent=True)
    _seal(child)
    class Bucket(_Bucket):
        def blob(self, path):
            if path == f"walk_forward/oof_cohorts/{original['cohort_id']}/manifest.json":
                from types import SimpleNamespace
                return SimpleNamespace(download_as_text=lambda:json.dumps(original))
            return super().blob(path)
    return child, original, Bucket(paths)


def test_reused_latest_fold_keeps_exact_original_model_versions():
    child, original, bucket = _reused()
    result = _oof_forward_parent_contract(bucket, child)
    assert result['ready'], result
    assert result['expected_version'] == original['cohort_id'] + '-w4'
    assert result['latest_window_id'] == 6


import pytest

@pytest.mark.parametrize('fault', ['parent_checksum','source_checksum','fold','model','prediction','profile','path'])
def test_reused_fold_cannot_relabel_or_borrow_unverified_model_sources(fault):
    child, original, bucket = _reused()
    w = child['windows'][0]
    if fault == 'parent_checksum': original['cohort_id'] = 'different'
    elif fault == 'source_checksum': w['source_manifest_checksum'] = '0'*64
    elif fault == 'fold': w['source_fold_id'] = 'w3'
    elif fault == 'model': w['tree_result']['artifact_registrations']['LightGBM']['version'] = 'extended-cohort-w6'
    elif fault == 'prediction': w['model_metrics']['TabM']['artifact_checksum'] = 'f'*64
    elif fault == 'profile': child['model_profile_schema_version'] = 'different-recipe'
    else: w['source_cohort_id'] = '../other-cohort'
    _seal(child)
    result = _oof_forward_parent_contract(bucket, child)
    assert result['ready'] is False
    assert any('reused_forward_source_invalid' in r for r in result['reasons'])



def test_modal_frozen_forward_uses_same_verified_reused_source_as_controller():
    from pathlib import Path
    from app.oof_forward_source_contract import assess_fold_forward_sources
    root=Path(__file__).resolve().parents[2]
    assert (root/'ml-controller/services/oof_forward_source_identity.py').read_bytes() == (root/'ml-service/app/oof_forward_source_identity.py').read_bytes()
    child, original, bucket = _reused()
    result=assess_fold_forward_sources(child['windows'][0],cohort_id=child['cohort_id'],bucket=bucket,manifest=child)
    assert result['ready'] and result['expected_version']==original['cohort_id']+'-w4'
    child['windows'][0]['source_manifest_checksum']='0'*64
    result=assess_fold_forward_sources(child['windows'][0],cohort_id=child['cohort_id'],bucket=bucket,manifest=child)
    assert result['ready'] is False
