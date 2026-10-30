"""T5 (C28-02): revisions between two archived vintages are masked, never trusted.

Monthly revenue locked values were measured to change (E4), so revenue is held at
level R with that limitation instead of asserting zero revisions (PIT-P0 3)."""
import copy
import hashlib
import io
import json

import polars as pl
import pytest

from services import pit_certification as pc
from services.training_auxiliary_capture import _mask_revised_quarters

QUARTERS = ["2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2"]


def _wide(values):
    return pl.DataFrame({"date": QUARTERS, **values})


def test_changed_cells_and_constant_rebase_are_revisions():
    old = _wide({"A": [1.0, 2.0, 3.0, 4.0], "B": [1.0, 2.0, 3.0, 4.0], "C": [1.0, None, 3.0, 4.0]})
    new = _wide({"A": [1.0, 2.0, 3.5, 4.0], "B": [1.1, 2.2, 3.3, 4.4], "C": [1.0, 9.0, 3.0, 4.0 + 1e-12]})
    got = pc.revised_quarter_cells(old, new)
    assert got["cells"] == [["A", "2026-Q1"]] + [["B", q] for q in QUARTERS]
    assert got["rebase_symbols"] == ["B"] and got["symbols"] == 2
    # A cell absent from one vintage is not an overlap; a float-noise change is not a revision.
    assert got["overlap_cells"] == 11 and got["changed_cells"] == 5


def test_repo_mask_is_bound_to_the_contract_by_sha256():
    contract = pc.load_contract()
    mask = pc.load_revision_mask(contract, "eps")
    raw = json.loads(pc.registry_path(contract["revision_masks"]["eps"]["file"]).read_text(encoding="utf-8"))
    assert len(mask["cells"]) == raw["changed_cells"] == 1442 and len({s for s, _ in mask["cells"]}) == raw["symbols"]
    assert {s for s in raw["rebase_symbols"]} <= {s for s, _ in mask["cells"]}
    assert all(q[:4].isdigit() and q[4:6] == "-Q" for _, q in mask["cells"])
    tampered = copy.deepcopy(contract)
    tampered["revision_masks"]["eps"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="pit_revision_mask_checksum_mismatch:eps"):
        pc.load_revision_mask(tampered, "eps")
    with pytest.raises(ValueError, match="pit_revision_mask_undeclared:roe"):
        pc.load_revision_mask(contract, "roe")


def test_revenue_is_not_claimed_revision_free():
    datasets = pc.load_contract()["datasets"]
    assert datasets["monthly_revenue"]["level"] == "R" and datasets["monthly_revenue"]["lag_sessions"] == 1
    assert any("rewritten" in line for line in datasets["monthly_revenue"]["evidence"])
    assert datasets["eps"]["revision_mask"] == "eps"


class Bucket:
    def __init__(self, files):
        self.files, self.reads = files, []

    def blob(self, name):
        bucket = self

        class Blob:
            def download_as_bytes(self):
                bucket.reads.append(name)
                return bucket.files[name]
        return Blob()


ROOT = "finlab/v4/backfill/cap"
EVENTS = "raw/training_auxiliary_full_vintage/eps_events.parquet"


def _capture(events: pl.DataFrame, sha=None):
    buf = io.BytesIO()
    events.write_parquet(buf)
    data = buf.getvalue()
    capture = {"capture_manifest_path": ROOT + "/raw/training_auxiliary_full_vintage/manifest.json",
               "meta": {"availability_proof": {"events_path": EVENTS,
                                               "events_sha256": sha or hashlib.sha256(data).hexdigest()}}}
    return Bucket({ROOT + "/" + EVENTS: data}), capture


def _events():
    return pl.DataFrame({"symbol": ["A", "A", "A", "B"],
                         "quarter": ["2025-Q4", "2026-Q1", "2025-Q3", "2026-Q1"],
                         # 2025-Q3 restated late: an older quarter never becomes active again.
                         "session": ["2026-03-31", "2026-05-15", "2026-06-01", "2026-05-15"]})


def _values():
    rows = [("A", "2026-03-30", 1.0), ("A", "2026-04-01", 2.0), ("A", "2026-05-15", 3.0), ("A", "2026-06-02", 3.0),
            ("B", "2026-05-15", 7.0), ("B", "2026-06-02", 7.0)]
    return pl.DataFrame(rows, schema={"symbol": pl.String, "date": pl.String, "value": pl.Float64}, orient="row")


def test_masked_active_quarter_rows_are_nulled_through_the_loader_helper():
    bucket, capture = _capture(_events())
    mask = {"sha256": "m" * 64, "cells": frozenset({("A", "2026-Q1"), ("A", "2025-Q3")})}
    out, info = _mask_revised_quarters(bucket, _values(), capture, mask)
    assert out.rows() == [("A", "2026-03-30", 1.0), ("A", "2026-04-01", 2.0), ("A", "2026-05-15", None),
                          ("A", "2026-06-02", None), ("B", "2026-05-15", 7.0), ("B", "2026-06-02", 7.0)]
    assert info["masked_rows"] == 2 and info["cells"] == 2 and info["events_sha256"] == capture["meta"]["availability_proof"]["events_sha256"]


def test_a_late_restated_older_quarter_does_not_mask_the_active_quarter():
    bucket, capture = _capture(_events())
    # Only 2025-Q3 (restated 2026-06-01) is revised; 2026-Q1 stays active, so nothing is masked.
    out, info = _mask_revised_quarters(bucket, _values(), capture,
                                       {"sha256": "m" * 64, "cells": frozenset({("A", "2025-Q3")})})
    assert out.equals(_values().sort("symbol", "date")) and info["masked_rows"] == 0
    # 2025-Q4 was active from 2026-03-31 until 2026-Q1 arrived on 2026-05-15.
    out, info = _mask_revised_quarters(bucket, _values(), capture,
                                       {"sha256": "m" * 64, "cells": frozenset({("A", "2025-Q4")})})
    assert out["value"].to_list() == [1.0, None, 3.0, 3.0, 7.0, 7.0] and info["masked_rows"] == 1


def test_mask_without_present_symbols_reads_nothing_and_bad_events_fail_closed():
    bucket, capture = _capture(_events())
    out, info = _mask_revised_quarters(bucket, _values(), capture, {"sha256": "m" * 64, "cells": frozenset({("Z", "2026-Q1")})})
    assert out.equals(_values()) and info["masked_rows"] == 0 and bucket.reads == []
    mask = {"sha256": "m" * 64, "cells": frozenset({("A", "2026-Q1")})}
    bucket, capture = _capture(_events(), sha="f" * 64)
    with pytest.raises(ValueError, match="root_auxiliary_revision_events_checksum_mismatch"):
        _mask_revised_quarters(bucket, _values(), capture, mask)
    capture["meta"]["availability_proof"] = {}
    with pytest.raises(ValueError, match="root_auxiliary_revision_events_missing"):
        _mask_revised_quarters(bucket, _values(), capture, mask)


def test_selected_field_captures_record_their_contract_level():
    from services.training_auxiliary_capture import FIELDS, select_field_captures

    manifest = json.dumps({"schema_version": "finlab-training-auxiliary-single-capture-v1", "capture_id": "cap",
                           "end_date": "2026-10-30",
                           "fields": {f: {"sha256": hashlib.sha256(f.encode()).hexdigest()} for f in FIELDS}}).encode()
    path = ROOT + "/raw/training_auxiliary_full_vintage/manifest.json"

    class Listing(Bucket):
        def list_blobs(self, prefix="", match_glob=None):
            return []

        def blob(self, name):
            blob = super().blob(name)
            blob.exists = lambda: name in self.files
            return blob

    price = {"capture_manifest_path": ROOT + "/raw/daily_price_full_vintage/manifest.json"}
    selected = select_field_captures(Listing({path: manifest}), price_capture=price, run_date="2026-10-30")
    # Every auxiliary field is level R in contract v1 (margin/short, valuation, revenue, eps, roe).
    assert {f: v["availability_level"] for f, v in selected.items()} == {f: "R" for f in FIELDS}


def test_the_r33_loader_applies_the_contract_eps_mask():
    from services.training_auxiliary_capture import FIELDS, load_training_auxiliary_capture

    contract = pc.load_contract()
    cells = pc.load_revision_mask(contract, "eps")["cells"]
    assert ("2245", "2025-Q4") in cells and ("2245", "2026-Q1") not in cells
    events = pl.DataFrame({"symbol": ["2245", "2245"], "quarter": ["2025-Q4", "2026-Q1"],
                           "session": ["2026-03-31", "2026-05-15"]})
    bucket, _ = _capture(events)
    folder = ROOT + "/raw/training_auxiliary_full_vintage"
    captures = {}
    for field in FIELDS:
        buf = io.BytesIO()
        pl.DataFrame({"date": ["2026-04-01", "2026-05-15"], "2245": [2.0, 3.0]}).write_parquet(buf)
        bucket.files[f"{folder}/{field}.parquet"] = buf.getvalue()
        meta = {"sha256": hashlib.sha256(buf.getvalue()).hexdigest(), "rows": 2, "columns": ["2245"]}
        if field == "eps":
            meta["availability_proof"] = {"events_path": EVENTS, "events_sha256": hashlib.sha256(
                bucket.files[ROOT + "/" + EVENTS]).hexdigest()}
        captures[field] = {"capture_id": "cap", "capture_manifest_path": folder + "/manifest.json", "meta": meta}
    dated, _, proof = load_training_auxiliary_capture(
        bucket, price_capture={"capture_id": "cap", "capture_manifest_path": ROOT + "/raw/daily_price_full_vintage/manifest.json"},
        stock_rows=[{"id": 1, "symbol": "2245"}], prices_map={"2245": [{"date": "2026-04-01"}, {"date": "2026-05-15"}]},
        prior_ts={}, prior_chips={}, run_date="2026-05-15", field_captures=captures)
    # 2025-Q4 is active on 2026-04-01 and revised: null. 2026-Q1 (active from 2026-05-15) is not.
    assert dated[1]["2026-04-01"]["eps"] is None and dated[1]["2026-05-15"]["eps"] == 3.0
    assert dated[1]["2026-04-01"]["roe"] == 2.0  # only fields the contract masks are masked
    mask = proof["fields"]["eps"]["revision_mask"]
    assert mask["sha256"] == contract["revision_masks"]["eps"]["sha256"] and mask["masked_rows"] == 1
    # Before the price window only the latest known value is carried in; a revised one falls
    # back to the latest unrevised value (2025-Q3) instead of leaving no history.
    events = pl.concat([pl.DataFrame({"symbol": ["2245"], "quarter": ["2025-Q3"], "session": ["2025-11-14"]}), events])
    bucket, _ = _capture(events)
    for field in FIELDS:
        buf = io.BytesIO()
        pl.DataFrame({"date": ["2026-02-02", "2026-04-01", "2026-05-15"], "2245": [1.0, 2.0, 3.0]}).write_parquet(buf)
        bucket.files[f"{folder}/{field}.parquet"] = buf.getvalue()
        captures[field]["meta"].update(sha256=hashlib.sha256(buf.getvalue()).hexdigest(), rows=3)
        if field == "eps":
            captures[field]["meta"]["availability_proof"]["events_sha256"] = hashlib.sha256(
                bucket.files[ROOT + "/" + EVENTS]).hexdigest()
    dated, _, _ = load_training_auxiliary_capture(
        bucket, price_capture={"capture_id": "cap", "capture_manifest_path": ROOT + "/raw/daily_price_full_vintage/manifest.json"},
        stock_rows=[{"id": 1, "symbol": "2245"}], prices_map={"2245": [{"date": "2026-05-15"}]},
        prior_ts={}, prior_chips={}, run_date="2026-05-15", field_captures=captures)
    assert {d: v["eps"] for d, v in dated[1].items() if "eps" in v} == {"2026-02-02": 1.0, "2026-05-15": 3.0}
    assert {d: v["roe"] for d, v in dated[1].items() if "roe" in v} == {"2026-04-01": 2.0, "2026-05-15": 3.0}
