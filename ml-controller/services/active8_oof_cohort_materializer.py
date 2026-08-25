"""Verify and materialize immutable Active-8 OOF cohorts and EV snapshots."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Callable

import numpy as np

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
from services.active8_oof_stacker import (
    ACTIVE8_MODELS,
    CORE_CROSS_SECTIONAL_MODELS,
    STACKER_SEMANTIC_VERSION,
    build_chronological_oof_stack,
)
from services.ev_lineage_contract import build_model_set_signature
from services.model_artifact_registry import upsert_artifact_record
from services.evidence_contracts import LABEL_SCHEMA_VERSION
from services.fundamental_quality import score_fundamental_quality
from services.fusion_market_context import (
    context_for_market_segment,
    merge_market_context,
    recorded_market_context,
)
from services.price_horizon_projection_contract import OOF_PRICE_HORIZON_SOURCE
from services.pit_sector_alpha import unavailable_sector_alpha
from services.oof_retention_policy import (
    build_oof_date_eligibility_rows,
    persist_oof_date_eligibility,
)
from services.worker_evidence_archive_client import resolve_legacy_screener_evidence

TARGET_SEMANTIC_VERSION = LABEL_SCHEMA_VERSION
SCORE_SEMANTIC_VERSION = "score-v2-active8-components-v3"
D1_IN_CLAUSE_CHUNK_SIZE = 80
OOF_MATERIALIZED_ARTIFACT_SCHEMA_VERSION = "active8-oof-materialized-jsonl-gzip-v1"
OOF_PIT_ELIGIBILITY_POLICY_VERSION = "recorded-score-v2-r2-sector-before-next-session-open-v4"
OOF_POLICY_REPLACEMENT_REASON = "add-recorded-decision-cutoff-sector-pit-evidence"
OOF_MATERIALIZED_ARTIFACT_KINDS = {
    "allocator_ev_snapshots": "snapshot_date",
    "l4_predictions": "prediction_date",
}
OOF_FORWARD_COVERAGE_POLICY_VERSION = "verified-frozen-forward-monitoring-v2"
EXPECTED_RETURN_SHADOW_EVALUATION_IDENTITY_VERSION = (
    "expected-return-shadow-evaluation-identity-v2"
)
EXPECTED_RETURN_SHADOW_EVALUATOR_VERSION = "expected-return-frozen-forward-evaluator-v2"

CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)
MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)
LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
OPS_D1_CLIENT = client_proxy_for_domain(D1DataDomain.OPS)


def _query_native_pit_component_domain_split(
    sql: str,
    params: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Route the legacy-shaped Active8 loader without executing cross-D1 joins."""

    values = list(params or [])
    if "FROM daily_recommendations dr" in sql:
        dates = [str(value)[:10] for value in values[:-1]]
        semantic_version = values[-1] if values else SCORE_SEMANTIC_VERSION
        placeholders = ",".join("?" for _ in dates)
        rows = CORE_D1_CLIENT.query(
            f"""
            SELECT dr.stock_id, s.symbol, dr.date prediction_date, dr.score,
                   dr.score_components, dr.alpha_context, dr.alpha_allocation,
                   dr.market_segment, dr.recommendation_lane,
                   NULL forecast_data,
                   json_extract(dr.alpha_context, '$.market_heat_expected_return') market_heat_expected_return,
                   'daily_recommendations_score_v2_v3' native_component_source,
                   NULL native_run_id, dr.created_at native_created_at
              FROM daily_recommendations dr
              JOIN stocks s ON s.id = dr.stock_id
             WHERE dr.date IN ({placeholders})
               AND json_extract(dr.score_components, '$.version') = 'score_v2'
               AND json_extract(dr.score_components, '$.semanticVersion') = ?
            """,
            [*dates, semantic_version],
        )
        latest_forecast: dict[tuple[str, str], Any] = {}
        if dates:
            prediction_rows = LEARNING_D1_CLIENT.query(
                f"""
                SELECT stock_id, substr(prediction_date, 1, 10) prediction_date,
                       forecast_data, generated_at, id
                  FROM predictions
                 WHERE substr(prediction_date, 1, 10) IN ({placeholders})
                   AND model_name = 'ensemble'
                 ORDER BY stock_id, prediction_date, datetime(generated_at) DESC, id DESC
                """,
                dates,
            )
            for prediction in prediction_rows:
                key = (
                    str(prediction.get("stock_id") or ""),
                    str(prediction.get("prediction_date") or "")[:10],
                )
                if key not in latest_forecast:
                    latest_forecast[key] = prediction.get("forecast_data")
        for row in rows:
            row["forecast_data"] = latest_forecast.get((
                str(row.get("stock_id") or ""),
                str(row.get("prediction_date") or "")[:10],
            ))
        return rows
    if "FROM stock_prices" in sql:
        return MARKET_D1_CLIENT.query(sql, values)
    if "COUNT(i.id) component_rows" in sql:
        return OPS_D1_CLIENT.query(sql, values)
    if "FROM screener_funnel_items i" in sql:
        ops_sql = sql.replace("s.id stock_id,", "NULL stock_id,")
        ops_sql = ops_sql.replace("s.market market_segment,", "NULL market_segment,")
        ops_sql = ops_sql.replace("JOIN stocks s ON s.symbol = i.symbol", "")
        rows = OPS_D1_CLIENT.query(ops_sql, values)
        symbols = sorted({str(row.get("symbol") or "") for row in rows if row.get("symbol")})
        identities: dict[str, dict[str, Any]] = {}
        for offset in range(0, len(symbols), D1_IN_CLAUSE_CHUNK_SIZE):
            chunk = symbols[offset:offset + D1_IN_CLAUSE_CHUNK_SIZE]
            placeholders = ",".join("?" for _ in chunk)
            for identity in CORE_D1_CLIENT.query(
                f"SELECT id, symbol, market FROM stocks WHERE symbol IN ({placeholders})",
                chunk,
            ):
                identities[str(identity.get("symbol") or "")] = identity
        for row in rows:
            identity = identities.get(str(row.get("symbol") or ""), {})
            row["stock_id"] = identity.get("id")
            row["market_segment"] = identity.get("market")
        return rows
    return LEARNING_D1_CLIENT.query(sql, values)


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def _manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    payload = json.dumps(unsigned, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _json_default(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError(f"active8_oof_json_type_unsupported:{type(value).__name__}")


def archive_oof_materialized_rows(
    *,
    bucket: Any,
    cohort_id: str,
    artifact_kind: str,
    rows: list[dict[str, Any]],
    source_manifest_checksum: str,
) -> dict[str, Any]:
    """Archive large offline evidence while keeping only a compact D1 index."""

    date_field = OOF_MATERIALIZED_ARTIFACT_KINDS.get(artifact_kind)
    if date_field is None:
        raise ValueError("active8_oof_materialized_artifact_kind_invalid")
    row_dates = [str(row.get(date_field) or "")[:10] for row in rows]
    if any(not value for value in row_dates):
        raise ValueError("active8_oof_materialized_artifact_date_missing")
    dates = sorted(set(row_dates))
    if len(source_manifest_checksum) != 64:
        raise ValueError("active8_oof_materialized_artifact_manifest_checksum_invalid")
    if any(str(row.get("cohort_id") or "") != cohort_id for row in rows):
        raise ValueError("active8_oof_materialized_artifact_cohort_mismatch")
    date_set_checksum = hashlib.sha256("\n".join(dates).encode("utf-8")).hexdigest()
    metadata = {
        "schema_version": OOF_MATERIALIZED_ARTIFACT_SCHEMA_VERSION,
        "cohort_id": cohort_id,
        "artifact_kind": artifact_kind,
        "source_manifest_checksum": source_manifest_checksum,
        "row_count": len(rows),
        "date_count": len(dates),
        "min_date": dates[0] if dates else None,
        "max_date": dates[-1] if dates else None,
        "eligibility_policy_version": OOF_PIT_ELIGIBILITY_POLICY_VERSION,
        "date_set_checksum": date_set_checksum,
    }
    ordered_rows = sorted(
        rows,
        key=lambda row: (
            str(row.get(date_field) or ""),
            str(row.get("fold_id") or ""),
            str(row.get("symbol") or ""),
            str(row.get("market_segment") or ""),
        ),
    )
    lines = [json.dumps({"_metadata": metadata}, sort_keys=True, separators=(",", ":"))]
    lines.extend(
        json.dumps(row, sort_keys=True, separators=(",", ":"), default=_json_default)
        for row in ordered_rows
    )
    uncompressed = ("\n".join(lines) + "\n").encode("utf-8")
    encoded = gzip.compress(uncompressed, compresslevel=6, mtime=0)
    checksum = hashlib.sha256(encoded).hexdigest()
    path = (
        f"walk_forward/oof_cohorts/{cohort_id}/materialized/"
        f"{artifact_kind}/{checksum}.jsonl.gz"
    )
    bucket.blob(path).upload_from_string(encoded, content_type="application/gzip")
    return {
        **metadata,
        "artifact_path": path,
        "artifact_checksum": checksum,
        "format_version": OOF_MATERIALIZED_ARTIFACT_SCHEMA_VERSION,
        "compressed_bytes": len(encoded),
        "uncompressed_bytes": len(uncompressed),
        "dates": dates,
    }


def load_oof_materialized_rows(
    *,
    bucket: Any,
    cohort_id: str,
    artifact_kind: str,
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
) -> list[dict[str, Any]]:
    """Resolve and verify one compact-indexed OOF evidence artifact."""

    index_rows = query_fn(
        """
        SELECT artifact_path, artifact_checksum, format_version, row_count,
               date_count, min_date, max_date, source_manifest_checksum,
               eligibility_policy_version, date_set_checksum
        FROM active8_oof_materialized_artifacts
        WHERE cohort_id = ? AND artifact_kind = ?
        """,
        [cohort_id, artifact_kind],
    )
    if len(index_rows) != 1:
        raise ValueError("active8_oof_materialized_artifact_index_missing")
    index = index_rows[0]
    if str(index.get("format_version") or "") != OOF_MATERIALIZED_ARTIFACT_SCHEMA_VERSION:
        raise ValueError("active8_oof_materialized_artifact_format_mismatch")
    encoded = bucket.blob(str(index["artifact_path"])).download_as_bytes()
    if hashlib.sha256(encoded).hexdigest() != str(index["artifact_checksum"]):
        raise ValueError("active8_oof_materialized_artifact_checksum_mismatch")
    lines = gzip.decompress(encoded).decode("utf-8").splitlines()
    if not lines:
        raise ValueError("active8_oof_materialized_artifact_empty")
    metadata = _loads(json.loads(lines[0]).get("_metadata"))
    expected = {
        "schema_version": OOF_MATERIALIZED_ARTIFACT_SCHEMA_VERSION,
        "cohort_id": cohort_id,
        "artifact_kind": artifact_kind,
        "source_manifest_checksum": str(index["source_manifest_checksum"]),
        "row_count": int(index["row_count"]),
        "date_count": int(index["date_count"]),
        "min_date": index.get("min_date"),
        "max_date": index.get("max_date"),
        "eligibility_policy_version": index.get("eligibility_policy_version"),
        "date_set_checksum": index.get("date_set_checksum"),
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise ValueError(f"active8_oof_materialized_artifact_metadata_mismatch:{key}")
    rows = [json.loads(line) for line in lines[1:]]
    if len(rows) != int(index["row_count"]):
        raise ValueError("active8_oof_materialized_artifact_row_count_mismatch")
    if any(str(row.get("cohort_id") or "") != cohort_id for row in rows):
        raise ValueError("active8_oof_materialized_artifact_row_cohort_mismatch")
    date_field = OOF_MATERIALIZED_ARTIFACT_KINDS[artifact_kind]
    dates = sorted({str(row.get(date_field) or "")[:10] for row in rows})
    if (
        len(dates) != int(index["date_count"])
        or (dates[0] if dates else None) != index.get("min_date")
        or (dates[-1] if dates else None) != index.get("max_date")
    ):
        raise ValueError("active8_oof_materialized_artifact_date_range_mismatch")
    return rows


def load_indexed_oof_ev_rows(
    *,
    bucket: Any,
    cohort_id: str,
    source_manifest_checksum: str,
    knowledge_cutoff_date: str,
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Load checksum-verified compact OOF evidence without D1 full-row tables."""

    snapshots = load_oof_materialized_rows(
        bucket=bucket,
        cohort_id=cohort_id,
        artifact_kind="allocator_ev_snapshots",
        query_fn=query_fn,
    )
    l4_predictions = load_oof_materialized_rows(
        bucket=bucket,
        cohort_id=cohort_id,
        artifact_kind="l4_predictions",
        query_fn=query_fn,
    )
    if len(source_manifest_checksum) != 64:
        raise ValueError("active8_oof_indexed_source_manifest_checksum_invalid")
    if any(
        str(row.get("source_manifest_checksum") or "") != source_manifest_checksum
        for row in snapshots
    ):
        raise ValueError("active8_oof_indexed_snapshot_lineage_mismatch")

    mature_snapshots = [
        row for row in snapshots
        if str(row.get("label_known_date") or "")[:10] <= knowledge_cutoff_date
    ]
    mature_snapshot_keys = {
        (
            str(row.get("cohort_id") or ""),
            str(row.get("fold_id") or ""),
            str(row.get("snapshot_date") or "")[:10],
            str(row.get("symbol") or ""),
            str(row.get("market_segment") or ""),
        )
        for row in mature_snapshots
    }
    eligible_l4 = [
        row for row in l4_predictions
        if int(row.get("eligible_for_efficacy") or 0) == 1
        and str(row.get("trained_until") or "")[:10]
        < str(row.get("prediction_date") or "")[:10]
        and (
            str(row.get("cohort_id") or ""),
            str(row.get("fold_id") or ""),
            str(row.get("prediction_date") or "")[:10],
            str(row.get("symbol") or ""),
            str(row.get("market_segment") or ""),
        ) in mature_snapshot_keys
    ]
    return mature_snapshots, eligible_l4, {
        "schema_version": "active8-oof-indexed-loader-evidence-v1",
        "storage_mode": "gcs_indexed_v1",
        "source_manifest_checksum": source_manifest_checksum,
        "knowledge_cutoff_date": knowledge_cutoff_date,
        "snapshot_rows_loaded": len(snapshots),
        "snapshot_rows_mature": len(mature_snapshots),
        "snapshot_dates_mature": len({
            str(row.get("snapshot_date") or "")[:10]
            for row in mature_snapshots
        }),
        "l4_rows_loaded": len(l4_predictions),
        "l4_rows_eligible": len(eligible_l4),
        "d1_full_row_tables_required": False,
    }


def persist_oof_materialized_artifact_indexes(
    artifacts: list[dict[str, Any]],
    *,
    eligibility_rows: list[dict[str, Any]] | None = None,
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
    batch_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.batch_execute,
) -> dict[str, Any]:
    eligibility_rows = eligibility_rows or []
    legal_by_scope: dict[str, set[str]] = defaultdict(set)
    for row in eligibility_rows:
        if row.get("eligibility_status") == "legal":
            legal_by_scope[str(row.get("evidence_scope") or "")].add(
                str(row.get("prediction_date") or "")[:10]
            )
    scope_by_kind = {
        "allocator_ev_snapshots": "snapshot",
        "l4_predictions": "l4",
    }
    cohort_ids = sorted({str(row["cohort_id"]) for row in artifacts})
    existing_rows = query_fn(
        f"""
        SELECT cohort_id, artifact_kind, artifact_path, artifact_checksum,
               format_version, row_count, date_count, min_date, max_date,
               compressed_bytes, uncompressed_bytes, source_manifest_checksum,
               eligibility_policy_version, date_set_checksum
        FROM active8_oof_materialized_artifacts
        WHERE cohort_id IN ({','.join('?' for _ in cohort_ids)})
        """,
        cohort_ids,
    ) if cohort_ids else []
    existing_by_key = {
        (str(row["cohort_id"]), str(row["artifact_kind"])): row
        for row in existing_rows
    }
    history_sql = """
        INSERT OR IGNORE INTO active8_oof_materialized_artifact_history (
          cohort_id, artifact_kind, artifact_path, artifact_checksum,
          format_version, row_count, date_count, min_date, max_date,
          compressed_bytes, uncompressed_bytes, source_manifest_checksum,
          eligibility_policy_version, date_set_checksum,
          replaced_by_checksum, replacement_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    statements: list[tuple[str, list[Any]]] = []
    for artifact in artifacts:
        existing = existing_by_key.get((artifact["cohort_id"], artifact["artifact_kind"]))
        artifact["replacement_reason"] = None
        if existing and existing.get("artifact_checksum") != artifact["artifact_checksum"]:
            same_manifest = (
                existing.get("source_manifest_checksum")
                == artifact.get("source_manifest_checksum")
            )
            strict_forward = (
                same_manifest
                and existing.get("eligibility_policy_version")
                == OOF_PIT_ELIGIBILITY_POLICY_VERSION
                and int(artifact["date_count"]) > int(existing.get("date_count") or 0)
                and int(artifact["row_count"]) >= int(existing.get("row_count") or 0)
                and artifact.get("min_date") == existing.get("min_date")
                and str(artifact.get("max_date") or "") > str(existing.get("max_date") or "")
            )
            scope = scope_by_kind[artifact["artifact_kind"]]
            policy_upgrade = (
                same_manifest
                and existing.get("eligibility_policy_version")
                != OOF_PIT_ELIGIBILITY_POLICY_VERSION
                and artifact.get("eligibility_policy_version")
                == OOF_PIT_ELIGIBILITY_POLICY_VERSION
                and bool(artifact.get("dates"))
                and int(artifact.get("date_count") or 0) > 0
                and set(artifact.get("dates") or []).issubset(legal_by_scope[scope])
            )
            if not strict_forward and not policy_upgrade:
                raise ValueError(
                    "active8_oof_materialized_artifact_replacement_invalid:"
                    f"{artifact['artifact_kind']}"
                )
            reason = "strict-forward-extension" if strict_forward else OOF_POLICY_REPLACEMENT_REASON
            artifact["replacement_reason"] = reason
            statements.append((history_sql, [
                existing["cohort_id"], existing["artifact_kind"],
                existing["artifact_path"], existing["artifact_checksum"],
                existing["format_version"], existing["row_count"],
                existing["date_count"], existing.get("min_date"),
                existing.get("max_date"), existing["compressed_bytes"],
                existing["uncompressed_bytes"],
                existing["source_manifest_checksum"],
                existing.get("eligibility_policy_version") or "legacy-unversioned",
                existing.get("date_set_checksum"), artifact["artifact_checksum"], reason,
            ]))

    sql = """
        INSERT INTO active8_oof_materialized_artifacts (
          cohort_id, artifact_kind, artifact_path, artifact_checksum,
          format_version, row_count, date_count, min_date, max_date,
          compressed_bytes, uncompressed_bytes, source_manifest_checksum,
          eligibility_policy_version, date_set_checksum, replacement_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cohort_id, artifact_kind) DO UPDATE SET
          artifact_path=excluded.artifact_path,
          artifact_checksum=excluded.artifact_checksum,
          format_version=excluded.format_version,
          row_count=excluded.row_count,
          date_count=excluded.date_count,
          min_date=excluded.min_date,
          max_date=excluded.max_date,
          compressed_bytes=excluded.compressed_bytes,
          uncompressed_bytes=excluded.uncompressed_bytes,
          source_manifest_checksum=excluded.source_manifest_checksum,
          eligibility_policy_version=excluded.eligibility_policy_version,
          date_set_checksum=excluded.date_set_checksum,
          replacement_reason=excluded.replacement_reason,
          updated_at=CURRENT_TIMESTAMP
        WHERE active8_oof_materialized_artifacts.source_manifest_checksum = excluded.source_manifest_checksum
          AND (
            active8_oof_materialized_artifacts.artifact_checksum = excluded.artifact_checksum
            OR excluded.replacement_reason IN (
              'strict-forward-extension',
              'remove-post-next-open-native-pit-rows',
              'restore-checksum-verified-recorded-pit-evidence',
              'add-recorded-decision-cutoff-sector-pit-evidence'
            )
          )
    """
    statements.extend((sql, [
        row["cohort_id"], row["artifact_kind"], row["artifact_path"],
        row["artifact_checksum"], row["format_version"], row["row_count"],
        row["date_count"], row["min_date"], row["max_date"],
        row["compressed_bytes"], row["uncompressed_bytes"],
        row["source_manifest_checksum"], row["eligibility_policy_version"],
        row["date_set_checksum"], row.get("replacement_reason"),
    ]) for row in artifacts)
    result = batch_fn(statements, timeout=60.0, chunk_size=10)
    if result.get("error_count"):
        raise RuntimeError(f"active8_oof_materialized_artifact_index_failed:{result}")
    return result
def load_verified_oof_manifest(
    manifest_path: str,
    *,
    bucket: Any,
) -> tuple[dict[str, Any], bytes]:
    raw = bucket.blob(manifest_path).download_as_bytes()
    manifest = json.loads(raw.decode("utf-8"))
    if manifest.get("schema_version") not in {
        "active8-oof-cohort-manifest-v1",
        "active8-oof-cohort-manifest-v2",
        "active8-oof-cohort-manifest-v3",
        "active8-oof-cohort-manifest-v4",
    }:
        raise ValueError("active8_oof_manifest_schema_invalid")
    if manifest.get("generation_mode") != "purged_oof":
        raise ValueError("active8_oof_manifest_generation_mode_invalid")
    if manifest.get("status") != "ready":
        raise ValueError("active8_oof_manifest_not_ready")
    if list(manifest.get("model_set") or []) != list(ACTIVE8_MODELS):
        raise ValueError("active8_oof_manifest_model_set_invalid")
    if manifest.get("manifest_checksum") != _manifest_checksum(manifest):
        raise ValueError("active8_oof_manifest_checksum_mismatch")
    if manifest.get("schema_version") in {
        "active8-oof-cohort-manifest-v2",
        "active8-oof-cohort-manifest-v3",
        "active8-oof-cohort-manifest-v4",
    }:
        parent = manifest.get("parent_manifest") or {}
        reused = [window for window in manifest.get("windows") or [] if window.get("source_cohort_id")]
        if reused and (
            not str(parent.get("path") or "").strip()
            or len(str(parent.get("checksum") or "")) != 64
            or not str(parent.get("cohort_id") or "").strip()
        ):
            raise ValueError("active8_oof_parent_manifest_lineage_missing")
    if manifest.get("schema_version") in {
        "active8-oof-cohort-manifest-v3",
        "active8-oof-cohort-manifest-v4",
    }:
        prep = manifest.get("prep_manifest") or {}
        if (
            len(str(prep.get("manifest_checksum") or "")) != 64
            or prep.get("target_semantic_version") != TARGET_SEMANTIC_VERSION
            or float(prep.get("roundtrip_cost_bps") or 0.0) != 18.0
            or int(prep.get("batch_count") or 0) < 1
        ):
            raise ValueError("active8_oof_prep_manifest_lineage_invalid")
        sequence = manifest.get("sequence_manifest") or {}
        batch_checksums = sequence.get("batch_checksums") or {}
        if (
            len(str(sequence.get("artifact_checksum") or "")) != 64
            or sequence.get("contract") != "sequence_records_v3"
            or sequence.get("target_semantic_version") != TARGET_SEMANTIC_VERSION
            or int(sequence.get("batch_count") or 0) < 1
            or len(batch_checksums) != int(sequence.get("batch_count") or 0)
            or any(len(str(value or "")) != 64 for value in batch_checksums.values())
        ):
            raise ValueError("active8_oof_sequence_manifest_lineage_invalid")
    if manifest.get("schema_version") == "active8-oof-cohort-manifest-v4":
        for window in manifest.get("windows") or []:
            if (
                not str(window.get("source_prep_gcs_prefix") or "").strip()
                or len(str(window.get("source_prep_manifest_checksum") or "")) != 64
                or not str(window.get("source_sequence_gcs_prefix") or "").strip()
                or len(str(window.get("source_sequence_manifest_checksum") or "")) != 64
            ):
                raise ValueError("active8_oof_fold_input_lineage_invalid")
    return manifest, raw



def _load_prediction_artifact(
    *,
    bucket: Any,
    path: str,
    expected_checksum: str,
    expected_artifact_cohort: str,
    materialized_cohort: str,
    expected_artifact_fold: str,
    materialized_fold: str,
    expected_model: str,
    split: dict[str, str],
    expected_generation_mode: str = "purged_oof",
) -> list[dict[str, Any]]:
    raw = bucket.blob(path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_checksum:
        raise ValueError(f"active8_oof_artifact_checksum_mismatch:{expected_model}:{expected_artifact_fold}")
    data = np.load(io.BytesIO(raw), allow_pickle=True)
    metadata = json.loads(str(data["metadata"].item()))
    expected = {
        "schema_version": "active8-oof-predictions-v1",
        "generation_mode": expected_generation_mode,
        "cohort_id": expected_artifact_cohort,
        "fold_id": expected_artifact_fold,
        "model_name": expected_model,
        "target_semantic_version": TARGET_SEMANTIC_VERSION,
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise ValueError(f"active8_oof_artifact_metadata_mismatch:{key}:{expected_model}:{expected_artifact_fold}")
    arrays = {
        name: np.asarray(data[name]).reshape(-1)
        for name in (
            "raw_scores",
            "rank_scores",
            "targets",
            "dates",
            "symbols",
            "markets",
            "label_known_dates",
        )
    }
    lengths = {len(values) for values in arrays.values()}
    if lengths != {int(metadata.get("rows") or 0)}:
        raise ValueError(f"active8_oof_artifact_array_length_mismatch:{expected_model}:{expected_artifact_fold}")
    return [
        {
            "cohort_id": materialized_cohort,
            "source_cohort_id": expected_artifact_cohort,
            "fold_id": materialized_fold,
            "prediction_date": str(arrays["dates"][idx])[:10],
            "symbol": str(arrays["symbols"][idx]),
            "market_segment": str(arrays["markets"][idx]),
            "model_name": expected_model,
            "raw_score": float(arrays["raw_scores"][idx]),
            "rank_score": float(arrays["rank_scores"][idx]),
            "target_return": float(arrays["targets"][idx]),
            "label_known_date": str(arrays["label_known_dates"][idx])[:10],
            "artifact_version": str(metadata["artifact_version"]),
            "artifact_checksum": expected_checksum,
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
            "score_semantic_version": str(metadata["score_semantic"]),
            **split,
        }
        for idx in range(next(iter(lengths), 0))
    ]


def load_oof_prediction_rows(
    manifest: dict[str, Any],
    *,
    bucket: Any,
) -> list[dict[str, Any]]:
    cohort_id = str(manifest["cohort_id"])
    rows: list[dict[str, Any]] = []
    for window in manifest.get("windows") or []:
        fold_id = f"w{window['window_id']}"
        source_fold_id = str(window.get("source_fold_id") or fold_id)
        source_cohort_id = str(window.get("source_cohort_id") or cohort_id)
        split = {
            "train_start": str((window.get("train_range") or [None, None])[0]),
            "train_end": str((window.get("train_range") or [None, None])[1]),
            "test_start": str((window.get("test_range") or [None, None])[0]),
            "test_end": str((window.get("test_range") or [None, None])[1]),
        }
        metrics = window.get("model_metrics") or {}
        for model_name in ACTIVE8_MODELS:
            model = metrics.get(model_name) or {}
            if model.get("status") != "ready" or not model.get("oof_artifact"):
                raise ValueError(f"active8_oof_fold_model_missing:{fold_id}:{model_name}")
            rows.extend(_load_prediction_artifact(
                bucket=bucket,
                path=str(model["oof_artifact"]),
                expected_checksum=str(model.get("artifact_checksum") or ""),
                expected_artifact_cohort=source_cohort_id,
                materialized_cohort=cohort_id,
                expected_artifact_fold=source_fold_id,
                materialized_fold=fold_id,
                expected_model=model_name,
                split=split,
            ))
    return rows


def load_verified_oof_forward_extension(
    manifest_path: str,
    *,
    bucket: Any,
    base_manifest: dict[str, Any],
) -> dict[str, Any]:
    raw = bucket.blob(manifest_path).download_as_bytes()
    manifest = json.loads(raw.decode("utf-8"))
    if (
        manifest.get("schema_version") != "active8-oof-forward-extension-v1"
        or manifest.get("status") != "ready"
        or manifest.get("generation_mode") != "frozen_forward_oos"
        or manifest.get("promotion_eligible") is not False
        or manifest.get("training_dispatched") is not False
        or manifest.get("counterfactual_reconstruction") is not True
        or manifest.get("target_semantic_version") != TARGET_SEMANTIC_VERSION
        or manifest.get("manifest_checksum") != _manifest_checksum(manifest)
    ):
        raise ValueError("active8_oof_forward_manifest_invalid")
    if (
        str(manifest.get("base_cohort_id") or "") != str(base_manifest.get("cohort_id") or "")
        or str(manifest.get("base_manifest_checksum") or "")
        != str(base_manifest.get("manifest_checksum") or "")
    ):
        raise ValueError("active8_oof_forward_base_lineage_mismatch")
    artifacts = dict(manifest.get("model_artifacts") or {})
    if any(name not in artifacts for name in CORE_CROSS_SECTIONAL_MODELS):
        raise ValueError("active8_oof_forward_core_models_missing")
    dates = [str(value)[:10] for value in (manifest.get("dates") or [])]
    extension_range = list(manifest.get("extension_range") or [])
    if (
        not dates
        or len(extension_range) != 2
        or min(dates) < str(extension_range[0])[:10]
        or max(dates) > str(extension_range[1])[:10]
        or max(dates) > str(manifest.get("knowledge_cutoff_date") or "")[:10]
    ):
        raise ValueError("active8_oof_forward_date_contract_invalid")
    return manifest


def load_oof_forward_prediction_rows(
    manifest: dict[str, Any],
    *,
    bucket: Any,
    materialized_cohort: str,
) -> list[dict[str, Any]]:
    extension_id = str(manifest.get("extension_id") or "")
    extension_range = list(manifest.get("extension_range") or [None, None])
    train_range = list(manifest.get("source_train_range") or [None, None])
    split = {
        "train_start": str(train_range[0]),
        "train_end": str(train_range[1]),
        "test_start": str(extension_range[0]),
        "test_end": str(extension_range[1]),
    }
    rows: list[dict[str, Any]] = []
    for model_name, artifact in sorted(dict(manifest.get("model_artifacts") or {}).items()):
        if model_name not in ACTIVE8_MODELS:
            raise ValueError(f"active8_oof_forward_unknown_model:{model_name}")
        rows.extend(_load_prediction_artifact(
            bucket=bucket,
            path=str(artifact.get("path") or ""),
            expected_checksum=str(artifact.get("payload_checksum") or ""),
            expected_artifact_cohort=extension_id,
            materialized_cohort=materialized_cohort,
            expected_artifact_fold="frozen_forward",
            materialized_fold="frozen_forward",
            expected_model=model_name,
            split=split,
            expected_generation_mode="frozen_forward_oos",
        ))
    observed = sorted({str(row["prediction_date"])[:10] for row in rows})
    if observed != sorted(str(value)[:10] for value in (manifest.get("dates") or [])):
        raise ValueError("active8_oof_forward_prediction_dates_mismatch")
    return rows

def build_oof_fold_artifact_rows(
    manifest: dict[str, Any],
    prediction_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    counts: dict[tuple[str, str], dict[str, Any]] = defaultdict(
        lambda: {"rows": 0, "dates": set()}
    )
    for row in prediction_rows:
        key = (str(row["fold_id"]), str(row["model_name"]))
        counts[key]["rows"] += 1
        counts[key]["dates"].add(str(row["prediction_date"])[:10])

    cohort_id = str(manifest["cohort_id"])
    parent = manifest.get("parent_manifest") or {}
    output: list[dict[str, Any]] = []
    for window in manifest.get("windows") or []:
        fold_id = f"w{window['window_id']}"
        source_cohort_id = str(window.get("source_cohort_id") or cohort_id)
        source_manifest_checksum = str(
            window.get("source_manifest_checksum")
            or (
                parent.get("checksum")
                if source_cohort_id != cohort_id
                else manifest["manifest_checksum"]
            )
            or ""
        )
        if len(source_manifest_checksum) != 64:
            raise ValueError(f"active8_oof_fold_source_manifest_checksum_invalid:{fold_id}")
        train_range = list(window.get("train_range") or [None, None])
        test_range = list(window.get("test_range") or [None, None])
        for model_name in ACTIVE8_MODELS:
            model = (window.get("model_metrics") or {}).get(model_name) or {}
            count = counts[(fold_id, model_name)]
            output.append({
                "cohort_id": cohort_id,
                "fold_id": fold_id,
                "source_cohort_id": source_cohort_id,
                "source_manifest_checksum": source_manifest_checksum,
                "model_name": model_name,
                "artifact_path": str(model.get("oof_artifact") or ""),
                "artifact_checksum": str(model.get("artifact_checksum") or ""),
                "artifact_rows": int(count["rows"]),
                "prediction_dates": len(count["dates"]),
                "train_start": str(train_range[0]),
                "train_end": str(train_range[1]),
                "test_start": str(test_range[0]),
                "test_end": str(test_range[1]),
                "target_semantic_version": TARGET_SEMANTIC_VERSION,
                "score_semantic_version": "same-market-same-date-percentile-rank-v1",
            })
    return output


RECORDED_PIT_COMPONENT_SOURCE = "screener_funnel_scoring_recorded_pit_v1"


def _counterfactual_score_v2(
    native_payload: dict[str, Any],
    ensemble_rank: float,
    *,
    native_component_source: str = "daily_recommendations_score_v2_v3",
    fundamental_quality: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if native_payload.get("version") != "score_v2":
        raise ValueError("oof_native_score_v2_missing")
    source_semantic = native_payload.get("semanticVersion")
    recorded_pit = native_component_source == RECORDED_PIT_COMPONENT_SOURCE
    if source_semantic != SCORE_SEMANTIC_VERSION and not (
        recorded_pit and source_semantic in {None, ""}
    ):
        raise ValueError("oof_native_score_semantic_mismatch")
    components = dict(native_payload.get("components") or {})
    required = {"chipFlow", "technicalStructure", "fundamentalQuality"}
    if not required.issubset(components):
        raise ValueError("oof_native_non_ml_score_components_missing")
    components["mlEdge"] = round(max(0.0, min(1.0, float(ensemble_rank))) * 25.0, 6)
    formal_fundamental = (
        fundamental_quality
        if isinstance(fundamental_quality, dict)
        and fundamental_quality.get("version") == "fundamental_quality_v1"
        else None
    )
    if formal_fundamental is not None:
        components["fundamentalQuality"] = round(
            max(0.0, min(25.0, float(formal_fundamental.get("score") or 0.0))),
            6,
        )
    components["newsTheme"] = 0.0
    total = round(sum(float(components[name]) for name in (
        "mlEdge", "chipFlow", "technicalStructure", "fundamentalQuality", "newsTheme"
    )), 6)
    return {
        **native_payload,
        "components": components,
        "total": total,
        "finalScore": total,
        "alphaAdjustment": 0.0,
        "semanticVersion": SCORE_SEMANTIC_VERSION,
        "counterfactualLineage": {
            "generationMode": "purged_oof",
            "mlEdgeOwner": STACKER_SEMANTIC_VERSION,
            "nonMlComponentsOwner": native_component_source,
            "sourceSemanticVersion": source_semantic,
            "sourceWasRecordedPointInTime": recorded_pit,
            "nativeAlphaAdjustmentExcluded": True,
            "fundamentalQualityOwner": (
                "fundamental_quality_v1_pit"
                if formal_fundamental is not None
                else native_component_source
            ),
            "fundamentalQualityNoLookahead": (
                formal_fundamental.get("noLookahead")
                if formal_fundamental is not None
                else None
            ),
            "fundamentalQualityDataIssues": (
                formal_fundamental.get("dataIssues")
                if formal_fundamental is not None
                else None
            ),
        },
    }


def build_oof_snapshot_rows(
    prediction_rows: list[dict[str, Any]],
    native_rows: list[dict[str, Any]],
    *,
    cohort_id: str,
    source_manifest_checksum: str,
    fundamental_quality_by_key: dict[tuple[str, str], dict[str, Any]] | None = None,
    market_context_by_date: dict[tuple[str, str], dict[str, Any]] | None = None,
    sector_alpha_by_key: dict[tuple[str, str], dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    stack_rows, stack_evidence = build_chronological_oof_stack(prediction_rows)
    native_by_key = {
        (str(row.get("prediction_date") or row.get("date") or "")[:10], str(row.get("symbol") or "")): row
        for row in native_rows
    }
    fundamental_quality_by_key = fundamental_quality_by_key or {}
    market_context_by_date = market_context_by_date or {}
    sector_alpha_by_key = sector_alpha_by_key or {}
    fundamental_pit_rows = 0
    market_context_rows = 0
    sector_alpha_rows = 0
    snapshots: list[dict[str, Any]] = []
    rejected = defaultdict(int)
    rejected_by_date: dict[str, Counter[str]] = defaultdict(Counter)
    stacker_eligible_by_date: Counter[str] = Counter()
    native_matched_by_date: Counter[str] = Counter()
    snapshot_rows_by_date: Counter[str] = Counter()
    for stacked in stack_rows:
        if not stacked["eligible_for_efficacy"]:
            rejected["stacker_warmup"] += 1
            rejected_by_date[stacked["prediction_date"]]["stacker_warmup"] += 1
            continue
        stacker_eligible_by_date[stacked["prediction_date"]] += 1
        native = native_by_key.get((stacked["prediction_date"], stacked["symbol"]))
        if native is None:
            rejected["native_pit_components_missing"] += 1
            rejected_by_date[stacked["prediction_date"]]["native_pit_components_missing"] += 1
            continue
        native_matched_by_date[stacked["prediction_date"]] += 1
        try:
            score_payload = _counterfactual_score_v2(
                _loads(native.get("score_components")),
                stacked["ensemble_rank"],
                fundamental_quality=fundamental_quality_by_key.get((
                    stacked["prediction_date"], stacked["symbol"]
                )),
                native_component_source=str(
                    native.get("native_component_source")
                    or "daily_recommendations_score_v2_v3"
                ),
            )
            if score_payload["counterfactualLineage"].get("fundamentalQualityOwner") == "fundamental_quality_v1_pit":
                fundamental_pit_rows += 1
        except ValueError as exc:
            rejected[str(exc)] += 1
            rejected_by_date[stacked["prediction_date"]][str(exc)] += 1
            continue
        versions = dict(stacked["artifact_versions"])
        contributors = [name for name in ACTIVE8_MODELS if name in versions]
        signature = build_model_set_signature(versions, contributors)
        if signature is None:
            rejected["model_set_signature_invalid"] += 1
            rejected_by_date[stacked["prediction_date"]]["model_set_signature_invalid"] += 1
            continue
        forecast = _loads(native.get("forecast_data"))
        forecast["ensemble_v2"] = {
            "avg_rank": stacked["ensemble_rank"],
            "semantic_version": STACKER_SEMANTIC_VERSION,
            "generation_mode": "purged_oof",
            "artifact_versions": versions,
            "contributing_models": contributors,
            "model_availability": stacked["model_availability"],
            "model_set_signature": signature,
            "stacker_source": stacked["stacker_source"],
        }
        signal_date = stacked["prediction_date"]
        recorded_context = recorded_market_context(native, signal_date=signal_date)
        reconstructed_context = context_for_market_segment(
            market_context_by_date,
            signal_date=signal_date,
            market_segment=stacked["market_segment"],
        )
        market_context = merge_market_context(
            recorded_context,
            reconstructed_context,
            signal_date=signal_date,
        )
        if market_context.get("market_context_available"):
            market_context_rows += 1
        alpha_context = _loads(native.get("alpha_context"))
        alpha_context["market_regime_context"] = market_context
        sector_expert = sector_alpha_by_key.get((signal_date, stacked["symbol"]))
        if not isinstance(sector_expert, dict):
            sector_expert = unavailable_sector_alpha(signal_date, "oof_sector_alpha_not_loaded")
        alpha_context["pit_sector_alpha_expert"] = sector_expert
        if sector_expert.get("status") == "loaded" and sector_expert.get("point_in_time") is True:
            sector_alpha_rows += 1
        forecast.pop("s12_trade_ev", None)
        allocation = _loads(native.get("alpha_allocation"))
        allocation.pop("s12_trade_ev", None)
        snapshot_rows_by_date[stacked["prediction_date"]] += 1
        snapshots.append({
            "cohort_id": cohort_id,
            "fold_id": stacked["fold_id"],
            "snapshot_date": stacked["prediction_date"],
            "stock_id": native.get("stock_id"),
            "symbol": stacked["symbol"],
            "market_segment": stacked["market_segment"],
            "forecast_data": json.dumps(forecast, sort_keys=True),
            "score": score_payload["finalScore"],
            "score_components": json.dumps(score_payload, sort_keys=True),
            "alpha_context": json.dumps(alpha_context, sort_keys=True),
            "alpha_allocation": json.dumps(allocation, sort_keys=True),
            "market_heat_expected_return": native.get("market_heat_expected_return"),
            "recommendation_lane": native.get("recommendation_lane"),
            "l4_model_version": None,
            "s12_source": None,
            "s12_asof_date": None,
            "label_known_date": stacked["label_known_date"],
            "model_set_signature": signature,
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
            "generation_mode": "purged_oof",
            "source_manifest_checksum": source_manifest_checksum,
            "l4_executable_return_pct": stacked["target_return"],
            "label_adjustment_source": OOF_PRICE_HORIZON_SOURCE,
            "prediction_generated_at": f"{stacked['prediction_date']}T13:30:00+08:00",
        })
    return snapshots, {
        "stacker": stack_evidence,
        "snapshot_rows": len(snapshots),
        "snapshot_dates": len({row["snapshot_date"] for row in snapshots}),
        "fundamental_pit_rows": fundamental_pit_rows,
        "fundamental_pit_coverage": round(fundamental_pit_rows / max(1, len(snapshots)), 6),
        "market_context_rows": market_context_rows,
        "market_context_coverage": round(market_context_rows / max(1, len(snapshots)), 6),
        "sector_alpha_rows": sector_alpha_rows,
        "sector_alpha_coverage": round(sector_alpha_rows / max(1, len(snapshots)), 6),
        "rejected": dict(sorted(rejected.items())),
        "rejected_by_date": {
            date: dict(sorted(reasons.items()))
            for date, reasons in sorted(rejected_by_date.items())
        },
        "stacker_eligible_by_date": dict(sorted(stacker_eligible_by_date.items())),
        "native_matched_by_date": dict(sorted(native_matched_by_date.items())),
        "snapshot_rows_by_date": dict(sorted(snapshot_rows_by_date.items())),
    }


def load_fundamental_quality_pit_by_key(
    prediction_rows: list[dict[str, Any]],
    *,
    query_fn: Callable[..., list[dict[str, Any]]] = MARKET_D1_CLIENT.query,
) -> dict[tuple[str, str], dict[str, Any]]:
    """Resolve formal fundamental scores using only immutable rows available by prediction date.

    Legacy canonical_revenue_monthly is mutable by natural key and has no trustworthy
    observation revision, so historical OOF must exclude it until append-only v2 exists.
    """

    keys = sorted({
        (str(row.get("prediction_date") or "")[:10], str(row.get("symbol") or "").strip())
        for row in prediction_rows
        if row.get("prediction_date") and row.get("symbol")
    })
    if not keys:
        return {}
    symbols = sorted({symbol for _date, symbol in keys})
    max_date = max(date for date, _symbol in keys)
    financial_by_symbol: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for offset in range(0, len(symbols), D1_IN_CLAUSE_CHUNK_SIZE):
        chunk = symbols[offset:offset + D1_IN_CLAUSE_CHUNK_SIZE]
        placeholders = ",".join("?" for _ in chunk)
        financial_rows = query_fn(
            f"""
            SELECT stock_id, period, market_segment, report_date, available_date,
                   revenue_growth_yoy, gross_margin, operating_margin, roe, eps,
                   pe, pb, dividend_yield, debt_ratio, current_ratio,
                   operating_cash_flow, industry_quality_percentile,
                   roa, roa_comprehensive, roe_comprehensive, free_cash_flow,
                   net_margin, quick_ratio, cash_flow_ratio, equity_to_assets,
                   liabilities_to_equity, gross_margin_growth,
                   operating_income_growth, net_income_growth,
                   recurring_income_growth, total_asset_turnover,
                   receivables_turnover, inventory_turnover,
                   interest_expense_ratio, source, as_of_date
            FROM canonical_fundamental_features
            WHERE stock_id IN ({placeholders})
              AND date(available_date) <= date(?)
              AND date(as_of_date) <= date(?)
              AND source IN ('finlab.fundamental_factor_diversity', 'finlab.daily_valuation')
            ORDER BY stock_id, available_date, period
            """,
            [*chunk, max_date, max_date],
        )
        for row in financial_rows or []:
            financial_by_symbol[str(row.get("stock_id") or "")].append(dict(row))

    out: dict[tuple[str, str], dict[str, Any]] = {}
    for prediction_date, symbol in keys:
        financial_rows = financial_by_symbol.get(symbol, [])
        payload = score_fundamental_quality(
            decision_date=prediction_date,
            revenue_rows=[],
            financial_rows=financial_rows,
        )
        no_lookahead = payload.get("noLookahead") or {}
        no_lookahead["legacyMonthlyRevenueStatus"] = "PIT_UNAVAILABLE"
        no_lookahead["legacyMonthlyRevenueReason"] = (
            "canonical_revenue_monthly_mutable_natural_key_without_observation_revision"
        )
        payload["noLookahead"] = no_lookahead
        available_rows = (
            len(financial_rows) - int(no_lookahead.get("droppedFutureFinancialRows") or 0)
        )
        if available_rows <= 0:
            continue
        payload["sourceRowCounts"] = {
            "available": available_rows,
            "loadedRevenue": 0,
            "loadedFinancial": len(financial_rows),
        }
        out[(prediction_date, symbol)] = payload
    return out

def load_native_pit_component_rows(
    prediction_rows: list[dict[str, Any]],
    *,
    query_fn: Callable[..., list[dict[str, Any]]] | None = None,
    archive_resolver: Callable[
        [list[dict[str, Any]]], dict[int, dict[str, Any]]
    ] = resolve_legacy_screener_evidence,
) -> list[dict[str, Any]]:
    """Load same-day non-ML ScoreV2 inputs without reconstructing future data."""

    query_fn = query_fn or _query_native_pit_component_domain_split

    dates = sorted({row["prediction_date"] for row in prediction_rows})
    if not dates:
        return []
    symbols = {str(row.get("symbol") or "") for row in prediction_rows}
    rows_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    query_date_chunk_size = 4  # Bounds large screener evidence JSON returned by each D1 request.

    # Native v3 rows remain authoritative whenever the historical producer
    # persisted the complete semantic contract.
    for offset in range(0, len(dates), query_date_chunk_size):
        chunk = dates[offset:offset + query_date_chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        native_rows = query_fn(
            f"""
            SELECT
              dr.stock_id,
              s.symbol,
              dr.date prediction_date,
              dr.score,
              dr.score_components,
              dr.alpha_context,
              dr.alpha_allocation,
              dr.market_segment,
              dr.recommendation_lane,
              p.forecast_data,
              json_extract(dr.alpha_context, '$.market_heat_expected_return') market_heat_expected_return,
              'daily_recommendations_score_v2_v3' native_component_source,
              NULL native_run_id,
              dr.created_at native_created_at
            FROM daily_recommendations dr
            JOIN stocks s ON s.id = dr.stock_id
            LEFT JOIN predictions p
              ON p.stock_id = dr.stock_id
             AND p.prediction_date = dr.date
             AND p.model_name = 'ensemble'
             AND p.generated_at = (
               SELECT MAX(p2.generated_at)
               FROM predictions p2
               WHERE p2.stock_id = dr.stock_id
                 AND p2.prediction_date = dr.date
                 AND p2.model_name = 'ensemble'
             )
            WHERE dr.date IN ({placeholders})
              AND json_extract(dr.score_components, '$.version') = 'score_v2'
              AND json_extract(dr.score_components, '$.semanticVersion') = ?
            """,
            [*chunk, SCORE_SEMANTIC_VERSION],
        )
        for row in native_rows:
            key = (str(row.get("prediction_date") or "")[:10], str(row.get("symbol") or ""))
            if key[0] and key[1] in symbols:
                rows_by_key[key] = row

    # Older ScoreV2 producers omitted semanticVersion from daily outputs, but
    # their canonical screener scoring stage retained the actual non-ML
    # components. Resolve only runs completed before the next market open.
    calendar_rows = query_fn(
        """
        SELECT substr(date, 1, 10) trading_date, COUNT(*) price_rows
        FROM stock_prices
        WHERE substr(date, 1, 10) BETWEEN date(?, '-30 days') AND date(?, '+14 days')
        GROUP BY substr(date, 1, 10)
        ORDER BY trading_date
        """,
        [dates[0], dates[-1]],
    )
    observed_counts = [
        max(0, int(row.get("price_rows") or 0))
        for row in calendar_rows
        if str(row.get("trading_date") or "")
    ]
    coverage_reference = statistics.median(observed_counts) if observed_counts else 0.0
    coverage_threshold = max(1, int(coverage_reference * 0.20))
    market_sessions = sorted({
        str(row.get("trading_date") or "")[:10]
        for row in calendar_rows
        if int(row.get("price_rows") or 0) >= coverage_threshold
    })
    next_session: dict[str, str] = {}
    for date in dates:
        later = [session for session in market_sessions if session > date]
        if later:
            next_session[date] = later[0]

    for offset in range(0, len(dates), query_date_chunk_size):
        chunk = dates[offset:offset + query_date_chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        run_rows = query_fn(
            f"""
            SELECT
              r.date,
              r.run_id,
              r.created_at,
              COUNT(i.id) component_rows
            FROM screener_funnel_runs r
            JOIN screener_funnel_items i
              ON i.run_id = r.run_id
             AND i.stage = 'scoring'
            WHERE r.date IN ({placeholders})
              AND r.status = 'success'
              AND json_valid(i.evidence) = 1
              AND (
                json_extract(i.evidence, '$.score_components') IS NOT NULL
                OR (
                  json_extract(i.evidence, '$.schema_version') = 'legacy-screener-evidence-pointer-v1'
                  AND json_extract(i.evidence, '$.artifact_id') LIKE 'artifact:legacy_screener_funnel_evidence:%'
                  AND substr(json_extract(i.evidence, '$.r2_key'), 1, 69) = 'evidence/class=superseded_run/domain=legacy_screener_funnel_evidence/'
                  AND json_extract(i.evidence, '$.checksum') LIKE 'sha256:%'
                  AND CAST(json_extract(i.evidence, '$.row_id') AS INTEGER) = i.id
                )
              )
            GROUP BY r.date, r.run_id, r.created_at
            ORDER BY r.date, r.created_at, r.run_id
            """,
            chunk,
        )
        selected_runs: dict[str, dict[str, Any]] = {}
        for run in run_rows:
            date = str(run.get("date") or "")[:10]
            cutoff_date = next_session.get(date)
            created_at = str(run.get("created_at") or "").strip()
            if not cutoff_date or not created_at:
                continue
            try:
                created = datetime.fromisoformat(created_at.replace(" ", "T")).replace(
                    tzinfo=timezone.utc
                )
                execution_cutoff = datetime.fromisoformat(
                    f"{cutoff_date}T01:00:00+00:00"
                )
            except ValueError:
                continue
            if created >= execution_cutoff or int(run.get("component_rows") or 0) <= 0:
                continue
            selected_runs.setdefault(date, run)
        if not selected_runs:
            continue

        run_ids = [str(run["run_id"]) for run in selected_runs.values()]
        run_placeholders = ",".join("?" for _ in run_ids)
        evidence_rows = query_fn(
            f"""
            SELECT
              i.id evidence_row_id,
              s.id stock_id,
              i.symbol,
              r.date prediction_date,
              i.score_after score,
              i.evidence,
              s.market market_segment,
              r.run_id native_run_id,
              r.created_at native_created_at
            FROM screener_funnel_items i
            JOIN screener_funnel_runs r ON r.run_id = i.run_id
            JOIN stocks s ON s.symbol = i.symbol
            WHERE i.run_id IN ({run_placeholders})
              AND i.stage = 'scoring'
              AND json_valid(i.evidence) = 1
              AND (
                json_extract(i.evidence, '$.score_components') IS NOT NULL
                OR (
                  json_extract(i.evidence, '$.schema_version') = 'legacy-screener-evidence-pointer-v1'
                  AND json_extract(i.evidence, '$.artifact_id') LIKE 'artifact:legacy_screener_funnel_evidence:%'
                  AND substr(json_extract(i.evidence, '$.r2_key'), 1, 69) = 'evidence/class=superseded_run/domain=legacy_screener_funnel_evidence/'
                  AND json_extract(i.evidence, '$.checksum') LIKE 'sha256:%'
                  AND CAST(json_extract(i.evidence, '$.row_id') AS INTEGER) = i.id
                )
              )
            """,
            run_ids,
        )
        pointer_requests: list[dict[str, Any]] = []
        for row in evidence_rows:
            pointer = _loads(row.get("evidence"))
            if pointer.get("schema_version") != "legacy-screener-evidence-pointer-v1":
                continue
            pointer_requests.append({
                "row_id": int(row.get("evidence_row_id") or 0),
                "artifact_id": pointer.get("artifact_id"),
                "r2_key": pointer.get("r2_key"),
                "checksum": pointer.get("checksum"),
                "source_run_id": row.get("native_run_id"),
                "symbol": row.get("symbol"),
                "stage": "scoring",
            })
        archived_by_row_id = archive_resolver(pointer_requests) if pointer_requests else {}
        for row in evidence_rows:
            date = str(row.get("prediction_date") or "")[:10]
            symbol = str(row.get("symbol") or "")
            selected = selected_runs.get(date)
            if not selected or str(row.get("native_run_id") or "") != str(selected["run_id"]):
                continue
            if symbol not in symbols or (date, symbol) in rows_by_key:
                continue
            pointer = _loads(row.get("evidence"))
            archive_lineage: dict[str, Any] = {"native_evidence_storage_mode": "d1_inline_v1"}
            if pointer.get("schema_version") == "legacy-screener-evidence-pointer-v1":
                row_id = int(row.get("evidence_row_id") or 0)
                archived = archived_by_row_id.get(row_id)
                if archived is None:
                    raise RuntimeError(f"legacy_evidence_resolve_failed:missing_row:{row_id}")
                evidence = _loads(archived.get("evidence"))
                archive_lineage = {
                    "native_evidence_storage_mode": "r2_checksum_pointer_v1",
                    "native_evidence_artifact_id": archived.get("artifact_id"),
                    "native_evidence_r2_key": archived.get("r2_key"),
                    "native_evidence_checksum": archived.get("checksum"),
                    "native_evidence_row_id": row_id,
                }
            else:
                evidence = pointer
            score_payload = _loads(evidence.get("score_components"))
            components = score_payload.get("components")
            if (
                score_payload.get("version") != "score_v2"
                or not isinstance(components, dict)
                or not {"chipFlow", "technicalStructure", "fundamentalQuality"}.issubset(components)
            ):
                continue
            alpha_context = {
                "version": "oof-recorded-pit-context-v1",
                "taxonomy": evidence.get("taxonomy") or {},
                "raw_signals": evidence.get("raw_signals") or {},
                "native_component_source": RECORDED_PIT_COMPONENT_SOURCE,
                "native_run_id": row.get("native_run_id"),
                "native_created_at": row.get("native_created_at"),
                "execution_cutoff_utc": f"{next_session[date]}T01:00:00+00:00",
                **archive_lineage,
            }
            rows_by_key[(date, symbol)] = {
                **row,
                "score": score_payload.get("total", row.get("score")),
                "score_components": json.dumps(score_payload, sort_keys=True),
                "alpha_context": json.dumps(alpha_context, sort_keys=True),
                "alpha_allocation": "{}",
                "recommendation_lane": "oof_recorded_pit_screener_scoring",
                "forecast_data": "{}",
                "market_heat_expected_return": None,
                "native_component_source": RECORDED_PIT_COMPONENT_SOURCE,
            }
    rows = list(rows_by_key.values())
    for row in rows:
        prediction_date = str(row.get("prediction_date") or "")[:10]
        decision_cutoff = str(
            row.get("decision_universe_frozen_at")
            or row.get("native_created_at")
            or ""
        ).strip()
        if decision_cutoff:
            row["decision_universe_frozen_at"] = decision_cutoff
        elif prediction_date:
            # Match the conservative market-close cutoff persisted on OOF rows.
            row["decision_universe_frozen_at"] = (
                f"{prediction_date}T13:30:00+08:00"
            )
    return rows


def persist_l4_oof_predictions(
    predictions: list[dict[str, Any]],
    *,
    dry_run: bool = True,
    batch_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.batch_execute,
) -> dict[str, Any]:
    if dry_run:
        return {"status": "dry_run", "rows": len(predictions)}
    sql = """
        INSERT INTO l4_oof_predictions (
          cohort_id, fold_id, prediction_date, symbol, market_segment,
          expected_return, prediction_json, trained_until, model_version,
          eligible_for_efficacy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cohort_id, fold_id, prediction_date, symbol, market_segment)
        DO UPDATE SET
          expected_return=excluded.expected_return,
          prediction_json=excluded.prediction_json,
          trained_until=excluded.trained_until,
          model_version=excluded.model_version,
          eligible_for_efficacy=excluded.eligible_for_efficacy    """
    result = batch_fn([(sql, [
        row["cohort_id"], row["fold_id"], row["prediction_date"], row["symbol"],
        row["market_segment"], row["expected_return"], row["prediction_json"],
        row["trained_until"], row["model_version"], row["eligible_for_efficacy"],
    ]) for row in predictions], timeout=60.0, chunk_size=200)
    if result.get("error_count"):
        raise RuntimeError(f"l4_oof_prediction_materialization_failed:{result}")
    return {"status": "ready", "rows": len(predictions), "result": result}


def _classify_forward_evaluability(
    expected_dates: list[str],
    snapshot_evidence: dict[str, Any],
) -> dict[str, Any]:
    """Classify every mature extension date without fabricating missing PIT inputs."""

    stacker_by_date = {
        str(date)[:10]: int(count or 0)
        for date, count in dict(snapshot_evidence.get("stacker_eligible_by_date") or {}).items()
    }
    native_by_date = {
        str(date)[:10]: int(count or 0)
        for date, count in dict(snapshot_evidence.get("native_matched_by_date") or {}).items()
    }
    snapshots_by_date = {
        str(date)[:10]: int(count or 0)
        for date, count in dict(snapshot_evidence.get("snapshot_rows_by_date") or {}).items()
    }
    rejected_by_date = {
        str(date)[:10]: {
            str(reason): int(count or 0)
            for reason, count in dict(reasons or {}).items()
        }
        for date, reasons in dict(snapshot_evidence.get("rejected_by_date") or {}).items()
    }

    evaluable_dates: list[str] = []
    not_evaluable: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    for date in expected_dates:
        snapshot_count = snapshots_by_date.get(date, 0)
        stacker_count = stacker_by_date.get(date, 0)
        native_count = native_by_date.get(date, 0)
        rejected = rejected_by_date.get(date, {})
        if snapshot_count > 0:
            evaluable_dates.append(date)
            continue
        if (
            stacker_count > 0
            and native_count == 0
            and rejected == {"native_pit_components_missing": stacker_count}
        ):
            not_evaluable.append({
                "date": date,
                "reason": "missing_native_pit_components",
                "stacker_eligible_rows": stacker_count,
                "native_matched_rows": 0,
            })
            continue
        unresolved.append({
            "date": date,
            "stacker_eligible_rows": stacker_count,
            "native_matched_rows": native_count,
            "snapshot_rows": snapshot_count,
            "rejected": rejected,
        })

    if not evaluable_dates or unresolved:
        raise RuntimeError(
            "active8_oof_forward_date_evaluability_unresolved:"
            + json.dumps({
                "expected_dates": expected_dates,
                "evaluable_dates": evaluable_dates,
                "not_evaluable": not_evaluable,
                "unresolved": unresolved,
            }, sort_keys=True)
        )
    return {
        "schema_version": "active8-oof-forward-date-evaluability-v1",
        "expected_dates": expected_dates,
        "evaluable_dates": evaluable_dates,
        "not_evaluable": not_evaluable,
    }


def _classify_l4_forward_evaluability(
    expected_dates: list[str],
    snapshot_evaluability: dict[str, Any],
    l4_prediction_evidence: dict[str, Any] | None,
) -> dict[str, Any]:
    """Separate legitimate L4 warmup from missing forward evidence."""

    if not l4_prediction_evidence:
        return snapshot_evaluability
    date_evidence = {
        str(row.get("prediction_date") or "")[:10]: row
        for row in list(l4_prediction_evidence.get("dates") or [])
        if str(row.get("prediction_date") or "")[:10]
    }
    snapshot_evaluable = set(snapshot_evaluability.get("evaluable_dates") or [])
    snapshot_not_evaluable = {
        str(row.get("date") or "")[:10]: row
        for row in list(snapshot_evaluability.get("not_evaluable") or [])
    }
    evaluable_dates: list[str] = []
    not_evaluable: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    for date in expected_dates:
        if date not in snapshot_evaluable:
            upstream = snapshot_not_evaluable.get(date)
            if upstream is None:
                unresolved.append({
                    "date": date,
                    "reason": "snapshot_evaluability_missing",
                })
            else:
                not_evaluable.append({
                    **upstream,
                    "upstream_artifact": "allocator_ev_snapshots",
                })
            continue
        evidence = date_evidence.get(date)
        if evidence is None:
            unresolved.append({
                "date": date,
                "reason": "l4_date_evidence_missing",
            })
            continue
        if evidence.get("eligible_for_efficacy") is True:
            evaluable_dates.append(date)
            continue
        not_evaluable.append({
            "date": date,
            "reason": "l4_chronological_history_not_ready",
            "train_samples": int(evidence.get("train_samples") or 0),
            "train_dates": int(evidence.get("train_dates") or 0),
        })

    if not evaluable_dates or unresolved:
        raise RuntimeError(
            "active8_oof_l4_forward_date_evaluability_unresolved:"
            + json.dumps({
                "expected_dates": expected_dates,
                "evaluable_dates": evaluable_dates,
                "not_evaluable": not_evaluable,
                "unresolved": unresolved,
            }, sort_keys=True)
        )
    return {
        "schema_version": "active8-oof-l4-forward-date-evaluability-v1",
        "expected_dates": expected_dates,
        "evaluable_dates": evaluable_dates,
        "not_evaluable": not_evaluable,
    }


def load_verified_oof_forward_coverage(
    *,
    cohort_id: str,
    base_manifest_checksum: str,
    knowledge_cutoff_date: str,
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
) -> dict[str, Any] | None:
    """Read the newest complete checksum-bound monitoring-only coverage group."""

    rows = query_fn(
        """
        SELECT extension_manifest_checksum, artifact_kind,
               extension_manifest_path, knowledge_cutoff_date,
               min_date, max_date, date_count, row_count,
               expected_date_count, not_evaluable_date_count,
               coverage_status, promotion_eligible, training_dispatched,
               policy_version, verified_at, updated_at
          FROM active8_oof_forward_extension_coverage
         WHERE cohort_id = ?
           AND base_manifest_checksum = ?
           AND coverage_status = 'verified'
           AND promotion_eligible = 0
           AND training_dispatched = 0
           AND policy_version = ?
           AND knowledge_cutoff_date <= ?
           AND max_date <= ?
         ORDER BY knowledge_cutoff_date DESC, verified_at DESC,
                  extension_manifest_checksum DESC, artifact_kind
        """,
        [
            cohort_id,
            base_manifest_checksum,
            OOF_FORWARD_COVERAGE_POLICY_VERSION,
            knowledge_cutoff_date,
            knowledge_cutoff_date,
        ],
    )
    required_kinds = set(OOF_MATERIALIZED_ARTIFACT_KINDS)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    group_order: list[str] = []
    for row in rows:
        checksum = str(row.get("extension_manifest_checksum") or "").lower()
        if checksum not in grouped:
            group_order.append(checksum)
        grouped[checksum].append(row)

    for checksum in group_order:
        group_rows = grouped[checksum]
        by_kind = {
            str(row.get("artifact_kind") or ""): row for row in group_rows
        }
        manifest_paths = {
            str(row.get("extension_manifest_path") or "") for row in group_rows
        }
        if (
            len(checksum) != 64
            or any(char not in "0123456789abcdef" for char in checksum)
            or set(by_kind) != required_kinds
            or len(manifest_paths) != 1
            or not next(iter(manifest_paths), "")
            or any(int(row.get("date_count") or 0) <= 0 for row in group_rows)
            or any(int(row.get("row_count") or 0) <= 0 for row in group_rows)
        ):
            continue
        artifacts = {
            kind: {
                "status": "verified",
                "rows": int(row.get("row_count") or 0),
                "dates": int(row.get("date_count") or 0),
                "min_date": str(row.get("min_date") or "")[:10] or None,
                "max_date": str(row.get("max_date") or "")[:10] or None,
                "expected_dates": int(row.get("expected_date_count") or 0),
                "not_evaluable_dates": int(
                    row.get("not_evaluable_date_count") or 0
                ),
            }
            for kind, row in by_kind.items()
        }
        artifact_max_dates = [
            str(row.get("max_date") or "")[:10] for row in group_rows
        ]
        if any(not value for value in artifact_max_dates):
            continue
        return {
            "status": "verified",
            "source": "persisted_verified_forward_coverage",
            "promotion_eligible": False,
            "training_dispatched": False,
            "extension_manifest_checksum": checksum,
            "extension_manifest_path": next(iter(manifest_paths)),
            "knowledge_cutoff_date": str(
                group_rows[0].get("knowledge_cutoff_date") or ""
            )[:10],
            "max_date": min(artifact_max_dates),
            "artifacts": artifacts,
        }
    return None


def persist_verified_oof_forward_coverage(
    *,
    cohort_id: str,
    base_manifest_checksum: str,
    extension_manifest_path: str,
    extension_manifest: dict[str, Any],
    knowledge_cutoff_date: str,
    snapshot_rows: list[dict[str, Any]],
    snapshot_evidence: dict[str, Any],
    l4_predictions: list[dict[str, Any]],
    l4_prediction_evidence: dict[str, Any] | None = None,
    batch_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.batch_execute,
) -> dict[str, Any]:
    """Persist monitoring-only coverage after verified frozen-forward evaluation."""

    expected_dates = sorted({
        str(value or "")[:10]
        for value in (extension_manifest.get("dates") or [])
        if str(value or "")[:10]
    })
    extension_checksum = str(extension_manifest.get("manifest_checksum") or "").lower()
    if (
        not expected_dates
        or len(extension_checksum) != 64
        or any(char not in "0123456789abcdef" for char in extension_checksum)
        or extension_manifest.get("promotion_eligible") is not False
        or extension_manifest.get("training_dispatched") is not False
        or str(extension_manifest.get("base_cohort_id") or "") != cohort_id
        or str(extension_manifest.get("base_manifest_checksum") or "") != base_manifest_checksum
        or knowledge_cutoff_date < expected_dates[-1]
    ):
        raise ValueError("active8_oof_forward_coverage_contract_invalid")

    snapshot_evaluability = _classify_forward_evaluability(
        expected_dates, snapshot_evidence
    )
    l4_evaluability = _classify_l4_forward_evaluability(
        expected_dates,
        snapshot_evaluability,
        l4_prediction_evidence,
    )

    rows_by_kind = {
        "allocator_ev_snapshots": (
            snapshot_rows, "snapshot_date", snapshot_evaluability
        ),
        "l4_predictions": (
            l4_predictions, "prediction_date", l4_evaluability
        ),
    }
    sql = """
        INSERT INTO active8_oof_forward_extension_coverage (
          cohort_id, extension_manifest_checksum, artifact_kind,
          base_manifest_checksum, extension_manifest_path, knowledge_cutoff_date,
          min_date, max_date, date_count, row_count, date_checksum,
          expected_date_count, not_evaluable_date_count, date_eligibility_json,
          coverage_status, promotion_eligible, training_dispatched, policy_version,
          verified_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?,
                  CASE WHEN ? = 'verified' THEN CURRENT_TIMESTAMP ELSE NULL END,
                  CURRENT_TIMESTAMP)
        ON CONFLICT(cohort_id, extension_manifest_checksum, artifact_kind)
        DO UPDATE SET
          base_manifest_checksum=excluded.base_manifest_checksum,
          extension_manifest_path=excluded.extension_manifest_path,
          knowledge_cutoff_date=excluded.knowledge_cutoff_date,
          min_date=excluded.min_date,
          max_date=excluded.max_date,
          date_count=excluded.date_count,
          row_count=excluded.row_count,
          date_checksum=excluded.date_checksum,
          expected_date_count=excluded.expected_date_count,
          not_evaluable_date_count=excluded.not_evaluable_date_count,
          date_eligibility_json=excluded.date_eligibility_json,
          coverage_status=excluded.coverage_status,
          promotion_eligible=0,
          training_dispatched=0,
          policy_version=excluded.policy_version,
          verified_at=excluded.verified_at,
          updated_at=CURRENT_TIMESTAMP
    """
    statements: list[tuple[str, list[Any]]] = []
    evidence: dict[str, Any] = {}
    all_verified = True
    for artifact_kind, (rows, date_field, evaluability) in rows_by_kind.items():
        evaluable_dates = list(evaluability["evaluable_dates"])
        not_evaluable = list(evaluability["not_evaluable"])
        eligibility_json = json.dumps(
            evaluability, sort_keys=True, separators=(",", ":")
        )
        extension_rows = [
            row for row in rows
            if str(row.get(date_field) or "")[:10] in evaluable_dates
        ]
        actual_dates = sorted({
            str(row.get(date_field) or "")[:10]
            for row in extension_rows
            if str(row.get(date_field) or "")[:10]
        })
        status = "verified" if actual_dates == evaluable_dates and extension_rows else "partial"
        all_verified = all_verified and status == "verified"
        date_checksum = hashlib.sha256(
            json.dumps(actual_dates, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        min_date = actual_dates[0] if actual_dates else evaluable_dates[0]
        max_date = actual_dates[-1] if actual_dates else evaluable_dates[0]
        statements.append((sql, [
            cohort_id, extension_checksum, artifact_kind,
            base_manifest_checksum, extension_manifest_path, knowledge_cutoff_date,
            min_date, max_date, len(actual_dates), len(extension_rows), date_checksum,
            len(expected_dates), len(not_evaluable), eligibility_json,
            status, OOF_FORWARD_COVERAGE_POLICY_VERSION, status,
        ]))
        evidence[artifact_kind] = {
            "status": status,
            "rows": len(extension_rows),
            "dates": len(actual_dates),
            "min_date": min_date,
            "max_date": max_date,
            "date_checksum": date_checksum,
            "expected_dates": len(expected_dates),
            "not_evaluable_dates": len(not_evaluable),
        }

    result = batch_fn(statements, timeout=30.0, chunk_size=2)
    if result.get("error_count"):
        raise RuntimeError(f"active8_oof_forward_coverage_persistence_failed:{result}")
    if not all_verified:
        raise RuntimeError(
            "active8_oof_forward_coverage_incomplete:"
            + json.dumps(evidence, sort_keys=True)
        )
    return {
        "status": "verified",
        "promotion_eligible": False,
        "training_dispatched": False,
        "extension_manifest_checksum": extension_checksum,
        "date_evaluability": snapshot_evaluability,
        "artifact_date_evaluability": {
            "allocator_ev_snapshots": snapshot_evaluability,
            "l4_predictions": l4_evaluability,
        },
        "artifacts": evidence,
    }


def build_fusion_oof_rows(
    snapshot_rows: list[dict[str, Any]],
    l4_predictions: list[dict[str, Any]],
    *,
    knowledge_cutoff_date: str,
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
) -> list[dict[str, Any]]:
    """Attach cross-fitted L4 and mature S12 replay labels without D1 round-trip."""

    l4_by_key = {
        (row["cohort_id"], row["fold_id"], row["prediction_date"], row["symbol"], row["market_segment"]): row
        for row in l4_predictions
        if int(row.get("eligible_for_efficacy") or 0) == 1
    }
    dates = sorted({row["snapshot_date"] for row in snapshot_rows})
    replay_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for offset in range(0, len(dates), 20):
        chunk = dates[offset:offset + 20]
        placeholders = ",".join("?" for _ in chunk)
        replay_rows = query_fn(
            f"""
            SELECT symbol, date(signal_date) signal_date, pnl_pct,
                   json_extract(detail_json, '$.status') replay_status,
                   json_extract(detail_json, '$.status_reason') replay_archetype,
                   sample_eligible, created_at, id
            FROM s12_replay_trade_outcomes
            WHERE source = 's12_multisession_structure_replay_v3'
              AND date(signal_date) IN ({placeholders})
              AND date(json_extract(detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
            ORDER BY signal_date, symbol, sample_eligible DESC, created_at DESC, id DESC
            """,
            [*chunk, knowledge_cutoff_date],
        )
        for replay in replay_rows:
            key = (str(replay.get("signal_date") or "")[:10], str(replay.get("symbol") or ""))
            replay_by_key.setdefault(key, replay)

    rows: list[dict[str, Any]] = []
    for snapshot in snapshot_rows:
        key = (
            snapshot["cohort_id"], snapshot["fold_id"], snapshot["snapshot_date"],
            snapshot["symbol"], snapshot["market_segment"],
        )
        l4 = l4_by_key.get(key)
        if l4 is None:
            continue
        replay = replay_by_key.get((snapshot["snapshot_date"], snapshot["symbol"])) or {}
        rows.append({
            **snapshot,
            "prediction_date": snapshot["snapshot_date"],
            "l4_alpha_ev": _loads(l4["prediction_json"]),
            "allocator_ev_feature_snapshot_source": "allocator_ev_oof_snapshots",
            "allocator_ev_feature_snapshot_guard": "purged_oof_label_known_date_strict",
            "s12_replay_pnl_pct": (
                replay.get("pnl_pct") if int(replay.get("sample_eligible") or 0) == 1 else None
            ),
            "s12_replay_status": replay.get("replay_status"),
            "s12_replay_archetype": replay.get("replay_archetype"),
            "trade_pnl_pct": None,
        })
    return rows


def archive_ev_shadow_evaluation_packets(
    *,
    bucket: Any,
    cohort_id: str,
    business_date: str,
    base_manifest_checksum: str,
    extension_manifest: dict[str, Any],
    l4_result: dict[str, Any],
    fusion_result: dict[str, Any],
    forward_row_count: int,
    execute_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.execute,
) -> dict[str, Any]:
    """Persist daily evaluation evidence without creating a promotion candidate."""

    extension_checksum = str(extension_manifest.get("manifest_checksum") or "").lower()
    dates = sorted({
        str(value or "")[:10]
        for value in (extension_manifest.get("dates") or [])
        if str(value or "")[:10]
    })
    if (
        len(base_manifest_checksum) != 64
        or len(extension_checksum) != 64
        or not dates
        or forward_row_count <= 0
        or extension_manifest.get("promotion_eligible") is not False
        or extension_manifest.get("training_dispatched") is not False
        or str(extension_manifest.get("base_cohort_id") or "") != cohort_id
        or str(extension_manifest.get("base_manifest_checksum") or "") != base_manifest_checksum
    ):
        raise ValueError("expected_return_shadow_evaluation_contract_invalid")

    output: dict[str, Any] = {}
    for model_name, result in (
        ("l4_alpha_ev", l4_result),
        ("allocator_ev_fusion", fusion_result),
    ):
        artifact = dict(result.get("artifact") or {})
        validation = dict(result.get("validation_packet") or {})
        model_version = str(artifact.get("model_version") or "unknown")
        subject_artifact_checksum = hashlib.sha256(
            json.dumps(artifact, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        evaluator_contract = {
            "evaluator_version": EXPECTED_RETURN_SHADOW_EVALUATOR_VERSION,
            "model_name": model_name,
            "artifact_contract_version": artifact.get("artifact_contract_version"),
            "feature_semantic_version": artifact.get("feature_semantic_version"),
            "label_schema_version": artifact.get("label_schema_version"),
            "validation_schema_version": validation.get("schema_version"),
            "policy_decision": "shadow_only",
        }
        evaluator_contract_checksum = hashlib.sha256(
            json.dumps(evaluator_contract, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        payload = {
            "schema_version": "expected-return-shadow-evaluation-packet-v2",
            "identity_schema_version": EXPECTED_RETURN_SHADOW_EVALUATION_IDENTITY_VERSION,
            "subject_artifact_checksum": subject_artifact_checksum,
            "evaluator_contract_checksum": evaluator_contract_checksum,
            "evaluator_contract": evaluator_contract,
            "business_date": business_date,
            "cohort_id": cohort_id,
            "base_manifest_checksum": base_manifest_checksum,
            "extension_manifest_checksum": extension_checksum,
            "model_name": model_name,
            "model_version": model_version,
            "oof_min_date": dates[0],
            "oof_max_date": dates[-1],
            "oof_date_count": len(dates),
            "oof_row_count": forward_row_count,
            "quality_decision": str(
                validation.get("decision")
                or validation.get("quality_decision_before_shadow_policy")
                or "PENDING"
            ).upper(),
            "policy_decision": "shadow_only",
            "validation_packet": validation,
        }
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        checksum = hashlib.sha256(encoded).hexdigest()
        path = (
            f"universal/ev_shadow_evaluations/{cohort_id}/{business_date}/"
            f"{model_name}/{checksum}.json"
        )
        bucket.blob(path).upload_from_string(encoded, content_type="application/json")
        evaluation_identity = {
            "identity_schema_version": EXPECTED_RETURN_SHADOW_EVALUATION_IDENTITY_VERSION,
            "cohort_id": cohort_id,
            "extension_manifest_checksum": extension_checksum,
            "model_name": model_name,
            "subject_artifact_checksum": subject_artifact_checksum,
            "evaluator_contract_checksum": evaluator_contract_checksum,
            "evidence_checksum": checksum,
        }
        evaluation_id = hashlib.sha256(
            json.dumps(evaluation_identity, sort_keys=True).encode("utf-8")
        ).hexdigest()
        execute_fn(
            """
            INSERT INTO expected_return_shadow_evaluation_packets (
              evaluation_id, identity_schema_version, subject_artifact_checksum,
              evaluator_contract_checksum, business_date, cohort_id, base_manifest_checksum,
              extension_manifest_checksum, model_name, model_version,
              oof_min_date, oof_max_date, oof_date_count, oof_row_count,
              quality_decision, policy_decision, validation_packet_json,
              artifact_path, artifact_checksum, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shadow_only', ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(evaluation_id) DO UPDATE SET evaluation_id=NULL
            WHERE NOT (
              expected_return_shadow_evaluation_packets.identity_schema_version
                IS excluded.identity_schema_version
              AND expected_return_shadow_evaluation_packets.subject_artifact_checksum
                IS excluded.subject_artifact_checksum
              AND expected_return_shadow_evaluation_packets.evaluator_contract_checksum
                IS excluded.evaluator_contract_checksum
              AND expected_return_shadow_evaluation_packets.artifact_checksum
                IS excluded.artifact_checksum
              AND expected_return_shadow_evaluation_packets.artifact_path
                IS excluded.artifact_path
            )
            """,
            [
                evaluation_id, EXPECTED_RETURN_SHADOW_EVALUATION_IDENTITY_VERSION,
                subject_artifact_checksum, evaluator_contract_checksum,
                business_date, cohort_id, base_manifest_checksum,
                extension_checksum, model_name, model_version,
                dates[0], dates[-1], len(dates), forward_row_count,
                payload["quality_decision"], json.dumps(validation, ensure_ascii=False),
                path, checksum,
            ],
        )
        output[model_name] = {
            "evaluation_id": evaluation_id,
            "subject_artifact_checksum": subject_artifact_checksum,
            "evaluator_contract_checksum": evaluator_contract_checksum,
            "path": path,
            "checksum": checksum,
            "quality_decision": payload["quality_decision"],
            "policy_decision": "shadow_only",
            "oof_max_date": dates[-1],
        }
    return output


def archive_ev_candidate_artifacts(
    *,
    bucket: Any,
    cohort_id: str,
    source_run_date: str,
    manifest_path: str,
    lifecycle_cadence: str,
    l4_result: dict[str, Any],
    fusion_result: dict[str, Any],
    parity: dict[str, Any] | None,
    promoted: bool | dict[str, bool],
    register_candidate: bool = True,
) -> dict[str, Any]:
    """Persist candidate or promotion-receipt JSON without mutating candidate identity twice."""

    output = {}
    promoted_by_owner = (
        dict(promoted)
        if isinstance(promoted, dict)
        else {
            "l4_alpha_ev": bool(promoted),
            "allocator_ev_fusion": bool(promoted),
        }
    )
    for model_name, result in (("l4_alpha_ev", l4_result), ("allocator_ev_fusion", fusion_result)):
        artifact = dict(result.get("artifact") or {})
        validation = dict(result.get("validation_packet") or {})
        model_version = str(artifact.get("model_version") or "unknown")
        owner_promoted = bool(promoted_by_owner.get(model_name))
        owner_parity = (
            ((parity or {}).get("owner_decisions") or {}).get(model_name)
            if isinstance((parity or {}).get("owner_decisions"), dict)
            else None
        )
        payload = {
            "schema_version": "ev-oof-candidate-packet-v1",
            "cohort_id": cohort_id,
            "artifact": artifact,
            "validation_packet": validation,
            "operational_parity": parity,
            "owner_operational_parity": owner_parity,
            "promoted": owner_promoted,
            "promoted_by_owner": promoted_by_owner,
        }
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        checksum = hashlib.sha256(encoded).hexdigest()
        path = f"universal/ev_candidates/{cohort_id}/{model_name}/{checksum}.json"
        bucket.blob(path).upload_from_string(encoded, content_type="application/json")
        decision = str(validation.get("decision") or "PENDING").upper()
        state = "production" if owner_promoted else "offline_passed" if decision == "PASS" else "offline_failed"
        candidate_type = (
            "l4_alpha_ev_refresh"
            if model_name == "l4_alpha_ev"
            else "allocator_ev_fusion_refresh"
        )
        registry_record = {
            "artifact_id": f"{model_name}:{model_version}:{checksum}",
            "model_name": model_name,
            "version": model_version,
            "candidate_type": candidate_type,
            "state": state,
            "artifact_path": path,
            "metadata_path": path,
            "training_run_id": f"active8_oof:{cohort_id}",
            "training_manifest_path": manifest_path,
            "trained_from_snapshot": "allocator_ev_oof_snapshots",
            "feature_policy_version": artifact.get("feature_snapshot_version"),
            "checksum": checksum,
            "source_run_date": source_run_date,
            "offline_gate_status": "passed" if decision == "PASS" else "failed",
            "offline_gate_decision": decision,
            "offline_gate_failed_gates": json.dumps(validation.get("failed_gates") or []),
            "offline_evidence_json": json.dumps({
                "identity_schema_version": "expected-return-candidate-identity-v3",
                "expected_return_owner": artifact.get("expected_return_owner"),
                "model_version": model_version,
                "artifact_checksum": checksum,
                "cadence": lifecycle_cadence,
                "cohort_id": cohort_id,
                "artifact_contract_version": artifact.get("artifact_contract_version"),
                "feature_semantic_version": artifact.get("feature_semantic_version"),
                "label_schema_version": artifact.get("label_schema_version"),
                "validation_packet": validation,
                "training_data": artifact.get("training_data"),
            }, ensure_ascii=False),
            "live_gate_status": (
                "promoted"
                if owner_promoted
                else "parity_passed"
                if isinstance(owner_parity, dict) and owner_parity.get("decision") == "PASS"
                else "not_started"
            ),
            "live_evidence_json": json.dumps(parity or {}, ensure_ascii=False),
            "promotion_decision": "primary" if owner_promoted else "shadow",
            "approval_state": artifact.get("promotion_state") or "approval_required",
        }
        if register_candidate:
            upsert_artifact_record(registry_record, immutable_identity=True)
        output[model_name] = {
            "artifact_id": registry_record["artifact_id"],
            "path": path,
            "checksum": checksum,
            "state": state,
            "registry_registered": register_candidate,
        }
    return output


def persist_oof_cohort(
    *,
    manifest: dict[str, Any],
    prediction_rows: list[dict[str, Any]],
    snapshot_rows: list[dict[str, Any]],
    l4_predictions: list[dict[str, Any]] | None = None,
    bucket: Any | None = None,
    knowledge_cutoff_date: str | None = None,
    dry_run: bool = True,
    prediction_storage_mode: str = "gcs_indexed_v1",
    query_fn: Callable[..., list[dict[str, Any]]] = LEARNING_D1_CLIENT.query,
    batch_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.batch_execute,
    execute_fn: Callable[..., dict[str, Any]] = LEARNING_D1_CLIENT.execute,
) -> dict[str, Any]:
    cohort_id = str(manifest["cohort_id"])
    if prediction_storage_mode not in {"gcs_indexed_v1", "d1_full_v1"}:
        raise ValueError("active8_oof_prediction_storage_mode_invalid")
    fold_artifact_rows = build_oof_fold_artifact_rows(manifest, prediction_rows)
    prediction_dates = len({str(row["prediction_date"])[:10] for row in prediction_rows})
    identity_specs = (
        ("prediction", prediction_rows, ("cohort_id", "fold_id", "prediction_date", "symbol", "market_segment", "model_name")),
        ("fold_artifact", fold_artifact_rows, ("cohort_id", "fold_id", "model_name")),
        ("snapshot", snapshot_rows, ("cohort_id", "fold_id", "snapshot_date", "symbol", "market_segment")),
        ("l4_prediction", list(l4_predictions or []), ("cohort_id", "fold_id", "prediction_date", "symbol", "market_segment")),
    )
    for identity_name, rows, fields in identity_specs:
        identities = {tuple(str(row.get(field) or "") for field in fields) for row in rows}
        if len(identities) != len(rows):
            raise ValueError(f"active8_oof_{identity_name}_identity_duplicate")
    eligibility_rows = build_oof_date_eligibility_rows(
        cohort_id=cohort_id,
        source_manifest_checksum=str(manifest.get("manifest_checksum") or ""),
        prediction_rows=prediction_rows,
        snapshot_rows=snapshot_rows,
        l4_prediction_rows=list(l4_predictions or []),
        knowledge_cutoff_date=str(
            knowledge_cutoff_date
            or manifest.get("knowledge_cutoff_date")
            or max((str(row.get("label_known_date") or "")[:10] for row in prediction_rows), default="")
        ),
        target_semantic_version=TARGET_SEMANTIC_VERSION,
    )
    if dry_run:
        return {
            "status": "dry_run",
            "cohort_id": cohort_id,
            "prediction_rows": len(prediction_rows),
            "prediction_dates": prediction_dates,
            "snapshot_rows": len(snapshot_rows),
            "l4_prediction_rows": len(l4_predictions or []),
            "fold_artifact_rows": len(fold_artifact_rows),
            "prediction_storage_mode": prediction_storage_mode,
            "date_eligibility": {
                scope: sum(
                    row["evidence_scope"] == scope and row["eligibility_status"] == "legal"
                    for row in eligibility_rows
                )
                for scope in ("active8_oof", "snapshot", "l4", "fusion")
            },
        }
    refreshing_ready = False
    existing = query_fn(
        "SELECT status, artifact_manifest_checksum, prediction_storage_mode FROM active8_oof_cohorts WHERE cohort_id = ?",
        [cohort_id],
    )
    if existing:
        row = existing[0]
        same_lineage = row.get("artifact_manifest_checksum") == manifest["manifest_checksum"]
        same_storage = row.get("prediction_storage_mode") == prediction_storage_mode
        if row.get("status") == "ready" and same_lineage and same_storage:
            refreshing_ready = True
        elif row.get("status") != "building" or not same_lineage or not same_storage:
            raise ValueError("active8_oof_cohort_id_collision")

    model_signature = build_model_set_signature(
        {name: f"cohort:{cohort_id}" for name in ACTIVE8_MODELS},
        list(ACTIVE8_MODELS),
    )
    parent = manifest.get("parent_manifest") or {}
    if not existing:
        execute_fn(
            """
            INSERT INTO active8_oof_cohorts (
          cohort_id, generation_mode, status, target_semantic_version,
          score_semantic_version, model_set_signature, expected_models,
          expected_folds, artifact_manifest_path, artifact_manifest_checksum,
          prediction_storage_mode, parent_cohort_id, parent_manifest_checksum
        ) VALUES (?, 'purged_oof', 'building', ?, ?, ?, 8, ?, ?, ?, ?, ?, ?)
        """,
            [
                cohort_id,
                TARGET_SEMANTIC_VERSION,
                "same-market-same-date-percentile-rank-v1",
                model_signature,
                len(manifest.get("windows") or []),
                f"walk_forward/oof_cohorts/{cohort_id}/manifest.json",
                manifest["manifest_checksum"],
                prediction_storage_mode,
                parent.get("cohort_id"),
                parent.get("checksum"),
            ],
        )
    prediction_sql = """
        INSERT INTO active8_oof_predictions (
          cohort_id, fold_id, prediction_date, stock_id, symbol, market_segment,
          model_name, raw_score, rank_score, target_return, label_known_date,
          artifact_version, artifact_checksum, train_start, train_end, test_start,
          test_end, target_semantic_version, score_semantic_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cohort_id, fold_id, prediction_date, symbol, market_segment, model_name)
        DO UPDATE SET
          stock_id=excluded.stock_id, raw_score=excluded.raw_score,
          rank_score=excluded.rank_score, target_return=excluded.target_return,
          label_known_date=excluded.label_known_date,
          artifact_version=excluded.artifact_version,
          artifact_checksum=excluded.artifact_checksum,
          train_start=excluded.train_start, train_end=excluded.train_end,
          test_start=excluded.test_start, test_end=excluded.test_end,
          target_semantic_version=excluded.target_semantic_version,
          score_semantic_version=excluded.score_semantic_version    """
    statements = [(prediction_sql, [
        row["cohort_id"], row["fold_id"], row["prediction_date"], row.get("stock_id"),
        row["symbol"], row["market_segment"], row["model_name"], row["raw_score"],
        row["rank_score"], row["target_return"], row["label_known_date"],
        row["artifact_version"], row["artifact_checksum"], row["train_start"],
        row["train_end"], row["test_start"], row["test_end"],
        row["target_semantic_version"], row["score_semantic_version"],
    ]) for row in prediction_rows]
    prediction_result = (
        batch_fn(statements, timeout=60.0, chunk_size=200)
        if prediction_storage_mode == "d1_full_v1"
        else {"success_count": 0, "error_count": 0, "storage_mode": "gcs_indexed_v1"}
    )
    if prediction_result.get("error_count"):
        raise RuntimeError(f"active8_oof_prediction_materialization_failed:{prediction_result}")

    fold_artifact_sql = """
        INSERT INTO active8_oof_fold_artifacts (
          cohort_id, fold_id, source_cohort_id, source_manifest_checksum,
          model_name, artifact_path, artifact_checksum, artifact_rows,
          prediction_dates, train_start, train_end, test_start, test_end,
          target_semantic_version, score_semantic_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cohort_id, fold_id, model_name)
        DO UPDATE SET
          source_cohort_id=excluded.source_cohort_id,
          source_manifest_checksum=excluded.source_manifest_checksum,
          artifact_path=excluded.artifact_path,
          artifact_checksum=excluded.artifact_checksum,
          artifact_rows=excluded.artifact_rows,
          prediction_dates=excluded.prediction_dates,
          train_start=excluded.train_start, train_end=excluded.train_end,
          test_start=excluded.test_start, test_end=excluded.test_end,
          target_semantic_version=excluded.target_semantic_version,
          score_semantic_version=excluded.score_semantic_version    """
    fold_artifact_statements = [(fold_artifact_sql, [
        row["cohort_id"], row["fold_id"], row["source_cohort_id"],
        row["source_manifest_checksum"], row["model_name"], row["artifact_path"],
        row["artifact_checksum"], row["artifact_rows"], row["prediction_dates"],
        row["train_start"], row["train_end"], row["test_start"], row["test_end"],
        row["target_semantic_version"], row["score_semantic_version"],
    ]) for row in fold_artifact_rows]
    fold_artifact_result = batch_fn(
        fold_artifact_statements, timeout=60.0, chunk_size=100
    )
    if fold_artifact_result.get("error_count"):
        raise RuntimeError(f"active8_oof_fold_artifact_index_failed:{fold_artifact_result}")

    snapshot_sql = """
        INSERT INTO allocator_ev_oof_snapshots (
          cohort_id, fold_id, snapshot_date, stock_id, symbol, market_segment,
          forecast_data, score, score_components, alpha_context, alpha_allocation,
          market_heat_expected_return, recommendation_lane, l4_model_version,
          s12_source, s12_asof_date, label_known_date, model_set_signature,
          target_semantic_version, generation_mode, source_manifest_checksum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'purged_oof', ?)
        ON CONFLICT(cohort_id, fold_id, snapshot_date, symbol, market_segment)
        DO UPDATE SET
          stock_id=excluded.stock_id, forecast_data=excluded.forecast_data,
          score=excluded.score, score_components=excluded.score_components,
          alpha_context=excluded.alpha_context, alpha_allocation=excluded.alpha_allocation,
          market_heat_expected_return=excluded.market_heat_expected_return,
          recommendation_lane=excluded.recommendation_lane,
          l4_model_version=excluded.l4_model_version,
          s12_source=excluded.s12_source, s12_asof_date=excluded.s12_asof_date,
          label_known_date=excluded.label_known_date,
          model_set_signature=excluded.model_set_signature,
          target_semantic_version=excluded.target_semantic_version,
          generation_mode=excluded.generation_mode,
          source_manifest_checksum=excluded.source_manifest_checksum    """
    snapshot_statements = [(snapshot_sql, [
        row["cohort_id"], row["fold_id"], row["snapshot_date"], row.get("stock_id"),
        row["symbol"], row["market_segment"], row["forecast_data"], row.get("score"),
        row.get("score_components"), row.get("alpha_context"), row["alpha_allocation"],
        row.get("market_heat_expected_return"), row.get("recommendation_lane"),
        row.get("l4_model_version"), row.get("s12_source"), row["s12_asof_date"],
        row["label_known_date"], row["model_set_signature"], row["target_semantic_version"],
        row["source_manifest_checksum"],
    ]) for row in snapshot_rows]
    eligibility_result = persist_oof_date_eligibility(
        eligibility_rows,
        batch_fn=batch_fn,
    )
    if eligibility_result.get("error_count"):
        raise RuntimeError(f"active8_oof_date_eligibility_failed:{eligibility_result}")
    materialized_artifacts: list[dict[str, Any]] = []
    if prediction_storage_mode == "gcs_indexed_v1":
        if bucket is None:
            raise ValueError("active8_oof_gcs_indexed_bucket_missing")
        materialized_artifacts = [
            archive_oof_materialized_rows(
                bucket=bucket,
                cohort_id=cohort_id,
                artifact_kind="allocator_ev_snapshots",
                rows=snapshot_rows,
                source_manifest_checksum=manifest["manifest_checksum"],
            ),
            archive_oof_materialized_rows(
                bucket=bucket,
                cohort_id=cohort_id,
                artifact_kind="l4_predictions",
                rows=list(l4_predictions or []),
                source_manifest_checksum=manifest["manifest_checksum"],
            ),
        ]
        index_result = persist_oof_materialized_artifact_indexes(
            materialized_artifacts,
            eligibility_rows=eligibility_rows,
            query_fn=query_fn,
            batch_fn=batch_fn,
        )
        persisted_indexes = query_fn(
            """
            SELECT artifact_kind, artifact_path, artifact_checksum, row_count,
                   source_manifest_checksum
            FROM active8_oof_materialized_artifacts
            WHERE cohort_id = ?
            """,
            [cohort_id],
        )
        persisted_by_kind = {
            str(row.get("artifact_kind") or ""): row for row in persisted_indexes
        }
        if len(persisted_by_kind) != len(materialized_artifacts):
            raise RuntimeError("active8_oof_materialized_artifact_index_count_mismatch")
        for artifact in materialized_artifacts:
            persisted = persisted_by_kind.get(artifact["artifact_kind"]) or {}
            expected_identity = (
                artifact["artifact_path"],
                artifact["artifact_checksum"],
                int(artifact["row_count"]),
                artifact["source_manifest_checksum"],
            )
            actual_identity = (
                persisted.get("artifact_path"),
                persisted.get("artifact_checksum"),
                int(persisted.get("row_count") or -1),
                persisted.get("source_manifest_checksum"),
            )
            if actual_identity != expected_identity:
                raise RuntimeError(
                    f"active8_oof_materialized_artifact_index_identity_mismatch:"
                    f"{artifact['artifact_kind']}"
                )
        snapshot_result = {
            "status": "ready",
            "rows": len(snapshot_rows),
            "storage_mode": "gcs_indexed_v1",
            "artifact": materialized_artifacts[0],
            "index_result": index_result,
        }
        l4_result = {
            "status": "ready",
            "rows": len(l4_predictions or []),
            "storage_mode": "gcs_indexed_v1",
            "artifact": materialized_artifacts[1],
            "index_result": index_result,
        }
    else:
        snapshot_result = batch_fn(snapshot_statements, timeout=60.0, chunk_size=200)
        if snapshot_result.get("error_count"):
            raise RuntimeError(f"allocator_ev_oof_snapshot_materialization_failed:{snapshot_result}")
        l4_result = persist_l4_oof_predictions(
            list(l4_predictions or []),
            dry_run=False,
            batch_fn=batch_fn,
        )
    counts = query_fn(
        """
        SELECT
          (SELECT COUNT(*) FROM active8_oof_predictions WHERE cohort_id = ?) prediction_rows,
          (SELECT COUNT(*) FROM active8_oof_fold_artifacts WHERE cohort_id = ?) fold_artifact_rows,
          (SELECT COUNT(*) FROM allocator_ev_oof_snapshots WHERE cohort_id = ?) snapshot_rows,
          (SELECT COUNT(*) FROM l4_oof_predictions WHERE cohort_id = ?) l4_prediction_rows,
          (SELECT COUNT(*) FROM active8_oof_materialized_artifacts WHERE cohort_id = ?) materialized_artifact_rows,
          (SELECT COALESCE(SUM(row_count), 0) FROM active8_oof_materialized_artifacts
            WHERE cohort_id = ? AND artifact_kind = 'allocator_ev_snapshots') indexed_snapshot_rows,
          (SELECT COALESCE(SUM(row_count), 0) FROM active8_oof_materialized_artifacts
            WHERE cohort_id = ? AND artifact_kind = 'l4_predictions') indexed_l4_prediction_rows
        """,
        [cohort_id, cohort_id, cohort_id, cohort_id, cohort_id, cohort_id, cohort_id],
    )[0]
    if (
        (
            prediction_storage_mode == "d1_full_v1"
            and int(counts.get("prediction_rows") or 0) != len(prediction_rows)
        )
        or int(counts.get("fold_artifact_rows") or 0) != len(fold_artifact_rows)
        or (
            prediction_storage_mode == "d1_full_v1"
            and (
                int(counts.get("snapshot_rows") or 0) != len(snapshot_rows)
                or int(counts.get("l4_prediction_rows") or 0) != len(l4_predictions or [])
            )
        )
        or (
            prediction_storage_mode == "gcs_indexed_v1"
            and (
                int(counts.get("materialized_artifact_rows") or 0) != 2
                or int(counts.get("indexed_snapshot_rows") or 0) != len(snapshot_rows)
                or int(counts.get("indexed_l4_prediction_rows") or 0) != len(l4_predictions or [])
            )
        )
    ):
        raise RuntimeError("active8_oof_materialization_count_mismatch")
    if refreshing_ready:
        execute_fn(
            """
            UPDATE active8_oof_cohorts
            SET prediction_rows = ?, prediction_dates = ?, updated_at = CURRENT_TIMESTAMP
            WHERE cohort_id = ? AND status = 'ready'
            """,
            [len(prediction_rows), prediction_dates, cohort_id],
        )
    else:
        execute_fn(
            """
            UPDATE active8_oof_cohorts
            SET status = 'ready', completed_folds = expected_folds,
                prediction_rows = ?, prediction_dates = ?, ready_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE cohort_id = ? AND status = 'building'
            """,
            [len(prediction_rows), prediction_dates, cohort_id],
        )
    return {
        "status": "ready_refreshed" if refreshing_ready else "ready",
        "cohort_id": cohort_id,
        "prediction_storage_mode": prediction_storage_mode,
        "prediction_result": prediction_result,
        "fold_artifact_result": fold_artifact_result,
        "snapshot_result": snapshot_result,
        "l4_result": l4_result,
        "counts": counts,
        "eligibility_result": eligibility_result,
    }
