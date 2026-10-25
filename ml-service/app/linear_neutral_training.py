"""LinearNeutral §7 challenger trainer (fold OOF and full-fit).

Reads the same canonical prep batches as the tree trainer and writes the same
outputs: a ``model-artifact-v2`` joblib + metadata through
``_save_universal_versioned_model``, an ``active8-oof-predictions-v2`` fold OOF
through ``save_oof_prediction_artifact``, and a training run manifest.
"""
from __future__ import annotations

import io
import json
import os
import time
from typing import Any

import numpy as np

from .artifact_contract import build_training_run_manifest, now_utc_iso
from .challenger_models import CHALLENGERS, challenger_feature_policy_metadata
from .formal_feature_contract import FEATURE131_SEMANTIC, FEATURES131, payload_semantic
from .gcs_batch_io import download_existing_blobs
from .industry_exposure import asof_industry, coverage_report, load_industry_sidecar
from .linear_neutral import (
    EXPOSURE_SET_MODEL_NAMES,
    EXPOSURE_SETS,
    LINEAR_NEUTRAL_SEMANTIC_VERSION,
    cohort_groups,
    daily_rank_ic,
    fit_linear_neutral,
)
from .prep_input_validation import validate_feature_names, validate_prep_keys, validate_tabular_batch
from .prep_lineage import attach_prep_lineage_aliases, collect_prep_lineage
from .sequence_training import RANK_IC_SEMANTIC_VERSION, SEQUENCE_RETURN_SEMANTIC_VERSION
from .target_rank_scope import GLOBAL_CROSS_SECTIONAL_RANK_VERSION, recompute_global_cross_sectional_rank

def _load_prep(bucket, *, gcs_prefix: str, batch_count: int) -> dict[str, np.ndarray]:
    parts: dict[str, list[np.ndarray]] = {k: [] for k in (
        "X", "target_returns", "dates", "symbols", "markets", "label_known_dates")}
    keys = [f"{gcs_prefix}/prep/batch_{i}.npz" for i in range(batch_count)]
    for key, raw in download_existing_blobs(bucket, keys, max_workers=4):
        if raw is None:
            raise ValueError(f"prep_batch_missing:{key}")
        data = np.load(io.BytesIO(raw), allow_pickle=True)
        validate_tabular_batch(data, key=key)
        for name in parts:
            if name not in data.files:
                raise ValueError(f"linear_neutral_prep_field_missing:{name}")
            parts[name].append(np.asarray(data[name]))
    if not parts["X"]:
        raise ValueError("No prep batches found in GCS")
    out = {name: np.concatenate(values, axis=0) for name, values in parts.items()}
    out["X"] = out["X"].astype(float)
    out["target_returns"] = out["target_returns"].astype(float).reshape(-1)
    for name in ("dates", "symbols", "markets", "label_known_dates"):
        out[name] = out[name].astype(str).reshape(-1)
    return out


AUTO_EXPOSURE_SET = "auto"


def resolve_auto_exposure_set(sidecar_meta: dict[str, Any] | None, window_first_date: str) -> tuple[str, dict[str, Any]]:
    """Industry dummies only once true PIT snapshots cover the whole fit window; otherwise size-only.

    A rule-inferred backfill never qualifies, so the switch cannot read labels from after a signal date.
    """
    first_snapshot = (sidecar_meta or {}).get("snapshot_date_min")
    pit_status = (sidecar_meta or {}).get("pit_status")
    covered = bool(sidecar_meta) and pit_status == "pit_snapshot" and str(first_snapshot) <= window_first_date
    if not sidecar_meta:
        reason = "no_industry_sidecar"
    elif pit_status != "pit_snapshot":
        reason = f"sidecar_not_pit:{pit_status}"
    elif not covered:
        reason = "pit_snapshots_start_after_window"
    else:
        reason = "pit_snapshots_cover_window"
    resolved = "industry_log_mktcap" if covered else "log_mktcap"
    return resolved, {"resolved_exposure_set": resolved, "reason": reason, "window_first_date": window_first_date,
                      "sidecar_first_snapshot_date": first_snapshot, "sidecar_pit_status": pit_status}


def train_linear_neutral_universal(payload: dict | None = None) -> dict[str, Any]:
    payload = dict(payload or {})
    t0 = time.time()
    from .model_store import _get_bucket
    from .universal_training import _save_universal_versioned_model

    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    gcs_prefix = str(payload.get("gcs_prefix") or payload.get("prep_gcs_prefix") or "").strip().rstrip("/")
    version = str(payload.get("output_model_version") or "").strip()
    exposure_set = str(payload.get("neutralization_exposures") or "").strip()
    inner_folds = int(payload.get("validation_folds") or 0)
    if not gcs_prefix or not version:
        raise ValueError("linear_neutral_requires_gcs_prefix_and_output_model_version")
    requested_exposure_set = exposure_set
    if exposure_set != AUTO_EXPOSURE_SET and exposure_set not in EXPOSURE_SETS:
        raise ValueError(f"linear_neutral_exposure_set_invalid:{exposure_set or 'missing'}")
    if exposure_set == AUTO_EXPOSURE_SET and payload.get("model_name"):
        raise ValueError("linear_neutral_auto_exposure_resolves_model_name")
    if inner_folds < 2:
        raise ValueError("linear_neutral_validation_folds_required")
    generation_mode = str(payload.get("generation_mode") or "native").strip().lower()
    label_horizon_days = int(payload.get("label_horizon_days") or 5)

    prep = _load_prep(bucket, gcs_prefix=gcs_prefix, batch_count=int(payload.get("batch_count") or 0))
    X, dates, symbols = prep["X"], prep["dates"], prep["symbols"]
    markets, label_known_dates, target_returns = prep["markets"], prep["label_known_dates"], prep["target_returns"]
    y = recompute_global_cross_sectional_rank(target_returns, dates, markets)
    fn_blob = bucket.blob(f"{gcs_prefix}/prep/feature_names.json")
    if not fn_blob.exists():
        raise ValueError("prep_feature_names_missing")
    feature_names = [str(n) for n in json.loads(fn_blob.download_as_text())]
    validate_feature_names(feature_names, X.shape[1])
    feature_semantic = payload_semantic(payload)
    if feature_semantic == FEATURE131_SEMANTIC and feature_names != list(FEATURES131):
        raise ValueError("formal131_training_inventory_mismatch")
    validate_prep_keys(dates, symbols, markets)

    from .deployment_refit import requested, validate_full_history
    full_fit = requested(payload)
    walk_forward = all(payload.get(k) for k in ("train_start", "train_end", "test_start", "test_end"))
    deployment_fit = None
    if full_fit:
        deployment_fit = validate_full_history(
            signal_dates=dates, label_known_dates=label_known_dates,
            cutoff=payload.get("as_of_date") or payload.get("run_date"),
        )
        train_idx = np.arange(len(y), dtype=np.int64)
        test_idx = np.asarray([], dtype=np.int64)
        split_meta: dict[str, Any] = {"method": "full_known_history_refit", "label_horizon_days": label_horizon_days}
    elif walk_forward:
        from .purged_cv import purged_explicit_walk_forward_indices
        train_idx, test_idx, split_meta = purged_explicit_walk_forward_indices(
            dates, train_start=str(payload["train_start"]), train_end=str(payload["train_end"]),
            test_start=str(payload["test_start"]), test_end=str(payload["test_end"]),
            label_horizon_days=label_horizon_days, label_known_dates=label_known_dates,
        )
        split_meta = {**split_meta, "window_id": payload.get("window_id"),
                      "train_range": split_meta["effective_train_range"]}
    else:
        raise ValueError("linear_neutral_requires_walk_forward_ranges_or_full_fit")
    if not len(train_idx):
        raise ValueError("linear_neutral_train_rows_empty")

    industries = None
    industry_sidecar_meta = None
    sidecar = None
    if payload.get("industry_exposure") or exposure_set == "industry_log_mktcap":
        sidecar = load_industry_sidecar(bucket, payload.get("industry_exposure"))
        industry_sidecar_meta = sidecar["metadata"]
    window_first_date = str(np.sort(dates[train_idx])[0])
    auto_resolution = None
    if exposure_set == AUTO_EXPOSURE_SET:
        exposure_set, auto_resolution = resolve_auto_exposure_set(industry_sidecar_meta, window_first_date)
    model_name = EXPOSURE_SET_MODEL_NAMES[exposure_set]
    if payload.get("model_name") not in (None, "", model_name):
        raise ValueError(f"linear_neutral_model_name_exposure_mismatch:{payload.get('model_name')}:{model_name}")
    if "industry" in EXPOSURE_SETS[exposure_set]:
        industries = asof_industry(symbols, dates, sidecar)
        eligible = industries != ""
        train_idx = train_idx[eligible[train_idx]]
        test_idx = test_idx[eligible[test_idx]]
    else:
        industry_sidecar_meta = None
    if not len(train_idx):
        raise ValueError("linear_neutral_train_rows_empty_after_exposure_filter")
    if walk_forward and not len(test_idx):
        raise ValueError("linear_neutral_test_rows_empty_after_exposure_filter")
    exposure_coverage = {
        "exposure_set": exposure_set,
        "requested_exposure_set": requested_exposure_set,
        "auto_resolution": auto_resolution,
        "industry": coverage_report(industries, dates) if industries is not None else None,
        "train_rows": int(len(train_idx)),
        "test_rows": int(len(test_idx)),
    }
    print(f"[{model_name}] rows train={len(train_idx)} test={len(test_idx)} exposures={exposure_set}", flush=True)

    fit_t0 = time.time()
    model = fit_linear_neutral(
        X[train_idx], y[train_idx], feature_names=feature_names,
        dates=dates[train_idx], markets=markets[train_idx], label_known_dates=label_known_dates[train_idx],
        exposure_set=exposure_set, inner_folds=inner_folds,
        industries=None if industries is None else industries[train_idx],
    )
    fit_s = round(time.time() - fit_t0, 3)
    print(f"[{model_name}] alpha={model.alpha_:.6g} cv_ic={model.alpha_selection['selected_cv_mean_daily_rank_ic']:.4f} "
          f"edge={model.alpha_selection['alpha_at_grid_edge']} fit_s={fit_s}", flush=True)

    oos_ic = None
    oof_artifact = None
    if len(test_idx):
        preds = model.predict(X[test_idx], dates=dates[test_idx], markets=markets[test_idx],
                              industries=None if industries is None else industries[test_idx])
        oos_ic = float(daily_rank_ic(preds, y[test_idx], cohort_groups(dates[test_idx], markets[test_idx]))[0])
        if generation_mode == "purged_oof":
            from .oof_lineage import save_oof_prediction_artifact
            oof_artifact = save_oof_prediction_artifact(
                feature_semantic_version=feature_semantic, bucket=bucket, gcs_prefix=gcs_prefix,
                cohort_id=str(payload.get("cohort_id") or ""),
                fold_id=str(payload.get("fold_id") or payload.get("window_id") or ""),
                model_name=model_name, artifact_version=version, raw_scores=preds,
                targets=target_returns[test_idx], dates=dates[test_idx], symbols=symbols[test_idx],
                markets=markets[test_idx], label_known_dates=label_known_dates[test_idx],
                split_metadata={**split_meta, "test_range": [payload.get("test_start"), payload.get("test_end")]},
            )

    fitted = X[train_idx]
    medians = np.nanmedian(fitted, axis=0)
    feature_medians = {name: float(v) if np.isfinite(v) else 0.0 for name, v in zip(feature_names, medians)}
    prep_lineage = collect_prep_lineage(
        bucket, gcs_prefix=gcs_prefix, batch_count=int(payload.get("batch_count") or 0),
        feature_names=feature_names, rows=len(y), dates=dates,
    )
    training_run_id = f"{version}-{model_name.lower()}"
    manifest_path = f"{gcs_prefix}/manifests/{training_run_id}.json"
    training_config = {
        "semantic_version": LINEAR_NEUTRAL_SEMANTIC_VERSION,
        "estimator_params": model.get_params(),
        "alpha_selection": model.alpha_selection,
        "exposure_coverage": exposure_coverage,
        "industry_sidecar": industry_sidecar_meta,
        "neutralization_cohort": "signal_date_x_market_segment",
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        "score_semantic": "same-market-same-date-average-tie-percentile-rank-v2",
    }
    manifest = build_training_run_manifest(
        run_id=training_run_id, model_names=[model_name], feature_names=feature_names,
        dataset={
            "source": f"{gcs_prefix}/prep", "rows": int(len(y)), "train_rows": int(len(train_idx)),
            "test_rows": int(len(test_idx)), "date_min": min(dates.tolist()), "date_max": max(dates.tolist()),
            "walk_forward": bool(walk_forward), "validation_split": split_meta,
            "deployment_fit": deployment_fit, "prep_lineage": prep_lineage,
            "target_rank_scope": GLOBAL_CROSS_SECTIONAL_RANK_VERSION,
        },
        params={k: v for k, v in payload.items() if k not in {"release_training_contract", "dataset_snapshot"}},
        code_version=os.environ.get("STOCKVISION_SOURCE_SHA") or os.environ.get("GIT_SHA") or "unknown",
    )
    bucket.blob(manifest_path).upload_from_string(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True), content_type="application/json")
    extra_meta = attach_prep_lineage_aliases({
        "training_run_id": training_run_id,
        "training_manifest_path": manifest_path,
        "deployment_fit": deployment_fit,
        "target_semantic_version": SEQUENCE_RETURN_SEMANTIC_VERSION,
        "rank_ic_semantic_version": RANK_IC_SEMANTIC_VERSION,
        "feature_semantic_version": feature_semantic,
        "target_rank_scope": GLOBAL_CROSS_SECTIONAL_RANK_VERSION,
        "batch_local_target_rank_used_for_training": False,
        "validation_split": split_meta,
        "oos_ic": oos_ic,
        "linear_neutral": training_config,
        **challenger_feature_policy_metadata(
            model_name, feature_names, feature_release_mode=payload.get("feature_release_mode")),
    }, prep_lineage)
    if walk_forward:
        extra_meta.update({"window_id": payload.get("window_id"),
                           "train_range": [payload["train_start"], payload["train_end"]],
                           "test_range": [payload["test_start"], payload["test_end"]]})
    saved = _save_universal_versioned_model(
        bucket=bucket, model_name=model_name, model=model, feature_names=feature_names,
        sample_count=int(len(train_idx)), version=version, feature_medians=feature_medians,
        extra_metadata=extra_meta,
        artifact_root=f"{gcs_prefix}/frozen_models" if walk_forward else "universal",
    )
    if saved["artifact_path"].split("/")[-2] != CHALLENGERS[model_name]["artifact_folder"]:
        raise RuntimeError("linear_neutral_artifact_folder_contract_drift")
    elapsed = round(time.time() - t0, 3)
    ic_tracking = {model_name: {"oos_ic": oos_ic, "oos_samples": int(len(test_idx)),
                                "passed": None if oos_ic is None else oos_ic > 0.0,
                                "source": "linear_neutral_outer_fold_daily_rank_ic"}}
    return {
        "type": "linear_neutral",
        "status": "ok",
        "model": model_name,
        "version": version,
        "candidate_version": version,
        "total_samples": int(len(y)),
        "train_samples": int(len(train_idx)),
        "test_samples": int(len(test_idx)),
        "feature_count": len(feature_names),
        "results": {model_name: {"oos_ic": oos_ic, "train": int(len(train_idx)), "test": int(len(test_idx)),
                                 "alpha": model.alpha_, "saved": True}},
        "ic_tracking": ic_tracking,
        "artifact_registrations": {model_name: {
            "status": "shadow_source" if walk_forward else "challenger_full_fit",
            "promotion_eligible": False,
            "version": version,
            "gcs_path": saved["artifact_path"],
            "metadata_path": saved["metadata_path"],
            "checksum": saved["checksum"],
            "training_run_id": training_run_id,
            "training_manifest_path": manifest_path,
            "oos_ic": oos_ic,
        }},
        "oof_artifact": oof_artifact,
        "exposure_coverage": exposure_coverage,
        "alpha": model.alpha_,
        "trained_at": now_utc_iso(),
        "training_run_id": training_run_id,
        "training_manifest_path": manifest_path,
        "stage_timings": {"fit_s": fit_s},
        "elapsed_s": elapsed,
    }
