"""Build immutable Active-8 prep with canonical adjusted net-return labels."""

from __future__ import annotations

import hashlib
import io
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .features import FEATURE_IMPUTATION_SEMANTIC_VERSION, FEATURE_SEMANTIC_VERSION
from .model_store import _get_bucket
from .oof_lineage import canonical_market_segment, percentile_rank_by_date_market
from .research_benchmarks.common import load_sequence_dataset
from .sequence_training import (
    CANONICAL_ROUNDTRIP_COST_BPS,
    SEQUENCE_RETURN_SEMANTIC_VERSION,
    canonical_session_calendar,
)


SCHEMA_VERSION = "active8-canonical-adjusted-prep-v3"
SOURCE_RECEIPT_SCHEMA_VERSION = "active8-immutable-feature-prep-receipt-v2"


def _runtime_source_sha() -> str:
    source_sha = str(os.environ.get("STOCKVISION_SOURCE_SHA") or "").strip().lower()
    if len(source_sha) != 40 or any(char not in "0123456789abcdef" for char in source_sha):
        raise RuntimeError("stockvision_source_sha_missing_or_invalid")
    return source_sha

def _manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    return hashlib.sha256(json.dumps(unsigned, sort_keys=True).encode("utf-8")).hexdigest()


def _sequence_manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    return hashlib.sha256(
        json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

def _verified_source_receipt(bucket: Any, prefix: str, batch_count: int) -> dict[str, Any]:
    path = f"{prefix}/prep/immutable_receipt.json"
    blob = bucket.blob(path)
    if not blob.exists():
        raise ValueError("canonical_adjusted_source_receipt_missing")
    receipt = json.loads(blob.download_as_text().lstrip("\ufeff"))
    unsigned = {key: value for key, value in receipt.items() if key != "receipt_checksum"}
    if (
        receipt.get("schema_version") != SOURCE_RECEIPT_SCHEMA_VERSION
        or receipt.get("feature_semantic_version") != FEATURE_SEMANTIC_VERSION
        or receipt.get("feature_imputation_semantic") != FEATURE_IMPUTATION_SEMANTIC_VERSION
        or receipt.get("producer_source_sha") != _runtime_source_sha()
        or receipt.get("status") != "ready"
        or str(receipt.get("output_gcs_prefix") or "").rstrip("/") != prefix
        or int(receipt.get("batch_count") or 0) != batch_count
        or receipt.get("receipt_checksum")
        != hashlib.sha256(json.dumps(unsigned, sort_keys=True).encode("utf-8")).hexdigest()
    ):
        raise ValueError("canonical_adjusted_source_receipt_invalid")
    checksums = receipt.get("output_checksums") or {}
    expected = [f"{prefix}/prep/batch_{index}.npz" for index in range(batch_count)]
    if sorted(checksums) != expected:
        raise ValueError("canonical_adjusted_source_inventory_invalid")
    for artifact_path, checksum in checksums.items():
        raw = bucket.blob(artifact_path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != checksum:
            raise ValueError(f"canonical_adjusted_source_checksum_mismatch:{artifact_path}")
    return receipt


def _verified_sequence_manifest(bucket: Any, prefix: str, batch_count: int) -> dict[str, Any]:
    path = f"{prefix}/prep/sequence_manifest.json"
    blob = bucket.blob(path)
    if not blob.exists():
        raise ValueError("canonical_adjusted_sequence_manifest_missing")
    manifest = json.loads(blob.download_as_text().lstrip("\ufeff"))
    if (
        manifest.get("status") != "ready"
        or manifest.get("contract") != "sequence_records_v3"
        or str(manifest.get("output_gcs_prefix") or "").rstrip("/") != prefix
        or int(manifest.get("batch_count") or 0) != batch_count
        or manifest.get("manifest_checksum") != _sequence_manifest_checksum(manifest)
    ):
        raise ValueError("canonical_adjusted_sequence_manifest_invalid")
    checksums = manifest.get("output_checksums") or {}
    expected_batches = [f"{prefix}/prep/batch_{index}.npz" for index in range(batch_count)]
    if any(path not in checksums for path in expected_batches):
        raise ValueError("canonical_adjusted_sequence_inventory_invalid")
    for artifact_path, checksum in checksums.items():
        raw = bucket.blob(artifact_path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != checksum:
            raise ValueError(f"canonical_adjusted_sequence_checksum_mismatch:{artifact_path}")
    return manifest

def build_adjusted_target_lookup(records: list[dict[str, Any]]) -> dict[str, dict[str, tuple[float, str]]]:
    output: dict[str, dict[str, tuple[float, str]]] = {}
    cost = CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
    calendar = canonical_session_calendar(records)
    calendar_index = {date: idx for idx, date in enumerate(calendar)}
    for record in records:
        symbol = str(record.get("symbol") or "").strip()
        dates = [str(value)[:10] for value in (record.get("dates") or [])]
        opens = np.asarray(record.get("open") or [], dtype=float)
        closes = np.asarray(record.get("close") or [], dtype=float)
        if not symbol or len(dates) != len(opens) or len(dates) != len(closes):
            continue
        row_index = {date: idx for idx, date in enumerate(dates)}
        targets: dict[str, tuple[float, str]] = {}
        for signal_date in dates:
            signal_idx = calendar_index.get(signal_date)
            if signal_idx is None or signal_idx + 5 >= len(calendar):
                continue
            entry_date = calendar[signal_idx + 1]
            outcome_date = calendar[signal_idx + 5]
            if entry_date not in row_index or outcome_date not in row_index:
                continue
            entry_open = float(opens[row_index[entry_date]])
            outcome_close = float(closes[row_index[outcome_date]])
            if not np.isfinite(entry_open) or entry_open <= 0 or not np.isfinite(outcome_close):
                continue
            targets[signal_date] = (outcome_close / entry_open - 1.0 - cost, outcome_date)
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

    source_receipt = _verified_source_receipt(bucket, source_prefix, batch_count)
    sequence_manifest = _verified_sequence_manifest(bucket, sequence_prefix, sequence_batch_count)
    source_receipt_checksum = str(source_receipt["receipt_checksum"])
    sequence_manifest_checksum = str(sequence_manifest["manifest_checksum"])

    manifest_blob = bucket.blob(f"{output_prefix}/prep/manifest.json")
    if manifest_blob.exists():
        manifest = json.loads(manifest_blob.download_as_text().lstrip("\ufeff"))
        output_checksums = manifest.get("output_checksums") or {}
        valid_outputs = bool(output_checksums) and all(
            hashlib.sha256(bucket.blob(path).download_as_bytes()).hexdigest() == checksum
            for path, checksum in output_checksums.items()
        )
        if (
            manifest.get("schema_version") == SCHEMA_VERSION
            and manifest.get("source_gcs_prefix") == source_prefix
            and manifest.get("sequence_gcs_prefix") == sequence_prefix
            and manifest.get("source_receipt_checksum") == source_receipt_checksum
            and manifest.get("sequence_manifest_checksum") == sequence_manifest_checksum
            and manifest.get("feature_semantic_version") == FEATURE_SEMANTIC_VERSION
            and manifest.get("feature_imputation_semantic") == FEATURE_IMPUTATION_SEMANTIC_VERSION
            and manifest.get("producer_source_sha") == _runtime_source_sha()
            and manifest.get("manifest_checksum") == _manifest_checksum(manifest)
            and valid_outputs
        ):
            return {**manifest, "status": "idempotent_ready"}
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
        "source_business_date": source_receipt.get("business_date"),
        "source_receipt_checksum": source_receipt_checksum,
        "feature_semantic_version": source_receipt["feature_semantic_version"],
        "feature_imputation_semantic": source_receipt["feature_imputation_semantic"],
        "producer_source_sha": source_receipt["producer_source_sha"],
        "sequence_manifest_checksum": sequence_manifest_checksum,
        "source_feature_date_min": min(
            str(value)[:10] for batch in source_batches for value in batch["dates"]
        ),
        "source_feature_date_max": max(
            str(value)[:10] for batch in source_batches for value in batch["dates"]
        ),
        "sequence_date_min": (sequence_manifest.get("summary") or {}).get("date_min"),
        "sequence_date_max": (sequence_manifest.get("summary") or {}).get("date_max"),
        "signal_date_min": min(all_dates.astype(str).tolist()),
        "signal_date_max": max(all_dates.astype(str).tolist()),
        "label_known_date_max": max(
            str(value)[:10] for row in staged for value in row["known_dates"]
        ),
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
    manifest["manifest_checksum"] = _manifest_checksum(manifest)
    manifest_blob.upload_from_string(
        json.dumps(manifest, sort_keys=True, indent=2),
        content_type="application/json",
    )
    return manifest
