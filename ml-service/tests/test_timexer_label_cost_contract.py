"""NEW-55: the TimeXer net label reads the canonical label cost instead of a literal."""
import json

import numpy as np
import pytest

pytest.importorskip("torch")

from app import sequence_training
from app import timexer_training as tt
from app.timexer_runtime import ARCHITECTURE, OFFICIAL_COMMIT


def _inputs(tmp_path):
    rng = np.random.default_rng(11)
    dates = np.array([str(np.datetime64("2025-01-01") + i) for i in range(200)])
    records, symbols, rows = [], [], []
    for symbol in ("1101", "2330"):
        close = (100 * np.exp(np.cumsum(rng.normal(0, 0.02, len(dates))))).astype(np.float32)
        opening = (close * (1 + rng.normal(0, 0.005, len(dates)))).astype(np.float32)
        records.append({"symbol": symbol, "dates": dates.tolist(), "close": close.tolist(), "open": opening.tolist()})
        symbols += [symbol] * len(dates)
        rows.append(rng.random((len(dates), 137), dtype=np.float32))
    (tmp_path / "features-ready/prep").mkdir(parents=True)
    np.savez(tmp_path / "features-ready/prep/batch_0.npz", symbols=np.array(symbols),
             dates=np.concatenate([dates, dates]), X=np.concatenate(rows))
    (tmp_path / "sequence/prep").mkdir(parents=True)
    np.savez(tmp_path / "sequence/prep/batch_0.npz", sequence_records=np.array(records, dtype=object))
    (tmp_path / "canonical/prep").mkdir(parents=True)
    (tmp_path / "canonical/prep/symbol_market.json").write_text(json.dumps({"1101": "TWSE", "2330": "TWSE"}))
    job = {"settings": dict(ARCHITECTURE, official_commit=OFFICIAL_COMMIT), "exogenous": True,
           "train_start": str(dates[0]), "test_end": str(dates[-1])}
    return job, {r["symbol"]: r for r in records}


def test_target_is_bit_identical_to_the_former_literal(tmp_path):
    job, records = _inputs(tmp_path)
    _series, rows, _coverage = tt.load_windows(tmp_path, job)
    assert rows
    for row in rows:
        record, end = records[row["symbol"]], row["end"]
        expected = float(np.float32(record["close"][end + 5])) / float(np.float32(record["open"][end + 1])) - 1 - 0.0018
        assert row["target"] == expected


def test_target_follows_the_canonical_cost_owner(tmp_path, monkeypatch):
    job, records = _inputs(tmp_path)
    monkeypatch.setattr(sequence_training, "CANONICAL_ROUNDTRIP_COST_BPS", 25.0)
    _series, rows, _coverage = tt.load_windows(tmp_path, job)
    row = rows[0]
    record, end = records[row["symbol"]], row["end"]
    gross = float(np.float32(record["close"][end + 5])) / float(np.float32(record["open"][end + 1])) - 1
    assert row["target"] == gross - 0.0025
