"""Synthetic prep + in-memory GCS bucket for the §7 challenger tests and dry-run."""
from __future__ import annotations

import hashlib
import io
import json

import numpy as np

from app.formal_feature_contract import FEATURES131
from app.industry_exposure import encode_industry_sidecar

PREFIX = "challenger-dryrun"
INDUSTRIES = ("半導體業", "電子零組件業", "金融保險業")


class FakeBlob:
    def __init__(self, bucket, name: str):
        self.bucket, self.name = bucket, name
        self.data: bytes | None = None
        self.generation = None
        self.updated = None

    @property
    def size(self):
        return len(self.data or b"")

    def exists(self):
        return self.data is not None

    def reload(self):
        return None

    def download_as_bytes(self, **_kwargs):
        assert self.data is not None, self.name
        return self.data

    def download_as_text(self):
        return self.download_as_bytes().decode("utf-8")

    def download_to_file(self, buf):
        buf.write(self.download_as_bytes())

    def upload_from_string(self, data, content_type=None, if_generation_match=None, **_kwargs):
        if if_generation_match == 0 and self.data is not None:
            raise RuntimeError("precondition_failed")
        self.data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        self.generation = str(int(self.generation or 0) + 1)

    def upload_from_file(self, buf, content_type=None, **_kwargs):
        self.upload_from_string(buf.read(), content_type=content_type)


class FakeBucket:
    name = "fake-bucket"

    def __init__(self):
        self.blobs: dict[str, FakeBlob] = {}

    def blob(self, name: str) -> FakeBlob:
        return self.blobs.setdefault(name, FakeBlob(self, name))

    def list_blobs(self, prefix: str = ""):
        return [b for k, b in sorted(self.blobs.items()) if k.startswith(prefix) and b.exists()]


def business_dates(n: int, start: str = "2026-01-05") -> list[str]:
    days = np.busday_offset(np.datetime64(start), np.arange(n), roll="forward")
    return [str(d) for d in days]


def synthetic_prep(*, n_dates=90, n_symbols=60, horizon=5, seed=7, batch_count=2):
    """Prep rows whose target is industry effect + size effect + a neutral signal in feature 0."""

    rng = np.random.default_rng(seed)
    all_dates = business_dates(n_dates + horizon)
    signal_dates = all_dates[:n_dates]
    symbols = [f"{1100 + i}" for i in range(n_symbols)]
    industry_of = {s: INDUSTRIES[i % len(INDUSTRIES)] for i, s in enumerate(symbols)}
    market_of = {s: ("LISTED" if i % 2 == 0 else "OTC") for i, s in enumerate(symbols)}
    size_base = {s: rng.normal(22.0, 1.0) for s in symbols}
    size_index = FEATURES131.index("size_log_mktcap")
    rows = []
    for di, day in enumerate(signal_dates):
        for s in symbols:
            x = rng.normal(size=len(FEATURES131))
            x[size_index] = size_base[s] + rng.normal(0, 0.02)
            ind_effect = INDUSTRIES.index(industry_of[s]) * 0.02
            # Feature 0 carries industry/size exposure on top of an idiosyncratic signal.
            idio = rng.normal()
            x[0] = idio + 3.0 * INDUSTRIES.index(industry_of[s]) + 2.0 * (size_base[s] - 22.0)
            x[FEATURES131.index("advance_ratio")] = 0.37 + di * 0.001
            ret = 0.01 * idio + ind_effect + 0.005 * (size_base[s] - 22.0) + rng.normal(0, 0.01)
            rows.append((x, ret, day, s, market_of[s], all_dates[di + horizon]))
    X = np.stack([r[0] for r in rows])
    target = np.asarray([r[1] for r in rows])
    cols = {
        "dates": np.asarray([r[2] for r in rows], dtype=object),
        "symbols": np.asarray([r[3] for r in rows], dtype=object),
        "markets": np.asarray([r[4] for r in rows], dtype=object),
        "label_known_dates": np.asarray([r[5] for r in rows], dtype=object),
    }
    bucket = FakeBucket()
    splits = np.array_split(np.arange(len(rows)), batch_count)
    for b, idx in enumerate(splits):
        buf = io.BytesIO()
        np.savez_compressed(
            buf, X=X[idx], y=np.zeros(len(idx)), target_returns=target[idx],
            sectors=np.asarray(["unknown"] * len(idx), dtype=object),
            missingness_rates=np.zeros(len(FEATURES131)), **{k: v[idx] for k, v in cols.items()},
        )
        bucket.blob(f"{PREFIX}/prep/batch_{b}.npz").upload_from_string(buf.getvalue())
    bucket.blob(f"{PREFIX}/prep/feature_names.json").upload_from_string(json.dumps(list(FEATURES131)))
    return bucket, {
        "signal_dates": signal_dates, "symbol_list": symbols, "industry_of": industry_of,
        "market_of": market_of, "batch_count": batch_count, "X": X, "target": target, **cols,
    }


def put_industry_sidecar(bucket, info, *, snapshot_dates, pit_status="pit_snapshot"):
    syms, snaps, inds = [], [], []
    for day in snapshot_dates:
        for s in info["symbol_list"]:
            syms.append(s)
            snaps.append(day)
            inds.append(info["industry_of"][s])
    raw = encode_industry_sidecar(symbols=syms, snapshot_dates=snaps, industries=inds,
                                  pit_status=pit_status, source={"table": "synthetic"})
    path = f"{PREFIX}/exposures/industry.npz"
    bucket.blob(path).upload_from_string(raw)
    return {"path": path, "sha256": hashlib.sha256(raw).hexdigest()}
