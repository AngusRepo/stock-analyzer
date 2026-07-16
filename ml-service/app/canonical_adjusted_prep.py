"""Build immutable Active-8 prep with canonical adjusted net-return labels."""

from __future__ import annotations

import hashlib
import io
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .model_store import _get_bucket
from .oof_lineage import canonical_market_segment, percentile_rank_by_date_market
from .research_benchmarks.common import load_sequence_dataset
from .sequence_training import CANONICAL_ROUNDTRIP_COST_BPS, SEQUENCE_RETURN_SEMANTIC_VERSION


SCHEMA_VERSION = "active8-canonical-adjusted-prep-v1"


def build_adjusted_target_lookup(records: list[dict[str, Any]]) -> dict[str, dict[str, tuple[float, str]]]:
    output: dict[str, dict[str, tuple[float, str]]] = {}
    cost = CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
    for record in records:
        symbol = str(record.get("symbol") or "").strip()
        dates = [str(value)[:10] for value in (record.get("dates") or [])]
        opens = np.asarray(record.get("open") or [], dtype=float)
        closes = np.asarray(record.get("close") or [], dtype=float)
        if not symbol or len(dates) != len(opens) or len(dates) != len(closes):
            continue
        targets: dict[str, tuple[float, str]] = {}
        for idx in range(0, len(dates) - 5):
            entry_open = float(opens[idx + 1])
            outcome_close = float(closes[idx + 5])
            if not np.isfinite(entry_open) or entry_open <= 0 or not np.isfinite(outcome_close):
                continue
            targets[dates[idx]] = (outcome_close / entry_open - 1.0 - cost, dates[idx + 5])
        if targets:
            output[symbol] = targets
    return output


def _load_npz(raw: bytes) -> dict[str, np.ndarray]:
    data = np.load(io.BytesIO(raw), allow_pickle=True)
    return {name: np.asarray(data[name]) for name in data.files}


def _market_map(batches: list[dict[str, np.ndarray]]) -> dict[str, str]:
    observed: dict[str, Counter[str]] = defaultdict(Counter)
    for batch in batches:
        for symbol, market in zip(batch["symbols"].astype(str), batch["markets"].astype(str)):
            canonical = canonical_market_segment(market)
            if canonical in {"LISTED", "OTC", "EMERGING"}:
                observed[str(symbol)][canonical] += 1
    return {
        symbol: counts.most_common(1)[0][0]
        for symbol, counts in observed.items()
        if counts
    }


def rebuild_canonical_adjusted_prep(payload: dict[str, Any]) -> dict[str, Any]:
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    source_prefix = str(payload.get("source_gcs_prefix") or "universal").strip().rstrip("/")
    sequence_prefix = str(
        payload.get("sequence_gcs_prefix") or "universal/sequence_long/latest"
    ).strip().rstrip("/")
    output_prefix = str(payload.get("output_gcs_prefix") or "").strip().rstrip("/")
    batch_count = int(payload.get("batch_count") or 5)
    sequence_batch_count = int(payload.get("sequence_batch_count") or 5)
    if not output_prefix or output_prefix in {source_prefix, sequence_prefix}:
        raise ValueError("canonical_adjusted_output_prefix_must_be_new")

    manifest_blob = bucket.blob(f"{output_prefix}/prep/manifest.json")
    if manifest_blob.exists():
        manifest = json.loads(manifest_blob.download_as_text())
        if (
            manifest.get("schema_version") == SCHEMA_VERSION
            and manifest.get("source_gcs_prefix") == source_prefix
            and manifest.get("sequence_gcs_prefix") == sequence_prefix
        ):
            return {"status": "idempotent_ready", **manifest}
        raise ValueError("canonical_adjusted_output_prefix_collision")

    source_batches: list[dict[str, np.ndarray]] = []
    source_checksums: dict[str, str] = {}
    for index in range(batch_count):
        path = f"{source_prefix}/prep/batch_{index}.npz"
        raw = bucket.blob(path).download_as_bytes()
        source_checksums[path] = hashlib.sha256(raw).hexdigest()
        source_batches.append(_load_npz(raw))

    sequence_records = load_sequence_dataset({
        "sequence_gcs_prefix": sequence_prefix,
        "sequence_batch_count": sequence_batch_count,
    }).records
    target_lookup = build_adjusted_target_lookup(sequence_records)
    market_by_symbol = _market_map(source_batches)

    staged: list[dict[str, Any]] = []
    total_input_rows = 0
    total_matched_rows = 0
    for batch in source_batches:
        dates = batch["dates"].astype(str)
        symbols = batch["symbols"].astype(str)
        targets = np.full(len(dates), np.nan, dtype=float)
        known_dates = np.full(len(dates), "", dtype=object)
        markets = np.asarray([market_by_symbol.get(symbol, "") for symbol in symbols], dtype=object)
        for idx, (date, symbol) in enumerate(zip(dates, symbols)):
            target = target_lookup.get(symbol, {}).get(str(date)[:10])
            if target is None or not markets[idx]:
                continue
            targets[idx] = float(target[0])
            known_dates[idx] = str(target[1])
        mask = np.isfinite(targets) & (known_dates.astype(str) != "") & (markets.astype(str) != "")
        total_input_rows += len(mask)
        total_matched_rows += int(mask.sum())
        staged.append({
            "source": batch,
            "mask": mask,
            "targets": targets[mask],
            "known_dates": known_dates[mask],
            "markets": markets[mask],
            "dates": dates[mask],
        })

    all_targets = np.concatenate([row["targets"] for row in staged])
    all_dates = np.concatenate([row["dates"] for row in staged])
    all_markets = np.concatenate([row["markets"] for row in staged])
    all_ranks = percentile_rank_by_date_market(all_targets, all_dates, all_markets)
    rank_offset = 0
    output_checksums: dict[str, str] = {}
    output_rows: list[int] = []
    for index, row in enumerate(staged):
        source = row["source"]
        mask = row["mask"]
        count = int(mask.sum())
        arrays = {
            name: values[mask]
            for name, values in source.items()
            if len(values.shape) >= 1 and values.shape[0] == len(mask)
        }
        arrays.update({
            "y": all_ranks[rank_offset:rank_offset + count],
            "target_returns": row["targets"],
            "dates": row["dates"].astype(object),
            "symbols": source["symbols"][mask].astype(object),
            "markets": row["markets"].astype(object),
            "label_known_dates": row["known_dates"].astype(object),
        })
        for name, values in source.items():
            if name not in arrays and (len(values.shape) == 0 or values.shape[0] != len(mask)):
                arrays[name] = values
        rank_offset += count
        buffer = io.BytesIO()
        np.savez_compressed(buffer, **arrays)
        encoded = buffer.getvalue()
        path = f"{output_prefix}/prep/batch_{index}.npz"
        bucket.blob(path).upload_from_string(encoded, content_type="application/octet-stream")
        output_checksums[path] = hashlib.sha256(encoded).hexdigest()
        output_rows.append(count)

    feature_source = bucket.blob(f"{source_prefix}/prep/feature_names.json")
    if feature_source.exists():
        bucket.blob(f"{output_prefix}/prep/feature_names.json").upload_from_string(
            feature_source.download_as_bytes(),
            content_type="application/json",
        )
    bucket.blob(f"{output_prefix}/prep/symbol_market.json").upload_from_string(
        json.dumps(market_by_symbol, sort_keys=True),
        content_type="application/json",
    )
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "status": "ready",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_gcs_prefix": source_prefix,
        "sequence_gcs_prefix": sequence_prefix,
        "output_gcs_prefix": output_prefix,
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        "roundtrip_cost_bps": CANONICAL_ROUNDTRIP_COST_BPS,
        "rank_semantic_version": "same-market-same-date-global-percentile-v2",
        "input_rows": total_input_rows,
        "output_rows": total_matched_rows,
        "coverage": round(total_matched_rows / max(1, total_input_rows), 8),
        "dates": len(set(all_dates.astype(str).tolist())),
        "symbols": len(market_by_symbol),
        "batch_rows": output_rows,
        "source_checksums": source_checksums,
        "output_checksums": output_checksums,
    }
    encoded_manifest = json.dumps(manifest, sort_keys=True).encode("utf-8")
    manifest["manifest_checksum"] = hashlib.sha256(encoded_manifest).hexdigest()
    manifest_blob.upload_from_string(
        json.dumps(manifest, sort_keys=True, indent=2),
        content_type="application/json",
    )
    return manifest

