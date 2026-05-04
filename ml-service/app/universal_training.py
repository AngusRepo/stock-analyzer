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

from .ft_transformer import rank_from_ft_regression_output, rebuild_ft_transformer_from_bundle
from .artifact_contract import (
    build_model_artifact_metadata,
    build_training_run_manifest,
    now_utc_iso,
    validate_model_artifact_metadata,
)
from .model_store import _get_bucket, save_model
from .training_policy import (
    build_model_feature_policy_metadata,
    generated_model_pool_version,
    should_force_full_feature_pool,
    should_force_model_pool_challenger,
)
from .training_finalizer import build_oos_artifact_path, derive_oos_artifact_group
from .gcs_batch_io import download_existing_blobs


class UniversalPrepRequest(BaseModel):
    """單批 prep request。"""

    payloads: list[dict]
    barrier_params: dict = {}
    batch_index: int = 0
    shared_market_history: dict = {}
    per_stock_ts_map: dict = {}
    active_features: list[str] | None = None
    gcs_prefix: str = "universal"


class UniversalTrainRequest(BaseModel):
    """Universal train request。"""

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
    ftt_d_model: int = 128
    ftt_n_heads: int = 8
    ftt_n_layers: int = 3
    ftt_dropout: float = 0.12
    ftt_max_epochs: int = 120
    ftt_lr: float = 2e-4
    ftt_patience: int = 16
    ftt_batch_size: int = 1024
    ftt_margin: float = 0.0
    followup_webhook_url: str | None = None
    output_model_version: str | None = None
    register_challengers: bool = False


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


def _register_challenger_safe(model_name: str, version: str) -> dict:
    try:
        from .model_pool import register_challenger

        pool = register_challenger(model_name, version, save=True)
        return {"status": "registered", "version": version, "pool_updated": bool(pool)}
    except Exception as exc:
        return {"status": "error", "version": version, "error": str(exc)}


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
    artifact = joblib_load(buf)

    metadata: dict = {}
    version = get_active_version(model_name, pool=pool)
    if version:
        meta_blob = bucket.blob(gcs_metadata_path_for(model_name, version))
        if meta_blob.exists():
            metadata = json.loads(meta_blob.download_as_text())
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
        ft_active = set(feature_pool_contract.get("ft_active") or [])
        if ft_active:
            missing_from_prep = sorted(ft_active - set(feature_names))[:10]
            extra_in_prep = sorted(set(feature_names) - ft_active)[:10]
            print(
                "[TrainUniversal] Full-feature schema parity: "
                f"ft_active={len(ft_active)} prep={len(feature_names)} "
                f"missing_sample={missing_from_prep} extra_sample={extra_in_prep}"
            )
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
    else:
        if len(X) < 1000:
            raise ValueError(f"Pooled rows below 1000 ({len(X)})")
        from .purged_cv import purged_train_test_split

        X_train, y_train, dates_train, X_test, y_test, dates_test = purged_train_test_split(
            X,
            y,
            dates_arr,
            test_ratio=0.2,
            embargo_days=10,
        )
        print(f"[TrainUniversal] Purged split: train={len(X_train)}, test={len(X_test)}, embargo=10d")

    results = {}
    trained_models: dict[str, object] = {}
    oos_rank_predictions: dict[str, np.ndarray] = {}
    _filter = set(req.models_filter) if req.models_filter else None

    def _should_train(name: str) -> bool:
        return _filter is None or name in _filter

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
        if not _should_train("CatBoost"):
            raise _SkipModel()
        from catboost import CatBoostRegressor

        cat = CatBoostRegressor(
            iterations=400,
            depth=6,
            learning_rate=0.03,
            l2_leaf_reg=3.0,
            loss_function="RMSE",
            random_seed=42,
            verbose=0,
            thread_count=-1,
        )
        cat.fit(X_train, y_train)
        preds = cat.predict(X_test)
        ic = _oos_ic(preds, y_test)
        trained_models["CatBoost"] = cat
        oos_rank_predictions["CatBoost"] = np.clip(np.asarray(preds, dtype=float).reshape(-1), 0.0, 1.0)
        results["CatBoost"] = {"oos_ic": round(ic, 4), "train": len(X_train), "test": len(X_test), "saved": True}
        print(f"[TrainUniversal] CatBoost IC={ic:.4f}")
    except _SkipModel:
        results["CatBoost"] = {"skipped": True}
    except Exception as exc:
        results["CatBoost"] = {"error": str(exc)}

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

    try:
        if not _should_train("FT-Transformer"):
            raise _SkipModel()
        import torch
        import torch.nn as nn
        from sklearn.preprocessing import StandardScaler

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"[TrainUniversal] FT-T device={device}")

        n_features = X_train.shape[1]
        D_MODEL = int(req.ftt_d_model)
        N_HEADS = int(req.ftt_n_heads)
        N_LAYERS = int(req.ftt_n_layers)
        MAX_EPOCHS = int(req.ftt_max_epochs)
        LR = float(req.ftt_lr)
        PATIENCE = int(req.ftt_patience)
        BATCH_SIZE = int(req.ftt_batch_size)
        FTT_DROPOUT = float(req.ftt_dropout)

        class _FTT(nn.Module):
            def __init__(self, n_feat, d_model, n_heads, n_layers):
                super().__init__()
                self.feat_embed = nn.Linear(1, d_model, bias=True)
                self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
                encoder_layer = nn.TransformerEncoderLayer(
                    d_model=d_model,
                    nhead=n_heads,
                    dim_feedforward=int(d_model * 4 / 3),
                    dropout=0.12,
                    batch_first=True,
                )
                self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
                for layer in self.encoder.layers:
                    for attr in ("dropout", "dropout1", "dropout2"):
                        if hasattr(layer, attr):
                            setattr(layer, attr, nn.Dropout(FTT_DROPOUT))
                self.head = nn.Linear(d_model, 1)

            def forward(self, x):
                batch_size = x.shape[0]
                tokens = self.feat_embed(x.unsqueeze(-1))
                cls = self.cls_token.expand(batch_size, -1, -1)
                tokens = torch.cat([cls, tokens], dim=1)
                out = self.encoder(tokens)
                return self.head(out[:, 0, :]).squeeze(-1)

        feat_scaler = StandardScaler()
        Xt = feat_scaler.fit_transform(X_train).astype(np.float32)
        zero_var_count = int((feat_scaler.scale_ <= 1e-10).sum())
        Xt = np.nan_to_num(Xt, nan=0.0, posinf=0.0, neginf=0.0)
        yt = y_train.astype(np.float32)
        print(
            f"[TrainUniversal] FT-T scaler: "
            f"{len(feat_scaler.scale_) - zero_var_count}/{len(feat_scaler.scale_)} columns with variance "
            f"(zero-var={zero_var_count})"
        )
        print(f"[TrainUniversal] FT-T using all {len(Xt)} samples (L4 24GB + batched val)")

        if len(Xt) >= 1000:
            _unique_td = np.sort(np.unique(np.array([str(d) for d in dates_train])))
            _n_td = len(_unique_td)
            _val_start_idx = int(_n_td * 0.8)
            _embargo_end_idx = min(_val_start_idx + 5, _n_td)
            _trn_date_set = set(_unique_td[:_val_start_idx].tolist())
            _val_date_set = set(_unique_td[_embargo_end_idx:].tolist())
            _dates_str = np.array([str(d) for d in dates_train])
            _trn_mask = np.array([d in _trn_date_set for d in _dates_str])
            _val_mask = np.array([d in _val_date_set for d in _dates_str])
            Xt_trn, yt_trn = Xt[_trn_mask], yt[_trn_mask]
            Xt_val, yt_val = Xt[_val_mask], yt[_val_mask]
            print(f"[TrainUniversal] FT-T embargo split: trn={_trn_mask.sum()}, val={_val_mask.sum()}, embargo=5d")
            if len(Xt_val) == 0:
                val_size = max(int(len(Xt) * 0.2), 256)
                Xt_val, yt_val = Xt[-val_size:], yt[-val_size:]
                Xt_trn, yt_trn = Xt[:-val_size], yt[:-val_size]
                print("[TrainUniversal] FT-T embargo fallback: not enough val dates, using simple split")
        else:
            val_size = max(int(len(Xt) * 0.2), 256)
            Xt_val, yt_val = Xt[-val_size:], yt[-val_size:]
            Xt_trn, yt_trn = Xt[:-val_size], yt[:-val_size]
            print(f"[TrainUniversal] FT-T simple split (data < 1000): trn={len(Xt_trn)}, val={len(Xt_val)}")

        model_ftt = _FTT(n_features, D_MODEL, N_HEADS, N_LAYERS).to(device)
        opt = torch.optim.AdamW(model_ftt.parameters(), lr=LR, weight_decay=5e-5)
        _global_step = 0
        _ftt_margin = float(req.ftt_margin)
        _margin_loss = nn.MarginRankingLoss(margin=_ftt_margin)
        _n_pairs = 1024

        def crit(preds: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
            batch_size = preds.shape[0]
            if batch_size < 2:
                return torch.tensor(0.0, device=preds.device)
            n = min(_n_pairs, batch_size * (batch_size - 1) // 2)
            idx_i = torch.randint(0, batch_size, (n,), device=preds.device)
            idx_j = torch.randint(0, batch_size, (n,), device=preds.device)
            mask = idx_i != idx_j
            idx_i, idx_j = idx_i[mask], idx_j[mask]
            if len(idx_i) == 0:
                return torch.tensor(0.0, device=preds.device)
            target = torch.sign(labels[idx_i] - labels[idx_j])
            non_tie = target != 0
            if non_tie.sum() == 0:
                return torch.tensor(0.0, device=preds.device)
            return _margin_loss(preds[idx_i[non_tie]], preds[idx_j[non_tie]], target[non_tie])

        use_amp = device.type == "cuda"
        amp_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        grad_scaler = torch.amp.GradScaler(enabled=(use_amp and amp_dtype == torch.float16))
        print(f"[TrainUniversal] AMP={'ON' if use_amp else 'OFF'} dtype={amp_dtype if use_amp else 'fp32'}")

        best_val_ic = -float("inf")
        best_state = None
        no_improve = 0
        last_epoch = 0

        def _run_ftt_training(batch_sz: int, grad_accum: int = 1) -> None:
            nonlocal best_val_ic, best_state, no_improve, _global_step, last_epoch

            for epoch in range(MAX_EPOCHS):
                model_ftt.train()
                perm = np.random.permutation(len(Xt_trn))
                opt.zero_grad()
                mini_step = 0
                for s in range(0, len(Xt_trn), batch_sz):
                    bi = perm[s:s + batch_sz]
                    xb = torch.tensor(Xt_trn[bi], device=device)
                    yb = torch.tensor(yt_trn[bi], device=device)
                    with torch.amp.autocast(device_type="cuda", dtype=amp_dtype, enabled=use_amp):
                        preds_amp = model_ftt(xb)
                    loss = crit(preds_amp.float(), yb.float()) / grad_accum
                    grad_scaler.scale(loss).backward()
                    mini_step += 1
                    if mini_step % grad_accum == 0:
                        grad_scaler.step(opt)
                        grad_scaler.update()
                        opt.zero_grad()
                        _global_step += 1
                if mini_step % grad_accum != 0:
                    grad_scaler.step(opt)
                    grad_scaler.update()
                    opt.zero_grad()
                    _global_step += 1

                model_ftt.eval()
                with torch.no_grad():
                    val_preds = []
                    for vs in range(0, len(Xt_val), batch_sz):
                        xvb = torch.tensor(Xt_val[vs:vs + batch_sz], device=device)
                        with torch.amp.autocast(device_type="cuda", dtype=amp_dtype, enabled=use_amp):
                            val_preds.append(model_ftt(xvb).float().cpu().numpy())
                    val_preds_arr = np.concatenate(val_preds)
                val_ic = 0.0
                nan_count = int(np.isnan(val_preds_arr).sum())
                if nan_count > 0:
                    print(f"[TrainUniversal] FT-T val preds contain {nan_count} NaN -> skipping IC")
                elif np.std(val_preds_arr) > 1e-10 and np.std(yt_val) > 1e-10:
                    rho, _ = _spearmanr(val_preds_arr, yt_val)
                    val_ic = float(rho) if not np.isnan(rho) else 0.0

                if val_ic > best_val_ic:
                    best_val_ic = val_ic
                    best_state = {k: v.cpu().clone() for k, v in model_ftt.state_dict().items()}
                    no_improve = 0
                else:
                    no_improve += 1

                if (epoch + 1) % 10 == 0:
                    print(
                        f"[TrainUniversal] FT-T epoch {epoch+1} "
                        f"val_IC={val_ic:.6f} best={best_val_ic:.6f} "
                        f"patience={no_improve}/{PATIENCE}"
                    )

                last_epoch = epoch + 1
                if no_improve >= PATIENCE:
                    print(f"[TrainUniversal] FT-T early stop at epoch {epoch+1} (val_IC={best_val_ic:.6f})")
                    break

        try:
            _run_ftt_training(BATCH_SIZE, grad_accum=1)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            print("[TrainUniversal] FT-T OOM with BATCH_SIZE=1024, retrying BATCH_SIZE=512 + grad_accum=2")
            best_val_ic = -float("inf")
            best_state = None
            no_improve = 0
            _global_step = 0
            _run_ftt_training(512, grad_accum=2)

        if best_state is not None:
            model_ftt.load_state_dict(best_state)
        model_ftt.to("cpu").eval()

        Xt_test = feat_scaler.transform(X_test).astype(np.float32)
        Xt_test = np.nan_to_num(Xt_test, nan=0.0, posinf=0.0, neginf=0.0)
        all_preds = []
        with torch.no_grad():
            for ts in range(0, len(Xt_test), BATCH_SIZE):
                xb = torch.tensor(Xt_test[ts:ts + BATCH_SIZE])
                all_preds.append(model_ftt(xb).numpy())
        raw_preds = np.asarray(np.concatenate(all_preds), dtype=float).reshape(-1)
        rank_preds = np.asarray([rank_from_ft_regression_output(v) for v in raw_preds], dtype=float)
        raw_std = float(np.nanstd(raw_preds))
        rank_std = float(np.nanstd(rank_preds))
        if rank_std < 1e-6:
            raise ValueError(
                "FT-Transformer degenerate rank output "
                f"(rank_std={rank_std:.8f}, raw_std={raw_std:.8f}); artifact not saved"
            )
        ic = _oos_ic(raw_preds, y_test)
        oos_rank_predictions["FT-Transformer"] = rank_preds

        stopped_epoch = last_epoch
        bundle = {
            "state_dict": model_ftt.state_dict(),
            "scaler": feat_scaler,
            "n_features": n_features,
            "model_type": "regression",
            "arch": {
                "d_model": D_MODEL,
                "n_heads": N_HEADS,
                "n_layers": N_LAYERS,
                "dropout": FTT_DROPOUT,
                "head_type": "regression",
            },
        }
        trained_models["FT-Transformer"] = (model_ftt, feat_scaler, None, bundle)
        results["FT-Transformer"] = {
            "oos_ic": round(ic, 4),
            "train": len(X_train),
            "test": len(X_test),
            "stopped_epoch": stopped_epoch,
            "best_val_ic": round(best_val_ic, 6),
            "raw_pred_std": round(raw_std, 8),
            "rank_pred_std": round(rank_std, 8),
            "device": str(device),
            "saved": True,
            "arch": {
                "d_model": D_MODEL,
                "n_heads": N_HEADS,
                "n_layers": N_LAYERS,
                "dropout": FTT_DROPOUT,
                "margin": _ftt_margin,
                "lr": LR,
                "batch_size": BATCH_SIZE,
                "patience": PATIENCE,
                "max_epochs": MAX_EPOCHS,
            },
        }
        print(f"[TrainUniversal] FT-Transformer IC={ic:.4f} stopped={stopped_epoch} device={device}")
    except _SkipModel:
        results["FT-Transformer"] = {"skipped": True}
    except Exception as exc:
        results["FT-Transformer"] = {"error": str(exc)}

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

    training_run_id = str(
        req.output_model_version
        or f"{gcs_prefix}:{now_utc_iso().replace(':', '').replace('-', '')}"
    )
    manifest_path = f"{gcs_prefix}/manifests/{training_run_id}.json"
    req_params = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    manifest = build_training_run_manifest(
        run_id=training_run_id,
        model_names=list(trained_models.keys()),
        feature_names=feature_names,
        dataset={
            "source": f"{gcs_prefix}/prep",
            "rows": int(len(X)),
            "train_rows": int(len(X_train)),
            "test_rows": int(len(X_test)),
            "date_min": str(dates_arr.astype(str).min()) if len(dates_arr) else None,
            "date_max": str(dates_arr.astype(str).max()) if len(dates_arr) else None,
            "walk_forward": bool(walk_forward_mode),
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
                    "enabled": model_name == "FT-Transformer",
                    "zero_fill_after_median_alignment": True,
                    "prep_missingness_by_feature": prep_missingness_by_feature,
                    "source": "universal/prep/*.npz:missingness_rates",
                },
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
                artifact = model_obj[3] if model_name == "FT-Transformer" else model_obj
                model_path = _save_universal_versioned_model(
                    bucket=bucket,
                    model_name=model_name,
                    model=artifact,
                    feature_names=feature_names,
                    sample_count=len(X_train),
                    version=req.output_model_version,
                    feature_medians=feature_medians,
                    extra_metadata=model_extra_meta or None,
                )
                if req.register_challengers:
                    challenger_registrations[model_name] = _register_challenger_safe(
                        model_name,
                        req.output_model_version,
                    )
                print(
                    f"[TrainUniversal] Saved {model_name} challenger to {model_path} "
                    f"(version={req.output_model_version})"
                )
                continue

            if model_name == "FT-Transformer":
                _, _, _, ftt_bundle = model_obj
                save_model(
                    0,
                    "FT-Transformer",
                    ftt_bundle,
                    feature_names,
                    len(X_train),
                    feature_medians=feature_medians,
                    gcs_prefix=req.gcs_prefix,
                    extra_metadata=model_extra_meta or None,
                    skip_weekly_backup=req.skip_weekly_backup,
                )
            else:
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
                "ic_summary": {k: v.get("ic") for k, v in (ic_tracking or {}).items() if isinstance(v, dict)},
                "candidate_version": req.output_model_version,
                "training_run_id": training_run_id,
                "training_manifest_path": manifest_path,
                "challenger_registrations": challenger_registrations,
            }
            _headers = {"Content-Type": "application/json"}
            _token = os.environ.get("ML_CONTROLLER_TOKEN") or os.environ.get("INTERNAL_TOKEN")
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

    try:
        import torch

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        bundle, ftt_meta = _load_active_model_pool_joblib(bucket, "FT-Transformer")

        ftt_n_features = bundle.get("n_features", n_features)
        model_ftt, _ftt_type, _ftt_arch = rebuild_ft_transformer_from_bundle(bundle)
        model_ftt.to(device).eval()
        ftt_scaler = bundle.get("scaler")
        ftt_valid_cols = bundle.get("valid_cols_mask")

        X_shap_ftt = X_shap
        ftt_keep_idx = list(range(n_features))
        if ftt_n_features != n_features:
            try:
                ftt_fnames = ftt_meta.get("feature_names", [])
                name_to_idx_ftt = {n: i for i, n in enumerate(feature_names)}
                ftt_keep_idx = [name_to_idx_ftt[n] for n in ftt_fnames if n in name_to_idx_ftt]
                if not ftt_keep_idx:
                    raise RuntimeError("FT-Transformer metadata has no matching feature_names")
                X_shap_ftt = X_shap[:, ftt_keep_idx]
                print(
                    f"[SHAP] FT-T feature align: {len(ftt_keep_idx)} features "
                    f"(model={ftt_n_features}, prep={n_features})"
                )
            except Exception as feature_err:
                print(f"[SHAP] FT-T meta load failed: {feature_err}")
                X_shap_ftt = X_shap[:, :ftt_n_features]
                ftt_keep_idx = list(range(ftt_n_features))

        if ftt_scaler and ftt_valid_cols is not None:
            X_shap_scaled = X_shap_ftt.copy().astype(np.float32)
            if hasattr(ftt_valid_cols, "dtype") and ftt_valid_cols.dtype == bool:
                vc = (
                    ftt_valid_cols
                    if ftt_valid_cols.shape[0] == X_shap_ftt.shape[1]
                    else ftt_valid_cols[: X_shap_ftt.shape[1]]
                )
                X_shap_scaled[:, vc] = ftt_scaler.transform(X_shap_ftt)[:, vc].astype(np.float32)
            else:
                X_shap_scaled = ftt_scaler.transform(X_shap_ftt).astype(np.float32)
                X_shap_scaled = np.nan_to_num(X_shap_scaled, nan=0.0, posinf=0.0, neginf=0.0)
        elif ftt_scaler:
            X_shap_scaled = ftt_scaler.transform(X_shap_ftt).astype(np.float32)
            X_shap_scaled = np.nan_to_num(X_shap_scaled, nan=0.0, posinf=0.0, neginf=0.0)
        else:
            X_shap_scaled = X_shap_ftt.astype(np.float32)

        bg_size = min(500, len(X_shap_scaled))
        bg = torch.tensor(X_shap_scaled[:bg_size], device=device)
        data_tensor = torch.tensor(X_shap_scaled, device=device)

        print(f"[SHAP] Computing GradientExplainer for FT-Transformer on {device} ({ftt_n_features} features)...")
        t1 = time.time()
        explainer = shap.GradientExplainer(model_ftt, bg)
        shap_values = explainer.shap_values(data_tensor)
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
        for local_i, global_i in enumerate(ftt_keep_idx):
            if local_i < len(local_importance):
                full_importance[global_i] = local_importance[local_i]
        total = full_importance.sum()
        if total > 0:
            full_importance = full_importance / total
        model_importance["ft-transformer"] = full_importance
        top_idx = int(full_importance.argmax())
        print(
            f"[SHAP] FT-Transformer done in {time.time() - t1:.1f}s, "
            f"top feature: {feature_names[top_idx]} ({full_importance[top_idx]:.4f})"
        )
    except Exception as exc:
        print(f"[SHAP] FT-Transformer failed: {exc}")
        model_importance["ft-transformer"] = np.zeros(n_features)

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
    "prep_universal_batch",
    "train_universal_from_gcs",
    "run_shap_audit",
]
