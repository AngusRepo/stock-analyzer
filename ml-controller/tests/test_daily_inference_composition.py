import hashlib
import io
import json
from pathlib import Path

import polars as pl
import pytest

from services.daily_inference_composition import append_wide_delta, read_frame, read_verified
from services.training_auxiliary_capture import FIELDS, load_training_auxiliary_capture


class Bucket:
    def __init__(self):
        self.files = {}

    def blob(self, path):
        owner = self
        class Blob:
            def download_as_bytes(self):
                return owner.files[path]
        return Blob()

    def put(self, path, raw):
        self.files[path] = raw
        return {"path": path, "sha256": hashlib.sha256(raw).hexdigest()}


def frame_item(bucket, name, frame):
    buf = io.BytesIO()
    frame.write_parquet(buf)
    original = bucket.put(name + "-original", buf.getvalue())
    return {**bucket.put(name, buf.getvalue()), "rows": frame.height,
            "columns": frame.columns, "inputs": [original], "availability": "vendor_date_index"}


def test_append_keeps_historical_zero_null_and_values_and_excludes_future():
    old = pl.DataFrame({"date": ["2026-10-07", "2026-10-08"], "2330": [0., None]})
    delta = pl.DataFrame({"date": ["2026-10-08", "2026-10-12", "2026-10-13"], "2330": [9., 2., 99.], "0050": [1., 3., 4.]})
    result = append_wide_delta(old, delta, baseline_end="2026-10-08", run_date="2026-10-12")
    assert result["2330"].to_list() == [0., None, 2.]
    assert result["0050"].to_list() == [None, None, 3.]


def test_duplicate_delta_rejected():
    old = pl.DataFrame({"date": ["2026-10-08"], "2330": [1.]})
    delta = pl.DataFrame({"date": ["2026-10-12"] * 2, "2330": [2., 3.]})
    with pytest.raises(ValueError, match="duplicate_or_null"):
        append_wide_delta(old, delta, baseline_end="2026-10-08", run_date="2026-10-12")


@pytest.mark.parametrize("mutation", ["source", "output", "future", "shape"])
def test_read_rejects_broken_lineage_or_output(mutation):
    b = Bucket()
    f = pl.DataFrame({"date": ["2026-10-13" if mutation == "future" else "2026-10-12"], "2330": [1.]})
    item = frame_item(b, "field", f)
    if mutation == "source": b.files["field-original"] = b"changed"
    if mutation == "output": b.files["field"] = b"changed"
    if mutation == "shape": item["rows"] = 2
    with pytest.raises(ValueError): read_frame(b, item, run_date="2026-10-12")


def test_composition_reaches_original_calendar_and_value_checks():
    b = Bucket()
    frame = pl.DataFrame({"date": ["2026-10-08", "2026-10-12"], "2330": [1., 2.]})
    composition = {"auxiliary": {f: frame_item(b, f, frame) for f in FIELDS},
                   "manifest_path": "composition.json", "manifest_sha256": "a" * 64}
    args = dict(price_capture={"capture_id": "daily", "capture_manifest_path": "raw/daily_price_full_vintage/manifest.json"},
                stock_rows=[{"id": "id2330", "symbol": "2330"}],
                prices_map={"id2330": [{"date": "2026-10-08"}, {"date": "2026-10-12"}]},
                prior_ts={}, prior_chips={}, run_date="2026-10-12", inference_composition=composition)
    dates, _, proof = load_training_auxiliary_capture(b, **args)
    assert dates["id2330"]["2026-10-12"]["pe"] == 2.
    assert proof["schema_version"] == "inference-auxiliary-composition-binding-v1"
    args["prices_map"]["id2330"].append({"date": "2026-10-07"})
    with pytest.raises(ValueError, match="market_dates_missing"):
        load_training_auxiliary_capture(b, **args)


def test_training_source_gate_still_requires_training_schema():
    from test_training_source_preflight import manifests, seal, Bucket as SourceBucket
    from services.training_source_preflight import require_single_adjustment_capture
    prep, sequence = manifests()
    prep['auxiliary_capture']['schema_version'] = 'inference-auxiliary-composition-binding-v1'
    with pytest.raises(ValueError, match='training_source_auxiliary_binding_required'):
        require_single_adjustment_capture(SourceBucket(seal(prep), sequence),
                                          prep_gcs_prefix='prep', sequence_gcs_prefix='seq')
