import pytest

from app.canonical_adjusted_prep import build_adjusted_target_lookup, _sequence_manifest_checksum
from app.sequence_training import CANONICAL_ROUNDTRIP_COST_BPS
from app.long_history_sequence_prep import _manifest_checksum as producer_manifest_checksum


def test_adjusted_target_lookup_uses_next_open_fifth_close_and_net_cost():
    dates = [f"2026-01-{day:02d}" for day in range(1, 8)]
    records = [{
        "symbol": "2330",
        "dates": dates,
        "open": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0],
        "close": [100.5, 101.5, 102.5, 103.5, 104.5, 111.0, 112.0],
    }]

    lookup = build_adjusted_target_lookup(records)

    expected = 111.0 / 101.0 - 1.0 - CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
    assert lookup["2330"]["2026-01-01"][0] == pytest.approx(expected)
    assert lookup["2330"]["2026-01-01"][1] == "2026-01-06"


def test_adjusted_target_lookup_rejects_missing_exchange_session_bars():
    calendar = [f"2026-06-{day:02d}" for day in range(1, 9)]
    records = [
        {
            "symbol": "2330",
            "dates": calendar,
            "open": [100.0 + day for day in range(8)],
            "close": [100.5 + day for day in range(8)],
        },
        {
            "symbol": "3665",
            "dates": [date for date in calendar if date != "2026-06-02"],
            "open": [200.0 + day for day in range(7)],
            "close": [200.5 + day for day in range(7)],
        },
    ]

    lookup = build_adjusted_target_lookup(records)

    assert "2026-06-01" not in lookup["3665"]
    assert "2026-06-01" in lookup["2330"]


def test_sequence_manifest_checksum_matches_long_history_producer():
    manifest = {
        "schema_version": "finlab-long-history-sequence-prep-v2",
        "status": "ready",
        "contract": "sequence_records_v3",
        "output_gcs_prefix": "universal/sequence_long/runs/example",
        "batch_count": 1,
        "summary": {"date_min": "2025-01-02", "date_max": "2026-07-23"},
        "output_checksums": {"batch_0.npz": "a" * 64},
    }

    assert _sequence_manifest_checksum(manifest) == producer_manifest_checksum(manifest)

@pytest.mark.parametrize("batch_count", [1, 10, 12, 20])
def test_source_receipt_inventory_uses_same_order_for_multi_digit_batches(monkeypatch, batch_count):
    import hashlib
    import json
    from app import canonical_adjusted_prep as prep
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "a" * 40)
    objects = {f"features/prep/batch_{i}.npz": f"batch-{i}".encode() for i in range(batch_count)}
    objects["features/prep/feature_names.json"] = b'["feature"]'
    receipt = {
        "feature_names_path": "features/prep/feature_names.json",
        "schema_version": prep.SOURCE_RECEIPT_SCHEMA_VERSION,
        "feature_semantic_version": prep.FEATURE_SEMANTIC_VERSION,
        "feature_imputation_semantic": prep.FEATURE_IMPUTATION_SEMANTIC_VERSION,
        "producer_source_sha": "a" * 40,
        "status": "ready", "output_gcs_prefix": "features", "batch_count": batch_count,
        "output_checksums": {k: hashlib.sha256(v).hexdigest() for k, v in objects.items()},
    }
    receipt["receipt_checksum"] = hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest()
    objects["features/prep/immutable_receipt.json"] = json.dumps(receipt).encode()
    class Bucket:
        def blob(self, name):
            class Blob:
                def exists(self): return name in objects
                def download_as_text(self): return objects[name].decode()
                def download_as_bytes(self): return objects[name]
            return Blob()
    assert prep._verified_source_receipt(Bucket(), "features", batch_count) == receipt
    # Metadata and data are both checksum-protected.
    original = objects["features/prep/feature_names.json"]
    objects["features/prep/feature_names.json"] = b'["tampered"]'
    with pytest.raises(ValueError, match="checksum_mismatch"):
        prep._verified_source_receipt(Bucket(), "features", batch_count)
    objects["features/prep/feature_names.json"] = original
    # Real missing and altered batches must still be rejected.
    objects["features/prep/batch_0.npz"] = b"changed"
    with pytest.raises(ValueError, match="checksum_mismatch"):
        prep._verified_source_receipt(Bucket(), "features", batch_count)


def test_event_inventory_survives_adjustment_and_both_training_consumers(monkeypatch, tmp_path):
    import hashlib
    import io
    import json
    import sys
    from pathlib import Path
    from types import SimpleNamespace
    import numpy as np
    from app import canonical_adjusted_prep as prep
    from app.features import FEATURE_COLS
    from app.timexer_job import materialize_inputs
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ml-controller"))
    from routers.retrain_trigger import _verify_prebuilt_canonical_prep

    sha = "a" * 40
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", sha)
    n = 10000
    buffer = io.BytesIO()
    np.savez_compressed(buffer, dates=np.array(["2026-01-01"] * n),
        symbols=np.array(["2330"] * n), markets=np.array(["LISTED"] * n),
        X=np.zeros((n, 137), dtype=np.float32))
    objects = {"features/prep/batch_0.npz": buffer.getvalue(),
        "features/prep/feature_names.json": json.dumps(list(FEATURE_COLS)).encode(),
        "sequence/prep/batch_0.npz": b"verified-sequence"}
    receipt = {"schema_version": prep.SOURCE_RECEIPT_SCHEMA_VERSION,
        "feature_semantic_version": prep.FEATURE_SEMANTIC_VERSION,
        "feature_imputation_semantic": prep.FEATURE_IMPUTATION_SEMANTIC_VERSION,
        "producer_source_sha": sha, "business_date": "2026-01-07",
        "status": "ready", "output_gcs_prefix": "features", "batch_count": 1,
        "feature_names_path": "features/prep/feature_names.json",
        "output_checksums": {k: hashlib.sha256(v).hexdigest() for k, v in objects.items() if k.startswith("features/")}}
    receipt["receipt_checksum"] = hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest()
    objects["features/prep/immutable_receipt.json"] = json.dumps(receipt).encode()
    sequence = {"status": "ready", "contract": "sequence_records_v3", "output_gcs_prefix": "sequence",
        "batch_count": 1, "summary": {"date_min": "2026-01-01", "date_max": "2026-01-07"},
        "output_checksums": {"sequence/prep/batch_0.npz": hashlib.sha256(b"verified-sequence").hexdigest()}}
    sequence["manifest_checksum"] = prep._sequence_manifest_checksum(sequence)
    objects["sequence/prep/sequence_manifest.json"] = json.dumps(sequence).encode()
    class Bucket:
        def blob(self, name):
            class Blob:
                def exists(self): return name in objects
                def download_as_text(self): return objects[name].decode()
                def download_as_bytes(self): return objects[name]
                def upload_from_string(self, raw, **kwargs): objects[name] = raw.encode() if isinstance(raw, str) else raw
            return Blob()
    bucket = Bucket()
    monkeypatch.setattr(prep, "_get_bucket", lambda: bucket)
    records = [{"symbol": "2330", "dates": [f"2026-01-{i:02d}" for i in range(1, 8)],
        "open": [100.] * 7, "close": [110.] * 7}]
    monkeypatch.setattr(prep, "load_sequence_dataset", lambda _: SimpleNamespace(records=records))
    payload = {"source_gcs_prefix": "features", "sequence_gcs_prefix": "sequence",
        "output_gcs_prefix": "adjusted", "batch_count": 1, "sequence_batch_count": 1}
    manifest = prep.rebuild_canonical_adjusted_prep(payload)
    assert manifest["source_checksums"] == receipt["output_checksums"]
    training = {"run_date": "2026-01-07", "dataset_snapshot": {
        "manifest_path": "adjusted/prep/manifest.json", "manifest_checksum": manifest["manifest_checksum"]}}
    _, counts = materialize_inputs(bucket, training, tmp_path)
    assert counts == {"2026-01-01": n}
    full_fit = _verify_prebuilt_canonical_prep(bucket=bucket, prefix="adjusted",
        expected_manifest_checksum=manifest["manifest_checksum"],
        expected_target_semantic_version=manifest["target_semantic_version"], expected_producer_source_sha=sha)
    assert full_fit["total_rows"] == n
    assert prep.rebuild_canonical_adjusted_prep(payload)["status"] == "idempotent_ready"
    # Even whitespace-only metadata mutation must fail exact-byte provenance.
    objects["features/prep/feature_names.json"] += b" "
    with pytest.raises(ValueError, match="feature_names_changed"):
        materialize_inputs(bucket, training, tmp_path)
    with pytest.raises(ValueError, match="checksum_mismatch"):
        prep.rebuild_canonical_adjusted_prep(payload)
