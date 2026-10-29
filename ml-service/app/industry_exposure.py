"""PIT industry membership sidecar shared by the §7 challengers.

The sidecar is an immutable npz built from D1
``sector_taxonomy_membership_snapshots_v1`` (tag_type='industry',
source='finlab.security_categories').  A row is labelled only from the latest
snapshot dated on or before its signal date; rows with no such snapshot stay
unlabelled and are excluded, never filled from a later snapshot.
"""
from __future__ import annotations

import hashlib
import io
import json
from typing import Any

import numpy as np

INDUSTRY_SIDECAR_SCHEMA_VERSION = "industry-pit-membership-sidecar-v1"
PIT_STATUSES = {
    "pit_snapshot": "every label comes from a snapshot dated <= signal date",
    "rule_inferred_backfill": "dates before the first snapshot reuse it; requires explicit Wei approval",
}


def encode_industry_sidecar(
    *,
    symbols,
    snapshot_dates,
    industries,
    pit_status: str,
    source: dict[str, Any],
) -> bytes:
    if pit_status not in PIT_STATUSES:
        raise ValueError(f"industry_sidecar_pit_status_invalid:{pit_status}")
    sym = np.asarray(symbols).astype(str)
    snap = np.asarray(snapshot_dates).astype(str)
    ind = np.asarray(industries).astype(str)
    if not (len(sym) == len(snap) == len(ind)) or not len(sym):
        raise ValueError("industry_sidecar_columns_misaligned")
    if np.any(sym == "") or np.any(ind == "") or np.any(snap == ""):
        raise ValueError("industry_sidecar_blank_value")
    if len(set(zip(sym.tolist(), snap.tolist()))) != len(sym):
        raise ValueError("industry_sidecar_symbol_snapshot_not_unique")
    metadata = {
        "schema_version": INDUSTRY_SIDECAR_SCHEMA_VERSION,
        "pit_status": pit_status,
        "pit_status_meaning": PIT_STATUSES[pit_status],
        "rows": int(len(sym)),
        "symbols": int(len(np.unique(sym))),
        "industries": int(len(np.unique(ind))),
        "snapshot_date_min": min(snap.tolist()),
        "snapshot_date_max": max(snap.tolist()),
        "snapshot_dates": int(len(np.unique(snap))),
        "source": source,
    }
    buffer = io.BytesIO()
    np.savez_compressed(buffer, metadata=np.asarray(json.dumps(metadata, sort_keys=True)),
                        symbols=sym, snapshot_dates=snap, industries=ind)
    return buffer.getvalue()


def decode_industry_sidecar(raw: bytes, *, expected_sha256: str) -> dict[str, Any]:
    actual = hashlib.sha256(raw).hexdigest()
    if not expected_sha256 or actual != str(expected_sha256).removeprefix("sha256:"):
        raise ValueError("industry_sidecar_checksum_mismatch")
    data = np.load(io.BytesIO(raw), allow_pickle=False)
    metadata = json.loads(str(data["metadata"]))
    if metadata.get("schema_version") != INDUSTRY_SIDECAR_SCHEMA_VERSION:
        raise ValueError("industry_sidecar_schema_mismatch")
    if metadata.get("pit_status") not in PIT_STATUSES:
        raise ValueError("industry_sidecar_pit_status_invalid")
    return {
        "metadata": {**metadata, "sha256": actual},
        "symbols": data["symbols"].astype(str),
        "snapshot_dates": data["snapshot_dates"].astype(str),
        "industries": data["industries"].astype(str),
    }


def load_industry_sidecar(bucket, spec: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(spec, dict) or not spec.get("path") or not spec.get("sha256"):
        raise ValueError("industry_exposure_spec_requires_path_and_sha256")
    blob = bucket.blob(str(spec["path"]))
    if not blob.exists():
        raise ValueError(f"industry_sidecar_missing:{spec['path']}")
    sidecar = decode_industry_sidecar(blob.download_as_bytes(), expected_sha256=str(spec["sha256"]))
    sidecar["metadata"]["path"] = str(spec["path"])
    return sidecar


def asof_industry(symbols, dates, sidecar: dict[str, Any]) -> np.ndarray:
    """Latest snapshot on or before each signal date; '' when none exists."""

    import polars as pl

    side = pl.DataFrame({
        "symbol": sidecar["symbols"],
        "snapshot_date": sidecar["snapshot_dates"],
        "industry": sidecar["industries"],
    })
    rows = pl.DataFrame({
        "_row": np.arange(len(symbols), dtype=np.int64),
        "symbol": np.asarray(symbols).astype(str),
        "date": np.asarray(dates).astype(str),
    })
    joined = rows.sort("date").join_asof(
        side.sort("snapshot_date"), left_on="date", right_on="snapshot_date", by="symbol", strategy="backward",
        check_sortedness=False,  # both sides are sorted on the asof key just above
    ).sort("_row")
    return joined["industry"].fill_null("").to_numpy().astype(str)


def coverage_report(labels: np.ndarray, dates: np.ndarray) -> dict[str, Any]:
    labelled = np.asarray(labels).astype(str) != ""
    d = np.asarray(dates).astype(str)
    return {
        "rows": int(len(labelled)),
        "labelled_rows": int(labelled.sum()),
        "coverage": round(float(labelled.mean()), 6) if len(labelled) else 0.0,
        "first_labelled_date": min(d[labelled].tolist()) if labelled.any() else None,
        "unlabelled_rows_excluded": int((~labelled).sum()),
    }
