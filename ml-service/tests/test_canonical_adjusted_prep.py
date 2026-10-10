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


@pytest.mark.parametrize("use131", [False, True])
def test_event_inventory_survives_adjustment_and_both_training_consumers(monkeypatch, tmp_path, use131):
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

    from app.formal_feature_contract import FEATURES131, FEATURE131_SEMANTIC, LEGACY_SEMANTIC
    names = list(FEATURES131) if use131 else list(FEATURE_COLS)
    semantic = FEATURE131_SEMANTIC if use131 else LEGACY_SEMANTIC
    sha = "a" * 40
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", sha)
    n = 10000
    buffer = io.BytesIO()
    np.savez_compressed(buffer, dates=np.array(["2026-01-01"] * n),
        symbols=np.array(["2330"] * n), markets=np.array(["LISTED"] * n),
        X=np.zeros((n, len(names)), dtype=np.float32), missingness_rates=np.zeros(len(names)))
    objects = {"features/prep/batch_0.npz": buffer.getvalue(),
        "features/prep/feature_names.json": json.dumps(names).encode(),
        "sequence/prep/batch_0.npz": b"verified-sequence"}
    receipt = {"schema_version": prep.SOURCE_RECEIPT_SCHEMA_VERSION,
        "feature_semantic_version": semantic,
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
    sequence["lane_reports"]=[{"lane":"daily_price","source_uri":{"capture_id":"capture-1",
        "checksums":{"adj_close":"b"*64,"adj_open":"c"*64}}}]
    sequence["manifest_checksum"] = prep._sequence_manifest_checksum(sequence)
    objects["sequence/prep/sequence_manifest.json"] = json.dumps(sequence).encode()
    receipt["price_capture"]={"schema_version":"training-price-capture-binding-v1","capture_id":"capture-1",
        "actual_price_values_sha256":"d"*64,"sequence_manifest_checksum":sequence["manifest_checksum"],
        "checksums":{"adj_close":"b"*64,"adj_open":"c"*64}}
    receipt["institutional_capture"]={"schema_version":"training-institutional-capture-binding-v1","capture_id":"capture-1",
        "actual_values_sha256":"e"*64,"checksums":{k:"f"*64 for k in ("foreign_net","trust_net","dealer_self_net","dealer_hedge_net")}}
    receipt["market_cap_capture"]={"schema_version":"training-market-cap-capture-binding-v1","capture_id":"capture-1",
        "market_value_sha256":"f"*64,"actual_values_sha256":"e"*64}
    receipt["auxiliary_capture"]={"schema_version":"training-auxiliary-capture-binding-v1","capture_id":"capture-1","capture_manifest_sha256":"a"*64}
    receipt["long_source_capture"]={"schema_version":"training-long-source-binding-v1","capture_id":"capture-1",**{k:{"manifest_sha256":"a"*64} for k in ("broker","holding")}}
    receipt["global_capture"]={"schema_version":"training-global-capture-binding-v1","capture_id":"capture-1","history_sha256":"a"*64}
    receipt.pop("receipt_checksum")
    receipt["receipt_checksum"]=hashlib.sha256(json.dumps(receipt,sort_keys=True).encode()).hexdigest()
    objects["features/prep/immutable_receipt.json"]=json.dumps(receipt).encode()

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
        "output_gcs_prefix": "adjusted", "feature_semantic_version":semantic, "batch_count": 1, "sequence_batch_count": 1}
    manifest = prep.rebuild_canonical_adjusted_prep(payload)
    assert manifest["source_checksums"] == receipt["output_checksums"]
    training = {"run_date": "2026-01-07", "settings":{"feature_history_schema":semantic}, "dataset_snapshot": {
        "manifest_path": "adjusted/prep/manifest.json", "manifest_checksum": manifest["manifest_checksum"]}}
    _, counts = materialize_inputs(bucket, training, tmp_path)
    assert counts == {"2026-01-01": n}
    full_fit = _verify_prebuilt_canonical_prep(bucket=bucket, prefix="adjusted",
        expected_manifest_checksum=manifest["manifest_checksum"],
        expected_target_semantic_version=manifest["target_semantic_version"], expected_producer_source_sha=sha, expected_feature_semantic=semantic)
    assert full_fit["total_rows"] == n
    assert full_fit["feature_semantic_version"] == semantic
    with pytest.raises(ValueError,match="feature_semantic|source_receipt"):
        _verify_prebuilt_canonical_prep(bucket=bucket,prefix="adjusted",
            expected_manifest_checksum=manifest["manifest_checksum"],
            expected_target_semantic_version=manifest["target_semantic_version"],expected_producer_source_sha=sha,
            expected_feature_semantic=LEGACY_SEMANTIC if use131 else FEATURE131_SEMANTIC)
    assert prep.rebuild_canonical_adjusted_prep(payload)["status"] == "idempotent_ready"
    # Even whitespace-only metadata mutation must fail exact-byte provenance.
    objects["features/prep/feature_names.json"] += b" "
    with pytest.raises(ValueError, match="feature_names_changed"):
        materialize_inputs(bucket, training, tmp_path)
    with pytest.raises(ValueError, match="checksum_mismatch"):
        prep.rebuild_canonical_adjusted_prep(payload)


def test_missingness_is_not_sliced_when_rows_equal_feature_width():
    import numpy as np
    from app.canonical_adjusted_prep import _slice_feature_batch
    rates=np.linspace(0,1,137);mask=np.arange(137)<100
    source={"X":np.zeros((137,137)),"dates":np.arange(137),"missingness_rates":rates}
    result=_slice_feature_batch(source,mask)
    assert result["X"].shape==(100,137) and result["dates"].shape==(100,)
    np.testing.assert_array_equal(result["missingness_rates"],rates)
    source.pop("missingness_rates")
    with pytest.raises(ValueError,match="missingness_required"):_slice_feature_batch(source,mask)
