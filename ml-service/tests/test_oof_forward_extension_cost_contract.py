"""NEW-55b: the forward-extension prep gate reads the canonical label cost owner."""
import json
from pathlib import Path

import pytest

from app import oof_forward_extension as ext
from app import sequence_training
from app.features import FEATURE_IMPUTATION_SEMANTIC_VERSION

CONTRACT = Path(__file__).resolve().parents[2] / "schemas/expected-return-contracts-v1.json"
SHA = "a" * 40


class _Blob:
    def __init__(self, text):
        self.text = text

    def exists(self):
        return True

    def download_as_text(self):
        return self.text


class _Bucket:
    def __init__(self, manifest):
        self.manifest = manifest

    def blob(self, path):
        assert path == "fwd/prep/manifest.json"
        return _Blob(json.dumps(self.manifest))


def _manifest(cost):
    manifest = {
        "schema_version": "active8-canonical-adjusted-prep-v3", "status": "ready", "output_gcs_prefix": "fwd",
        "feature_semantic_version": ext.LEGACY_SEMANTIC,
        "feature_imputation_semantic": FEATURE_IMPUTATION_SEMANTIC_VERSION, "producer_source_sha": SHA,
        "target_semantic_version": sequence_training.SEQUENCE_RETURN_SEMANTIC_VERSION, "roundtrip_cost_bps": cost,
        "rank_semantic_version": "same-market-same-date-global-percentile-v2",
        "source_receipt_checksum": "b" * 64, "sequence_manifest_checksum": "c" * 64,
        "batch_rows": [1], "output_checksums": {"fwd/prep/batch_0.npz": "d" * 64},
    }
    return {**manifest, "manifest_checksum": ext._manifest_checksum(manifest)}


def test_gate_cost_is_the_expected_return_contract_cost():
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert ext.CANONICAL_ROUNDTRIP_COST_BPS is sequence_training.CANONICAL_ROUNDTRIP_COST_BPS
    assert ext.CANONICAL_ROUNDTRIP_COST_BPS == contract["canonical_roundtrip_cost_bps"] == 18.0


def test_prep_manifest_accepts_only_the_canonical_cost(monkeypatch):
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", SHA)
    canonical = sequence_training.CANONICAL_ROUNDTRIP_COST_BPS
    assert ext._verify_prep_manifest(_Bucket(_manifest(canonical)), "fwd")["roundtrip_cost_bps"] == canonical
    for cost in (canonical + 1.0, 0.0018, None):
        with pytest.raises(ValueError, match="forward_extension_prep_manifest_invalid"):
            ext._verify_prep_manifest(_Bucket(_manifest(cost)), "fwd")
    # A different owner value moves the gate with it instead of a second literal.
    monkeypatch.setattr(ext, "CANONICAL_ROUNDTRIP_COST_BPS", 25.0)
    assert ext._verify_prep_manifest(_Bucket(_manifest(25.0)), "fwd")["roundtrip_cost_bps"] == 25.0
    with pytest.raises(ValueError, match="forward_extension_prep_manifest_invalid"):
        ext._verify_prep_manifest(_Bucket(_manifest(18.0)), "fwd")
