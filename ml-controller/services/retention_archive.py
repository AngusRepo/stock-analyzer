"""Verify immutable retention exports and restore exact rows to a local SQLite copy.

Never restores into D1, overwrites an existing database, or reclassifies evidence.
The caller supplies the trusted artifact manifest separately from the body.
"""
from __future__ import annotations
import hashlib
import json
import re
import sqlite3
import threading
from pathlib import Path

SCHEMA = "d1-retention-hot-window-drain-v1"
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

def _ident(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise ValueError("retention_archive_identifier_invalid")
    return '"' + value + '"'

def verify_archive(raw: bytes, manifest: dict, *, require_restore_schema: bool = True) -> dict:
    expected = str(manifest.get("checksum") or "").removeprefix("sha256:")
    if len(expected) != 64 or hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("retention_archive_checksum_mismatch")
    body = json.loads(raw)
    payload = body.get("payload") or {}
    if body.get("schema_version") != SCHEMA or payload.get("schema_version") != SCHEMA:
        raise ValueError("retention_archive_schema_invalid")
    table = str(payload.get("dataset_id") or "")
    _ident(table)
    domain = payload.get("source_domain")
    if domain not in {"core", "market", "learning", "ops", "execution", "paper", "research", "legacy"}:
        raise ValueError("retention_archive_domain_invalid")
    if body.get("domain") != f"retention_{payload.get('policy_id')}_{table}":
        raise ValueError("retention_archive_identity_mismatch")
    if manifest.get("domain") != body["domain"] or manifest.get("schema_version") != SCHEMA:
        raise ValueError("retention_archive_manifest_mismatch")
    rows = payload.get("rows")
    if not isinstance(rows, list) or not rows or len(rows) != manifest.get("row_count"):
        raise ValueError("retention_archive_row_count_mismatch")
    ddl = str(payload.get("source_schema_sql") or "")
    pattern = r'^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?' + re.escape(table) + r'["`\]]?\s*\('
    if (ddl or require_restore_schema) and not re.match(pattern, ddl.strip(), re.I):
        raise ValueError("retention_archive_restore_schema_missing")
    keys = set()
    columns = None
    for row in rows:
        key = row.get("__cursor_key")
        if type(key) is not int or abs(key) > 2**53-1 or key in keys:
            raise ValueError("retention_archive_row_identity_invalid")
        keys.add(key)
        actual = sorted(k for k in row if k not in {"__cursor_key", "__archive_date"})
        if columns is not None and actual != columns:
            raise ValueError("retention_archive_columns_changed")
        columns = actual
        for column in actual:
            _ident(column)
            value = row[column]
            if not (value is None or type(value) in (str, int, float)):
                raise ValueError("retention_archive_value_unsupported")
        date = str(row.get("__archive_date") or "")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) or date >= payload["cutoff_date"]:
            raise ValueError("retention_archive_date_invalid")
    return payload

def restore_archives(archives, output: Path) -> dict:
    """Consume (raw bytes, trusted manifest) chunks; keep memory bounded per chunk."""
    output = Path(output)
    # Exclusive creation prevents accidental overwrite of user databases.
    with output.open("xb"):
        pass
    db = sqlite3.connect(output)
    schemas, counts, receipts = {}, {}, []
    try:
        db.execute("BEGIN")
        for raw, manifest in archives:
            payload = verify_archive(raw, manifest)
            table, ddl = payload["dataset_id"], payload["source_schema_sql"]
            identity = (payload["source_domain"], table)
            if table in schemas and schemas[table] != (identity, ddl):
                raise ValueError("retention_archive_restore_schema_conflict")
            if table not in schemas:
                db.execute(ddl)
                schemas[table] = (identity, ddl)
            rows = payload["rows"]
            columns = [k for k in rows[0] if k not in {"__cursor_key", "__archive_date"}]
            sql = f"INSERT INTO {_ident(table)} (rowid," + ','.join(_ident(k) for k in columns) + ') VALUES (' + ','.join('?' for _ in range(len(columns)+1)) + ')'
            db.executemany(sql, [[row["__cursor_key"], *[row[k] for k in columns]] for row in rows])
            for row in rows:
                restored = db.execute(f"SELECT " + ','.join(_ident(k) for k in columns) + f" FROM {_ident(table)} WHERE rowid=?", [row["__cursor_key"]]).fetchone()
                if restored != tuple(row[k] for k in columns):
                    raise ValueError("retention_archive_restore_readback_mismatch")
            counts[table] = counts.get(table, 0) + len(rows)
            receipts.append({"artifact_id": manifest.get("artifact_id"), "checksum": manifest["checksum"], "rows": len(rows)})
        if not receipts:
            raise ValueError("retention_archive_restore_empty")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("retention_archive_restore_integrity_failed")
        db.commit()
        return {"status": "verified", "tables": counts, "chunks": receipts, "production_effect": False}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


# Retry waits after a 429, a 5xx or a transport error; any other status fails at once.
DOWNLOAD_RETRY_DELAYS_SECONDS = (2.0, 4.0, 8.0)
DOWNLOAD_ATTEMPT_TIMEOUT_SECONDS = 60.0
# Archives download one after another inside the dataset-snapshot job (3600 s task timeout).
# Its after-close run is research + quiet wait until at most 14:50 TW (~30 min from the 14:20
# dispatch) + export (~13 min), leaving ~17 min. A kill at the task timeout skips the job's error
# callback, so retries across the whole job may spend about 300 s (sleeps plus retried attempts,
# each reserved at its 60 s timeout before it starts): about a third of that slack, and more than
# one archive's worst case (2+4+8 s waits + 3 x 60 s attempts = 194 s). Once spent, a transient
# failure raises at once, as before retries existed. The bound is approximate: httpx applies the
# 60 s timeout to each phase (connect, write, read, pool), so a single attempt can run past 60 s.
DOWNLOAD_RETRY_BUDGET_SECONDS = 300.0
DOWNLOAD_RETRY_BUDGET_ENV = "RETENTION_ARCHIVE_RETRY_BUDGET_SECONDS"
# Only a Cloud Run Job (CLOUD_RUN_JOB is set) is a bounded run whose retries share one budget.
# The long-lived controller service gives each call its own ledger, so one bad hour never
# disables retries until the instance restarts.
_job_retry_ledger = {"seconds": 0.0}
_retry_lock = threading.Lock()
_warned_budget_values: set[str] = set()


def _retry_budget_seconds() -> float:
    import logging
    import math
    import os
    raw = os.environ.get(DOWNLOAD_RETRY_BUDGET_ENV, "").strip()
    if not raw:
        return DOWNLOAD_RETRY_BUDGET_SECONDS
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if math.isfinite(value) and value >= 0:
        return value
    with _retry_lock:
        first = raw not in _warned_budget_values
        _warned_budget_values.add(raw)
    if first:
        logging.getLogger(__name__).warning("%s=%r is not a finite non-negative number; using %.0f s",
                                            DOWNLOAD_RETRY_BUDGET_ENV, raw, DOWNLOAD_RETRY_BUDGET_SECONDS)
    return DOWNLOAD_RETRY_BUDGET_SECONDS


def _retry_ledger() -> dict:
    import os
    return _job_retry_ledger if os.environ.get("CLOUD_RUN_JOB") else {"seconds": 0.0}


def _spend(ledger: dict, seconds: float) -> None:
    with _retry_lock:
        ledger["seconds"] += max(0.0, seconds)


def download_archive(manifest: dict, *, post=None, require_restore_schema: bool = True,
                     sleep=None, clock=None) -> bytes:
    """Fetch through the existing service-authenticated Worker, then verify locally.

    A transient Worker answer (429, 5xx) or transport error is retried after each
    DOWNLOAD_RETRY_DELAYS_SECONDS wait while the retry budget (job-wide inside a Cloud Run Job,
    per call elsewhere) still covers the wait and a full attempt; every 200 body is verified
    before it is returned.
    """
    import logging
    import time
    import httpx
    from services.worker_config_client import worker_auth_headers, worker_url
    sender = post or httpx.post
    wait = sleep or time.sleep
    now = clock or time.monotonic
    ledger = _retry_ledger()
    attempts = len(DOWNLOAD_RETRY_DELAYS_SECONDS) + 1
    for attempt in range(1, attempts + 1):
        started = now()
        try:
            response = sender(worker_url() + "/api/internal/evidence-artifacts/retention/read",
                              headers=worker_auth_headers(), json={"artifact_id": manifest["artifact_id"]},
                              timeout=DOWNLOAD_ATTEMPT_TIMEOUT_SECONDS)
        except httpx.TransportError as error:
            failure = RuntimeError(f"retention_archive_read_transport_{type(error).__name__}")
            failure.__cause__ = error
        else:
            if response.status_code == 200:
                raw = response.content
                verify_archive(raw, manifest, require_restore_schema=require_restore_schema)
                return raw
            failure = RuntimeError(f"retention_archive_read_http_{response.status_code}")
            if response.status_code != 429 and response.status_code < 500:
                raise failure
        finally:
            if attempt > 1:
                _spend(ledger, now() - started)
        if attempt == attempts:
            raise failure
        delay = DOWNLOAD_RETRY_DELAYS_SECONDS[attempt - 1]
        budget = _retry_budget_seconds()
        with _retry_lock:
            spent = ledger["seconds"]
        log = logging.getLogger(__name__)
        if spent + delay + DOWNLOAD_ATTEMPT_TIMEOUT_SECONDS > budget:
            log.warning("retention archive read retry budget spent artifact_id=%s attempt=%d/%d cause=%s "
                        "spent_s=%.0f budget_s=%.0f", manifest["artifact_id"], attempt, attempts, failure,
                        spent, budget)
            raise failure
        log.warning("retention archive read retry artifact_id=%s attempt=%d/%d cause=%s retry_s=%.0f",
                    manifest["artifact_id"], attempt, attempts, failure, delay)
        started = now()
        wait(delay)
        _spend(ledger, now() - started)
    raise AssertionError("unreachable")


def create_history_projection_table(db, payload, query_source):
    """Legacy read compatibility, never a claim of exact original-schema restore.

    The trusted current source schema is usable only when every archived column
    matches it. Callers must verify release proof before using any missing row.
    Value round trips are checked separately before running the caller's SQL.
    """
    table = payload['dataset_id']
    ddl = payload.get('source_schema_sql')
    legacy = not ddl
    if legacy:
        schemas = query_source("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table])
        if len(schemas) != 1 or not schemas[0].get('sql'):
            raise ValueError('retention_history_legacy_schema_missing')
        ddl = schemas[0]['sql']
    pattern = r'^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?' + re.escape(table) + r'["`\]]?\s*\('
    if not re.match(pattern, ddl.strip(), re.I):
        raise ValueError('retention_history_schema_invalid')
    db.execute(ddl)
    if legacy:
        actual = {row[1] for row in db.execute(f'PRAGMA table_xinfo({_ident(table)})')}
        archived = set(payload['rows'][0]) - {'__cursor_key', '__archive_date'}
        if actual != archived:
            raise ValueError('retention_history_legacy_columns_mismatch')


def insert_history_projection_row(db, table, row):
    """Reject lossy affinity conversion rather than manufacture historical values."""
    columns = list(row)
    projection = ','.join(_ident(c) for c in columns)
    inserted = db.execute(f'INSERT INTO {_ident(table)} ({projection}) VALUES ('
                          + ','.join('?' for _ in columns) + ')', list(row.values()))
    restored = db.execute(f'SELECT {projection} FROM {_ident(table)} WHERE rowid=?',
                          [inserted.lastrowid]).fetchone()
    if restored is None or tuple(restored) != tuple(row.values()):
        raise ValueError('retention_history_projection_readback_mismatch')
