"""Durable point-in-time feature/sequence prep owner for Active-8 OOF."""

from __future__ import annotations

import hashlib
import json
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from services import d1_client
from services.dataset_snapshots import latest_dataset_snapshot


SEQUENCE_PREFIX = "universal/sequence_long/runs/"
FEATURE_PREP_PREFIX = "universal/oof_forward_prep"
ADJUSTED_PREP_PREFIX = "universal/canonical_adjusted_v5"
ADJUSTED_PREP_SCHEMA = "active8-canonical-adjusted-prep-v2"


class Active8PrepDependencyPending(RuntimeError):
    """Raised when a legal upstream immutable artifact is not ready yet."""

    def __init__(self, reason: str, evidence: dict[str, Any] | None = None):
        super().__init__(reason)
        self.reason = reason
        self.evidence = evidence or {}


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _normalize_sha256(value: Any) -> str:
    digest = str(value or "").strip().lower()
    if digest.startswith("sha256:"):
        digest = digest.removeprefix("sha256:")
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        return ""
    return digest


def _manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    return _sha256(json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _latest_immutable_sequence(bucket: Any, cutoff: str) -> tuple[str, dict[str, Any]]:
    candidates: list[tuple[str, str, dict[str, Any]]] = []
    for blob in bucket.list_blobs(prefix=SEQUENCE_PREFIX):
        path = str(blob.name)
        if not path.endswith("/prep/sequence_manifest.json"):
            continue
        try:
            manifest = json.loads(blob.download_as_text().lstrip("\ufeff"))
            prefix = path.removesuffix("/prep/sequence_manifest.json")
            date_max = str((manifest.get("summary") or {}).get("date_max") or "")[:10]
            if (
                manifest.get("status") != "ready"
                or manifest.get("contract") != "sequence_records_v3"
                or str(manifest.get("output_gcs_prefix") or "").rstrip("/") != prefix
                or manifest.get("manifest_checksum") != _manifest_checksum(manifest)
                or not date_max
                or date_max > cutoff
            ):
                continue
            checksums = manifest.get("output_checksums") or {}
            batch_count = int(manifest.get("batch_count") or 0)
            expected = [f"{prefix}/prep/batch_{index}.npz" for index in range(batch_count)]
            if batch_count < 1 or any(item not in checksums for item in expected):
                continue
            if any(
                _sha256(bucket.blob(item).download_as_bytes()) != checksums[item]
                for item in expected
            ):
                continue
            candidates.append((date_max, str(manifest.get("created_at") or ""), manifest))
        except Exception:  # noqa: BLE001 - corrupt candidates are ignored, never selected.
            continue
    if not candidates:
        raise Active8PrepDependencyPending(
            "immutable_sequence_v3_missing",
            {"prefix": SEQUENCE_PREFIX, "cutoff": cutoff},
        )
    manifest = max(candidates, key=lambda item: (item[0], item[1]))[2]
    return str(manifest["output_gcs_prefix"]).rstrip("/"), manifest


def _receipt_checksum(receipt: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in receipt.items() if key != "receipt_checksum"}
    return _sha256(json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _latest_market_session(
    cutoff: str,
    *,
    query_fn: Callable[..., list[dict[str, Any]]],
) -> tuple[str, dict[str, Any]]:
    rows = query_fn(
        """
        SELECT substr(date, 1, 10) trading_date, COUNT(*) price_rows
        FROM stock_prices
        WHERE substr(date, 1, 10) BETWEEN date(?, '-45 days') AND date(?)
        GROUP BY substr(date, 1, 10)
        ORDER BY trading_date
        """,
        [cutoff, cutoff],
    )
    counts = [
        max(0, int(row.get("price_rows") or 0))
        for row in rows or []
        if str(row.get("trading_date") or "")[:10]
    ]
    if not counts:
        raise Active8PrepDependencyPending(
            "market_session_calendar_missing",
            {"cutoff": cutoff},
        )
    reference = float(statistics.median(counts))
    threshold = max(100, int(reference * 0.20))
    sessions = [
        str(row.get("trading_date") or "")[:10]
        for row in rows
        if int(row.get("price_rows") or 0) >= threshold
    ]
    if not sessions:
        raise Active8PrepDependencyPending(
            "market_session_coverage_incomplete",
            {
                "cutoff": cutoff,
                "coverage_reference": reference,
                "coverage_threshold": threshold,
            },
        )
    latest_row = next(row for row in reversed(rows) if str(row.get("trading_date") or "")[:10] == sessions[-1])
    return sessions[-1], {
        "market_session_coverage_reference": reference,
        "market_session_coverage_threshold": threshold,
        "market_session_price_rows": int(latest_row.get("price_rows") or 0),
    }


async def ensure_active8_daily_prep(
    *,
    end_date: str | None,
    dry_run: bool = False,
    query_fn: Callable[..., list[dict[str, Any]]] = d1_client.query,
) -> dict[str, Any]:
    from routers.retrain_trigger import UniversalRetrainTriggerRequest, trigger_universal_retrain
    from services import modal_client
    from services.walk_forward_retrain import _get_bucket

    cutoff = end_date or (datetime.now(timezone.utc) + timedelta(hours=8)).date().isoformat()
    expected_business_date, market_session_evidence = _latest_market_session(
        cutoff,
        query_fn=query_fn,
    )
    snapshot = latest_dataset_snapshot(
        kind="backtest_dataset",
        as_of_business_date=cutoff,
        access_tier="compute",
    )
    if not snapshot or snapshot.get("manifest_errors"):
        raise Active8PrepDependencyPending(
            "exact_compute_snapshot_missing",
            {"cutoff": cutoff, "manifest_errors": (snapshot or {}).get("manifest_errors")},
        )
    business_date = str(snapshot.get("business_date") or "")[:10]
    snapshot_checksum = _normalize_sha256(snapshot.get("checksum"))
    if not business_date or not snapshot_checksum:
        raise Active8PrepDependencyPending(
            "compute_snapshot_lineage_invalid",
            {"snapshot_id": snapshot.get("snapshot_id"), "business_date": business_date},
        )
    if business_date != expected_business_date:
        raise Active8PrepDependencyPending(
            "compute_snapshot_behind_market_session",
            {
                "cutoff": cutoff,
                "expected_business_date": expected_business_date,
                "snapshot_business_date": business_date,
                "snapshot_id": snapshot.get("snapshot_id"),
                **market_session_evidence,
            },
        )

    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS unavailable")
    sequence_prefix, sequence_manifest = _latest_immutable_sequence(bucket, cutoff)
    sequence_date_max = str((sequence_manifest.get("summary") or {}).get("date_max") or "")[:10]
    if sequence_date_max < business_date:
        raise Active8PrepDependencyPending(
            "immutable_sequence_behind_compute_snapshot",
            {
                "business_date": business_date,
                "sequence_date_max": sequence_date_max,
                "sequence_gcs_prefix": sequence_prefix,
            },
        )

    sequence_checksum = str(sequence_manifest["manifest_checksum"])
    source_prefix = f"{FEATURE_PREP_PREFIX}/{business_date}-{snapshot_checksum[:12]}"
    adjusted_prefix = (
        f"{ADJUSTED_PREP_PREFIX}/{business_date}-"
        f"{snapshot_checksum[:12]}-{sequence_checksum[:12]}"
    )
    plan = {
        "cutoff": cutoff,
        "business_date": business_date,
        "expected_business_date": expected_business_date,
        **market_session_evidence,
        "snapshot_id": snapshot.get("snapshot_id"),
        "snapshot_checksum": snapshot_checksum,
        "source_gcs_prefix": source_prefix,
        "sequence_gcs_prefix": sequence_prefix,
        "sequence_manifest_checksum": sequence_checksum,
        "sequence_date_max": sequence_date_max,
        "output_gcs_prefix": adjusted_prefix,
    }
    if dry_run:
        return {"status": "dry_run", **plan}

    prep_result = await trigger_universal_retrain(
        UniversalRetrainTriggerRequest(
            limit=2500,
            run_date=business_date,
            require_exact_dataset_snapshot=True,
            prep_only=True,
            prep_output_gcs_prefix=source_prefix,
            train_model_groups=[],
        ),
        request=None,
    )
    prep_status = str(prep_result.get("status") or "").lower()
    if prep_status in {"skipped", "pending"}:
        raise Active8PrepDependencyPending(
            "immutable_feature_prep_busy",
            {"prep_status": prep_status, "prep_result": prep_result},
        )
    if prep_status not in {"ready", "idempotent_ready"}:
        raise RuntimeError(
            f"immutable feature prep failed: {prep_result.get('error') or prep_status or 'unknown'}"
        )

    adjusted = await modal_client.rebuild_canonical_adjusted_prep({
        "source_gcs_prefix": source_prefix,
        "sequence_gcs_prefix": sequence_prefix,
        "output_gcs_prefix": adjusted_prefix,
        "batch_count": int(prep_result.get("batch_count") or 0),
        "sequence_batch_count": int(sequence_manifest.get("batch_count") or 0),
    })
    if adjusted.get("error"):
        raise RuntimeError(f"canonical adjusted prep failed: {adjusted['error']}")
    if adjusted.get("schema_version") != ADJUSTED_PREP_SCHEMA:
        raise RuntimeError("canonical adjusted prep schema mismatch")

    receipt = {
        "schema_version": "active8-daily-prep-lifecycle-v1",
        "status": "ready",
        "created_at": datetime.now(timezone.utc).isoformat(),
        **plan,
        "source_receipt_checksum": prep_result.get("receipt_checksum"),
        "adjusted_manifest_checksum": adjusted.get("manifest_checksum"),
        "source_feature_date_max": adjusted.get("source_feature_date_max"),
        "signal_date_max": adjusted.get("signal_date_max"),
        "label_known_date_max": adjusted.get("label_known_date_max"),
    }
    receipt["receipt_checksum"] = _receipt_checksum(receipt)
    receipt_path = (
        f"walk_forward/prep_lifecycle/{business_date}/"
        f"{snapshot_checksum[:12]}-{sequence_checksum[:12]}.json"
    )
    bucket.blob(receipt_path).upload_from_string(
        json.dumps(receipt, sort_keys=True, indent=2),
        content_type="application/json",
    )
    return {**receipt, "receipt_path": receipt_path}
