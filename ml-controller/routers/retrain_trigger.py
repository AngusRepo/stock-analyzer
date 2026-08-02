"""
routers/retrain_trigger.py ??POST /retrain/trigger

Sprint 6b: Self-contained retrain trigger.
Uses payload_builder to pull D1 data and build payloads,
then calls Modal retrain_single_stock for each stock.

Unlike /batch-retrain (which needs caller to supply payloads),
this endpoint builds everything server-side from D1.
"""
import os
import time
import json
import uuid
import logging
import asyncio
import hashlib
import tempfile
import math
from urllib.parse import urlsplit, urlunsplit
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, Field
from dataclasses import asdict

from services import d1_client, retrain_lock
from services.payload_builder import (
    load_market_env,
    _bulk_load_prices,
    _bulk_load_indicators,
    _bulk_load_chips,
    _bulk_load_sentiment,
    PredictPayload,
)
from services.active_model_policy import long_history_sequence_enabled, long_history_sequence_prefix
from services.training_calendar import monthly_revenue_available_date
from services.training_policy import TrainingPolicy
from services.modal_client import batch_retrain, prep_universal_batch, train_universal, shap_audit

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/retrain", tags=["retrain"])

# ?? Idempotency lock (P0-4 + persistent GCS layer) ??????????????????????????
# Protects against duplicate cron triggers (e.g. 13:37 + 13:47) AND against
# cross-instance races that the old in-memory dict missed. See
# services.retrain_lock for design (GCS CAS via if_generation_match).
_LOCK_TTL_SECONDS = 600  # 10 ??
_UNIVERSAL_LOCK_TTL_SECONDS = int(os.environ.get("UNIVERSAL_RETRAIN_LOCK_TTL_SECONDS", str(12 * 3600)))
_PREP_ONLY_LOCK_TTL_SECONDS = int(os.environ.get("UNIVERSAL_PREP_ONLY_LOCK_TTL_SECONDS", str(2 * 3600)))
_UNIVERSAL_PREP_CONCURRENCY_DEFAULT = 3
_UNIVERSAL_PREP_CONCURRENCY_MAX = 5
TIMESFM_L175_L2_FEATURE_RELEASE_CANDIDATE_TYPE = "timesfm_l175_l2_feature_release"
TIMESFM_L175_HISTORY_LOOKBACK_DAYS = int(os.environ.get("TIMESFM_L175_HISTORY_LOOKBACK_DAYS", "420"))
TIMESFM_L175_MIN_STOCK_COVERAGE = float(os.environ.get("TIMESFM_L175_MIN_STOCK_COVERAGE", "0.80"))
TIMESFM_L175_MIN_HISTORY_DATES = int(os.environ.get("TIMESFM_L175_MIN_HISTORY_DATES", "20"))
TIMESFM_L175_FEATURE_NAMES = (
    "timesfm_l175_forecast_return",
    "timesfm_l175_forecast_log_return",
    "timesfm_l175_forecast_slope",
    "timesfm_l175_forecast_curvature",
    "timesfm_l175_random_walk_residual",
    "timesfm_l175_quantile_width",
    "timesfm_l175_forecast_dispersion",
    "timesfm_l175_peer_sequence_mean_return",
    "timesfm_l175_market_excess_return",
    "timesfm_l175_sector_excess_return",
    "timesfm_l175_sign_flip_flag",
)


class RetrainTriggerRequest(BaseModel):
    use_optuna: bool = True
    limit: int = 50  # max stocks to retrain
    run_date: str | None = Field(default=None, description="Business date for scheduler/manual trigger lineage.")


class UniversalRetrainTriggerRequest(BaseModel):
    limit: int = 2500  # max stocks
    force_monthly: bool = False  # Force monthly flow, including feature selection.
    run_date: str | None = Field(default=None, description="Business date for scheduler/manual trigger lineage.")
    candidate_type: str | None = Field(default=None, description="Release-train candidate type, e.g. monthly_release or weekly_drift.")
    drift_target_models: list[str] = Field(default_factory=list)
    drift_target_families: list[str] = Field(default_factory=list)
    train_model_groups: list[str] = Field(default_factory=lambda: ["tree", "dlinear", "patchtst"])
    artifact_lifecycle_targets: list[str] = Field(default_factory=list)
    artifact_lifecycle_contracts: dict[str, str] = Field(default_factory=dict)
    artifact_lifecycle_only: bool = False
    register_challengers: bool = False
    promotion_allowed_models: list[str] = Field(default_factory=list)
    oof_promotion_evidence: dict[str, dict] = Field(default_factory=dict)
    oof_lifecycle_resume: dict[str, Any] = Field(default_factory=dict)
    require_exact_dataset_snapshot: bool = Field(
        default=False,
        description="Fail closed unless the compute snapshot business date exactly matches run_date.",
    )
    sequence_gcs_prefix: str | None = Field(default=None, description="GCS prefix for sequence_records_v3 batches.")
    prebuilt_prep_gcs_prefix: str | None = Field(default=None, description="Immutable canonical prep prefix validated before OOF full-fit.")
    prebuilt_prep_manifest_checksum: str | None = None
    prebuilt_prep_target_semantic_version: str | None = None
    prebuilt_prep_source_cohort_id: str | None = None
    prebuilt_prep_source_manifest_checksum: str | None = None
    prebuilt_feature_pool_path: str | None = None
    prebuilt_feature_pool_checksum: str | None = None
    prebuilt_sequence_manifest_checksum: str | None = None
    prebuilt_sequence_batch_checksums: dict[str, str] = Field(default_factory=dict)
    sequence_batch_count: int | None = Field(default=None, description="Number of sequence_records_v3 batches.")
    sequence_seq_len: int | None = Field(default=None, description="Shared L3 sequence context override.")
    dlinear_seq_len: int | None = Field(default=None, description="DLinear sequence context override.")
    patchtst_seq_len: int | None = Field(default=None, description="PatchTST sequence context override.")
    itransformer_seq_len: int | None = Field(default=None, description="iTransformer sequence context override.")
    prep_only: bool = Field(
        default=False,
        description="Build immutable universal feature prep and stop before any model training.",
    )
    prep_output_gcs_prefix: str | None = Field(
        default=None,
        description="New immutable GCS prefix required by prep_only.",
    )


def _verified_prep_only_receipt(bucket: object, prefix: str, run_date: str) -> dict[str, Any] | None:
    receipt_path = f"{prefix}/prep/immutable_receipt.json"
    receipt_blob = bucket.blob(receipt_path)
    if not receipt_blob.exists():
        return None
    receipt = json.loads(receipt_blob.download_as_text().lstrip("\ufeff"))
    unsigned = {key: value for key, value in receipt.items() if key != "receipt_checksum"}
    actual_checksum = hashlib.sha256(json.dumps(unsigned, sort_keys=True).encode("utf-8")).hexdigest()
    if (
        receipt.get("schema_version") != "active8-immutable-feature-prep-receipt-v1"
        or receipt.get("status") != "ready"
        or receipt.get("business_date") != run_date
        or str(receipt.get("output_gcs_prefix") or "").rstrip("/") != prefix
        or receipt.get("receipt_checksum") != actual_checksum
    ):
        raise ValueError("prep_only_sealed_receipt_invalid")
    checksums = receipt.get("output_checksums") or {}
    if not isinstance(checksums, dict) or not checksums:
        raise ValueError("prep_only_sealed_inventory_missing")
    for path, expected in checksums.items():
        artifact = bucket.blob(str(path))
        if not artifact.exists() or hashlib.sha256(artifact.download_as_bytes()).hexdigest() != expected:
            raise ValueError(f"prep_only_sealed_checksum_mismatch:{path}")
    feature_names_path = str(receipt.get("feature_names_path") or "")
    if not feature_names_path or not bucket.blob(feature_names_path).exists():
        raise ValueError("prep_only_feature_names_missing")
    return receipt

def _exact_dataset_snapshot_rejection(
    *,
    require_exact: bool,
    run_date: str,
    snapshot_maps: tuple | None,
) -> dict[str, object] | None:
    if not require_exact:
        return None
    if not snapshot_maps:
        return {
            "reason": "exact_dataset_snapshot_missing",
            "required_business_date": run_date,
        }

    snapshot_info = snapshot_maps[-1]
    business_date = str(snapshot_info.get("business_date") or "").strip()
    if business_date != run_date:
        return {
            "reason": "exact_dataset_snapshot_business_date_mismatch",
            "required_business_date": run_date,
            "actual_business_date": business_date or None,
            "snapshot_id": snapshot_info.get("snapshot_id"),
        }
    if "canonical_fundamentals" not in set(snapshot_info.get("components") or []):
        return {
            "reason": "exact_dataset_snapshot_feature_component_missing",
            "required_component": "canonical_fundamentals",
            "snapshot_id": snapshot_info.get("snapshot_id"),
        }
    return None


def _force_https(url: str) -> str:
    parsed = urlsplit(url.strip())
    if parsed.scheme != "http":
        return url.rstrip("/")
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "127.0.0.1"}:
        return url.rstrip("/")
    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, parsed.fragment)).rstrip("/")


def _universal_prep_concurrency() -> int:
    raw = os.environ.get("UNIVERSAL_PREP_CONCURRENCY", str(_UNIVERSAL_PREP_CONCURRENCY_DEFAULT))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = _UNIVERSAL_PREP_CONCURRENCY_DEFAULT
    return max(1, min(_UNIVERSAL_PREP_CONCURRENCY_MAX, value))


def _parse_gcs_uri(uri: str) -> tuple[str, str]:
    if not uri.startswith("gs://"):
        raise ValueError(f"invalid_gcs_uri:{uri}")
    raw = uri[5:]
    bucket, _, blob = raw.partition("/")
    if not bucket or not blob:
        raise ValueError(f"invalid_gcs_uri:{uri}")
    return bucket, blob


def _sequence_batch_count_from_manifest(manifest: dict, fallback: int) -> int:
    try:
        batch_size = int(manifest.get("batch_size") or 0)
    except (TypeError, ValueError):
        batch_size = 0
    records = 0
    for report in manifest.get("lane_reports") or []:
        if not isinstance(report, dict):
            continue
        try:
            records += int(report.get("sequence_records") or 0)
        except (TypeError, ValueError):
            continue
    if records <= 0:
        try:
            records = int((manifest.get("summary") or {}).get("symbols") or 0)
        except (TypeError, ValueError):
            records = 0
    if records <= 0 or batch_size <= 0:
        return max(1, int(fallback))
    return max(1, int((records + batch_size - 1) // batch_size))


def _infer_sequence_batch_count(sequence_gcs_prefix: str, fallback: int) -> int:
    if not sequence_gcs_prefix:
        return max(1, int(fallback))
    try:
        from google.cloud import storage as _gcs

        bucket_name = os.environ.get("GCS_BUCKET_NAME") or os.environ.get("RETRAIN_LOCK_BUCKET")
        if not bucket_name:
            return max(1, int(fallback))
        prefix = sequence_gcs_prefix.strip().rstrip("/")
        blob = _gcs.Client().bucket(bucket_name).blob(f"{prefix}/prep/sequence_manifest.json")
        if not blob.exists():
            return max(1, int(fallback))
        manifest = json.loads(blob.download_as_text().lstrip("\ufeff"))
        return _sequence_batch_count_from_manifest(manifest if isinstance(manifest, dict) else {}, fallback)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[retrain/universal] sequence manifest read failed: %s", exc)
        return max(1, int(fallback))


def _verify_prebuilt_canonical_prep(
    *,
    bucket: object,
    prefix: str,
    expected_manifest_checksum: str,
    expected_target_semantic_version: str,
) -> dict[str, object]:
    import hashlib

    normalized_prefix = str(prefix or "").strip().rstrip("/")
    if not normalized_prefix or normalized_prefix == "universal":
        raise ValueError("prebuilt_canonical_prep_prefix_invalid")
    if len(str(expected_manifest_checksum or "")) != 64:
        raise ValueError("prebuilt_canonical_prep_manifest_checksum_missing")
    if not str(expected_target_semantic_version or "").strip():
        raise ValueError("prebuilt_canonical_prep_target_missing")

    manifest_path = f"{normalized_prefix}/prep/manifest.json"
    manifest = json.loads(bucket.blob(manifest_path).download_as_text().lstrip("\ufeff"))
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    actual_manifest_checksum = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True).encode("utf-8")
    ).hexdigest()
    schema_version = str(manifest.get("schema_version") or "")
    if schema_version not in {
        "active8-canonical-adjusted-prep-v1",
        "active8-canonical-adjusted-prep-v2",
    }:
        raise ValueError("prebuilt_canonical_prep_manifest_mismatch:schema_version")
    required = {
        "status": "ready",
        "output_gcs_prefix": normalized_prefix,
        "target_semantic_version": expected_target_semantic_version,
        "roundtrip_cost_bps": 18.0,
    }
    for key, value in required.items():
        if manifest.get(key) != value:
            raise ValueError(f"prebuilt_canonical_prep_manifest_mismatch:{key}")
    if (
        manifest.get("manifest_checksum") != actual_manifest_checksum
        or actual_manifest_checksum != expected_manifest_checksum
    ):
        raise ValueError("prebuilt_canonical_prep_manifest_checksum_mismatch")

    batch_rows = [int(value) for value in (manifest.get("batch_rows") or [])]
    output_checksums = dict(manifest.get("output_checksums") or {})
    expected_paths = [f"{normalized_prefix}/prep/batch_{idx}.npz" for idx in range(len(batch_rows))]
    if not batch_rows or sorted(output_checksums) != sorted(expected_paths):
        raise ValueError("prebuilt_canonical_prep_batch_inventory_mismatch")
    if sum(batch_rows) != int(manifest.get("output_rows") or 0):
        raise ValueError("prebuilt_canonical_prep_row_count_mismatch")
    if int(manifest.get("output_rows") or 0) < 10000:
        raise ValueError("prebuilt_canonical_prep_rows_below_minimum")
    for path in expected_paths:
        raw = bucket.blob(path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != str(output_checksums.get(path) or ""):
            raise ValueError(f"prebuilt_canonical_prep_batch_checksum_mismatch:{path}")

    sequence_prefix = str(manifest.get("sequence_gcs_prefix") or "").strip().rstrip("/")
    if not sequence_prefix:
        raise ValueError("prebuilt_canonical_prep_sequence_prefix_missing")

    source_receipt_checksum = ""
    sequence_manifest_checksum = ""
    if schema_version == "active8-canonical-adjusted-prep-v2":
        if manifest.get("rank_semantic_version") != "same-market-same-date-global-percentile-v2":
            raise ValueError("prebuilt_canonical_prep_rank_semantic_invalid")
        source_prefix = str(manifest.get("source_gcs_prefix") or "").strip().rstrip("/")
        source_receipt_checksum = str(manifest.get("source_receipt_checksum") or "").strip()
        sequence_manifest_checksum = str(manifest.get("sequence_manifest_checksum") or "").strip()
        if not source_prefix or len(source_receipt_checksum) != 64:
            raise ValueError("prebuilt_canonical_prep_source_lineage_incomplete")
        if len(sequence_manifest_checksum) != 64:
            raise ValueError("prebuilt_canonical_prep_sequence_lineage_incomplete")
        receipt = json.loads(
            bucket.blob(f"{source_prefix}/prep/immutable_receipt.json")
            .download_as_text()
            .lstrip("\ufeff")
        )
        unsigned_receipt = {
            key: value for key, value in receipt.items() if key != "receipt_checksum"
        }
        actual_receipt_checksum = hashlib.sha256(
            json.dumps(unsigned_receipt, sort_keys=True).encode("utf-8")
        ).hexdigest()
        if (
            receipt.get("schema_version") != "active8-immutable-feature-prep-receipt-v1"
            or receipt.get("status") != "ready"
            or str(receipt.get("output_gcs_prefix") or "").rstrip("/") != source_prefix
            or receipt.get("receipt_checksum") != actual_receipt_checksum
            or actual_receipt_checksum != source_receipt_checksum
            or dict(receipt.get("output_checksums") or {})
            != dict(manifest.get("source_checksums") or {})
        ):
            raise ValueError("prebuilt_canonical_prep_source_receipt_invalid")
        date_fields = {
            key: str(manifest.get(key) or "")[:10]
            for key in (
                "source_business_date",
                "source_feature_date_max",
                "sequence_date_max",
                "signal_date_max",
                "label_known_date_max",
            )
        }
        if any(len(value) != 10 for value in date_fields.values()):
            raise ValueError("prebuilt_canonical_prep_date_lineage_incomplete")
        if (
            date_fields["signal_date_max"] > date_fields["source_feature_date_max"]
            or date_fields["signal_date_max"] > date_fields["sequence_date_max"]
            or date_fields["label_known_date_max"] <= date_fields["signal_date_max"]
        ):
            raise ValueError("prebuilt_canonical_prep_date_lineage_invalid")
    return {
        "schema_version": schema_version,
        "manifest_path": manifest_path,
        "manifest_checksum": actual_manifest_checksum,
        "gcs_prefix": normalized_prefix,
        "batch_count": len(batch_rows),
        "total_rows": int(manifest["output_rows"]),
        "sequence_gcs_prefix": sequence_prefix,
        "source_receipt_checksum": source_receipt_checksum,
        "sequence_manifest_checksum": sequence_manifest_checksum,
        "target_semantic_version": expected_target_semantic_version,
        "roundtrip_cost_bps": 18.0,
    }

def _verify_prebuilt_feature_pool(
    *,
    bucket: object,
    path: str,
    expected_checksum: str,
    expected_cohort_id: str,
    expected_source_manifest_checksum: str,
    expected_target_semantic_version: str,
) -> dict[str, object]:
    import hashlib

    normalized_path = str(path or "").strip()
    raw = bucket.blob(normalized_path).download_as_bytes()
    feature_pool = json.loads(raw.decode("utf-8").lstrip("\ufeff"))
    unsigned = {key: value for key, value in feature_pool.items() if key != "artifact_checksum"}
    actual_checksum = hashlib.sha256(json.dumps(unsigned, sort_keys=True).encode("utf-8")).hexdigest()
    required = {
        "schema_version": "active8-oof-full-fit-feature-consensus-v1",
        "status": "ready",
        "cohort_id": expected_cohort_id,
        "source_manifest_checksum": expected_source_manifest_checksum,
        "target_semantic_version": expected_target_semantic_version,
        "selection_method": "outer_fold_majority_vote",
    }
    for key, value in required.items():
        if feature_pool.get(key) != value:
            raise ValueError(f"prebuilt_feature_pool_mismatch:{key}")
    if (
        feature_pool.get("artifact_checksum") != actual_checksum
        or actual_checksum != str(expected_checksum or "")
    ):
        raise ValueError("prebuilt_feature_pool_checksum_mismatch")
    if int(feature_pool.get("fold_count") or 0) < 5:
        raise ValueError("prebuilt_feature_pool_fold_count_insufficient")
    min_votes = int(feature_pool.get("min_votes") or 0)
    if min_votes <= int(feature_pool.get("fold_count") or 0) // 2:
        raise ValueError("prebuilt_feature_pool_majority_threshold_invalid")
    selected = sorted({str(name) for name in (feature_pool.get("tree_active") or []) if str(name)})
    if len(selected) < 10 or selected != list(feature_pool.get("tree_active") or []):
        raise ValueError("prebuilt_feature_pool_selection_invalid")
    return {
        "schema_version": feature_pool["schema_version"],
        "path": normalized_path,
        "artifact_checksum": actual_checksum,
        "selection_method": feature_pool["selection_method"],
        "fold_count": int(feature_pool["fold_count"]),
        "min_votes": min_votes,
        "selected_count": len(selected),
        "source_manifest_checksum": expected_source_manifest_checksum,
    }
def _verify_prebuilt_sequence_prep(
    *,
    bucket: object,
    prefix: str,
    expected_manifest_checksum: str,
    expected_batch_checksums: dict[str, str],
    expected_target_semantic_version: str,
) -> dict[str, object]:
    import hashlib

    normalized_prefix = str(prefix or "").strip().rstrip("/")
    manifest_path = f"{normalized_prefix}/prep/sequence_manifest.json"
    manifest_raw = bucket.blob(manifest_path).download_as_bytes()
    if hashlib.sha256(manifest_raw).hexdigest() != str(expected_manifest_checksum or ""):
        raise ValueError("prebuilt_sequence_manifest_checksum_mismatch")
    manifest = json.loads(manifest_raw.decode("utf-8").lstrip("\ufeff"))
    if (
        manifest.get("contract") != "sequence_records_v3"
        or manifest.get("target_semantic_version") != expected_target_semantic_version
        or str(manifest.get("output_gcs_prefix") or "").rstrip("/") != normalized_prefix
    ):
        raise ValueError("prebuilt_sequence_manifest_contract_invalid")
    checksums = dict(expected_batch_checksums or {})
    expected_paths = [f"{normalized_prefix}/prep/batch_{idx}.npz" for idx in range(len(checksums))]
    if not checksums or sorted(checksums) != sorted(expected_paths):
        raise ValueError("prebuilt_sequence_batch_inventory_mismatch")
    for path in expected_paths:
        raw = bucket.blob(path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != str(checksums.get(path) or ""):
            raise ValueError(f"prebuilt_sequence_batch_checksum_mismatch:{path}")
    return {
        "manifest_path": manifest_path,
        "manifest_checksum": expected_manifest_checksum,
        "lineage_manifest_checksum": str(manifest.get("manifest_checksum") or ""),
        "gcs_prefix": normalized_prefix,
        "batch_count": len(checksums),
        "batch_checksums": checksums,
        "target_semantic_version": expected_target_semantic_version,
    }

def _snapshot_component_uris(snapshot: dict) -> dict[str, str]:
    try:
        metadata = json.loads(snapshot.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        return {}
    component_meta = metadata.get("component_meta") or {}
    components = metadata.get("components") or {}
    out: dict[str, str] = {}
    for name, meta in component_meta.items():
        uri = meta.get("gcs_uri") if isinstance(meta, dict) else None
        if uri:
            out[str(name)] = str(uri)
    for name, uri in components.items():
        out.setdefault(str(name), str(uri))
    return out


def _read_gcs_parquet_rows(gcs_uri: str) -> list[dict]:
    import polars as pl
    from google.cloud import storage

    bucket_name, blob_name = _parse_gcs_uri(gcs_uri)
    with tempfile.TemporaryDirectory(prefix="stockvision-retrain-snapshot-") as tmp:
        local_path = Path(tmp) / Path(blob_name).name
        storage.Client().bucket(bucket_name).blob(blob_name).download_to_filename(str(local_path))
        return pl.read_parquet(local_path).to_dicts()


def _group_rows_by_key(
    rows: list[dict],
    *,
    key: str,
    allowed: set,
    limit: int,
    mapper,
) -> dict:
    grouped = {item: [] for item in allowed}
    for row in sorted(rows, key=lambda r: (str(r.get(key)), str(r.get("date") or ""))):
        value = row.get(key)
        if value not in grouped:
            continue
        grouped[value].append(mapper(row))
    for value in grouped:
        if len(grouped[value]) > limit:
            grouped[value] = grouped[value][-limit:]
    return grouped


def _snapshot_sentiment_map(rows: list[dict], stock_ids: list[int], limit: int = 45) -> dict[int, list[dict]]:
    return _group_rows_by_key(
        rows,
        key="stock_id",
        allowed=set(stock_ids),
        limit=limit,
        mapper=lambda r: {"date": r.get("date"), "score": r.get("score")},
    )


def _snapshot_per_stock_ts_map(
    *,
    monthly_revenue_rows: list[dict] | None,
    canonical_fundamental_rows: list[dict] | None,
    margin_rows: list[dict] | None,
    shareholding_rows: list[dict] | None,
    stock_ids: list[int],
    symbol_to_id: dict[str, int] | None = None,
) -> dict[int, dict[str, dict]]:
    stock_id_set = set(stock_ids)
    per_stock_ts: dict[int, dict[str, dict]] = {}

    def ensure_date(stock_id, date_key: str) -> dict:
        per_stock_ts.setdefault(stock_id, {})
        per_stock_ts[stock_id].setdefault(date_key, {})
        return per_stock_ts[stock_id][date_key]

    for row in monthly_revenue_rows or []:
        sid = row.get("stock_id")
        if sid not in stock_id_set or row.get("revenue_yoy") is None:
            continue
        date_key = monthly_revenue_available_date(str(row.get("date") or ""))
        values = ensure_date(sid, date_key)
        for source, target in (
            ("revenue_yoy", "revenue_yoy"),
            ("revenue_mom", "revenue_mom"),
            ("revenue", "revenue"),
        ):
            if row.get(source) is not None:
                values[target] = row[source]

    symbol_to_id = symbol_to_id or {}
    for row in canonical_fundamental_rows or []:
        sid = symbol_to_id.get(str(row.get("stock_id") or ""))
        available_date = str(row.get("available_date") or "")
        if sid not in stock_id_set or not available_date:
            continue
        values = ensure_date(sid, available_date)
        for name in ("eps", "roe", "pe", "pb", "dividend_yield", "revenue_growth_yoy"):
            if row.get(name) is not None:
                values[name] = row[name]

    for row in margin_rows or []:
        sid = row.get("stock_id")
        if sid not in stock_id_set or not row.get("date"):
            continue
        values = ensure_date(sid, str(row.get("date")))
        if row.get("margin_balance") is not None:
            values["margin_balance"] = row["margin_balance"]
        if row.get("short_ratio") is not None:
            values["short_ratio"] = row["short_ratio"]

    for row in shareholding_rows or []:
        sid = row.get("stock_id")
        if sid not in stock_id_set or not row.get("date") or row.get("retail_pct") is None:
            continue
        ensure_date(sid, str(row.get("date")))["retail_pct"] = row.get("retail_pct")

    return per_stock_ts


def _truthy_env(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in {"1", "true", "yes", "on"}


def _timesfm_l175_feature_release_requested(req: UniversalRetrainTriggerRequest) -> bool:
    return (
        (req.candidate_type or "").strip() == TIMESFM_L175_L2_FEATURE_RELEASE_CANDIDATE_TYPE
        or _truthy_env("TIMESFM_L175_RETRAIN_FEATURES_ENABLED")
    )


def _clean_timesfm_l175_features(features: object) -> dict[str, float] | None:
    if not isinstance(features, dict):
        return None
    cleaned: dict[str, float] = {}
    numeric_seen = 0
    for name in TIMESFM_L175_FEATURE_NAMES:
        source_key = name.replace("timesfm_l175_", "", 1)
        raw = features.get(source_key)
        if raw is None:
            raw = features.get(name)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = 0.0
        if not math.isfinite(value):
            value = 0.0
        elif raw is not None:
            numeric_seen += 1
        cleaned[source_key] = value
    if numeric_seen <= 0:
        return None
    return cleaned


def _extract_timesfm_l175_features(forecast_data: object) -> dict[str, float] | None:
    if isinstance(forecast_data, str):
        try:
            forecast_data = json.loads(forecast_data)
        except json.JSONDecodeError:
            return None
    if not isinstance(forecast_data, dict):
        return None
    sidecar = forecast_data.get("timesfm_sidecar")
    if not isinstance(sidecar, dict):
        return None
    features = _clean_timesfm_l175_features(sidecar.get("features"))
    if features:
        return features
    return _clean_timesfm_l175_features(sidecar.get("l2_feature_values"))


def _load_timesfm_l175_history(
    *,
    stock_ids: list[int],
    run_date: str,
    lookback_days: int = TIMESFM_L175_HISTORY_LOOKBACK_DAYS,
) -> tuple[dict[int, dict[str, dict[str, float]]], dict[str, int | str]]:
    if not stock_ids:
        return {}, {"rows_scanned": 0, "rows_loaded": 0, "stocks_with_history": 0}

    try:
        run_dt = datetime.strptime(run_date, "%Y-%m-%d")
    except ValueError:
        run_dt = datetime.now(timezone.utc)
    start_date = (run_dt - timedelta(days=max(1, int(lookback_days)))).strftime("%Y-%m-%d")
    end_date = run_dt.strftime("%Y-%m-%d")

    history: dict[int, dict[str, dict[str, float]]] = {}
    rows_scanned = 0
    rows_loaded = 0
    for ci in range(0, len(stock_ids), 80):
        chunk_ids = stock_ids[ci:ci + 80]
        placeholders = ",".join("?" * len(chunk_ids))
        rows = d1_client.query(
            f"""
            SELECT stock_id, prediction_date, forecast_data
            FROM predictions
            WHERE model_name = 'ensemble'
              AND stock_id IN ({placeholders})
              AND prediction_date BETWEEN ? AND ?
              AND forecast_data LIKE '%"timesfm_sidecar"%'
            ORDER BY stock_id ASC, prediction_date ASC
            """,
            [*chunk_ids, start_date, end_date],
            timeout=120.0,
        )
        for row in rows or []:
            rows_scanned += 1
            features = _extract_timesfm_l175_features(row.get("forecast_data"))
            if not features:
                continue
            sid = int(row.get("stock_id"))
            date_key = str(row.get("prediction_date") or "")
            if not date_key:
                continue
            history.setdefault(sid, {})[date_key] = features
            rows_loaded += 1

    return history, {
        "source": "predictions.forecast_data.timesfm_sidecar.features",
        "lookback_days": int(lookback_days),
        "start_date": start_date,
        "end_date": end_date,
        "rows_scanned": rows_scanned,
        "rows_loaded": rows_loaded,
        "stocks_with_history": len(history),
        "history_dates": len({date_key for rows in history.values() for date_key in rows}),
    }


def _timesfm_l175_release_coverage(
    summary: dict[str, object],
    *,
    eligible_stocks: int,
    min_stock_coverage: float = TIMESFM_L175_MIN_STOCK_COVERAGE,
    min_history_dates: int = TIMESFM_L175_MIN_HISTORY_DATES,
) -> dict[str, object]:
    stocks_with_history = int(summary.get("stocks_with_history") or 0)
    history_dates = int(summary.get("history_dates") or 0)
    stock_coverage = stocks_with_history / eligible_stocks if eligible_stocks > 0 else 0.0
    blockers: list[str] = []
    if stock_coverage < min_stock_coverage:
        blockers.append("timesfm_l175_stock_coverage_below_minimum")
    if history_dates < min_history_dates:
        blockers.append("timesfm_l175_history_dates_below_minimum")
    return {
        "status": "pass" if not blockers else "fail",
        "eligible_stocks": int(eligible_stocks),
        "stocks_with_history": stocks_with_history,
        "stock_coverage": round(stock_coverage, 6),
        "min_stock_coverage": float(min_stock_coverage),
        "history_dates": history_dates,
        "min_history_dates": int(min_history_dates),
        "blockers": blockers,
    }


def _load_training_maps_from_snapshot(
    *,
    stock_ids: list[int],
    symbols: list[str],
    prices_lookback: int,
    as_of_business_date: str | None = None,
) -> tuple[
    dict[int, list[dict]],
    dict[int, list[dict]],
    dict[str, list[dict]],
    dict[int, list[dict]],
    dict[int, dict[str, dict]],
    dict,
] | None:
    from services.dataset_snapshots import latest_dataset_snapshot

    snapshot = latest_dataset_snapshot(
        kind="backtest_dataset",
        access_tier="compute",
        business_date=as_of_business_date,
    )
    if not snapshot or snapshot.get("manifest_errors"):
        return None
    component_uris = _snapshot_component_uris(snapshot)
    required = {"prices", "indicators", "chips"}
    if not required.issubset(component_uris):
        return None

    stock_id_set = set(stock_ids)
    symbol_set = set(symbols)
    prices_rows = _read_gcs_parquet_rows(component_uris["prices"])
    indicators_rows = _read_gcs_parquet_rows(component_uris["indicators"])
    chips_rows = _read_gcs_parquet_rows(component_uris["chips"])
    sentiment_rows = _read_gcs_parquet_rows(component_uris["sentiment"]) if component_uris.get("sentiment") else []
    monthly_revenue_rows = (
        _read_gcs_parquet_rows(component_uris["monthly_revenue"]) if component_uris.get("monthly_revenue") else []
    )
    canonical_fundamental_rows = (
        _read_gcs_parquet_rows(component_uris["canonical_fundamentals"])
        if component_uris.get("canonical_fundamentals") else []
    )
    margin_rows = _read_gcs_parquet_rows(component_uris["margin_data"]) if component_uris.get("margin_data") else []
    shareholding_rows = (
        _read_gcs_parquet_rows(component_uris["shareholding"]) if component_uris.get("shareholding") else []
    )

    prices_map = _group_rows_by_key(
        prices_rows,
        key="stock_id",
        allowed=stock_id_set,
        limit=prices_lookback,
        mapper=lambda r: {
            "date": r.get("date"),
            "open": r.get("open"),
            "high": r.get("high"),
            "low": r.get("low"),
            "close": r.get("close"),
            "volume": r.get("volume"),
            "adj_close": r.get("adj_close"),
            "avg_price": r.get("avg_price"),
        },
    )
    indicators_map = _group_rows_by_key(
        indicators_rows,
        key="stock_id",
        allowed=stock_id_set,
        limit=prices_lookback,
        mapper=lambda r: {
            "date": r.get("date"),
            "ma5": r.get("ma5"),
            "ma10": r.get("ma10"),
            "ma20": r.get("ma20"),
            "ma60": r.get("ma60"),
            "rsi14": r.get("rsi14"),
            "macdHist": r.get("macd_hist", r.get("macdHist")),
            "bb_upper": r.get("bb_upper"),
            "bb_lower": r.get("bb_lower"),
            "atr14": r.get("atr14"),
        },
    )
    chips_map = _group_rows_by_key(
        chips_rows,
        key="symbol",
        allowed=symbol_set,
        limit=252,
        mapper=lambda r: {
            "date": r.get("date"),
            "foreign_net": r.get("foreign_net"),
            "trust_net": r.get("trust_net"),
            "dealer_net": r.get("dealer_net"),
            "margin_balance": r.get("margin_balance"),
            "short_balance": r.get("short_balance"),
        },
    )
    sentiment_map = _snapshot_sentiment_map(sentiment_rows, stock_ids) if sentiment_rows else {}
    per_stock_ts_map = _snapshot_per_stock_ts_map(
        monthly_revenue_rows=monthly_revenue_rows,
        canonical_fundamental_rows=canonical_fundamental_rows,
        margin_rows=margin_rows,
        shareholding_rows=shareholding_rows,
        stock_ids=stock_ids,
        symbol_to_id={symbol: stock_id for stock_id, symbol in zip(stock_ids, symbols)},
    )
    return prices_map, indicators_map, chips_map, sentiment_map, per_stock_ts_map, {
        "snapshot_id": snapshot.get("snapshot_id"),
        "business_date": snapshot.get("business_date"),
        "row_count": snapshot.get("row_count"),
        "gcs_uri": snapshot.get("gcs_uri"),
        "components": sorted(component_uris),
    }


def _build_followup_webhook_url(request: Request | None) -> str:
    explicit = (
        os.environ.get("RETRAIN_FOLLOWUP_URL", "").strip()
        or os.environ.get("ML_CONTROLLER_PUBLIC_URL", "").strip()
    )
    if explicit:
        explicit = _force_https(explicit)
        if explicit.rstrip("/").endswith("/retrain/followup"):
            return explicit.rstrip("/")
        return f"{explicit.rstrip('/')}/retrain/followup"
    if request is not None:
        base = _force_https(str(request.base_url).rstrip("/"))
        return f"{base}/retrain/followup"
    return "http://localhost/retrain/followup"


def _build_prebuilt_oof_dataset_snapshot(
    *,
    verified_prep: dict[str, object],
    verified_feature_pool: dict[str, object],
    verified_sequence: dict[str, object],
    source_cohort_id: str,
    source_manifest_checksum: str,
) -> dict[str, object]:
    """Bind prep V2 evidence under the immutable full-fit lineage contract."""

    return {
        **verified_prep,
        "prep_schema_version": verified_prep.get("schema_version"),
        "schema_version": "active8-oof-full-fit-prep-lineage-v1",
        "source_cohort_id": source_cohort_id,
        "source_manifest_checksum": source_manifest_checksum,
        "feature_pool": verified_feature_pool,
        "sequence": verified_sequence,
    }


def _upsert_retrain_status(
    run_id: str,
    *,
    status: str,
    summary: dict | None = None,
    source: str = "ml-controller",
    action: str = "retrain_followup",
    downstream_notes: str = "",
) -> None:
    payload_summary = json.dumps(summary or {}, ensure_ascii=False)
    sql = """
        INSERT INTO webhook_log
          (idempotency_key, received_at, source, action, payload_summary, status, downstream_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          received_at = excluded.received_at,
          source = excluded.source,
          action = excluded.action,
          payload_summary = excluded.payload_summary,
          status = excluded.status,
          downstream_notes = excluded.downstream_notes
    """
    d1_client.execute(
        sql,
        [
            run_id,
            datetime.now(timezone.utc).isoformat(),
            source,
            action,
            payload_summary,
            status,
            downstream_notes,
        ],
    )


@router.post("/trigger")
async def trigger_retrain(req: RetrainTriggerRequest = Body(default=RetrainTriggerRequest())):
    """
    Sprint 6b retrain trigger ??builds payloads from D1, calls Modal.

    1. Load all active stocks from D1
    2. Build market_env (shared)
    3. Bulk load prices/indicators/chips/sentiment per stock
    4. Call Modal retrain_single_stock ? N stocks
    """
    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    run_date = req.run_date or tw_now.date().isoformat()

    # ?? 1. Active stocks ????????????????????????????????????????????????????
    stock_rows = d1_client.query(
        "SELECT id, symbol, market FROM stocks "
        "WHERE market IN ('TW','TWO','TWSE','OTC') AND in_current_watchlist=1 "
        "ORDER BY id LIMIT ?",
        [req.limit],
    )
    if not stock_rows:
        return {"error": "No active stocks found", "total": 0}

    stock_ids = [r["id"] for r in stock_rows]
    symbols = [r["symbol"] for r in stock_rows]
    id_to_sym = {r["id"]: r["symbol"] for r in stock_rows}

    logger.info(f"[retrain/trigger] {len(stock_rows)} active stocks, run_date={run_date}")

    # ?? 2. Shared market env ????????????????????????????????????????????????
    market_env, _adaptive, barrier_params, _lifecycle, _tc = load_market_env(run_date)

    # ?? 3. Bulk load per-stock data ?????????????????????????????????????????
    prices_map = _bulk_load_prices(stock_ids, limit=500)
    indicators_map = _bulk_load_indicators(stock_ids, limit=500)
    chips_map = _bulk_load_chips(symbols, limit=300)
    sentiment_map = _bulk_load_sentiment(stock_ids, limit=90)

    # ?? 4. Build payloads ???????????????????????????????????????????????????
    payloads = []
    skipped = []
    for row in stock_rows:
        sid, sym = row["id"], row["symbol"]
        px = prices_map.get(sid, [])
        if len(px) < 60:
            skipped.append(f"{sym}(prices={len(px)}<60)")
            continue
        payloads.append({
            "stock_id": sid,
            "symbol": sym,
            "market": row.get("market", "TW"),
            "prices": px,
            "indicators": indicators_map.get(sid, []),
            "chips": chips_map.get(sym, []),
            "sentiment_scores": sentiment_map.get(sid, []),
            "market_env": asdict(market_env),
            "barrier_params": barrier_params,
            "use_optuna": req.use_optuna,
        })

    if not payloads:
        return {"error": "All stocks skipped (insufficient data)", "skipped": skipped}

    logger.info(
        f"[retrain/trigger] {len(payloads)} payloads built, {len(skipped)} skipped. "
        f"Starting Modal retrain..."
    )

    # ?? 5. Call Modal batch retrain ?????????????????????????????????????????
    results = await batch_retrain(payloads)

    elapsed = round(time.time() - t0, 2)
    retrained = sum(1 for r in results if not r.get("error"))
    errors = [r for r in results if r.get("error")]

    logger.info(f"[retrain/trigger] Done: {retrained}/{len(payloads)} in {elapsed}s")

    return {
        "total": len(payloads),
        "retrained": retrained,
        "errors": len(errors),
        "skipped": skipped,
        "elapsed_s": elapsed,
        "error_details": [{"symbol": e.get("symbol"), "error": e.get("error")} for e in errors[:10]],
    }


# ?? Universal Model Retrain ?????????????????????????????????????????????????

# Sector ??int encoding (must match ml-service/app/features/__init__.py)
_SECTOR_ENCODING: dict[str, int] = {}  # populated lazily from D1


def _build_sector_encoding() -> dict[str, int]:
    """Load distinct industry tags from D1 and assign integer codes."""
    global _SECTOR_ENCODING
    if _SECTOR_ENCODING:
        return _SECTOR_ENCODING
    rows = d1_client.query(
        "SELECT DISTINCT tag FROM stock_tags WHERE tag_type='industry' ORDER BY tag"
    )
    _SECTOR_ENCODING = {r["tag"]: i for i, r in enumerate(rows)}
    logger.info(f"[universal] sector encoding: {len(_SECTOR_ENCODING)} industries")
    return _SECTOR_ENCODING


def _estimate_cap_bucket(prices: list[dict]) -> int:
    """Estimate market_cap_bucket from avg close ? avg volume (proxy).
    0=micro, 1=small, 2=mid, 3=large, 4=mega
    """
    if not prices:
        return 2
    recent = prices[-20:] if len(prices) >= 20 else prices
    avg_close = sum(float(p.get("close", 0)) for p in recent) / len(recent)
    avg_vol = sum(float(p.get("volume", 0)) for p in recent) / len(recent)
    proxy = avg_close * avg_vol  # ~daily turnover (NTD)
    if proxy > 5_000_000_000:
        return 4  # mega
    if proxy > 1_000_000_000:
        return 3  # large
    if proxy > 200_000_000:
        return 2  # mid
    if proxy > 50_000_000:
        return 1  # small
    return 0  # micro


def _volume_bucket(prices: list[dict]) -> int:
    """Avg volume bucket: 0=very low, 1=low, 2=mid, 3=high, 4=very high."""
    if not prices:
        return 2
    recent = prices[-20:] if len(prices) >= 20 else prices
    avg_vol = sum(float(p.get("volume", 0)) for p in recent) / len(recent)
    if avg_vol > 50_000_000:
        return 4
    if avg_vol > 10_000_000:
        return 3
    if avg_vol > 2_000_000:
        return 2
    if avg_vol > 500_000:
        return 1
    return 0


async def _dispatch_prebuilt_oof_full_fit(
    *,
    req: UniversalRetrainTriggerRequest,
    request: Request | None,
    run_id: str,
    run_date: str,
    lock_key: str,
) -> dict[str, object]:
    from google.cloud import storage
    from services.modal_client import retrain_orchestrator

    bucket_name = os.environ.get("GCS_BUCKET_NAME") or os.environ.get("RETRAIN_LOCK_BUCKET")
    if not bucket_name:
        raise RuntimeError("prebuilt_canonical_prep_bucket_missing")
    bucket = storage.Client().bucket(bucket_name)
    verified = _verify_prebuilt_canonical_prep(
        bucket=bucket,
        prefix=str(req.prebuilt_prep_gcs_prefix or ""),
        expected_manifest_checksum=str(req.prebuilt_prep_manifest_checksum or ""),
        expected_target_semantic_version=str(req.prebuilt_prep_target_semantic_version or ""),
    )
    sequence_verified = _verify_prebuilt_sequence_prep(
        bucket=bucket,
        prefix=str(req.sequence_gcs_prefix or ""),
        expected_manifest_checksum=str(req.prebuilt_sequence_manifest_checksum or ""),
        expected_batch_checksums=req.prebuilt_sequence_batch_checksums,
        expected_target_semantic_version=str(req.prebuilt_prep_target_semantic_version or ""),
    )
    if req.sequence_gcs_prefix and (
        str(req.sequence_gcs_prefix).strip().rstrip("/") != verified["sequence_gcs_prefix"]
    ):
        raise ValueError("prebuilt_canonical_prep_sequence_prefix_mismatch")
    if (
        verified.get("schema_version") == "active8-canonical-adjusted-prep-v2"
        and verified.get("sequence_manifest_checksum")
        != sequence_verified.get("lineage_manifest_checksum")
    ):
        raise ValueError("prebuilt_canonical_prep_sequence_checksum_mismatch")
    if len(str(req.prebuilt_prep_source_manifest_checksum or "")) != 64:
        raise ValueError("prebuilt_canonical_prep_source_manifest_checksum_missing")
    if not str(req.prebuilt_prep_source_cohort_id or "").strip():
        raise ValueError("prebuilt_canonical_prep_source_cohort_missing")
    feature_pool_verified: dict[str, object] = {}
    if "tree" in {str(group).strip().lower() for group in req.train_model_groups}:
        feature_pool_verified = _verify_prebuilt_feature_pool(
            bucket=bucket,
            path=str(req.prebuilt_feature_pool_path or ""),
            expected_checksum=str(req.prebuilt_feature_pool_checksum or ""),
            expected_cohort_id=str(req.prebuilt_prep_source_cohort_id),
            expected_source_manifest_checksum=str(req.prebuilt_prep_source_manifest_checksum),
            expected_target_semantic_version=str(req.prebuilt_prep_target_semantic_version),
        )

    training_policy = TrainingPolicy.from_env()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    is_monthly = training_policy.is_monthly(
        force_monthly=req.force_monthly,
        tw_day=tw_now.day,
    )
    sequence_batch_count = int(sequence_verified["batch_count"])
    if req.sequence_batch_count and int(req.sequence_batch_count) != sequence_batch_count:
        raise ValueError("prebuilt_sequence_batch_count_mismatch")
    sequence_contract: dict[str, object] = {
        "sequence_gcs_prefix": sequence_verified["gcs_prefix"],
        "sequence_batch_count": sequence_batch_count,
    }
    for key in ("sequence_seq_len", "dlinear_seq_len", "patchtst_seq_len", "itransformer_seq_len"):
        value = getattr(req, key, None)
        if value:
            sequence_contract[key] = int(value)

    followup_webhook_url = ""
    payload = {
        "batch_count": verified["batch_count"],
        "is_monthly": is_monthly,
        "candidate_type": req.candidate_type,
        "drift_target_models": req.drift_target_models,
        "drift_target_families": req.drift_target_families,
        "train_model_groups": req.train_model_groups,
        "artifact_lifecycle_targets": req.artifact_lifecycle_targets,
        "artifact_lifecycle_contracts": req.artifact_lifecycle_contracts,
        "artifact_lifecycle_only": req.artifact_lifecycle_only,
        "register_challengers": req.register_challengers,
        "promotion_allowed_models": req.promotion_allowed_models,
        "oof_promotion_evidence": req.oof_promotion_evidence,
        "oof_lifecycle_resume": req.oof_lifecycle_resume,
        "selection_params": training_policy.feature_selection_params(),
        "training_policy": training_policy.to_dict(),
        "dataset_snapshot": _build_prebuilt_oof_dataset_snapshot(
            verified_prep=verified,
            verified_feature_pool=feature_pool_verified,
            verified_sequence=sequence_verified,
            source_cohort_id=str(req.prebuilt_prep_source_cohort_id),
            source_manifest_checksum=str(req.prebuilt_prep_source_manifest_checksum),
        ),
        "timesfm_l175_feature_release": {"requested": False},
        "followup_webhook_url": followup_webhook_url,
        "gcs_prefix": verified["gcs_prefix"],
        "feature_pool_path": feature_pool_verified.get("path"),
        "run_id": run_id,
        "lock_key": lock_key,
        "run_date": run_date,
        **sequence_contract,
    }
    orchestrator_result = await retrain_orchestrator(payload=payload, fire_and_forget=True)
    function_call_id = str(orchestrator_result.get("function_call_id") or "")
    if not function_call_id.startswith("fc-"):
        raise RuntimeError("prebuilt_oof_full_fit_function_call_id_missing")
    _upsert_retrain_status(
        run_id,
        status="orchestrator_dispatched",
        summary={
            "lock_key": lock_key,
            "run_date": run_date,
            "prebuilt_oof_full_fit": True,
            "verified_prep": verified,
            "verified_feature_pool": feature_pool_verified,
            "source_cohort_id": req.prebuilt_prep_source_cohort_id,
            "source_manifest_checksum": req.prebuilt_prep_source_manifest_checksum,
            "sequence_contract": sequence_contract,
            "orchestrator_result": orchestrator_result,
        },
        downstream_notes="await_modal_followup",
    )
    return {
        "status": "dispatched",
        "prebuilt_oof_full_fit": True,
        "run_id": run_id,
        "lock_key": lock_key,
        "verified_prep": verified,
        "sequence_contract": sequence_contract,
        "orchestrator_result": orchestrator_result,
        "followup_webhook_url": followup_webhook_url,
    }

@router.post("/universal/run")
@router.post("/universal")
async def trigger_universal_retrain(
    req: UniversalRetrainTriggerRequest = Body(default=UniversalRetrainTriggerRequest()),
    request: Request = None,
):
    """
    ?典???universal model retrain trigger.

    1. Load ALL stocks from D1 (no in_current_watchlist filter ??universal covers all)
    2. Bulk load prices/indicators/chips/sentiment
    3. Add stock_meta (sector_encoded, market_cap_bucket, avg_volume_bucket)
    4. Send pooled payload to Modal retrain_universal_model
    """
    t0 = time.time()
    tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
    run_id = f"universal-{tw_now.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"

    # ?? Idempotency check (P0-4, persistent via GCS) ?????????????????????????
    run_date = req.run_date or tw_now.date().isoformat()
    prep_output_gcs_prefix = str(req.prep_output_gcs_prefix or "").strip().rstrip("/")
    if req.prep_only and (
        not prep_output_gcs_prefix
        or not prep_output_gcs_prefix.startswith("universal/oof_forward_prep/")
    ):
        return {
            "status": "rejected",
            "error": "prep_only_immutable_output_prefix_required",
            "required_prefix": "universal/oof_forward_prep/<run-id>",
        }
    prep_bucket = None
    if req.prep_only:
        from google.cloud import storage as _prep_storage

        prep_bucket = _prep_storage.Client().bucket(
            os.environ.get("GCS_BUCKET_NAME", "stockvision-models")
        )
        try:
            sealed = _verified_prep_only_receipt(prep_bucket, prep_output_gcs_prefix, run_date)
        except (ValueError, json.JSONDecodeError) as exc:
            return {
                "status": "rejected",
                "error": str(exc),
                "output_gcs_prefix": prep_output_gcs_prefix,
            }
        if sealed is not None:
            return {
                **sealed,
                "status": "idempotent_ready",
                "receipt_path": f"{prep_output_gcs_prefix}/prep/immutable_receipt.json",
            }
    lock_scope = hashlib.sha256(prep_output_gcs_prefix.encode("utf-8")).hexdigest()[:12]
    lock_key = f"prep-only:{run_date}:{lock_scope}" if req.prep_only else f"retrain:{run_date}"
    lock_ttl_seconds = _PREP_ONLY_LOCK_TTL_SECONDS if req.prep_only else _UNIVERSAL_LOCK_TTL_SECONDS
    lock_result = retrain_lock.acquire(
        lock_key,
        ttl_seconds=lock_ttl_seconds,
        metadata={
            "run_id": run_id,
            "run_date": run_date,
            "limit": req.limit,
            "force_monthly": req.force_monthly,
            "candidate_type": req.candidate_type,
            "promotion_allowed_models": req.promotion_allowed_models,
            "tw_now": tw_now.isoformat(),
        },
    )
    if not lock_result.acquired:
        logger.info(
            f"[retrain/universal] {lock_result.reason} ??skip duplicate trigger "
            f"(backend={lock_result.backend})"
        )
        return {
            "status": "skipped",
            "reason": lock_result.reason,
            "lock_key": lock_key,
            "backend": lock_result.backend,
            "existing_instance": lock_result.existing_instance,
            "elapsed_since": lock_result.elapsed_since_acquire,
        }
    logger.info(
        f"[retrain/universal] Lock acquired: {lock_key} (backend={lock_result.backend}, "
        f"reason={lock_result.reason})"
    )

    _upsert_retrain_status(
        run_id,
        status="started",
        summary={
            "lock_key": lock_key,
            "run_date": run_date,
            "limit": req.limit,
            "force_monthly": req.force_monthly,
            "lock_backend": lock_result.backend,
            "lock_ttl_seconds": lock_ttl_seconds,
        },
        downstream_notes="lock_acquired",
    )

    # ?? 1. All stocks (universal covers inactive too for training diversity) ??
    if req.prebuilt_prep_gcs_prefix:
        try:
            return await _dispatch_prebuilt_oof_full_fit(
                req=req,
                request=request,
                run_id=run_id,
                run_date=run_date,
                lock_key=lock_key,
            )
        except Exception as exc:
            retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
            _upsert_retrain_status(
                run_id,
                status="prep_failed",
                summary={
                    "lock_key": lock_key,
                    "run_date": run_date,
                    "reason": "prebuilt_oof_full_fit_validation_or_dispatch_failed",
                    "error": f"{type(exc).__name__}: {exc}",
                    "prebuilt_prep_gcs_prefix": req.prebuilt_prep_gcs_prefix,
                    "source_cohort_id": req.prebuilt_prep_source_cohort_id,
                },
                downstream_notes="prebuilt_oof_full_fit_rejected_before_training",
            )
            return {
                "status": "rejected",
                "error": "prebuilt_oof_full_fit_validation_or_dispatch_failed",
                "detail": f"{type(exc).__name__}: {exc}",
                "run_id": run_id,
                "lock_key": lock_key,
            }
    stock_rows = d1_client.query(
        "SELECT id, symbol, market FROM stocks "
        "WHERE market IN ('TW','TWO','TWSE','OTC') "
        "ORDER BY id LIMIT ?",
        [req.limit],
    )
    if not stock_rows:
        retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
        _upsert_retrain_status(
            run_id,
            status="prep_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "reason": "no_stocks_found",
                "limit": req.limit,
            },
            downstream_notes="aborted_before_data_load",
        )
        return {"error": "No stocks found", "total": 0}

    stock_ids = [r["id"] for r in stock_rows]
    symbols = [r["symbol"] for r in stock_rows]
    id_to_sym = {r["id"]: r["symbol"] for r in stock_rows}
    sym_to_id = {r["symbol"]: r["id"] for r in stock_rows}

    logger.info(f"[retrain/universal] {len(stock_rows)} stocks, run_date={run_date}")

    # ?? 2. Shared market env ????????????????????????????????????????????????
    market_env, _adaptive, barrier_params, _lifecycle, _tc = load_market_env(run_date)

    # 2a. B-lite regime-conditional training window.
    # VIX + TWII bias proxy decides prices lookback via TrainingPolicy.
    # Future HMM/KV regime source should only replace TrainingPolicy inputs.
    training_policy = TrainingPolicy.from_env()
    vix = getattr(market_env, "us_vix", 18) or 18
    twii_bias = getattr(market_env, "twii_bias", 0) or 0
    regime, prices_lookback = training_policy.resolve_regime(vix=float(vix), twii_bias=float(twii_bias))
    logger.info(f"[retrain/universal] Regime={regime} (VIX={vix:.1f}, bias={twii_bias:.3f}) -> prices_lookback={prices_lookback}d")

    # 2b. Monthly detection + feature pool for prep filtering.
    # Flow B: feature selection runs inside Modal orchestrator.
    # Cloud Run only prepares feature_pool.json for prep filtering.
    import json as _json
    from google.cloud import storage as _gcs
    is_monthly = training_policy.is_monthly(force_monthly=req.force_monthly, tw_day=tw_now.day)
    if is_monthly:
        logger.info(
            "[retrain/universal] Monthly detected "
            f"(day<={training_policy.monthly_day_cutoff}) -> selection will run in Modal orchestrator"
        )

    # Prep writes the full canonical tabular matrix. Train-side policy owns
    # model-specific filtering: active tree models use feature_pool.tree_active;
    # retired tabular-neural paths are not scheduled.
    active_features = None
    logger.info("[retrain/universal] prep writes full canonical features; train-side feature policy filters active models")

    # ?? 3. Bulk load per-stock data (chunked ??CF D1 REST API binding limit ~100) ??
    D1_CHUNK = 80
    prices_map: dict = {}
    indicators_map: dict = {}
    chips_map: dict = {}
    sentiment_map: dict = {}
    per_stock_ts_map: dict[int, dict[str, dict]] = {}
    dataset_snapshot_info: dict | None = None
    try:
        snapshot_maps = _load_training_maps_from_snapshot(
            stock_ids=stock_ids,
            symbols=symbols,
            prices_lookback=prices_lookback,
            as_of_business_date=run_date,
        )
    except Exception as snapshot_err:  # noqa: BLE001 - D1 fallback keeps retrain available.
        logger.warning("[retrain/universal] GCS snapshot load failed, falling back to D1: %s", snapshot_err)
        snapshot_maps = None

    snapshot_rejection = _exact_dataset_snapshot_rejection(
        require_exact=req.require_exact_dataset_snapshot,
        run_date=run_date,
        snapshot_maps=snapshot_maps,
    )
    if snapshot_rejection:
        retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
        summary = {
            "lock_key": lock_key,
            "run_date": run_date,
            **snapshot_rejection,
        }
        _upsert_retrain_status(
            run_id,
            status="prep_failed",
            summary=summary,
            downstream_notes="aborted_before_data_load",
        )
        return {
            "status": "rejected",
            "error": summary["reason"],
            **summary,
        }

    if snapshot_maps:
        prices_map, indicators_map, chips_map, sentiment_map, per_stock_ts_map, dataset_snapshot_info = snapshot_maps
        logger.info(
            "[retrain/universal] GCS snapshot bulk load done: "
            f"snapshot={dataset_snapshot_info.get('snapshot_id')} "
            f"business_date={dataset_snapshot_info.get('business_date')} "
            f"prices={len(prices_map)} indicators={len(indicators_map)} chips={len(chips_map)} "
            f"sentiment={len(sentiment_map)} per_stock_ts={len(per_stock_ts_map)}"
        )

    snapshot_components = set((dataset_snapshot_info or {}).get("components") or [])
    for ci in range(0, len(stock_ids), D1_CHUNK):
        chunk_ids = stock_ids[ci:ci + D1_CHUNK]
        chunk_syms = [id_to_sym[sid] for sid in chunk_ids]
        if not dataset_snapshot_info:
            prices_map.update(_bulk_load_prices(chunk_ids, limit=prices_lookback))
            indicators_map.update(_bulk_load_indicators(chunk_ids, limit=prices_lookback))
            chips_map.update(_bulk_load_chips(chunk_syms, limit=252))
        if "sentiment" not in snapshot_components:
            sentiment_map.update(_bulk_load_sentiment(chunk_ids, limit=45))
    source = "gcs_snapshot" if dataset_snapshot_info else "d1"
    if dataset_snapshot_info and "sentiment" not in snapshot_components:
        source += "+d1_sentiment"
    logger.info(
        f"[retrain/universal] Bulk load done: source={source} "
        f"prices={len(prices_map)} indicators={len(indicators_map)} chips={len(chips_map)}"
    )

    # ?? 3b. Bulk load per-stock time-series for Wave 3 features ????????????
    # revenue_yoy (monthly, per stock) + margin_data (daily, per stock)
    # monthly_revenue: all stocks ? all months
    rev_rows = []
    if "monthly_revenue" not in snapshot_components:
        rev_rows = d1_client.query(
            "SELECT stock_id, date, revenue_yoy FROM monthly_revenue "
            "WHERE revenue_yoy IS NOT NULL ORDER BY stock_id, date ASC",
            timeout=120.0,
        )
        for r in (rev_rows or []):
            sid = r["stock_id"]
            ym = r["date"]  # Usually revenue period "YYYY-MM"; full publication date is also accepted.
            if sid not in per_stock_ts_map:
                per_stock_ts_map[sid] = {}
            date_key = monthly_revenue_available_date(ym)
            if date_key not in per_stock_ts_map[sid]:
                per_stock_ts_map[sid][date_key] = {}
            per_stock_ts_map[sid][date_key]["revenue_yoy"] = r.get("revenue_yoy", 0)

    # margin_data: all stocks ? all dates (margin_balance, short_ratio)
    for ci in range(0, len(stock_ids), D1_CHUNK):
        chunk_ids = stock_ids[ci:ci + D1_CHUNK]
        placeholders = ",".join("?" * len(chunk_ids))
        if "margin_data" not in snapshot_components:
            margin_rows = d1_client.query(
                f"SELECT stock_id, date, margin_balance, short_ratio "
                f"FROM margin_data WHERE stock_id IN ({placeholders}) "
                f"ORDER BY stock_id, date ASC",
                list(chunk_ids),
                timeout=120.0,
            )
            for r in (margin_rows or []):
                sid = r["stock_id"]
                date_key = r["date"]
                if sid not in per_stock_ts_map:
                    per_stock_ts_map[sid] = {}
                if date_key not in per_stock_ts_map[sid]:
                    per_stock_ts_map[sid][date_key] = {}
                if r.get("margin_balance") is not None:
                    per_stock_ts_map[sid][date_key]["margin_balance"] = r["margin_balance"]
                if r.get("short_ratio") is not None:
                    per_stock_ts_map[sid][date_key]["short_ratio"] = r["short_ratio"]

        # shareholding: retail_pct (same chunk)
        if "shareholding" not in snapshot_components:
            sh_rows = d1_client.query(
                f"SELECT stock_id, date, retail_pct "
                f"FROM shareholding WHERE stock_id IN ({placeholders}) "
                f"ORDER BY stock_id, date ASC",
                list(chunk_ids),
                timeout=120.0,
            )
            for r in (sh_rows or []):
                sid = r["stock_id"]
                date_key = r["date"]
                if sid not in per_stock_ts_map:
                    per_stock_ts_map[sid] = {}
                if date_key not in per_stock_ts_map[sid]:
                    per_stock_ts_map[sid][date_key] = {}
                if r.get("retail_pct") is not None:
                    per_stock_ts_map[sid][date_key]["retail_pct"] = r["retail_pct"]

    logger.info(
        f"[retrain/universal] Per-stock TS: {len(per_stock_ts_map)} stocks with history, "
        f"{len(rev_rows or [])} revenue rows, margin+shareholding chunked"
    )

    # ?? 4. Sector encoding ??????????????????????????????????????????????????
    timesfm_l175_feature_release_requested = _timesfm_l175_feature_release_requested(req)
    if timesfm_l175_feature_release_requested:
        # TimesFM changes the governed tabular universe. TabM and GNN must be
        # trained in the same release run as the three tree models.
        req.artifact_lifecycle_targets = list(dict.fromkeys([
            *(req.artifact_lifecycle_targets or []),
            "TabM",
            "GNN",
        ]))
        req.artifact_lifecycle_contracts = {
            **(req.artifact_lifecycle_contracts or {}),
            "TabM": "formal137_plus_timesfm_l175_v1",
            "GNN": "formal137_plus_timesfm_l175_v1",
        }
    timesfm_l175_history_by_stock_id: dict[int, dict[str, dict[str, float]]] = {}
    timesfm_l175_history_summary: dict[str, int | str | bool] = {
        "requested": timesfm_l175_feature_release_requested,
        "candidate_type": req.candidate_type or "",
    }
    if timesfm_l175_feature_release_requested:
        timesfm_l175_history_by_stock_id, loaded_summary = _load_timesfm_l175_history(
            stock_ids=stock_ids,
            run_date=run_date,
        )
        timesfm_l175_history_summary.update(loaded_summary)
        logger.info(
            "[retrain/universal] TimesFM L2 feature-release history loaded: "
            f"stocks={loaded_summary.get('stocks_with_history')} rows={loaded_summary.get('rows_loaded')} "
            f"window={loaded_summary.get('start_date')}..{loaded_summary.get('end_date')}"
        )

    sector_enc = _build_sector_encoding()
    # Load per-symbol industry tag
    tag_rows = d1_client.query(
        "SELECT symbol, tag FROM stock_tags WHERE tag_type='industry'"
    )
    sym_to_sector: dict[str, str] = {}
    for r in tag_rows:
        sym_to_sector[r["symbol"]] = r["tag"]

    # ?? 5. Build pooled payloads ????????????????????????????????????????????
    per_stock_payloads = []
    skipped = []
    for row in stock_rows:
        sid, sym = row["id"], row["symbol"]
        px = prices_map.get(sid, [])
        if len(px) < 60:
            skipped.append(f"{sym}(prices={len(px)}<60)")
            continue
        sector_tag = sym_to_sector.get(sym, "")
        # market_env: lightweight per-stock (no history, no per_stock_ts)
        # shared data (history + per_stock_ts) passed at batch level to avoid 2500x deep copy
        me_lite = {
            "risk_score": market_env.risk_score,
            "risk_level": market_env.risk_level,
            "us_sox_return": market_env.us_sox_return,
            "us_vix": market_env.us_vix,
        }
        timesfm_l175_history = timesfm_l175_history_by_stock_id.get(sid, {})
        per_stock_payloads.append({
            "stock_id": sid,
            "symbol": sym,
            "market": row.get("market", "TW"),
            "prices": px,
            "indicators": indicators_map.get(sid, []),
            "chips": chips_map.get(sym, []),
            "sentiment_scores": sentiment_map.get(sid, []),
            "market_env": me_lite,
            "stock_meta": {
                "sector_encoded": sector_enc.get(sector_tag, 0),
                "market_cap_bucket": _estimate_cap_bucket(px),
                "avg_volume_bucket": _volume_bucket(px),
                "timesfm_l175_l2_feature_input_active": bool(timesfm_l175_history),
                "timesfm_l175_history": timesfm_l175_history,
            },
        })

    if timesfm_l175_feature_release_requested:
        coverage_gate = _timesfm_l175_release_coverage(
            timesfm_l175_history_summary,
            eligible_stocks=len(per_stock_payloads),
        )
        timesfm_l175_history_summary["coverage_gate"] = coverage_gate
        if coverage_gate["status"] != "pass":
            retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
            _upsert_retrain_status(
                run_id,
                status="prep_failed",
                summary={
                    "lock_key": lock_key,
                    "run_date": run_date,
                    "reason": "timesfm_l175_release_coverage_failed",
                    "timesfm_l175_feature_release": timesfm_l175_history_summary,
                },
                downstream_notes="aborted_before_batch_prep",
            )
            return {
                "status": "rejected",
                "error": "timesfm_l175_release_coverage_failed",
                "run_id": run_id,
                "lock_key": lock_key,
                "timesfm_l175_feature_release": timesfm_l175_history_summary,
            }

    if len(per_stock_payloads) < 10:
        retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
        _upsert_retrain_status(
            run_id,
            status="prep_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "reason": "usable_stocks_below_threshold",
                "usable_stocks": len(per_stock_payloads),
                "stocks_skipped": len(skipped),
            },
            downstream_notes="aborted_before_batch_prep",
        )
        return {"error": f"Usable stocks < 10 ({len(per_stock_payloads)})", "skipped": skipped}

    # ?? 5b. Cross-sectional features: sector peer returns ????????????????????
    # MI-LSTM ?嚗?蝞??Ｘ平撟喳??梢嚗釣??stock_meta
    sector_returns: dict[str, list[tuple[float, float]]] = {}  # tag ??[(return_1d, return_5d), ...]
    for p in per_stock_payloads:
        px = p["prices"]
        if len(px) < 6:
            continue
        close_last = float(px[-1].get("close", 0))
        close_1d = float(px[-2].get("close", 0)) if len(px) >= 2 else close_last
        close_5d = float(px[-6].get("close", 0)) if len(px) >= 6 else close_last
        r1d = (close_last - close_1d) / close_1d if close_1d > 0 else 0
        r5d = (close_last - close_5d) / close_5d if close_5d > 0 else 0
        sym = p["symbol"]
        tag = sym_to_sector.get(sym, "")
        if tag:
            sector_returns.setdefault(tag, []).append((r1d, r5d))
        # ?怠???梢靘?stock_vs_sector 閮?
        p["_r5d"] = r5d

    # 蝞?sector 撟喳?
    sector_avg: dict[str, tuple[float, float]] = {}
    for tag, returns in sector_returns.items():
        avg_1d = sum(r[0] for r in returns) / len(returns)
        avg_5d = sum(r[1] for r in returns) / len(returns)
        sector_avg[tag] = (avg_1d, avg_5d)

    # 瘜典 stock_meta
    for p in per_stock_payloads:
        tag = sym_to_sector.get(p["symbol"], "")
        avg = sector_avg.get(tag, (0.0, 0.0))
        p["stock_meta"]["sector_peer_return_1d"] = round(avg[0], 6)
        p["stock_meta"]["sector_peer_return_5d"] = round(avg[1], 6)
        p["stock_meta"]["stock_vs_sector"] = round(p.pop("_r5d", 0) - avg[1], 6)

    logger.info(
        f"[retrain/universal] {len(per_stock_payloads)} payloads built, "
        f"{len(skipped)} skipped, {len(sector_avg)} sectors. Starting batch prep..."
    )

    # ?? 6. Batch prep ?????Modal prep_universal_batch ????????????????????
    BATCH_SIZE = 500
    batches = [
        per_stock_payloads[i:i + BATCH_SIZE]
        for i in range(0, len(per_stock_payloads), BATCH_SIZE)
    ]
    batch_count = len(batches)
    # P0-3: guard log ??batch_count < 2 is unexpected for full-market retrain (should be 4-5)
    if batch_count < 2:
        logger.warning(
            f"[retrain/universal] ?? batch_count={batch_count} unexpectedly low "
            f"(payloads={len(per_stock_payloads)}, skipped={len(skipped)}, limit={req.limit}). "
            f"Verify D1 prices availability."
        )
    prep_results: list[dict] = []

    # Shared data: pass once per batch, not per stock (saves ~2.5GB memory)
    shared_history = asdict(market_env).get("history", {})
    # per_stock_ts: convert int keys to str for JSON serialization
    ps_ts_str = {str(k): v for k, v in per_stock_ts_map.items()} if per_stock_ts_map else {}

    prep_concurrency = min(_universal_prep_concurrency(), max(1, batch_count))
    prep_semaphore = asyncio.Semaphore(prep_concurrency)

    async def _run_prep_batch(idx: int, batch_payloads: list[dict]) -> dict:
        async with prep_semaphore:
            # Only include per_stock_ts for stocks in this batch.
            batch_stock_ids = {str(p["stock_id"]) for p in batch_payloads}
            batch_ps_ts = {k: v for k, v in ps_ts_str.items() if k in batch_stock_ids}
            logger.info(
                f"[retrain/universal] Prep batch {idx}/{batch_count} "
                f"({len(batch_payloads)} stocks, {len(batch_ps_ts)} with per_stock_ts, "
                f"concurrency={prep_concurrency})"
            )
            prep_payload = {
                "payloads": batch_payloads,
                "barrier_params": barrier_params,
                "batch_index": idx,
                "shared_market_history": shared_history,
                "per_stock_ts_map": batch_ps_ts,
                "gcs_prefix": prep_output_gcs_prefix if req.prep_only else "universal",
            }
            if active_features:
                prep_payload["active_features"] = active_features
            result = await prep_universal_batch(prep_payload)
            if not isinstance(result, dict):
                return {"batch_index": idx, "error": f"invalid prep result type: {type(result).__name__}"}
            result.setdefault("batch_index", idx)
            return result

    prep_task_results = await asyncio.gather(
        *(_run_prep_batch(idx, batch_payloads) for idx, batch_payloads in enumerate(batches)),
        return_exceptions=True,
    )
    for idx, result in enumerate(prep_task_results):
        if isinstance(result, Exception):
            result = {"batch_index": idx, "error": str(result)}
        prep_results.append(result)
        if result.get("error"):
            logger.warning(f"[retrain/universal] Batch {idx} error: {result['error']}")

    total_rows = sum(r.get("rows", 0) for r in prep_results)
    logger.info(
        f"[retrain/universal] Prep done: {batch_count} batches, "
        f"concurrency={prep_concurrency}, {total_rows} total rows"
    )
    _upsert_retrain_status(
        run_id,
        status="prep_complete",
        summary={
            "lock_key": lock_key,
            "run_date": run_date,
            "is_monthly": is_monthly,
            "batch_count": batch_count,
            "prep_concurrency": prep_concurrency,
            "dataset_snapshot": dataset_snapshot_info,
            "timesfm_l175_feature_release": timesfm_l175_history_summary,
            "total_prep_rows": total_rows,
            "stocks_sent": len(per_stock_payloads),
            "stocks_skipped": len(skipped),
        },
        downstream_notes="await_orchestrator_dispatch",
    )

    if total_rows < 10000:
        # Abort before orchestrator spawn ??release lock so next retry can run.
        logger.warning(f"[retrain/universal] Aborting: total_rows={total_rows} < 10000; releasing lock")
        retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
        _upsert_retrain_status(
            run_id,
            status="prep_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "batch_count": batch_count,
                "prep_concurrency": prep_concurrency,
                "dataset_snapshot": dataset_snapshot_info,
                "timesfm_l175_feature_release": timesfm_l175_history_summary,
                "total_prep_rows": total_rows,
            },
            downstream_notes="aborted_before_orchestrator",
        )
        return {
            "error": f"Total prep rows {total_rows} < 10000, aborting train",
            "prep_results": prep_results,
            "run_id": run_id,
            "lock_key": lock_key,
        }

    # ?? 7. Flow B: Modal orchestrator (selection ??train ??SHAP) ??????????????
    # Cloud Run 閫貊銝甈?Modal retrain_orchestrator嚗??Ｗ??Modal ?批???
    if req.prep_only:
        from google.cloud import storage as _prep_storage

        prep_bucket = _prep_storage.Client().bucket(
            os.environ.get("GCS_BUCKET_NAME", "stockvision-models")
        )
        feature_names_path = f"{prep_output_gcs_prefix}/prep/feature_names.json"
        expected_paths = [
            f"{prep_output_gcs_prefix}/prep/batch_{idx}.npz"
            for idx in range(batch_count)
        ]
        missing_paths = [
            path for path in [feature_names_path, *expected_paths]
            if not prep_bucket.blob(path).exists()
        ]
        if missing_paths:
            retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
            return {
                "status": "rejected",
                "error": "prep_only_output_inventory_incomplete",
                "missing_paths": missing_paths,
                "run_id": run_id,
            }
        prep_checksums = {
            path: hashlib.sha256(prep_bucket.blob(path).download_as_bytes()).hexdigest()
            for path in expected_paths
        }
        receipt = {
            "schema_version": "active8-immutable-feature-prep-receipt-v1",
            "status": "ready",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "run_id": run_id,
            "business_date": run_date,
            "output_gcs_prefix": prep_output_gcs_prefix,
            "batch_count": batch_count,
            "batch_rows": [int(row.get("rows") or 0) for row in prep_results],
            "output_rows": total_rows,
            "output_checksums": prep_checksums,
            "feature_names_path": feature_names_path,
            "training_dispatched": False,
        }
        unsigned = json.dumps(receipt, sort_keys=True).encode("utf-8")
        receipt["receipt_checksum"] = hashlib.sha256(unsigned).hexdigest()
        receipt_path = f"{prep_output_gcs_prefix}/prep/immutable_receipt.json"
        prep_bucket.blob(receipt_path).upload_from_string(
            json.dumps(receipt, sort_keys=True, indent=2),
            content_type="application/json",
        )
        retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
        _upsert_retrain_status(
            run_id,
            status="completed",
            summary=receipt,
            downstream_notes="prep_only_complete_no_training_dispatched",
        )
        return {**receipt, "receipt_path": receipt_path}
    from services.modal_client import retrain_orchestrator
    followup_webhook_url = _build_followup_webhook_url(request)
    sequence_required = (
        any(group in {"dlinear", "patchtst"} for group in (req.train_model_groups or []))
        or any(target in {"PatchTST", "iTransformer"} for target in (req.artifact_lifecycle_targets or []))
    )
    sequence_gcs_prefix = (req.sequence_gcs_prefix or "").strip().rstrip("/")
    if not sequence_gcs_prefix and sequence_required and long_history_sequence_enabled():
        sequence_gcs_prefix = long_history_sequence_prefix()
    sequence_batch_count = req.sequence_batch_count
    if sequence_gcs_prefix and not sequence_batch_count:
        sequence_batch_count = _infer_sequence_batch_count(sequence_gcs_prefix, batch_count)
    sequence_contract: dict[str, object] = {}
    if sequence_gcs_prefix:
        sequence_contract["sequence_gcs_prefix"] = sequence_gcs_prefix
        sequence_contract["sequence_batch_count"] = int(sequence_batch_count or batch_count)
    for key in ("sequence_seq_len", "dlinear_seq_len", "patchtst_seq_len", "itransformer_seq_len"):
        value = getattr(req, key, None)
        if value:
            sequence_contract[key] = int(value)
    logger.info(f"[retrain/universal] Flow B: spawning Modal orchestrator "
                f"(batches={batch_count}, monthly={is_monthly}, sequence={sequence_contract or None}, "
                f"followup={followup_webhook_url})")
    try:
        orchestrator_result = await retrain_orchestrator(
            payload={
                "batch_count": batch_count,
                "is_monthly": is_monthly,
                "candidate_type": req.candidate_type,
                "drift_target_models": req.drift_target_models,
                "drift_target_families": req.drift_target_families,
                "train_model_groups": req.train_model_groups,
                "artifact_lifecycle_targets": req.artifact_lifecycle_targets,
                "artifact_lifecycle_contracts": req.artifact_lifecycle_contracts,
                "artifact_lifecycle_only": req.artifact_lifecycle_only,
                "register_challengers": req.register_challengers,
                "promotion_allowed_models": req.promotion_allowed_models,
                "oof_promotion_evidence": req.oof_promotion_evidence,
                "selection_params": training_policy.feature_selection_params(),
                "training_policy": training_policy.to_dict(),
                "dataset_snapshot": dataset_snapshot_info,
                "timesfm_l175_feature_release": timesfm_l175_history_summary,
                "followup_webhook_url": followup_webhook_url,
                "gcs_prefix": "universal",
                "run_id": run_id,
                "lock_key": lock_key,
                "run_date": run_date,
                **sequence_contract,
            },
            fire_and_forget=True,  # Cloud Run 銝? Modal 摰?嚗??3600s timeout
        )
    except Exception as orch_err:
        # Orchestrator dispatch failed ??release lock so the next cron retry
        # is not blocked by our aborted attempt (matches pre-GCS behavior).
        logger.error(f"[retrain/universal] orchestrator dispatch failed: {orch_err}; releasing lock")
        retrain_lock.release(lock_key, expected_metadata={"run_id": run_id})
        _upsert_retrain_status(
            run_id,
            status="dispatch_failed",
            summary={
                "lock_key": lock_key,
                "run_date": run_date,
                "batch_count": batch_count,
                "prep_concurrency": prep_concurrency,
                "dataset_snapshot": dataset_snapshot_info,
                "timesfm_l175_feature_release": timesfm_l175_history_summary,
                "total_prep_rows": total_rows,
                "error": str(orch_err),
            },
            downstream_notes="orchestrator_dispatch_error",
        )
        raise

    # ?? Lock stays held until the Modal followup releases it. The long TTL is
    # only a safety net if the callback is lost or the orchestrator crashes.
    logger.info(f"[retrain/universal] Lock held: {lock_key} (orchestrator dispatched)")
    _upsert_retrain_status(
        run_id,
        status="orchestrator_dispatched",
        summary={
            "lock_key": lock_key,
            "run_date": run_date,
            "is_monthly": is_monthly,
            "batch_count": batch_count,
            "prep_concurrency": prep_concurrency,
            "sequence_contract": sequence_contract or None,
            "dataset_snapshot": dataset_snapshot_info,
            "timesfm_l175_feature_release": timesfm_l175_history_summary,
            "total_prep_rows": total_rows,
            "followup_webhook_url": followup_webhook_url,
            "stocks_sent": len(per_stock_payloads),
            "stocks_skipped": len(skipped),
            "orchestrator_result": orchestrator_result,
        },
        downstream_notes="await_modal_followup",
    )

    elapsed = round(time.time() - t0, 2)
    logger.info(f"[retrain/universal] Done in {elapsed}s")

    return {
        "trigger_elapsed_s": elapsed,
        "stocks_sent": len(per_stock_payloads),
        "stocks_skipped": len(skipped),
        "skipped_sample": skipped[:20],
        "batch_count": batch_count,
        "prep_concurrency": prep_concurrency,
        "sequence_contract": sequence_contract or None,
        "dataset_snapshot": dataset_snapshot_info,
        "timesfm_l175_feature_release": timesfm_l175_history_summary,
        "total_prep_rows": total_rows,
        "prep_results": prep_results,
        "orchestrator_result": orchestrator_result,
        "run_id": run_id,
        "lock_key": lock_key,
        "followup_webhook_url": followup_webhook_url,
    }
