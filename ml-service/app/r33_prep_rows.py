"""R33-NEW-11: under R33 the feature models read their serving row from the same sealed
oof_forward_prep_v2 prep the training rows came from (train = serve), not from a per-stock
rebuild (`historical_training=False`, whose size/eps/roe/pe/pb/revenue/margin fills differ
on about 13% of rows).

One view per PIT contract version: None is the legacy daily capture, a version is its
sealed PIT variant. A view is {"names", "rows": {symbol: row}, "receipt_checksum"} or the
error string that makes every artifact of that version unavailable for the day. A symbol
with no row on the signal date is unavailable for that version; it is never rebuilt.
"""
from __future__ import annotations

import hashlib
import io
import json
import threading
from contextvars import ContextVar

import numpy as np

SCHEMA = "r33-prep-feature-rows-v1"

# Set by modal_app around the R33 feature and GNN stages; None everywhere else.
PREP_VIEWS: ContextVar[dict | None] = ContextVar("r33_prep_views", default=None)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def load_view(bucket, source: dict, *, signal_date: str, symbols) -> dict:
    """Rows dated signal_date for the requested symbols, from one sealed prep."""
    from .formal_feature_contract import LEGACY_SEMANTIC
    from .timexer_inference import feature_receipt
    receipt = feature_receipt(bucket, source, signal_date,
                              expected_semantic=source.get("feature_semantic_version", LEGACY_SEMANTIC))
    prefix = source["source_gcs_prefix"].rstrip("/")
    checksums = receipt["output_checksums"]
    names_raw = bucket.blob(receipt["feature_names_path"]).download_as_bytes()
    if receipt["feature_names_path"] in checksums and _sha(names_raw) != checksums[receipt["feature_names_path"]]:
        raise ValueError("r33_prep_feature_names_checksum_mismatch")
    names = [str(name) for name in json.loads(names_raw)]
    wanted = {str(symbol) for symbol in symbols}
    rows: dict[str, np.ndarray] = {}
    for index in range(receipt["batch_count"]):
        path = f"{prefix}/prep/batch_{index}.npz"
        raw = bucket.blob(path).download_as_bytes()
        if _sha(raw) != checksums[path]:
            raise ValueError("r33_prep_shard_checksum_mismatch")
        with np.load(io.BytesIO(raw), allow_pickle=True) as shard:
            shard_symbols = shard["symbols"].astype(str)
            dates = np.asarray([str(d)[:10] for d in shard["dates"]])
            matrix = shard["X"]
        if matrix.ndim != 2 or matrix.shape[1] != len(names):
            raise ValueError("r33_prep_width_invalid")
        for position in np.flatnonzero((dates == signal_date) & np.isin(shard_symbols, list(wanted))):
            symbol = shard_symbols[position]
            if symbol in rows:
                raise ValueError("r33_prep_duplicate_row:" + symbol)
            rows[symbol] = np.asarray(matrix[position], dtype=np.float64).reshape(1, -1)
    return {"schema_version": SCHEMA, "names": names, "rows": rows,
            "receipt_checksum": receipt["receipt_checksum"], "signal_date": signal_date,
            "pit_contract_version": receipt.get("pit_contract_version")}


def load_views(bucket, sources: dict, *, signal_date: str, symbols) -> dict:
    """sources = {"base": legacy source, "pit": {version: source}} from the controller.

    The legacy view must load (TimeXer reads the same prep, so a failure here is
    structural); a PIT view that fails is that version's error string."""
    if not isinstance(sources, dict) or not isinstance(sources.get("base"), dict):
        raise ValueError("r33_prep_source_missing")
    views = {None: load_view(bucket, sources["base"], signal_date=signal_date, symbols=symbols)}
    if views[None]["pit_contract_version"] is not None:
        raise ValueError("r33_prep_base_source_not_legacy")
    for version, source in sorted((sources.get("pit") or {}).items()):
        try:
            view = load_view(bucket, source, signal_date=signal_date, symbols=symbols)
            if view["pit_contract_version"] != version:
                raise ValueError("pit_contract_version_serving_mismatch")
            views[version] = view
        except Exception as exc:  # noqa: BLE001 - only this version's artifacts become unavailable.
            views[version] = f"r33_prep_view_failed:{version}:{type(exc).__name__}:{exc}"[:300]
    return views


def context_views(views: dict, symbol: str) -> dict:
    """{version: (x, names) or error string} for one symbol, every version the day has."""
    out = {}
    for version, view in views.items():
        if isinstance(view, str):
            out[version] = view
        elif symbol in view["rows"]:
            out[version] = (view["rows"][symbol], list(view["names"]))
        else:
            out[version] = f"r33_prep_row_missing:{version}"
    return out


def stage_runner(pool_snapshot: dict, payload: dict, payloads, *, bucket_factory):
    """run(fn) calls fn with PREP_VIEWS set to the day's views under R33 (one load shared by
    the feature and GNN stages; a failed load fails both); outside R33 it just calls fn."""
    from .active8_ensemble_runtime import R33_KIND
    if (pool_snapshot.get("active8_ensemble") or {}).get("kind") != R33_KIND:
        return lambda fn: fn()
    lock, cache = threading.Lock(), {}

    def views():
        with lock:
            if "views" not in cache:
                try:
                    cache["views"] = load_views(
                        bucket_factory(), payload.get("r33_feature_prep_sources"), signal_date=payload["run_date"],
                        symbols=[str(p["symbol"]) for p in payloads if isinstance(p, dict) and p.get("symbol")])
                except Exception as exc:  # noqa: BLE001 - kept so the second stage fails the same way.
                    cache["views"] = exc
            if isinstance(cache["views"], Exception):
                raise cache["views"]
            return cache["views"]

    def run(fn):
        token = PREP_VIEWS.set(views())
        try:
            return fn()
        finally:
            PREP_VIEWS.reset(token)
    return run
