"""Immutable archive and bounded hot-row deletion for superseded OOF cohorts."""

from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from services.d1_domain_client import client_proxy_for_domain

LEARNING_D1_CLIENT = client_proxy_for_domain("learning")
OPS_D1_CLIENT = client_proxy_for_domain("ops")


ARCHIVE_SCHEMA_VERSION = "active8-oof-hot-archive-v1"
ARCHIVE_TABLES = {
    "active8_oof_predictions": "prediction_date",
    "allocator_ev_oof_snapshots": "snapshot_date",
    "l4_oof_predictions": "prediction_date",
}
LEGACY_ELIGIBILITY_REASON = "legacy_oof_lineage_policy_superseded"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _query_one(query_fn: Callable[..., list[dict[str, Any]]], sql: str, params: list[Any]) -> dict[str, Any]:
    rows = query_fn(sql, params)
    return dict(rows[0]) if rows else {}


def load_oof_archive_preflight(
    cohort_id: str,
    *,
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
    reference_query_fn: Callable[..., list[dict[str, Any]]] = OPS_D1_CLIENT.query,
) -> dict[str, Any]:
    row = _query_one(
        query_fn,
        """
        SELECT c.cohort_id, c.status, c.artifact_manifest_checksum, c.created_at,
          (SELECT COUNT(*) FROM active8_oof_predictions p WHERE p.cohort_id=c.cohort_id) prediction_rows,
          (SELECT COUNT(*) FROM allocator_ev_oof_snapshots s WHERE s.cohort_id=c.cohort_id) snapshot_rows,
          (SELECT COUNT(*) FROM l4_oof_predictions l WHERE l.cohort_id=c.cohort_id) l4_rows,
          (SELECT COUNT(*) FROM active8_oof_cohorts newer
             WHERE newer.status='ready' AND newer.created_at>c.created_at) newer_ready_cohorts
        FROM active8_oof_cohorts c
        WHERE c.cohort_id=?
        """,
        [cohort_id],
    )
    if not row:
        raise ValueError("active8_oof_archive_cohort_missing")
    artifacts = query_fn(
        "SELECT artifact_id FROM model_artifact_registry "
        "WHERE training_run_id='active8_oof:' || ? ORDER BY artifact_id",
        [cohort_id],
    )
    artifact_ids = sorted({
        str(item.get("artifact_id") or "").strip()
        for item in artifacts
        if str(item.get("artifact_id") or "").strip()
    })
    hard_reference_count = 0
    if artifact_ids:
        reference_row = _query_one(
            reference_query_fn,
            "SELECT COUNT(*) hard_reference_count FROM artifact_hard_references "
            "WHERE active=1 AND artifact_id IN (SELECT value FROM json_each(?))",
            [json.dumps(artifact_ids, separators=(",", ":"))],
        )
        hard_reference_count = int(reference_row.get("hard_reference_count") or 0)
    row["hard_reference_count"] = hard_reference_count
    row_counts = {
        "active8_oof_predictions": int(row.get("prediction_rows") or 0),
        "allocator_ev_oof_snapshots": int(row.get("snapshot_rows") or 0),
        "l4_oof_predictions": int(row.get("l4_rows") or 0),
    }
    blockers: list[str] = []
    if int(row.get("hard_reference_count") or 0) > 0:
        blockers.append("active_artifact_hard_reference")
    if int(row.get("newer_ready_cohorts") or 0) <= 0:
        blockers.append("newer_ready_cohort_missing")
    if sum(row_counts.values()) <= 0:
        blockers.append("hot_payload_empty")
    return {
        **row,
        "row_counts": row_counts,
        "total_rows": sum(row_counts.values()),
        "blockers": blockers,
        "eligible": not blockers,
    }


def _write_table_archive(
    *,
    cohort_id: str,
    table: str,
    date_field: str,
    bucket: Any,
    temp_dir: Path,
    query_fn: Callable[..., list[dict[str, Any]]],
    chunk_size: int,
) -> dict[str, Any]:
    output_path = temp_dir / f"{table}.jsonl.gz"
    cursor = 0
    row_count = 0
    min_date: str | None = None
    max_date: str | None = None
    with output_path.open("wb") as raw_handle:
        with gzip.GzipFile(fileobj=raw_handle, mode="wb", compresslevel=6, mtime=0) as gzip_handle:
            while True:
                rows = query_fn(
                    f"SELECT rowid AS _archive_rowid, * FROM {table} "
                    "WHERE cohort_id=? AND rowid>? ORDER BY rowid LIMIT ?",
                    [cohort_id, cursor, chunk_size],
                    timeout=120.0,
                )
                if not rows:
                    break
                for source_row in rows:
                    row = dict(source_row)
                    cursor = int(row.pop("_archive_rowid"))
                    value = str(row.get(date_field) or "")[:10]
                    min_date = value if min_date is None or value < min_date else min_date
                    max_date = value if max_date is None or value > max_date else max_date
                    line = json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)
                    gzip_handle.write(line.encode("utf-8") + b"\n")
                    row_count += 1
                if len(rows) < chunk_size:
                    break
    checksum = _sha256_file(output_path)
    object_path = f"archives/active8_oof/{cohort_id}/{table}/{checksum}.jsonl.gz"
    blob = bucket.blob(object_path)
    blob.upload_from_filename(str(output_path), content_type="application/gzip")
    verify_path = temp_dir / f"{table}.verify.jsonl.gz"
    blob.download_to_filename(str(verify_path))
    verified_checksum = _sha256_file(verify_path)
    if verified_checksum != checksum:
        raise RuntimeError(f"active8_oof_archive_remote_checksum_mismatch:{table}")
    return {
        "table": table,
        "row_count": row_count,
        "min_date": min_date,
        "max_date": max_date,
        "archive_path": object_path,
        "archive_checksum": checksum,
        "compressed_bytes": output_path.stat().st_size,
        "remote_verified": True,
    }


def _persist_legacy_date_eligibility(
    *,
    cohort_id: str,
    manifest_checksum: str,
    assessed_cutoff: str,
    query_fn: Callable[..., list[dict[str, Any]]],
    batch_fn: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    rows = query_fn(
        """
        SELECT prediction_date FROM active8_oof_predictions WHERE cohort_id=?
        UNION
        SELECT snapshot_date prediction_date FROM allocator_ev_oof_snapshots WHERE cohort_id=?
        UNION
        SELECT prediction_date FROM l4_oof_predictions WHERE cohort_id=?
        ORDER BY prediction_date
        """,
        [cohort_id, cohort_id, cohort_id],
        timeout=120.0,
    )
    dates = [str(row.get("prediction_date") or "")[:10] for row in rows]
    dates = [value for value in dates if len(value) == 10]
    if not dates:
        raise RuntimeError("active8_oof_archive_date_evidence_missing")
    sql = """
        INSERT INTO active8_oof_date_eligibility (
          cohort_id, prediction_date, evidence_scope, eligibility_status,
          reason_code, evidence_schema_version, source_manifest_checksum,
          assessed_knowledge_cutoff
        ) VALUES (?, ?, ?, 'illegal', ?, 'oof-date-eligibility-v2', ?, ?)
        ON CONFLICT(cohort_id, prediction_date, evidence_scope) DO UPDATE SET
          eligibility_status='illegal', reason_code=excluded.reason_code,
          evidence_schema_version=excluded.evidence_schema_version,
          source_manifest_checksum=excluded.source_manifest_checksum,
          assessed_knowledge_cutoff=excluded.assessed_knowledge_cutoff,
          assessed_at=CURRENT_TIMESTAMP
    """
    statements = [
        (sql, [cohort_id, day, scope, LEGACY_ELIGIBILITY_REASON, manifest_checksum, assessed_cutoff])
        for day in dates
        for scope in ("active8_oof", "l4", "fusion")
    ]
    result = batch_fn(statements, timeout=120.0, chunk_size=200)
    if int(result.get("error_count") or 0) > 0:
        raise RuntimeError(f"active8_oof_archive_eligibility_write_failed:{result}")
    return {"dates": dates, "rows": len(statements), "write": result}


def _persist_archive_ledger(
    *,
    cohort_id: str,
    preflight: dict[str, Any],
    manifest_path: str,
    manifest_checksum: str,
    archive_row_count: int,
    status: str,
    execute_fn: Callable[..., dict[str, Any]],
) -> None:
    result = execute_fn(
        """
        INSERT INTO active8_oof_retention_ledger (
          cohort_id, legality_state, retention_action, status,
          d1_prediction_rows, d1_snapshot_rows, d1_l4_rows,
          hard_reference_count, archive_store, archive_path,
          archive_checksum, archive_row_count, archive_verified_at,
          blocker_reason, updated_at
        ) VALUES (?, 'illegal', 'delete_hot', ?, ?, ?, ?, 0, 'gcs', ?, ?, ?, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
        ON CONFLICT(cohort_id) DO UPDATE SET
          legality_state='illegal', retention_action='delete_hot', status=excluded.status,
          d1_prediction_rows=excluded.d1_prediction_rows,
          d1_snapshot_rows=excluded.d1_snapshot_rows,
          d1_l4_rows=excluded.d1_l4_rows,
          hard_reference_count=0, archive_store='gcs',
          archive_path=excluded.archive_path, archive_checksum=excluded.archive_checksum,
          archive_row_count=excluded.archive_row_count,
          archive_verified_at=CURRENT_TIMESTAMP, blocker_reason=NULL,
          updated_at=CURRENT_TIMESTAMP
        """,
        [
            cohort_id,
            status,
            preflight["row_counts"]["active8_oof_predictions"],
            preflight["row_counts"]["allocator_ev_oof_snapshots"],
            preflight["row_counts"]["l4_oof_predictions"],
            manifest_path,
            manifest_checksum,
            archive_row_count,
        ],
        timeout=120.0,
    )
    if not result.get("success"):
        raise RuntimeError("active8_oof_archive_ledger_write_failed")


def _delete_hot_rows(
    *,
    cohort_id: str,
    table: str,
    execute_fn: Callable[..., dict[str, Any]],
    query_fn: Callable[..., list[dict[str, Any]]],
    chunk_size: int,
) -> int:
    deleted = 0
    while True:
        result = execute_fn(
            f"DELETE FROM {table} WHERE rowid IN ("
            f"SELECT rowid FROM {table} WHERE cohort_id=? ORDER BY rowid LIMIT ?)",
            [cohort_id, chunk_size],
            timeout=120.0,
        )
        changes = int((result.get("meta") or {}).get("changes") or 0)
        deleted += changes
        if changes == 0:
            break
    remaining = _query_one(
        query_fn,
        f"SELECT COUNT(*) row_count FROM {table} WHERE cohort_id=?",
        [cohort_id],
    )
    if int(remaining.get("row_count") or 0) != 0:
        raise RuntimeError(f"active8_oof_archive_hot_delete_incomplete:{table}")
    return deleted


def archive_superseded_oof_cohort(
    *,
    cohort_id: str,
    bucket: Any,
    delete_hot: bool,
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
    execute_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.execute,
    reference_query_fn: Callable[..., list[dict[str, Any]]] = OPS_D1_CLIENT.query,
    batch_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.batch_execute,
    chunk_size: int = 2000,
    delete_chunk_size: int = 5000,
) -> dict[str, Any]:
    preflight = load_oof_archive_preflight(
        cohort_id,
        query_fn=query_fn,
        reference_query_fn=reference_query_fn,
    )
    if not preflight["eligible"]:
        raise RuntimeError(f"active8_oof_archive_blocked:{','.join(preflight['blockers'])}")
    manifest_checksum = str(preflight.get("artifact_manifest_checksum") or "")
    if len(manifest_checksum) != 64:
        raise RuntimeError("active8_oof_archive_source_manifest_checksum_missing")
    assessed_cutoff = datetime.now(timezone.utc).date().isoformat()
    eligibility = _persist_legacy_date_eligibility(
        cohort_id=cohort_id,
        manifest_checksum=manifest_checksum,
        assessed_cutoff=assessed_cutoff,
        query_fn=query_fn,
        batch_fn=batch_fn,
    )
    with tempfile.TemporaryDirectory(prefix="active8-oof-archive-") as temp_name:
        temp_dir = Path(temp_name)
        components = [
            _write_table_archive(
                cohort_id=cohort_id,
                table=table,
                date_field=date_field,
                bucket=bucket,
                temp_dir=temp_dir,
                query_fn=query_fn,
                chunk_size=max(100, min(int(chunk_size), 5000)),
            )
            for table, date_field in ARCHIVE_TABLES.items()
            if preflight["row_counts"][table] > 0
        ]
    archive_row_count = sum(int(item["row_count"]) for item in components)
    if archive_row_count != int(preflight["total_rows"]):
        raise RuntimeError("active8_oof_archive_row_count_mismatch")
    manifest = {
        "schema_version": ARCHIVE_SCHEMA_VERSION,
        "cohort_id": cohort_id,
        "source_manifest_checksum": manifest_checksum,
        "eligibility_reason": LEGACY_ELIGIBILITY_REASON,
        "eligibility_dates": eligibility["dates"],
        "components": components,
        "archive_row_count": archive_row_count,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    raw_manifest = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    archive_checksum = hashlib.sha256(raw_manifest).hexdigest()
    manifest_path = f"archives/active8_oof/{cohort_id}/manifest-{archive_checksum}.json"
    manifest_blob = bucket.blob(manifest_path)
    manifest_blob.upload_from_string(raw_manifest, content_type="application/json")
    if hashlib.sha256(manifest_blob.download_as_bytes()).hexdigest() != archive_checksum:
        raise RuntimeError("active8_oof_archive_manifest_remote_checksum_mismatch")
    _persist_archive_ledger(
        cohort_id=cohort_id,
        preflight=preflight,
        manifest_path=manifest_path,
        manifest_checksum=archive_checksum,
        archive_row_count=archive_row_count,
        status="verified",
        execute_fn=execute_fn,
    )
    deleted_rows: dict[str, int] = {}
    if delete_hot:
        recheck = load_oof_archive_preflight(
            cohort_id,
            query_fn=query_fn,
            reference_query_fn=reference_query_fn,
        )
        if int(recheck.get("hard_reference_count") or 0) != 0:
            raise RuntimeError("active8_oof_archive_hard_reference_changed")
        for table in ARCHIVE_TABLES:
            deleted_rows[table] = _delete_hot_rows(
                cohort_id=cohort_id,
                table=table,
                execute_fn=execute_fn,
                query_fn=query_fn,
                chunk_size=max(100, min(int(delete_chunk_size), 10000)),
            )
        _persist_archive_ledger(
            cohort_id=cohort_id,
            preflight=preflight,
            manifest_path=manifest_path,
            manifest_checksum=archive_checksum,
            archive_row_count=archive_row_count,
            status="deleted",
            execute_fn=execute_fn,
        )
    return {
        "status": "deleted" if delete_hot else "verified",
        "cohort_id": cohort_id,
        "archive_path": manifest_path,
        "archive_checksum": archive_checksum,
        "archive_row_count": archive_row_count,
        "components": components,
        "eligibility": eligibility,
        "deleted_rows": deleted_rows,
    }
