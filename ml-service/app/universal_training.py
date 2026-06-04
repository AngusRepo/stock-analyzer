"""
Universal training use-case boundary.

This module owns the public surface for universal prep/train/audit flows.
Callers should stop importing the FastAPI route module directly. Implementations
can be moved here incrementally without changing Modal or controller call sites.
"""

import io
import json
import os
import time
import hashlib
from datetime import datetime

import numpy as np
import polars as pl
from joblib import load as joblib_load
from pydantic import BaseModel

from .artifact_contract import (
    build_model_artifact_metadata,
    build_training_run_manifest,
    now_utc_iso,
    validate_model_artifact_metadata,
)
from .artifact_runtime_versions import load_joblib_with_version_warnings, sklearn_version_report
from .model_store import _get_bucket, save_model
from .training_policy import (
    TREE_MODEL_NAMES,
    ValidationGovernancePolicy,
    build_model_feature_policy_metadata,
    generated_model_pool_version,
    should_force_full_feature_pool,
    should_force_model_pool_challenger,
)
from .training_finalizer import build_oos_artifact_path, derive_oos_artifact_group
from .gcs_batch_io import download_existing_blobs


class UniversalPrepRequest(BaseModel):
    """Universal batch prep request."""

    payloads: list[dict]
    barrier_params: dict = {}
    batch_index: int = 0
    shared_market_history: dict = {}
    per_stock_ts_map: dict = {}
    active_features: list[str] | None = None
    gcs_prefix: str = "universal"


class UniversalTrainRequest(BaseModel):
    """Universal training request."""

    batch_count: int = 5
    models_filter: list[str] | None = None
    skip_feature_pool: bool = False
    train_start: str | None = None
    train_end: str | None = None
    test_start: str | None = None
    test_end: str | None = None
    gcs_prefix: str | None = None
    window_id: int | None = None
    skip_weekly_backup: bool = False
    feature_pool_path: str | None = None
    followup_webhook_url: str | None = None
    output_model_version: str | None = None
    register_challengers: bool = False
    embargo_base_days: int | None = None
    embargo_pct: float | None = None
    max_embargo_days: int | None = None
    cpcv_n_groups: int | None = None
    cpcv_n_test_groups: int | None = None
    cpcv_min_train_groups: int | None = None
    enable_model_cpcv: bool = True
    model_cpcv_policy: dict | None = None
    training_run_suffix: str | None = None


def _ic_summary_value(metrics: dict) -> float | None:
    value = metrics.get("ic")
    if value is None:
        value = metrics.get("oos_ic")
    if value is None:
        value = metrics.get("ic_4w_avg")
    return value


def _controller_callback_token() -> str:
    return (
        os.environ.get("ML_CONTROLLER_TOKEN")
        or os.environ.get("INTERNAL_TOKEN")
        or os.environ.get("ML_CONTROLLER_SECRET")
        or os.environ.get("STOCKVISION_AUTH_TOKEN")
        or ""
    )


def _date_min_max_for_manifest(dates: np.ndarray) -> tuple[str | None, str | None]:
    """Return stable manifest date bounds without NumPy string min/max.

    NumPy 2.x does not support min/max reductions on string dtypes. Monthly
    retrain uses this path after model training; failing here incorrectly marks
    a successful train as an orchestrator error.
    """

    if dates is None or len(dates) == 0:
        return None, None
    values = [str(value) for value in np.asarray(dates).reshape(-1).tolist() if str(value)]
    if not values:
        return None, None
    values.sort()
    return values[0], values[-1]


def normalize_universal_lifecycle_request(
    req: UniversalTrainRequest,
    *,
    gcs_prefix: str,
    walk_forward_mode: bool,
    now_fn=now_utc_iso,
) -> UniversalTrainRequest:
    """Ensure production universal retrain enters model_pool lifecycle.

    Universal production retrain must not silently overwrite flat-file artifacts.
    If an older caller omits output_model_version, generate a challenger version
    so the artifact can be audited/promoted by model_pool instead of bypassing it.
    """
    if not should_force_model_pool_challenger(
        gcs_prefix=gcs_prefix,
        walk_forward_mode=walk_forward_mode,
        output_model_version=req.output_model_version,
    ):
        return req

    version = generated_model_pool_version(now_fn())
    update = {
        "output_model_version": version,
        "register_challengers": True,
    }
    if hasattr(req, "model_copy"):
        return req.model_copy(update=update)
    return req.copy(update=update)


def _save_universal_versioned_model(
    *,
    bucket,
    model_name: str,
    model,
    feature_names: list[str],
    sample_count: int,
    version: str,
    feature_medians: dict[str, float],
    extra_metadata: dict | None = None,
) -> str:
    """Save a universal model as a model_pool challenger artifact."""
    import joblib

    folder = model_name.lower().replace("-", "_")
    model_path = f"universal/{folder}/{version}.joblib"
    meta_path = f"universal/{folder}/metadata_{version}.json"

    buf = io.BytesIO()
    joblib.dump(model, buf)
    buf.seek(0)
    bucket.blob(model_path).upload_from_file(buf, content_type="application/octet-stream")

    artifact_sha = "sha256:" + hashlib.sha256(buf.getvalue()).hexdigest()
    extra = dict(extra_metadata or {})
    extra.update({
        "stock_id": 0,
        "model_pool_version": version,
    })
    training_run_id = str(
        extra.get("training_run_id")
        or extra.get("run_id")
        or f"universal:{model_name}:{version}"
    )
    meta = build_model_artifact_metadata(
        model_name=model_name,
        feature_names=feature_names,
        feature_medians=feature_medians or {},
        sample_count=sample_count,
        training_run_id=training_run_id,
        artifact_payload={"joblib_sha256": artifact_sha},
        gcs_prefix="universal",
        extra_metadata=extra,
    )
    validate_model_artifact_metadata(meta)
    bucket.blob(meta_path).upload_from_string(
        json.dumps(meta, ensure_ascii=False),
        content_type="application/json",
    )
    return model_path


def _register_challenger_safe(
    model_name: str,
    version: str,
    *,
    model_cpcv: dict | None = None,
    feature_policy_version: str | None = None,
    feature_policy: dict | None = None,
) -> dict:
    try:
        from .model_pool import register_challenger

        pool = register_challenger(model_name, version, save=True, model_cpcv=model_cpcv)
        return {
            "status": "registered",
            "version": version,
            "pool_updated": bool(pool),
            "model_cpcv": model_cpcv,
            "feature_policy_version": feature_policy_version,
            "feature_policy": feature_policy,
        }
    except Exception as exc:
        return {
            "status": "error",
            "version": version,
            "error": str(exc),
            "model_cpcv": model_cpcv,
            "feature_policy_version": feature_policy_version,
            "feature_policy": feature_policy,
        }


def build_validation_split_metadata(
    validation_policy: dict[str, object],
    *,
    enable_model_cpcv: bool,
) -> dict[str, object]:
    from .purged_cv import cpcv_split_count

    split_count = cpcv_split_count(
        n_groups=int(validation_policy["cpcv_n_groups"]),
        n_test_groups=int(validation_policy["cpcv_n_test_groups"]),
    )
    model_count = len(TREE_MODEL_NAMES)
    return {
        "policy_schema_version": "validation-governance-policy-v1",
        "policy": validation_policy,
        "model_cpcv_cost_estimate": {
            "enabled": bool(enable_model_cpcv),
            "supported_models": list(TREE_MODEL_NAMES),
            "model_count": model_count,
            "cpcv_split_count": split_count,
            "baseline_fit_count": model_count,
            "additional_fit_count": model_count * split_count,
            "total_fit_count": model_count * (1 + split_count),
            "tree_fit_multiplier": 1 + split_count,
            "optional_family_adapters": {},
            "artifact_required_targets": {
                "TabM": {"additional_fit_count": 0, "cost_note": "formal L3 slot; artifact-backed serving uses registered artifacts, not this tree retrain job"},
                "GNN": {"additional_fit_count": 0, "cost_note": "formal L3 slot; graph artifact registration owns training/serving readiness"},
                "iTransformer": {"additional_fit_count": 0, "cost_note": "formal L3 sequence slot; artifact-backed serving is owned by sequence artifact registry"},
                "TimesFM": {"additional_fit_count": 0, "cost_note": "formal L3 foundation slot; forecast artifact registration owns serving readiness"},
            },
            "sequence_models": {
                "DLinear": {
                    "default_method": "sequence_oos_fold_rank_ic",
                    "full_cpcv_method": "purged_cpcv_sequence_rank_ic",
                    "enabled_by_policy": "model_cpcv_policy.family_adapters.DLinear.enabled",
                    "additional_fit_count": split_count,
                    "cost_note": "Default governance records the existing OOS holdout evidence; full sequence CPCV retrains one fold per split only when explicitly enabled.",
                },
                "PatchTST": {
                    "default_method": "sequence_oos_fold_rank_ic",
                    "full_cpcv_method": "purged_cpcv_sequence_rank_ic",
                    "enabled_by_policy": "model_cpcv_policy.family_adapters.PatchTST.enabled",
                    "additional_fit_count": split_count,
                    "cost_note": "Default governance records the existing OOS holdout evidence; full sequence CPCV retrains one fold per split only when explicitly enabled.",
                },
            },
            "unsupported_until_family_adapter": {
                "sequence_models": [],
                "reason": "No known production alpha model lacks a validation owner; sequence models use OOS evidence by default and explicit full CPCV when enabled.",
            },
            "cost_formula": (
                "tree_stage_cost_with_cpcv ~= "
                "tree_stage_cost_without_cpcv * (1 + cpcv_split_count)"
            ),
        },
    }


def build_non_tree_model_cpcv_gap_evidence(
    trained_model_names: list[str],
    *,
    validation_split_metadata: dict[str, object],
) -> dict[str, dict]:
    from .model_validation import build_model_cpcv_adapter_missing_evidence

    family_by_model: dict[str, tuple[str, str]] = {}
    cost_estimate = (
        validation_split_metadata.get("model_cpcv_cost_estimate")
        if isinstance(validation_split_metadata, dict)
        else {}
    )
    evidence: dict[str, dict] = {}
    for model_name in trained_model_names:
        if model_name in TREE_MODEL_NAMES or model_name not in family_by_model:
            continue
        family, adapter = family_by_model[model_name]
        evidence[model_name] = build_model_cpcv_adapter_missing_evidence(
            model=model_name,
            family=family,
            adapter=adapter,
            cost_estimate=dict(cost_estimate or {}),
        )
    return evidence


def model_cpcv_family_adapter_enabled(model_name: str, policy: dict | None) -> bool:
    if not isinstance(policy, dict):
        return False
    from .training_policy import MODEL_FEATURE_POLICIES
    if str(model_name) not in MODEL_FEATURE_POLICIES:
        return False
    adapters = policy.get("family_adapters")
    if not isinstance(adapters, dict):
        return False
    cfg = adapters.get(model_name)
    return bool(isinstance(cfg, dict) and cfg.get("enabled") is True)


def _load_active_model_pool_joblib(bucket, model_name: str) -> tuple[object, dict]:
    """Load the active universal artifact through model_pool.json only."""
    from .model_pool import get_active_path, get_active_version, gcs_metadata_path_for, load_pool

    pool = load_pool()
    if not pool:
        raise RuntimeError("model_pool.json unavailable")
    path = get_active_path(model_name, pool=pool)
    if not path:
        raise RuntimeError(f"{model_name} has no active model_pool artifact")
    blob = bucket.blob(path)
    if not blob.exists():
        raise RuntimeError(f"{model_name} active artifact missing: {path}")

    buf = io.BytesIO()
    blob.download_to_file(buf)
    buf.seek(0)
    artifact = load_joblib_with_version_warnings(buf, artifact_name=path)

    metadata: dict = {}
    version = get_active_version(model_name, pool=pool)
    if version:
        meta_blob = bucket.blob(gcs_metadata_path_for(model_name, version))
        if meta_blob.exists():
            metadata = json.loads(meta_blob.download_as_text())
            metadata["runtime_version_report"] = sklearn_version_report(metadata)
    return artifact, metadata


def _save_oos_rank_artifact(
    *,
    bucket,
    req: UniversalTrainRequest,
    oos_rank_predictions: dict[str, np.ndarray],
    y_test: np.ndarray,
    dates_test: np.ndarray,
    feature_names: list[str],
) -> dict | None:
    """Persist split-job OOS predictions for the final rank-stacking reducer."""

    if not req.output_model_version or not oos_rank_predictions:
        return None

    group = derive_oos_artifact_group(req.models_filter)
    path = build_oos_artifact_path(req.gcs_prefix or "universal", req.output_model_version, group)
    model_names = list(oos_rank_predictions.keys())
    pred_matrix = np.vstack([
        np.clip(np.asarray(oos_rank_predictions[name], dtype=float).reshape(-1), 0.0, 1.0)
        for name in model_names
    ])

    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        group=np.array(group),
        version=np.array(req.output_model_version),
        model_names=np.asarray(model_names, dtype=object),
        pred_matrix=pred_matrix,
        y_test=np.asarray(y_test, dtype=float).reshape(-1),
        dates_test=np.asarray(dates_test).reshape(-1),
        feature_names=np.asarray(feature_names, dtype=object),
    )
    buf.seek(0)
    bucket.blob(path).upload_from_file(buf, content_type="application/octet-stream")
    return {
        "path": path,
        "group": group,
        "version": req.output_model_version,
        "models": model_names,
        "samples": int(len(y_test)),
    }


def prep_universal_batch(req: UniversalPrepRequest) -> dict:
    import json

    from .features import (
        FEATURE_COLS,
        build_feature_matrix,
        compute_cross_sectional_rank,
        sanitize_feature_frame,
    )
    from .sequence_training import build_sequence_record

    t0 = time.time()
    payloads = req.payloads
    shared_history = req.shared_market_history or {}
    ps_ts_map = req.per_stock_ts_map or {}

    all_dfs = []
    sequence_series: list[list[float]] = []
    sequence_records: list[dict] = []
    skipped = 0
    for payload in payloads:
        prices_data = payload.get("prices", [])
        if len(prices_data) < 60:
            skipped += 1
            continue
        try:
            chips_input = payload.get("chips", [])
            market_upper = payload.get("market", "TW").upper()
            if market_upper in ("US", "NYSE", "NASDAQ"):
                chips_input = []
            me = payload.get("market_env") or {}
            if shared_history and "history" not in me:
                me["history"] = shared_history
            stock_id_str = str(payload.get("stock_id", ""))
            if ps_ts_map and stock_id_str in ps_ts_map:
                me["per_stock_ts"] = ps_ts_map[stock_id_str]
            df = build_feature_matrix(
                prices_data,
                payload.get("indicators", []),
                chips_input,
                payload.get("sentiment_scores", []),
                me,
                req.barrier_params or None,
                payload.get("stock_meta"),
            )
            if "date" not in df.columns and len(prices_data) > 0:
                dates = [p.get("date", "") for p in prices_data]
                date_list = dates[-len(df):] if len(dates) >= len(df) else dates + [""] * (len(df) - len(dates))
                df = df.with_columns(pl.Series("_date", date_list))
            elif "date" in df.columns:
                df = df.with_columns(pl.col("date").cast(pl.Utf8).alias("_date"))
            else:
                df = df.with_columns(pl.lit("").alias("_date"))
            all_dfs.append(df)
            seq_record = build_sequence_record(
                symbol=str(payload.get("symbol") or payload.get("stock_id") or ""),
                market_type=str(payload.get("market") or "TW"),
                prices_data=prices_data,
                min_len=65,
            )
            if seq_record is not None:
                sequence_records.append(seq_record)
                sequence_series.append(seq_record["close"])
        except Exception as exc:
            skipped += 1
            print(f"[PrepBatch] Skip stock: {exc}")

    if not all_dfs:
        return {"batch_index": req.batch_index, "rows": 0, "skipped": skipped, "error": "no valid stocks"}

    pooled = pl.concat(all_dfs, how="diagonal_relaxed")
    pooled = compute_cross_sectional_rank(pooled, return_col="target_5d", date_col="_date")
    print(
        f"[PrepBatch] Cross-sectional rank: mean={pooled['target_rank'].mean():.3f}, "
        f"nulls={pooled['target_rank'].null_count()}"
    )

    active_filter = req.active_features
    if active_filter:
        keep_cols = [c for c in active_filter if c in pooled.columns]
        drop_cols = [c for c in FEATURE_COLS if c in pooled.columns and c not in keep_cols]
        if drop_cols:
            pooled = pooled.drop(drop_cols)
            print(f"[PrepBatch] Feature pool filter: kept {len(keep_cols)}, dropped {len(drop_cols)}")

    available = [c for c in FEATURE_COLS if c in pooled.columns]
    select_cols = available + ["target_rank", "_date"]
    if "target_5d" in pooled.columns:
        select_cols.append("target_5d")
    if "target_dir" in pooled.columns:
        select_cols.append("target_dir")
    required_targets = ["target_rank"]
    if "target_5d" in select_cols:
        required_targets.append("target_5d")
    if "target_dir" in select_cols:
        required_targets.append("target_dir")
    raw_selected = pooled.select(select_cols)
    missingness_by_feature = {
        col: float(raw_selected[col].null_count() / max(raw_selected.height, 1))
        for col in available
    }
    df_clean, cleaning_report = sanitize_feature_frame(
        raw_selected,
        feature_cols=available,
        required_target_cols=required_targets,
    )
    if cleaning_report.get("features") or cleaning_report.get("target_rows_dropped"):
        print(f"[PrepBatch] Feature cleaning report: {cleaning_report}")
    X = df_clean.select(available).to_numpy()
    y = df_clean["target_rank"].to_numpy()
    dates_arr = df_clean["_date"].to_numpy()
    sectors_arr = (
        df_clean["sector_encoded"].to_numpy()
        if "sector_encoded" in df_clean.columns
        else np.array(["unknown"] * len(df_clean), dtype=object)
    )
    missingness_rates_arr = np.array([missingness_by_feature.get(name, 0.0) for name in available], dtype=float)
    feature_names = available
    assert len(X) == len(y) == len(dates_arr) == len(sectors_arr), (
        f"prep alignment broken: X={len(X)} y={len(y)} dates={len(dates_arr)} sectors={len(sectors_arr)}"
    )

    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    gcs_prefix = req.gcs_prefix.rstrip("/")
    buf = io.BytesIO()
    np.savez_compressed(
        buf,
        X=X,
        y=y,
        dates=dates_arr,
        sectors=sectors_arr,
        missingness_rates=missingness_rates_arr,
        series_close=np.array(sequence_series, dtype=object),
        sequence_records=np.array(sequence_records, dtype=object),
    )
    buf.seek(0)
    blob = bucket.blob(f"{gcs_prefix}/prep/batch_{req.batch_index}.npz")
    blob.upload_from_file(buf, content_type="application/octet-stream")

    if req.batch_index == 0:
        meta_blob = bucket.blob(f"{gcs_prefix}/prep/feature_names.json")
        meta_blob.upload_from_string(json.dumps(feature_names), content_type="application/json")
    report_blob = bucket.blob(f"{gcs_prefix}/prep/cleaning_report_batch_{req.batch_index}.json")
    report_blob.upload_from_string(
        json.dumps(cleaning_report, ensure_ascii=False),
        content_type="application/json",
    )

    elapsed = round(time.time() - t0, 1)
    print(
        f"[PrepBatch] batch_{req.batch_index}: {len(all_dfs)} stocks -> {len(X)} rows, "
        f"skipped {skipped}, {elapsed}s"
    )
    return {
        "batch_index": req.batch_index,
        "stocks_pooled": len(all_dfs),
        "rows": len(X),
        "features": len(feature_names),
        "series_count": len(sequence_series),
        "sequence_record_count": len(sequence_records),
        "cleaning_report": cleaning_report,
        "gcs_prefix": gcs_prefix,
        "skipped": skipped,
        "elapsed_s": elapsed,
    }


def train_universal_from_gcs(req: UniversalTrainRequest) -> dict:
    import json

    t0 = time.time()
    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")

    gcs_prefix = (req.gcs_prefix or "universal").rstrip("/")
    all_X, all_y, all_dates, all_missingness_rates = [], [], [], []
    gcs_io = {"prep_objects": 0, "prep_bytes": 0, "download_elapsed_s": 0.0}
    gcs_t0 = time.time()
    batch_keys = [f"{gcs_prefix}/prep/batch_{i}.npz" for i in range(req.batch_count)]
    for key, raw in download_existing_blobs(bucket, batch_keys, max_workers=4):
        if raw is None:
            print(f"[TrainUniversal] {key.split('/')[-1]} not found, skipping")
            continue
        gcs_io["prep_objects"] += 1
        gcs_io["prep_bytes"] += len(raw)
        buf = io.BytesIO(raw)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
        if "missingness_rates" in data.files:
            all_missingness_rates.append(np.asarray(data["missingness_rates"], dtype=float))
        print(f"[TrainUniversal] {key.split('/')[-1]}: {len(data['X'])} rows loaded")
    gcs_io["download_elapsed_s"] = round(time.time() - gcs_t0, 3)

    if not all_X:
        raise ValueError("No prep batches found in GCS")

    X = np.concatenate(all_X, axis=0)
    y = np.concatenate(all_y, axis=0)
    dates_arr = np.concatenate(all_dates, axis=0)

    fn_blob = bucket.blob(f"{gcs_prefix}/prep/feature_names.json")
    feature_names = json.loads(fn_blob.download_as_text()) if fn_blob.exists() else [f"f{i}" for i in range(X.shape[1])]
    prep_missingness_rates = (
        np.nan_to_num(np.vstack(all_missingness_rates), nan=0.0, posinf=0.0, neginf=0.0).mean(axis=0)
        if all_missingness_rates and all(len(r) == len(feature_names) for r in all_missingness_rates)
        else np.zeros(len(feature_names), dtype=float)
    )

    feature_pool_selection_evidence: dict = {}
    feature_pool_model_policies: dict = {}
    feature_pool_contract: dict = {}
    pool_path = req.feature_pool_path or "universal/feature_pool.json"
    try:
        pool_blob = bucket.blob(pool_path)
        if pool_blob.exists():
            feature_pool_contract = json.loads(pool_blob.download_as_text())
            feature_pool_selection_evidence = dict(feature_pool_contract.get("selection_evidence") or {})
            feature_pool_model_policies = dict(feature_pool_contract.get("model_feature_policies") or {})
    except Exception as exc:
        print(f"[TrainUniversal] Feature pool contract load failed: {exc}")

    force_full_feature_pool = should_force_full_feature_pool(req.models_filter)
    effective_skip_feature_pool = req.skip_feature_pool or force_full_feature_pool
    if effective_skip_feature_pool:
        reason = "skip_feature_pool=True"
        if force_full_feature_pool and not req.skip_feature_pool:
            reason = f"models_filter={req.models_filter} -> full-feature policy"
        print(f"[TrainUniversal] {reason} -> using all {len(feature_names)} features")
    else:
        try:
            if feature_pool_contract:
                active = feature_pool_contract.get("tree_active") or feature_pool_contract.get("active", [])
                if active:
                    keep_idx = [i for i, name in enumerate(feature_names) if name in set(active)]
                    if keep_idx:
                        orig_count = len(feature_names)
                        X = X[:, keep_idx]
                        feature_names = [feature_names[i] for i in keep_idx]
                        prep_missingness_rates = prep_missingness_rates[keep_idx]
                        print(f"[TrainUniversal] Feature pool filter ({pool_path}): {len(keep_idx)} active (from {orig_count} total)")
                    else:
                        print(f"[TrainUniversal] Feature pool {pool_path} has {len(active)} active but none match prep columns, using all")
                else:
                    print(f"[TrainUniversal] Feature pool {pool_path} empty, using all features")
            else:
                print(f"[TrainUniversal] No {pool_path}, using all features")
        except Exception as exc:
            print(f"[TrainUniversal] Feature pool load failed (using all): {exc}")

    print(f"[TrainUniversal] Total: {len(X)} rows x {len(feature_names)} features")

    walk_forward_mode = (
        req.train_start is not None
        and req.train_end is not None
        and req.test_start is not None
        and req.test_end is not None
    )
    original_output_version = req.output_model_version
    req = normalize_universal_lifecycle_request(
        req,
        gcs_prefix=gcs_prefix,
        walk_forward_mode=walk_forward_mode,
    )
    if req.output_model_version and not original_output_version and gcs_prefix == "universal" and not walk_forward_mode:
        print(
            "[TrainUniversal] Lifecycle guard: generated challenger version "
            f"{req.output_model_version}; flat-file production overwrite disabled"
        )

    validation_policy = ValidationGovernancePolicy.from_env().to_split_params(
        {
            "embargo_base_days": req.embargo_base_days,
            "embargo_pct": req.embargo_pct,
            "max_embargo_days": req.max_embargo_days,
            "cpcv_n_groups": req.cpcv_n_groups,
            "cpcv_n_test_groups": req.cpcv_n_test_groups,
            "cpcv_min_train_groups": req.cpcv_min_train_groups,
        }
    )
    validation_split_metadata: dict[str, object] = build_validation_split_metadata(
        validation_policy,
        enable_model_cpcv=req.enable_model_cpcv,
    )
    if walk_forward_mode:
        print(
            f"[TrainUniversal] Walk-forward mode: train={req.train_start}..{req.train_end} "
            f"test={req.test_start}..{req.test_end} window_id={req.window_id}"
        )
        dates_str = dates_arr.astype(str)
        train_mask = (dates_str >= req.train_start) & (dates_str <= req.train_end)
        test_mask = (dates_str >= req.test_start) & (dates_str <= req.test_end)
        X_train, y_train, dates_train = X[train_mask], y[train_mask], dates_arr[train_mask]
        X_test, y_test, dates_test = X[test_mask], y[test_mask], dates_arr[test_mask]
        print(f"[TrainUniversal] Walk-forward split: train={len(X_train)}, test={len(X_test)}")
        if len(X_train) < 500:
            raise ValueError(
                f"Walk-forward train window {req.train_start}..{req.train_end} has only "
                f"{len(X_train)} samples (<500 minimum)"
            )
        if len(X_test) < 100:
            raise ValueError(
                f"Walk-forward test window {req.test_start}..{req.test_end} has only "
                f"{len(X_test)} samples (<100 minimum)"
            )
        validation_split_metadata = {
            **validation_split_metadata,
            "method": "walk_forward_explicit",
            "window_id": req.window_id,
            "train_range": [req.train_start, req.train_end],
            "test_range": [req.test_start, req.test_end],
            "purged": False,
            "cpcv_available": True,
            "cpcv_default": {
                "method": "combinatorial_purged_cv",
                "n_groups": validation_policy["cpcv_n_groups"],
                "n_test_groups": validation_policy["cpcv_n_test_groups"],
                "min_train_groups": validation_policy["cpcv_min_train_groups"],
            },
        }
    else:
        if len(X) < 1000:
            raise ValueError(f"Pooled rows below 1000 ({len(X)})")
        from .purged_cv import cpcv_split_count, dynamic_embargo_days, purged_train_test_split

        embargo_days = dynamic_embargo_days(
            len(np.unique(dates_arr)),
            base_days=int(validation_policy["embargo_base_days"]),
            embargo_pct=float(validation_policy["embargo_pct"]),
            max_days=int(validation_policy["max_embargo_days"]),
        )
        X_train, y_train, dates_train, X_test, y_test, dates_test = purged_train_test_split(
            X,
            y,
            dates_arr,
            test_ratio=0.2,
            embargo_days=embargo_days,
        )
        print(f"[TrainUniversal] Purged split: train={len(X_train)}, test={len(X_test)}, embargo={embargo_days}d")
        validation_split_metadata = {
            **validation_split_metadata,
            "method": "purged_holdout_dynamic_embargo",
            "purged": True,
            "embargo_days": embargo_days,
            "embargo_pct": validation_policy["embargo_pct"],
            "max_embargo_days": validation_policy["max_embargo_days"],
            "cpcv_available": True,
            "cpcv_default": {
                "method": "combinatorial_purged_cv",
                "n_groups": validation_policy["cpcv_n_groups"],
                "n_test_groups": validation_policy["cpcv_n_test_groups"],
                "min_train_groups": validation_policy["cpcv_min_train_groups"],
                "split_count": cpcv_split_count(
                    n_groups=int(validation_policy["cpcv_n_groups"]),
                    n_test_groups=int(validation_policy["cpcv_n_test_groups"]),
                ),
            },
        }

    results = {}
    trained_models: dict[str, object] = {}
    oos_rank_predictions: dict[str, np.ndarray] = {}
    model_cpcv_evidence_by_model: dict[str, dict] = {}
    _filter = set(req.models_filter) if req.models_filter else None
    _default_trainable_models = set(TREE_MODEL_NAMES)
    _allowed_trainable_models = set(TREE_MODEL_NAMES)

    def _should_train(name: str) -> bool:
        if name not in _allowed_trainable_models:
            return False
        if _filter is None:
            return name in _default_trainable_models
        return name in _filter

    class _SkipModel(Exception):
        pass

    from scipy.stats import spearmanr as _spearmanr

    def _oos_ic(preds: np.ndarray, y_actual: np.ndarray) -> float:
        if len(preds) < 10 or np.std(preds) < 1e-10 or np.std(y_actual) < 1e-10:
            return 0.0
        rho, _ = _spearmanr(preds, y_actual)
        return float(rho) if not np.isnan(rho) else 0.0

    try:
        if not _should_train("XGBoost"):
            raise _SkipModel()
        from xgboost import XGBRegressor

        xgb = XGBRegressor(
            n_estimators=300,
            max_depth=6,
            learning_rate=0.03,
            objective="reg:squarederror",
            subsample=0.8,
            colsample_bytree=0.8,
            eval_metric="rmse",
            random_state=42,
            verbosity=0,
            n_jobs=-1,
        )
        xgb.fit(X_train, y_train)
        preds = xgb.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["XGBoost"] = xgb
        oos_rank_predictions["XGBoost"] = np.clip(np.asarray(preds, dtype=float).reshape(-1), 0.0, 1.0)
        results["XGBoost"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] XGBoost IC={ic:.4f}")
    except _SkipModel:
        results["XGBoost"] = {"skipped": True}
    except Exception as exc:
        results["XGBoost"] = {"error": str(exc)}


    try:
        if not _should_train("ExtraTrees"):
            raise _SkipModel()
        from sklearn.ensemble import ExtraTreesRegressor

        et = ExtraTreesRegressor(
            n_estimators=300,
            max_depth=8,
            min_samples_split=10,
            min_samples_leaf=5,
            max_features="sqrt",
            bootstrap=True,
            random_state=42,
            n_jobs=-1,
        )
        et.fit(X_train, y_train)
        preds = et.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["ExtraTrees"] = et
        oos_rank_predictions["ExtraTrees"] = np.clip(np.asarray(preds, dtype=float).reshape(-1), 0.0, 1.0)
        results["ExtraTrees"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] ExtraTrees IC={ic:.4f}")
    except _SkipModel:
        results["ExtraTrees"] = {"skipped": True}
    except Exception as exc:
        results["ExtraTrees"] = {"error": str(exc)}

    try:
        if not _should_train("LightGBM"):
            raise _SkipModel()
        import lightgbm as lgb

        lgbm = lgb.LGBMRegressor(
            n_estimators=300,
            max_depth=6,
            learning_rate=0.03,
            objective="regression",
            num_leaves=63,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_samples=20,
            random_state=42,
            verbose=-1,
            n_jobs=-1,
        )
        lgbm.fit(X_train, y_train)
        preds = lgbm.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["LightGBM"] = lgbm
        oos_rank_predictions["LightGBM"] = np.clip(np.asarray(preds, dtype=float).reshape(-1), 0.0, 1.0)
        results["LightGBM"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] LightGBM IC={ic:.4f}")
    except _SkipModel:
        results["LightGBM"] = {"skipped": True}
    except Exception as exc:
        results["LightGBM"] = {"error": str(exc)}


    can_update_active_stacker = (
        req.models_filter is None
        and req.output_model_version is None
        and not walk_forward_mode
        and gcs_prefix == "universal"
    )
    if can_update_active_stacker:
        try:
            from .stacking import build_oos_rank_rows, save_meta_learner, train_rank_stacker_oof

            stack_rows, stack_model_order = build_oos_rank_rows(
                oos_rank_predictions,
                target_len=len(y_test),
            )
            rank_bundle = train_rank_stacker_oof(
                stack_rows,
                y_test,
                model_order=stack_model_order,
                min_samples=80,
            )
            if rank_bundle:
                saved = save_meta_learner(rank_bundle, 0)
                results["StackingRank"] = {
                    "trained": True,
                    "saved": bool(saved),
                    "oos_ic": rank_bundle.get("eval_ic"),
                    "eval_rmse": rank_bundle.get("eval_rmse"),
                    "train": rank_bundle.get("train_samples"),
                    "test": rank_bundle.get("eval_samples"),
                    "model_order": stack_model_order,
                    "target_type": "rank",
                }
                print(
                    f"[TrainUniversal] StackingRank IC={rank_bundle.get('eval_ic')} "
                    f"models={stack_model_order} saved={saved}"
                )
            else:
                results["StackingRank"] = {
                    "trained": False,
                    "skipped": True,
                    "reason": "insufficient_oos_rank_samples",
                    "model_order": stack_model_order,
                    "oos_models": len(stack_model_order),
                }
        except Exception as exc:
            results["StackingRank"] = {"error": str(exc)}
    else:
        reason = "active_full_universal_retrain_only"
        if req.models_filter is not None:
            reason = "models_filter_partial_retrain"
        elif req.output_model_version is not None:
            reason = "candidate_version_does_not_overwrite_active_stacker"
        elif walk_forward_mode:
            reason = "walk_forward_eval_does_not_overwrite_active_stacker"
        elif gcs_prefix != "universal":
            reason = "non_universal_prefix_does_not_overwrite_active_stacker"
        results["StackingRank"] = {
            "skipped": True,
            "reason": reason,
        }

    print("[TrainUniversal] Prep data preserved for SHAP audit")
    elapsed = round(time.time() - t0, 1)
    print(f"[TrainUniversal] Done in {elapsed}s -> {len(results)} models")

    if req.enable_model_cpcv:
        try:
            from .model_validation import evaluate_model_cpcv_rank_ic

            def _tree_cpcv_fit_predict(model_name: str, train_idx: np.ndarray, test_idx: np.ndarray) -> np.ndarray:
                if model_name == "XGBoost":
                    from xgboost import XGBRegressor

                    model = XGBRegressor(
                        n_estimators=300,
                        max_depth=6,
                        learning_rate=0.03,
                        objective="reg:squarederror",
                        subsample=0.8,
                        colsample_bytree=0.8,
                        eval_metric="rmse",
                        random_state=42,
                        verbosity=0,
                        n_jobs=-1,
                    )
                elif model_name == "ExtraTrees":
                    from sklearn.ensemble import ExtraTreesRegressor

                    model = ExtraTreesRegressor(
                        n_estimators=300,
                        max_depth=8,
                        min_samples_split=10,
                        min_samples_leaf=5,
                        max_features="sqrt",
                        bootstrap=True,
                        random_state=42,
                        n_jobs=-1,
                    )
                elif model_name == "LightGBM":
                    import lightgbm as lgb

                    model = lgb.LGBMRegressor(
                        n_estimators=300,
                        max_depth=6,
                        learning_rate=0.03,
                        objective="regression",
                        num_leaves=63,
                        subsample=0.8,
                        colsample_bytree=0.8,
                        min_child_samples=20,
                        random_state=42,
                        verbose=-1,
                        n_jobs=-1,
                    )
                else:
                    raise ValueError(f"Unsupported CPCV model family: {model_name}")
                model.fit(X[train_idx], y[train_idx])
                return np.asarray(model.predict(X[test_idx]), dtype=float)

            for model_name in TREE_MODEL_NAMES:
                if model_name not in trained_models:
                    continue
                evidence = evaluate_model_cpcv_rank_ic(
                    model=model_name,
                    X=X,
                    y=y,
                    dates=dates_arr,
                    fit_predict=lambda train_idx, test_idx, name=model_name: _tree_cpcv_fit_predict(
                        name,
                        train_idx,
                        test_idx,
                    ),
                    n_groups=int(validation_policy["cpcv_n_groups"]),
                    n_test_groups=int(validation_policy["cpcv_n_test_groups"]),
                    embargo_days=int(validation_policy["embargo_base_days"]),
                    min_train_groups=int(validation_policy["cpcv_min_train_groups"]),
                    embargo_pct=float(validation_policy["embargo_pct"]),
                    max_embargo_days=int(validation_policy["max_embargo_days"]),
                    policy=req.model_cpcv_policy,
                )
                model_cpcv_evidence_by_model[model_name] = evidence
                results.setdefault(model_name, {})["model_cpcv"] = evidence
                print(
                    f"[TrainUniversal] {model_name} CPCV decision={evidence['decision']} "
                    f"folds={evidence['folds']} ic={evidence['oos_ic_mean']}"
                )
        except Exception as exc:
            results["ModelCPCV"] = {"error": str(exc)}
            print(f"[TrainUniversal] Model CPCV failed: {exc}")
        for model_name, evidence in build_non_tree_model_cpcv_gap_evidence(
            list(trained_models.keys()),
            validation_split_metadata=validation_split_metadata,
        ).items():
            if model_name not in model_cpcv_evidence_by_model:
                model_cpcv_evidence_by_model[model_name] = evidence
                results.setdefault(model_name, {})["model_cpcv"] = evidence
                print(
                    f"[TrainUniversal] {model_name} CPCV decision=FAIL "
                    f"reason={evidence['failed_gates'][0]}"
                )

    ic_tracking = {}
    circuit_breaker_triggered = False
    for model_name, model_result in results.items():
        if model_result.get("error"):
            continue
        if model_result.get("skipped"):
            continue
        try:
            oos_ic = float(model_result.get("oos_ic") or 0.0)
        except (TypeError, ValueError):
            oos_ic = 0.0
        ic_tracking[model_name] = {
            "oos_ic": oos_ic,
            "oos_samples": len(X_test),
            "passed": oos_ic > 0,
        }
        if model_name in model_cpcv_evidence_by_model:
            ic_tracking[model_name]["model_cpcv"] = model_cpcv_evidence_by_model[model_name]
        if oos_ic <= 0:
            circuit_breaker_triggered = True
            print(f"[IC-Breaker] {model_name} OOS IC={oos_ic:.4f} <= 0 -> breaker")
        elif oos_ic < 0.02:
            print(f"[IC-Warning] {model_name} OOS IC={oos_ic:.4f} < 0.02 -> watch drift")

    oos_artifact = None
    if req.output_model_version and oos_rank_predictions:
        try:
            oos_artifact = _save_oos_rank_artifact(
                bucket=bucket,
                req=req,
                oos_rank_predictions=oos_rank_predictions,
                y_test=y_test,
                dates_test=dates_test,
                feature_names=feature_names,
            )
            if oos_artifact:
                print(
                    f"[TrainUniversal] OOS artifact saved: {oos_artifact['path']} "
                    f"models={oos_artifact['models']}"
                )
        except Exception as exc:
            print(f"[TrainUniversal] OOS artifact save failed: {exc}")
            results["OOSArtifact"] = {"error": str(exc)}

    if req.models_filter is not None:
        print(f"[IC-Track] models_filter={req.models_filter} -> skip GCS write (orchestrator will merge)")
    else:
        try:
            ic_record = {
                "computed_at": now_utc_iso(),
                "models": ic_tracking,
                "circuit_breaker": circuit_breaker_triggered,
                "train_samples": len(X_train),
                "test_samples": len(X_test),
            }
            if walk_forward_mode:
                ic_record.update(
                    {
                        "window_id": req.window_id,
                        "train_range": [req.train_start, req.train_end],
                        "test_range": [req.test_start, req.test_end],
                    }
                )
            ic_json = json.dumps(ic_record, indent=2)
            ic_base_prefix = req.gcs_prefix.rstrip("/") if req.gcs_prefix else "universal"
            bucket.blob(f"{ic_base_prefix}/ic_tracking.json").upload_from_string(
                ic_json,
                content_type="application/json",
            )
            if not walk_forward_mode:
                month = now_utc_iso()[:7]
                bucket.blob(f"{ic_base_prefix}/ic_history/{month}.json").upload_from_string(
                    ic_json,
                    content_type="application/json",
                )
            print(
                f"[IC-Track] Saved {ic_base_prefix}/ic_tracking.json "
                f"(breaker={'ON' if circuit_breaker_triggered else 'OFF'})"
            )
        except Exception as exc:
            print(f"[IC-Track] GCS save failed: {exc}")

    if circuit_breaker_triggered:
        print("[IC-Breaker] At least one model OOS IC <= 0; models still saved, ensemble will downweight")

    try:
        medians_arr = np.nanmedian(X_train, axis=0)
        feature_medians = {
            feature_names[i]: float(medians_arr[i]) if not np.isnan(medians_arr[i]) else 0.0
            for i in range(len(feature_names))
        }
    except Exception as med_err:
        print(f"[TrainUniversal] feature_medians compute failed: {med_err}")
        feature_medians = {}
    prep_missingness_by_feature = {
        feature_names[i]: round(float(prep_missingness_rates[i]), 6)
        for i in range(min(len(feature_names), len(prep_missingness_rates)))
    }

    base_training_run_id = str(
        req.output_model_version
        or f"{gcs_prefix}:{now_utc_iso().replace(':', '').replace('-', '')}"
    )
    training_run_id = (
        f"{base_training_run_id}-{req.training_run_suffix}"
        if req.training_run_suffix
        else base_training_run_id
    )
    manifest_path = f"{gcs_prefix}/manifests/{training_run_id}.json"
    req_params = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    date_min, date_max = _date_min_max_for_manifest(dates_arr)
    manifest = build_training_run_manifest(
        run_id=training_run_id,
        model_names=list(trained_models.keys()),
        feature_names=feature_names,
        dataset={
            "source": f"{gcs_prefix}/prep",
            "rows": int(len(X)),
            "train_rows": int(len(X_train)),
            "test_rows": int(len(X_test)),
            "date_min": date_min,
            "date_max": date_max,
            "walk_forward": bool(walk_forward_mode),
            "validation_split": validation_split_metadata,
        },
        params=req_params,
        code_version=os.environ.get("GIT_SHA") or os.environ.get("SOURCE_VERSION") or "unknown",
    )
    bucket.blob(manifest_path).upload_from_string(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True),
        content_type="application/json",
    )

    extra_meta = {
        "training_run_id": training_run_id,
        "training_manifest_path": manifest_path,
            "validation_split": validation_split_metadata,
            "model_cpcv_enabled": bool(req.enable_model_cpcv),
        }
    if walk_forward_mode:
        extra_meta.update({
            "window_id": req.window_id,
            "train_range": [req.train_start, req.train_end],
            "test_range": [req.test_start, req.test_end],
        })

    challenger_registrations: dict[str, dict] = {}
    for model_name, model_obj in trained_models.items():
        try:
            model_selection_evidence = {
                "feature_pool_path": req.feature_pool_path or "universal/feature_pool.json",
                "feature_pool_policy": feature_pool_model_policies.get(model_name),
                "selection_evidence": feature_pool_selection_evidence,
                "schema_parity": {
                    "training_feature_count": len(feature_names),
                    "feature_median_count": len(feature_medians or {}),
                },
                "missingness_mask": {
                    "enabled": bool(prep_missingness_by_feature),
                    "zero_fill_after_median_alignment": True,
                    "prep_missingness_by_feature": prep_missingness_by_feature,
                    "source": "universal/prep/*.npz:missingness_rates",
                },
                "validation_split": validation_split_metadata,
                "model_cpcv": model_cpcv_evidence_by_model.get(model_name),
            }
            model_extra_meta = dict(extra_meta)
            model_extra_meta.update(
                build_model_feature_policy_metadata(
                    model_name,
                    feature_names,
                    selection_evidence=model_selection_evidence,
                )
            )
            if req.output_model_version and not walk_forward_mode and gcs_prefix == "universal":
                model_path = _save_universal_versioned_model(
                    bucket=bucket,
                    model_name=model_name,
                    model=model_obj,
                    feature_names=feature_names,
                    sample_count=len(X_train),
                    version=req.output_model_version,
                    feature_medians=feature_medians,
                    extra_metadata=model_extra_meta or None,
                )
                if req.register_challengers:
                    registration = _register_challenger_safe(
                        model_name,
                        req.output_model_version,
                        model_cpcv=model_cpcv_evidence_by_model.get(model_name),
                        feature_policy_version=str(model_extra_meta.get("feature_policy_schema_version") or ""),
                        feature_policy=model_extra_meta.get("feature_policy") if isinstance(model_extra_meta.get("feature_policy"), dict) else None,
                    )
                    registration["training_run_id"] = training_run_id
                    registration["training_manifest_path"] = manifest_path
                    challenger_registrations[model_name] = registration
                print(
                    f"[TrainUniversal] Saved {model_name} challenger to {model_path} "
                    f"(version={req.output_model_version})"
                )
                continue

            save_model(
                0,
                model_name,
                model_obj,
                feature_names,
                len(X_train),
                feature_medians=feature_medians,
                gcs_prefix=req.gcs_prefix,
                extra_metadata=model_extra_meta or None,
                skip_weekly_backup=req.skip_weekly_backup,
            )
            print(f"[TrainUniversal] Saved {model_name} to GCS (prefix={req.gcs_prefix or 'universal'})")
        except Exception as exc:
            print(f"[TrainUniversal] Failed to save {model_name}: {exc}")

    elapsed = round(time.time() - t0, 1)
    print(f"[TrainUniversal] Done in {elapsed}s -> {len(results)} models")
    trained_at_iso = now_utc_iso()

    if getattr(req, "followup_webhook_url", None):
        try:
            import httpx as _httpx

            _followup_payload = {
                "trained_at": trained_at_iso,
                "gcs_prefix": req.gcs_prefix or "universal",
                "window_id": req.window_id,
                "total_samples": len(X),
                "train_samples": len(X_train),
                "feature_count": len(feature_names),
                "elapsed_s": elapsed,
                "circuit_breaker": circuit_breaker_triggered,
                "ic_summary": {k: _ic_summary_value(v) for k, v in (ic_tracking or {}).items() if isinstance(v, dict)},
                "candidate_version": req.output_model_version,
                "training_run_id": training_run_id,
                "training_manifest_path": manifest_path,
                "challenger_registrations": challenger_registrations,
            }
            _headers = {"Content-Type": "application/json"}
            _token = _controller_callback_token()
            if _token:
                _headers["X-Service-Token"] = _token
            _resp = _httpx.post(
                req.followup_webhook_url,
                json=_followup_payload,
                headers=_headers,
                timeout=15,
                follow_redirects=True,
            )
            if _resp.status_code < 200 or _resp.status_code >= 300:
                raise RuntimeError(f"followup webhook returned HTTP {_resp.status_code}")
            print(f"[TrainUniversal] followup webhook POST {req.followup_webhook_url} -> HTTP {_resp.status_code}")
        except Exception as webhook_err:
            print(f"[TrainUniversal] followup webhook failed (safety-net cron will catch): {webhook_err}")

    return {
        "type": "universal",
        "total_samples": len(X),
        "train_samples": len(X_train),
        "test_samples": len(X_test),
        "feature_count": len(feature_names),
        "embargo_days": 10,
        "elapsed_s": elapsed,
        "results": results,
        "ic_tracking": ic_tracking,
        "circuit_breaker": circuit_breaker_triggered,
        "candidate_version": req.output_model_version,
        "challenger_registrations": challenger_registrations,
        "oos_artifact": oos_artifact,
        "gcs_io": gcs_io,
        "trained_at": trained_at_iso,
        "training_run_id": training_run_id,
        "training_manifest_path": manifest_path,
    }


def run_shap_audit(shap_samples: int = 5000) -> dict:
    import json

    import shap

    t0 = time.time()
    bucket = _get_bucket()
    if bucket is None:
        return {"error": "GCS_BUCKET_NAME not configured or bucket unavailable"}

    prep_blobs = sorted(
        [b for b in bucket.list_blobs(prefix="universal/prep/") if b.name.endswith(".npz")],
        key=lambda b: b.name,
    )
    if not prep_blobs:
        return {"error": "No prep data in GCS. Run retrain first."}

    all_X, all_y, all_dates = [], [], []
    for key, raw in download_existing_blobs(bucket, [b.name for b in prep_blobs], max_workers=4):
        if raw is None:
            continue
        buf = io.BytesIO(raw)
        data = np.load(buf, allow_pickle=True)
        all_X.append(data["X"])
        all_y.append(data["y"])
        all_dates.append(data["dates"])
    X = np.vstack(all_X)
    dates = np.concatenate(all_dates)

    fn_blob = bucket.blob("universal/prep/feature_names.json")
    feature_names = json.loads(fn_blob.download_as_text())
    n_features = len(feature_names)
    print(f"[SHAP] Loaded {len(X)} samples, {n_features} features")

    sorted_dates = np.sort(np.unique(dates))
    cutoff_idx = int(len(sorted_dates) * 0.8)
    cutoff_date = sorted_dates[cutoff_idx]
    test_mask = dates > cutoff_date
    X_test = X[test_mask]
    print(f"[SHAP] Test set: {len(X_test)} samples (cutoff={cutoff_date})")

    if len(X_test) > shap_samples:
        rng = np.random.RandomState(42)
        idx = rng.choice(len(X_test), shap_samples, replace=False)
        idx.sort()
        X_shap = X_test[idx]
    else:
        X_shap = X_test
    print(f"[SHAP] Using {len(X_shap)} samples for SHAP computation")

    model_importance: dict[str, np.ndarray] = {}
    tree_models = ["xgboost", "catboost", "extratrees", "lightgbm"]
    for name in tree_models:
        try:
            blob = bucket.blob(f"universal/{name}.joblib")
            buf = io.BytesIO()
            blob.download_to_file(buf)
            buf.seek(0)
            model = joblib_load(buf)

            name_to_idx = {n: i for i, n in enumerate(feature_names)}
            model_keep_idx = list(range(n_features))
            try:
                meta_blob = bucket.blob(f"universal/metadata_{name}.json")
                if meta_blob.exists():
                    model_meta = json.loads(meta_blob.download_as_text())
                    model_fnames = model_meta.get("feature_names", [])
                    if model_fnames and model_fnames != feature_names:
                        model_keep_idx = [name_to_idx[n] for n in model_fnames if n in name_to_idx]
                        print(f"[SHAP] {name} feature align: {len(model_keep_idx)}/{n_features} features")
            except Exception as meta_err:
                print(f"[SHAP] {name} meta load failed (using all features): {meta_err}")

            X_shap_model = X_shap[:, model_keep_idx] if len(model_keep_idx) < n_features else X_shap
            print(f"[SHAP] Computing TreeExplainer for {name} ({X_shap_model.shape[1]} features)...")
            t1 = time.time()
            explainer = shap.TreeExplainer(model)
            shap_values = explainer.shap_values(X_shap_model)
            if isinstance(shap_values, list):
                sv = np.abs(shap_values[0])
            elif isinstance(shap_values, np.ndarray) and shap_values.ndim == 3:
                sv = np.abs(shap_values[:, :, 0])
            else:
                sv = np.abs(shap_values)
            local_importance = sv.mean(axis=0)
            if local_importance.ndim > 1:
                local_importance = local_importance.ravel()
            local_importance = local_importance.astype(np.float64)

            full_importance = np.zeros(n_features, dtype=np.float64)
            for local_i, global_i in enumerate(model_keep_idx):
                if local_i < len(local_importance):
                    full_importance[global_i] = local_importance[local_i]
            total = full_importance.sum()
            if total > 0:
                full_importance = full_importance / total
            model_importance[name] = full_importance
            top_idx = int(full_importance.argmax())
            print(
                f"[SHAP] {name} done in {time.time() - t1:.1f}s, "
                f"top feature: {feature_names[top_idx]} ({full_importance[top_idx]:.4f})"
            )
        except Exception as exc:
            print(f"[SHAP] {name} failed: {exc}")
            model_importance[name] = np.zeros(n_features)

    valid_models = [v.ravel() for v in model_importance.values() if v.sum() > 0]
    if not valid_models:
        return {"error": "All models failed SHAP computation"}

    avg_importance = np.mean(np.stack(valid_models), axis=0)
    total = avg_importance.sum()
    if total > 0:
        avg_importance = avg_importance / total

    ranked = sorted(
        [
            (
                feature_names[i],
                float(avg_importance[i]),
                {k: float(model_importance[k][i]) for k in model_importance},
            )
            for i in range(n_features)
        ],
        key=lambda x: x[1],
        reverse=True,
    )

    features_result = []
    for rank, (fname, avg_imp, per_model) in enumerate(ranked, 1):
        below_1pct_all = all(v < 0.01 for v in per_model.values() if v > 0)
        features_result.append(
            {
                "rank": rank,
                "feature": fname,
                "avg_importance": round(avg_imp, 6),
                "per_model": {k: round(v, 6) for k, v in per_model.items()},
                "below_1pct_all_models": below_1pct_all,
            }
        )

    n_below = sum(1 for f in features_result if f["below_1pct_all_models"])
    elapsed = round(time.time() - t0, 1)
    result = {
        "total_features": n_features,
        "shap_samples": len(X_shap),
        "models_computed": list(model_importance.keys()),
        "models_success": [k for k, v in model_importance.items() if v.sum() > 0],
        "below_1pct_count": n_below,
        "keep_count": n_features - n_below,
        "elapsed_s": elapsed,
        "features": features_result,
    }

    try:
        result_json = json.dumps(result, ensure_ascii=False, indent=2)
        bucket.blob("universal/shap_audit.json").upload_from_string(
            result_json, content_type="application/json"
        )
        print("[SHAP] Saved to GCS universal/shap_audit.json")
    except Exception as save_err:
        print(f"[SHAP] Failed to save to GCS: {save_err}")

    print(f"\n[SHAP] === RESULTS ({elapsed}s) ===")
    print(f"[SHAP] Models: {result['models_success']}")
    print(
        f"[SHAP] Features: {n_features} total, {n_below} below 1% (all models agree), "
        f"{n_features - n_below} keep"
    )
    print("\n[SHAP] Top 20:")
    for feature in features_result[:20]:
        print(
            f"  #{feature['rank']:3d} {feature['feature']:30s} "
            f"avg={feature['avg_importance']:.4f}"
        )
    print("\n[SHAP] Bottom 20 (candidates to cut):")
    for feature in features_result[-20:]:
        flag = " *** CUT" if feature["below_1pct_all_models"] else ""
        print(
            f"  #{feature['rank']:3d} {feature['feature']:30s} "
            f"avg={feature['avg_importance']:.4f}{flag}"
        )

    return result


__all__ = [
    "UniversalPrepRequest",
    "UniversalTrainRequest",
    "build_non_tree_model_cpcv_gap_evidence",
    "model_cpcv_family_adapter_enabled",
    "prep_universal_batch",
    "train_universal_from_gcs",
    "run_shap_audit",
]
