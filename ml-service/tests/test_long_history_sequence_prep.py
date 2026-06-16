from __future__ import annotations

import io
import json

import numpy as np
import polars as pl
import pytest

from app.long_history_sequence_prep import (
    SequenceSourceInvalidError,
    SequenceSourceMissingError,
    build_finlab_long_history_sequence_prep,
)
from app.research_benchmarks import common
from app.gcs_batch_io import clear_gcs_batch_cache


class _Blob:
    def __init__(self, store: dict[str, bytes], key: str):
        self.store = store
        self.key = key

    def exists(self) -> bool:
        return self.key in self.store

    def download_as_bytes(self) -> bytes:
        return self.store[self.key]

    def download_as_text(self) -> str:
        return self.store[self.key].decode("utf-8")

    def upload_from_string(self, data, content_type: str | None = None) -> None:
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.store[self.key] = bytes(data)


class _Bucket:
    def __init__(self):
        self.store: dict[str, bytes] = {}

    def blob(self, key: str) -> _Blob:
        return _Blob(self.store, key)


def _write_finlab_close_artifact(root):
    daily = root / "raw" / "daily_price"
    emerging = root / "raw" / "emerging_price_diversity"
    daily.mkdir(parents=True)
    emerging.mkdir(parents=True)

    dates = [f"2024-01-{day:02d}" for day in range(1, 9)]
    pl.DataFrame({
        "date": dates,
        "2330 TSMC": [100 + day for day in range(8)],
        "2317": [50 + day for day in range(8)],
        "bad": [None, 1, 2, 3, 4, 5, 6, 7],
    }).write_parquet(daily / "close.parquet")
    pl.DataFrame({
        "date": dates,
        "1260": [20 + day for day in range(8)],
    }).write_parquet(emerging / "close.parquet")


def test_build_finlab_long_history_sequence_prep_from_local_artifact(tmp_path):
    _write_finlab_close_artifact(tmp_path)

    result = build_finlab_long_history_sequence_prep({
        "source_artifact_root": str(tmp_path),
        "min_len": 8,
        "dry_run": True,
        "return_records": True,
    })

    assert result["status"] == "ok"
    assert result["dry_run"] is True
    assert result["batch_count"] == 1
    assert result["manifest"]["source"]["no_finlab_api_call"] is True
    assert result["manifest"]["summary"]["symbols"] == 3
    assert result["manifest"]["summary"]["max_series_len"] == 8
    assert result["manifest"]["summary"]["date_min"] == "2024-01-01"
    assert result["records"][0]["symbol"] == "1260"
    assert result["records"][0]["sequence_source"] == "finlab_long_history"


def test_build_finlab_long_history_sequence_prep_uploads_sequence_only_npz(tmp_path):
    _write_finlab_close_artifact(tmp_path)
    bucket = _Bucket()

    result = build_finlab_long_history_sequence_prep({
        "source_artifact_root": str(tmp_path),
        "output_gcs_prefix": "universal/sequence_long",
        "min_len": 8,
        "batch_size": 2,
    }, bucket=bucket)

    assert result["status"] == "ok"
    assert result["records"] == []
    assert result["output_paths"] == [
        "universal/sequence_long/prep/batch_0.npz",
        "universal/sequence_long/prep/batch_1.npz",
    ]
    assert json.loads(bucket.store["universal/sequence_long/prep/feature_names.json"].decode("utf-8")) == ["close"]
    manifest = json.loads(bucket.store["universal/sequence_long/prep/sequence_manifest.json"].decode("utf-8"))
    assert manifest["contract"] == "sequence_records_v2"

    npz = np.load(io.BytesIO(bucket.store["universal/sequence_long/prep/batch_0.npz"]), allow_pickle=True)
    records = npz["sequence_records"].tolist()
    assert len(records) == 2
    assert records[0]["dates"][0] == "2024-01-01"
    assert len(records[0]["close"]) == 8


def test_build_finlab_long_history_sequence_prep_reads_gs_style_prefix(tmp_path):
    _write_finlab_close_artifact(tmp_path)
    bucket = _Bucket()
    raw = (tmp_path / "raw" / "daily_price" / "close.parquet").read_bytes()
    bucket.store["finlab/v4/backfill/run-1/raw/daily_price/close.parquet"] = raw

    result = build_finlab_long_history_sequence_prep({
        "source_gcs_prefix": "gs://stockvision-models/finlab/v4/backfill/run-1",
        "lanes": ["daily_price"],
        "min_len": 8,
        "dry_run": True,
    }, bucket=bucket)

    assert result["status"] == "ok"
    assert result["manifest"]["lane_reports"][0]["source_uri"] == (
        "gs://stockvision-models/finlab/v4/backfill/run-1/raw/daily_price/close.parquet"
    )
    assert result["manifest"]["summary"]["symbols"] == 2


def test_build_finlab_long_history_sequence_prep_requires_requested_source(tmp_path):
    with pytest.raises(SequenceSourceMissingError, match="missing source parquet"):
        build_finlab_long_history_sequence_prep({
            "source_artifact_root": str(tmp_path),
            "lanes": ["daily_price"],
            "min_len": 8,
            "dry_run": True,
        })


def test_build_finlab_long_history_sequence_prep_rejects_invalid_source_schema(tmp_path):
    lane = tmp_path / "raw" / "daily_price"
    lane.mkdir(parents=True)
    pl.DataFrame({"2330": [100.0, 101.0]}).write_parquet(lane / "close.parquet")

    with pytest.raises(SequenceSourceInvalidError, match="missing date column"):
        build_finlab_long_history_sequence_prep({
            "source_artifact_root": str(tmp_path),
            "lanes": ["daily_price"],
            "min_len": 2,
            "dry_run": True,
        })


def test_build_finlab_long_history_sequence_prep_stitches_multiple_gcs_prefixes(tmp_path):
    bucket = _Bucket()
    base = tmp_path / "base.parquet"
    tail = tmp_path / "tail.parquet"
    pl.DataFrame({
        "date": ["2024-01-01", "2024-01-02", "2024-01-03"],
        "2330": [100.0, 101.0, 102.0],
    }).write_parquet(base)
    pl.DataFrame({
        "date": ["2024-01-03", "2024-01-04", "2024-01-05"],
        "2330": [103.0, 104.0, 105.0],
    }).write_parquet(tail)
    bucket.store["finlab/base/raw/daily_price/close.parquet"] = base.read_bytes()
    bucket.store["finlab/tail/raw/daily_price/close.parquet"] = tail.read_bytes()

    result = build_finlab_long_history_sequence_prep({
        "source_gcs_prefixes": [
            "gs://stockvision-models/finlab/base",
            "gs://stockvision-models/finlab/tail",
        ],
        "lanes": ["daily_price"],
        "min_len": 5,
        "dry_run": True,
        "return_records": True,
    }, bucket=bucket)

    assert result["status"] == "ok"
    assert result["records"][0]["dates"] == [
        "2024-01-01",
        "2024-01-02",
        "2024-01-03",
        "2024-01-04",
        "2024-01-05",
    ]
    assert result["records"][0]["close"] == [100.0, 101.0, 103.0, 104.0, 105.0]
    assert result["manifest"]["source"]["source_gcs_prefixes"] == [
        "gs://stockvision-models/finlab/base",
        "gs://stockvision-models/finlab/tail",
    ]


def test_sequence_loader_prefers_sequence_gcs_prefix(monkeypatch):
    bucket = _Bucket()
    records = [{
        "symbol": "2330",
        "market_type": "TW_LISTED_OTC",
        "close": [100.0, 101.0, 102.0],
        "dates": ["2024-01-01", "2024-01-02", "2024-01-03"],
    }]
    buf = io.BytesIO()
    np.savez_compressed(buf, sequence_records=np.asarray(records, dtype=object))
    bucket.store["universal/sequence_long/prep/batch_0.npz"] = buf.getvalue()
    clear_gcs_batch_cache()
    monkeypatch.setattr(common, "_bucket", lambda: bucket)

    dataset = common.load_sequence_dataset({
        "gcs_prefix": "universal",
        "batch_count": 5,
        "sequence_gcs_prefix": "universal/sequence_long",
        "sequence_batch_count": 1,
    })

    assert dataset.source == "gs://*/universal/sequence_long/prep/*.npz"
    assert dataset.records == records
