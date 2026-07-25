"""
walk_forward.py ??Sprint 6b walk-forward real orchestrator endpoints

POST /walk_forward/dry-run   preview plan
POST /walk_forward/run       execute full pipeline (requires confirm=true)
POST /walk_forward/analyze   aggregate latest run, produce markdown report
GET  /walk_forward/report/{start}/{end}  fetch persisted run

All endpoints require X-Controller-Token via main.py verify_token dependency.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import logging
import os
import statistics
from typing import Any
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

logger = logging.getLogger("walk_forward")
router = APIRouter()


class WalkForwardRequest(BaseModel):
    start_date: str
    end_date: str
    train_window_days: int = 60
    test_window_days: int = 30
    models: list[str] | None = None
    confirm: bool = False
    concurrent_windows: int = 2
    batch_count: int = 5
    subset_size: int = 500
    # 2026-04-19 N2: per-window feature selection controls
    fs_max_rounds: int = 60          # lighter than production 100; trade speed for slight precision loss
    fs_force_refresh: bool = False   # True = re-run FS even if walk_forward/w{id}/feature_pool.json exists
    cohort_id: str | None = None
    prep_gcs_prefix: str = "universal"
    sequence_gcs_prefix: str = "universal/sequence_long/latest"
    sequence_batch_count: int = 5
    resume_manifest_path: str | None = None


def _window_split_key(window) -> tuple[str, str, str, str]:
    train_range = getattr(window, "train_range", None) or [
        getattr(window, "train_start", None), getattr(window, "train_end", None)
    ]
    test_range = getattr(window, "test_range", None) or [
        getattr(window, "test_start", None), getattr(window, "test_end", None)
    ]
    if isinstance(window, dict):
        train_range = window.get("train_range") or [window.get("train_start"), window.get("train_end")]
        test_range = window.get("test_range") or [window.get("test_start"), window.get("test_end")]
    return tuple(str(value or "")[:10] for value in (*train_range, *test_range))


def _load_resume_plan(
    manifest_path: str | None,
    windows: list,
    *,
    models: list[str],
    prep_gcs_prefix: str,
    sequence_gcs_prefix: str,
) -> dict:
    if not manifest_path:
        return {"manifest_path": None, "reused_window_ids": [], "new_window_ids": [w.window_id for w in windows]}
    from services.walk_forward_retrain import _get_bucket
    from services.active8_oof_cohort_materializer import load_verified_oof_manifest

    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable for OOF resume planning")
    try:
        manifest, _raw = load_verified_oof_manifest(manifest_path, bucket=bucket)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid OOF resume manifest: {exc}") from exc
    if list(manifest.get("model_set") or []) != list(models):
        raise HTTPException(status_code=400, detail="resume model set does not match requested Active-8 set")
    if str(manifest.get("prep_gcs_prefix") or "").rstrip("/") != prep_gcs_prefix.rstrip("/"):
        raise HTTPException(status_code=400, detail="resume prep prefix does not match requested V3 prep")
    if str(manifest.get("sequence_gcs_prefix") or "").rstrip("/") != sequence_gcs_prefix.rstrip("/"):
        raise HTTPException(status_code=400, detail="resume sequence prefix does not match requested V3 sequence prep")
    requested = {_window_split_key(window): window.window_id for window in windows}
    reused = []
    for parent_window in manifest.get("windows") or []:
        key = _window_split_key(parent_window)
        if key not in requested:
            raise HTTPException(status_code=400, detail=f"resume fold split not present in requested plan: {key}")
        requested_window_id = requested[key]
        reused.append(requested_window_id)
    reused_set = set(reused)
    return {
        "manifest_path": manifest_path,
        "parent_cohort_id": manifest["cohort_id"],
        "parent_manifest_checksum": manifest["manifest_checksum"],
        "reused_window_ids": sorted(reused_set),
        "new_window_ids": [w.window_id for w in windows if w.window_id not in reused_set],
        "artifact_preflight": "modal_sha256_metadata_before_retrain",
    }


def _load_trading_calendar(start_date: str, end_date: str) -> tuple[list[str], dict]:
    """Load only observed market dates; OOF training data stays in immutable GCS prep."""
    from services import d1_client

    rows = d1_client.query(
        """
        SELECT substr(date, 1, 10) AS trading_date, COUNT(*) AS price_rows
        FROM stock_prices
        WHERE substr(date, 1, 10) BETWEEN ? AND ?
        GROUP BY substr(date, 1, 10)
        ORDER BY trading_date
        """,
        [start_date, end_date],
    )
    observed = [
        (
            str(row.get("trading_date") or "")[:10],
            max(0, int(row.get("price_rows") or 0)),
        )
        for row in rows
        if str(row.get("trading_date") or "").strip()
    ]
    coverage_reference = float(statistics.median(count for _, count in observed)) if observed else 0.0
    coverage_threshold = max(1, int(coverage_reference * 0.20))
    excluded = [
        {"date": date, "price_rows": count}
        for date, count in observed
        if count < coverage_threshold
    ]
    trading_days = sorted({
        date for date, count in observed if count >= coverage_threshold
    })
    if not trading_days:
        raise HTTPException(
            status_code=400,
            detail=f"no observed stock-price trading dates for {start_date}..{end_date}",
        )
    return trading_days, {
        "lane": "walk_forward.calendar",
        "kind": "observed_trading_calendar",
        "mode": "d1_stock_prices_grouped",
        "source": "stock_prices",
        "required_start_date": start_date,
        "required_end_date": end_date,
        "observed_dates": len(trading_days),
        "observed_price_rows": sum(int(row.get("price_rows") or 0) for row in rows),
        "coverage_reference_rows": coverage_reference,
        "coverage_threshold_rows": coverage_threshold,
        "excluded_low_coverage_dates": excluded,
        "date_min": trading_days[0],
        "date_max": trading_days[-1],
        "training_data_source": "immutable_gcs_prep",
    }


@router.post("/walk_forward/dry-run")
async def walk_forward_dry_run(req: WalkForwardRequest):
    """Preview window plan + compute budget without triggering retrains."""
    from services.walk_forward_retrain import MODELS_ALL, walk_forward_model_coverage
    from services.backtest_engine import walk_forward_windows

    trading_days, data_access = _load_trading_calendar(req.start_date, req.end_date)
    windows = walk_forward_windows(
        trading_days=trading_days,
        train_window_days=req.train_window_days,
        test_window_days=req.test_window_days,
    )
    if not windows:
        raise HTTPException(
            status_code=400,
            detail=(
                f"No windows generated. trading_days={len(trading_days)}, "
                f"need >= {req.train_window_days + req.test_window_days}"
            ),
        )
    models = req.models or MODELS_ALL
    coverage = walk_forward_model_coverage(models)
    resume_plan = _load_resume_plan(
        req.resume_manifest_path,
        windows,
        models=models,
        prep_gcs_prefix=req.prep_gcs_prefix,
        sequence_gcs_prefix=req.sequence_gcs_prefix,
    )
    planned_windows = len(resume_plan["new_window_ids"])
    return {
        "dry_run": True,
        "windows_count": len(windows),
        "planned_retrains": planned_windows * len(coverage["native_retrain_models"]),
        "planned_new_windows": planned_windows,
        "resume_plan": resume_plan,
        "planned_model_evaluations": len(windows) * len(models),
        "estimated_tree_wall_clock_hours": planned_windows * 15 / 60 / max(1, req.concurrent_windows),
        "model_coverage": coverage,
        "data_access": data_access,
        "cohort_id": req.cohort_id or (
            f"active8-oof-{req.start_date}-{req.end_date}-"
            f"tr{req.train_window_days}-te{req.test_window_days}"
        ),
        "prep_gcs_prefix": req.prep_gcs_prefix,
        "sequence_gcs_prefix": req.sequence_gcs_prefix,
        "sequence_batch_count": req.sequence_batch_count,
        "windows": [
            {
                "window_id": w.window_id,
                "train_range": (w.train_start, w.train_end),
                "test_range": (w.test_start, w.test_end),
            }
            for w in windows
        ],
    }


@router.post("/walk_forward/run")
async def walk_forward_run(req: WalkForwardRequest):
    """Execute full walk-forward ??fire-and-forget via Modal orchestrator.

    Returns 202-style response immediately with the spawn's fn_call_id. The
    orchestrator runs inside Modal for up to 4 hours and persists the
    aggregate JSON to walk_forward/runs/{start_date}_{end_date}.json.

    Poll GET /walk_forward/report/{start}/{end} for completion.
    """
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail=(
                "walk_forward/run requires confirm=true ??triggers Modal walk-forward jobs "
                "(active-8 coverage: tree native retrain + non-tree artifact lifecycle evidence). "
                "Use /walk_forward/dry-run first."
            ),
        )

    from services.walk_forward_retrain import MODELS_ALL, walk_forward_model_coverage
    from services.backtest_engine import walk_forward_windows
    from services.payload_builder import load_market_env
    from services import modal_client
    from dataclasses import asdict
    from datetime import datetime, timezone, timedelta

    trading_days, data_access = _load_trading_calendar(req.start_date, req.end_date)
    windows = walk_forward_windows(
        trading_days=trading_days,
        train_window_days=req.train_window_days,
        test_window_days=req.test_window_days,
    )
    if not windows:
        raise HTTPException(
            status_code=400,
            detail=f"No windows generated. trading_days={len(trading_days)}, need >= {req.train_window_days + req.test_window_days}",
        )

    # Load market_env once ??orchestrator filters per-window
    run_date = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    me, _, _, _, _ = load_market_env(run_date)
    market_env = asdict(me)

    windows_payload = [
        {
            "window_id": w.window_id,
            "train_start": w.train_start,
            "train_end":   w.train_end,
            "test_start":  w.test_start,
            "test_end":    w.test_end,
        }
        for w in windows
    ]
    models = req.models or MODELS_ALL
    cohort_id = req.cohort_id or (
        f"active8-oof-{req.start_date}-{req.end_date}-"
        f"tr{req.train_window_days}-te{req.test_window_days}"
    )
    resume_plan = _load_resume_plan(
        req.resume_manifest_path,
        windows,
        models=models,
        prep_gcs_prefix=req.prep_gcs_prefix,
        sequence_gcs_prefix=req.sequence_gcs_prefix,
    )

    # Spawn Modal orchestrator (fire-and-forget)
    try:
        fn_call = modal_client.spawn_walk_forward_orchestrator({
            "windows": windows_payload,
            "market_env": market_env,
            "batch_count": req.batch_count,
            "models": models,
            "concurrent_windows": req.concurrent_windows,
            "start_date": req.start_date,
            "end_date": req.end_date,
            "train_window_days": req.train_window_days,
            "test_window_days": req.test_window_days,
            "cohort_id": cohort_id,
            "prep_gcs_prefix": req.prep_gcs_prefix,
            "sequence_gcs_prefix": req.sequence_gcs_prefix,
            "sequence_batch_count": req.sequence_batch_count,
            "resume_manifest_path": req.resume_manifest_path,
            # 2026-04-19 N2: per-window FS to eliminate look-ahead bias
            "fs_max_rounds": req.fs_max_rounds,
            "fs_force_refresh": req.fs_force_refresh,
        })
        fn_call_id = getattr(fn_call, "object_id", None) or str(fn_call)
    except Exception as e:
        logger.error(f"[WalkForward] spawn failed: {e}")
        raise HTTPException(status_code=500, detail=f"Modal spawn failed: {e}")

    logger.info(
        f"[WalkForward] spawned orchestrator: {len(windows)} windows, "
        f"fn_call_id={fn_call_id}"
    )

    return {
        "status": "spawned",
        "fn_call_id": fn_call_id,
        "windows_planned": len(windows),
        "models": models,
        "model_coverage": walk_forward_model_coverage(models),
        "data_access": data_access,
        "resume_plan": resume_plan,
        "cohort_id": cohort_id,
        "gcs_result_path": f"walk_forward/oof_cohorts/{cohort_id}/manifest.json",
        "poll_endpoint": f"/walk_forward/report/{req.start_date}/{req.end_date}",
        "poll_hint": (
            "Orchestrator runs up to 4 hrs inside Modal. Poll the GET /walk_forward/report "
            "endpoint above; 404 = still running, 200 = done."
        ),
    }


class AnalyzeRequest(BaseModel):
    start_date: str
    end_date: str


class OofForwardExtensionRequest(BaseModel):
    base_manifest_path: str
    prep_gcs_prefix: str
    sequence_gcs_prefix: str
    sequence_batch_count: int = 5
    start_date: str
    end_date: str
    knowledge_cutoff_date: str
    confirm: bool = False


@router.post("/walk_forward/oof/forward-extension")
async def build_walk_forward_oof_forward_extension(req: OofForwardExtensionRequest):
    """Build frozen forward OOS evidence without retraining or promotion."""
    if not req.confirm:
        raise HTTPException(
            status_code=400,
            detail="forward extension requires confirm=true; writes immutable shadow evidence",
        )
    from services import modal_client

    result = await modal_client.build_frozen_oof_forward_extension(req.model_dump())
    if result.get("error"):
        raise HTTPException(status_code=422, detail=result)
    if result.get("training_dispatched") is not False or result.get("promotion_eligible") is not False:
        raise HTTPException(status_code=422, detail="forward_extension_safety_contract_invalid")
    return result

class OofMaterializeRequest(BaseModel):
    cohort_id: str
    knowledge_cutoff_date: str
    manifest_path: str | None = None
    dry_run: bool = True
    confirm: bool = False
    promote: bool = True
    prediction_storage_mode: str = "gcs_indexed_v1"
    lifecycle_cadence: str = "daily"
    forward_extension_manifest_path: str | None = None


_ACTIVE8_TREE_MODELS = {"LightGBM", "XGBoost", "ExtraTrees"}
_ACTIVE8_LIFECYCLE_MODELS = {"GNN", "TabM", "PatchTST", "iTransformer"}
_ACTIVE8_FULL_FIT_MODELS = _ACTIVE8_TREE_MODELS | _ACTIVE8_LIFECYCLE_MODELS | {"DLinear"}


def build_oof_full_fit_feature_consensus(manifest: dict[str, Any]) -> dict[str, Any]:
    """Build a deterministic majority-vote tree feature set from outer OOF folds."""

    aggregate = manifest.get("aggregate") if isinstance(manifest.get("aggregate"), dict) else {}
    expected_folds = int(aggregate.get("oof_ready_folds") or 0)
    fold_features: list[tuple[str, list[str]]] = []
    for window in sorted(
        (row for row in (manifest.get("windows") or []) if isinstance(row, dict)),
        key=lambda row: int(row.get("window_id") or 0),
    ):
        feature_pool = (
            (window.get("fs_result") or {}).get("feature_pool")
            if isinstance(window.get("fs_result"), dict)
            else {}
        )
        active = sorted({str(name) for name in ((feature_pool or {}).get("tree_active") or []) if str(name)})
        if active:
            fold_features.append((f"w{int(window.get('window_id') or 0)}", active))

    if expected_folds < OOF_PROMOTION_MIN_FOLDS or len(fold_features) != expected_folds:
        return {
            "status": "blocked",
            "reason": "outer_fold_feature_evidence_incomplete",
            "expected_folds": expected_folds,
            "observed_folds": len(fold_features),
        }
    min_votes = len(fold_features) // 2 + 1
    votes: dict[str, int] = {}
    for _, features in fold_features:
        for feature in features:
            votes[feature] = votes.get(feature, 0) + 1
    selected = sorted(feature for feature, count in votes.items() if count >= min_votes)
    if len(selected) < 10:
        return {
            "status": "blocked",
            "reason": "outer_fold_feature_consensus_too_small",
            "expected_folds": expected_folds,
            "observed_folds": len(fold_features),
            "selected_count": len(selected),
        }

    artifact = {
        "schema_version": "active8-oof-full-fit-feature-consensus-v1",
        "status": "ready",
        "cohort_id": str(manifest.get("cohort_id") or ""),
        "source_manifest_checksum": str(manifest.get("manifest_checksum") or ""),
        "target_semantic_version": str(manifest.get("target_semantic_version") or ""),
        "selection_method": "outer_fold_majority_vote",
        "fold_count": len(fold_features),
        "min_votes": min_votes,
        "fold_ids": [fold_id for fold_id, _ in fold_features],
        "feature_votes": dict(sorted(votes.items())),
        "tree_active": selected,
        "active": selected,
        "selected_count": len(selected),
    }
    artifact["artifact_checksum"] = hashlib.sha256(
        json.dumps(artifact, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return artifact
def _chronological_oof_windows(windows: Any) -> bool:
    if not isinstance(windows, list) or len(windows) < 5:
        return False
    prior_test_end = ""
    seen_ids: set[str] = set()
    for window in windows:
        if not isinstance(window, dict):
            return False
        train_range = window.get("train_range")
        test_range = window.get("test_range")
        raw_window_id = window.get("window_id")
        window_id = "" if raw_window_id is None else str(raw_window_id)
        if (
            not window_id
            or window_id in seen_ids
            or not isinstance(train_range, list)
            or len(train_range) != 2
            or not isinstance(test_range, list)
            or len(test_range) != 2
        ):
            return False
        train_start, train_end = map(str, train_range)
        test_start, test_end = map(str, test_range)
        if not (train_start <= train_end < test_start <= test_end):
            return False
        if prior_test_end and prior_test_end >= test_start:
            return False
        seen_ids.add(window_id)
        prior_test_end = test_end
    return True


def build_oof_full_fit_dispatch_plan(manifest: dict[str, Any]) -> dict[str, Any]:
    aggregate = manifest.get("aggregate") if isinstance(manifest.get("aggregate"), dict) else {}
    evidence_by_model = (
        aggregate.get("per_model_promotion_evidence")
        if isinstance(aggregate.get("per_model_promotion_evidence"), dict)
        else {}
    )
    requested = [str(name) for name in (aggregate.get("full_fit_eligible_models") or [])]
    unknown = sorted(set(requested) - _ACTIVE8_FULL_FIT_MODELS)
    eligible = [
        name for name in requested
        if name in _ACTIVE8_FULL_FIT_MODELS
        and isinstance(evidence_by_model.get(name), dict)
        and evidence_by_model[name].get("decision") == "PASS"
    ]
    evidence_missing_or_failed = sorted(set(requested) - set(eligible) - set(unknown))
    window_rows = manifest.get("windows") if isinstance(manifest.get("windows"), list) else []
    chronological_windows = _chronological_oof_windows(window_rows)
    promotion_evidence = {}
    for name in eligible:
        evidence = dict(evidence_by_model[name])
        evidence["validation_design"] = {
            "schema_version": "active8-oof-validation-design-v1",
            "chronological": chronological_windows,
            "refit_each_fold": True,
            "refit_inside_test": False,
            "purge_horizon_sessions": 5,
            "fold_count": len(window_rows),
            "window_ids": [str(window.get("window_id")) for window in window_rows],
        }
        promotion_evidence[name] = evidence
    tree_models = [name for name in eligible if name in _ACTIVE8_TREE_MODELS]
    train_groups = []
    if tree_models:
        train_groups.append("tree")
    if "DLinear" in eligible:
        train_groups.append("dlinear")
    lifecycle_targets = [name for name in eligible if name in _ACTIVE8_LIFECYCLE_MODELS]
    feature_consensus = (
        build_oof_full_fit_feature_consensus(manifest)
        if tree_models
        else {"status": "not_required", "reason": "no_tree_models_eligible"}
    )
    feature_lineage_ready = not tree_models or feature_consensus.get("status") == "ready"
    prep = manifest.get("prep_manifest") if isinstance(manifest.get("prep_manifest"), dict) else {}
    prep_lineage_ready = (
        manifest.get("schema_version") == "active8-oof-cohort-manifest-v3"
        and len(str(prep.get("manifest_checksum") or "")) == 64
        and prep.get("target_semantic_version") == manifest.get("target_semantic_version")
        and float(prep.get("roundtrip_cost_bps") or 0.0) == 18.0
        and int(prep.get("batch_count") or 0) > 0
    )
    sequence = (
        manifest.get("sequence_manifest")
        if isinstance(manifest.get("sequence_manifest"), dict)
        else {}
    )
    sequence_checksums = sequence.get("batch_checksums") or {}
    sequence_lineage_ready = (
        len(str(sequence.get("artifact_checksum") or "")) == 64
        and sequence.get("contract") == "sequence_records_v3"
        and sequence.get("target_semantic_version") == manifest.get("target_semantic_version")
        and int(sequence.get("batch_count") or 0) > 0
        and len(sequence_checksums) == int(sequence.get("batch_count") or 0)
        and all(len(str(value or "")) == 64 for value in sequence_checksums.values())
    )
    status = (
        "ready"
        if (
            eligible
            and chronological_windows
            and prep_lineage_ready
            and sequence_lineage_ready
            and feature_lineage_ready
        )
        else "blocked"
    )
    if not eligible:
        reason = "no_full_fit_eligible_models"
    elif not prep_lineage_ready or not sequence_lineage_ready:
        reason = "immutable_oof_input_lineage_missing"
    elif not feature_lineage_ready:
        reason = "outer_fold_feature_consensus_missing"
    elif not chronological_windows:
        reason = "chronological_oof_windows_invalid"
    else:
        reason = "eligible_models_ready"
    return {
        "status": status,
        "reason": reason,
        "prep_lineage_ready": prep_lineage_ready,
        "sequence_lineage_ready": sequence_lineage_ready,
        "feature_lineage_ready": feature_lineage_ready,
        "feature_consensus": feature_consensus,
        "sequence_manifest": sequence,
        "prep_manifest": prep,
        "eligible_models": eligible,
        "tree_models": tree_models,
        "train_model_groups": train_groups,
        "artifact_lifecycle_targets": lifecycle_targets,
        "promotion_evidence": promotion_evidence,
        "blocked_models": aggregate.get("full_fit_blocked_models") or {},
        "unknown_models": unknown,
        "evidence_missing_or_failed": evidence_missing_or_failed,
        "chronological_windows": chronological_windows,
        "folds": int(aggregate.get("oof_ready_folds") or 0),
    }


def _repair_completed_oof_registry_owner(
    *,
    payload_summary: Any,
    expected_run_id: str,
    expected_cohort_id: str,
    expected_manifest_checksum: str,
    expected_knowledge_cutoff_date: str,
    expected_models: list[str],
) -> dict[str, Any]:
    """Rebind completed OOF artifacts to their checksum-bound lifecycle owner."""
    from services.model_artifact_registry import (
        build_artifact_records_from_retrain_followup,
        hydrate_retrain_followup_artifact_metadata,
        upsert_artifact_records,
    )

    try:
        payload = json.loads(payload_summary) if isinstance(payload_summary, str) else dict(payload_summary or {})
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        return {"status": "rejected", "reason": "callback_payload_invalid", "error": str(exc)}

    resume = payload.get("oof_lifecycle_resume")
    resume = resume if isinstance(resume, dict) else {}
    identity = {
        "run_id": str(payload.get("run_id") or ""),
        "status": str(payload.get("status") or "").lower(),
        "schema_version": str(resume.get("schema_version") or ""),
        "cohort_id": str(resume.get("cohort_id") or ""),
        "source_manifest_checksum": str(resume.get("source_manifest_checksum") or ""),
        "knowledge_cutoff_date": str(resume.get("knowledge_cutoff_date") or ""),
    }
    expected_identity = {
        "run_id": expected_run_id,
        "status": "completed",
        "schema_version": "active8-oof-lifecycle-resume-v1",
        "cohort_id": expected_cohort_id,
        "source_manifest_checksum": expected_manifest_checksum,
        "knowledge_cutoff_date": expected_knowledge_cutoff_date,
    }
    mismatches = {
        key: {"expected": expected, "actual": identity.get(key)}
        for key, expected in expected_identity.items()
        if identity.get(key) != expected
    }
    allowed_models = sorted({str(name) for name in payload.get("promotion_allowed_models") or [] if str(name)})
    expected_model_set = sorted({str(name) for name in expected_models if str(name)})
    if allowed_models != expected_model_set:
        mismatches["promotion_allowed_models"] = {
            "expected": expected_model_set,
            "actual": allowed_models,
        }
    if mismatches:
        return {
            "status": "rejected",
            "reason": "callback_lifecycle_identity_mismatch",
            "mismatches": mismatches,
        }

    hydrated = hydrate_retrain_followup_artifact_metadata(payload)
    records = build_artifact_records_from_retrain_followup(hydrated)
    by_model = {
        str(record.get("model_name") or ""): record
        for record in records
        if str(record.get("model_name") or "") in expected_model_set
    }
    missing = sorted(set(expected_model_set) - set(by_model))
    wrong_owner = sorted(
        model_name for model_name, record in by_model.items()
        if str(record.get("training_run_id") or "") != expected_run_id
    )
    if missing or wrong_owner:
        return {
            "status": "rejected",
            "reason": "callback_artifact_contract_incomplete",
            "missing_models": missing,
            "wrong_owner_models": wrong_owner,
        }

    write_result = upsert_artifact_records([by_model[name] for name in expected_model_set])
    if write_result.get("errors") or int(write_result.get("written") or 0) != len(expected_model_set):
        return {
            "status": "error",
            "reason": "registry_owner_repair_write_failed",
            "write_result": write_result,
        }
    return {
        "status": "repaired",
        "run_id": expected_run_id,
        "models": expected_model_set,
        "written": int(write_result.get("written") or 0),
    }

def _materialize_completed_oof_release_aliases(
    *,
    manifest: dict[str, Any],
    registry_rows: list[dict[str, Any]],
    expected_run_id: str,
    knowledge_cutoff_date: str,
    lifecycle_cadence: str,
    eligible_models: list[str],
    bucket: object | None = None,
    release_validation_by_model: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    from services.model_artifact_registry import (
        ACTIVE8_TARGET_SEMANTIC_VERSION,
        upsert_artifact_record,
    )

    windows = manifest.get("windows") if isinstance(manifest.get("windows"), list) else []
    checksum = str(manifest.get("manifest_checksum") or "")
    cohort_id = str(manifest.get("cohort_id") or "")
    target_semantic = str(manifest.get("target_semantic_version") or "")
    chronological = (
        manifest.get("schema_version") == "active8-oof-cohort-manifest-v3"
        and len(checksum) == 64
        and bool(cohort_id)
        and target_semantic == ACTIVE8_TARGET_SEMANTIC_VERSION
        and _chronological_oof_windows(windows)
    )
    if not chronological:
        raise RuntimeError("oof_release_alias_manifest_contract_invalid")

    if release_validation_by_model is None:
        if bucket is None:
            raise RuntimeError("oof_release_validation_bucket_missing")
        from services.active8_oof_cohort_materializer import load_oof_prediction_rows
        from services.active8_oof_release_validation import build_active8_oof_release_validation

        release_validation = build_active8_oof_release_validation(
            load_oof_prediction_rows(manifest, bucket=bucket),
            eligible_models=eligible_models,
            cohort_id=cohort_id,
            source_manifest_checksum=checksum,
        )
        release_validation_by_model = release_validation["by_model"]
    eligible = set(eligible_models)
    source_by_model: dict[str, dict[str, Any]] = {}
    source_priority = {"weekly_drift": 0, "oof_full_fit_release": 1}
    for source_row in registry_rows:
        model_name = str(source_row.get("model_name") or "")
        candidate_type = str(source_row.get("candidate_type") or "")
        if model_name not in eligible or candidate_type not in source_priority:
            continue
        current = source_by_model.get(model_name)
        if current is None or source_priority[candidate_type] < source_priority.get(
            str(current.get("candidate_type") or ""),
            99,
        ):
            source_by_model[model_name] = source_row
    written: list[str] = []
    passed_models: list[str] = []
    failed_models: list[str] = []
    errors: list[str] = []
    for model_name in eligible_models:
        source_row = source_by_model.get(model_name)
        if source_row is None:
            errors.append(f"{model_name}:oof_release_alias_source_missing")
            continue
        row = dict(source_row)
        offline = row.get("offline_evidence_json")
        if isinstance(offline, str):
            offline = json.loads(offline)
        offline = dict(offline or {})
        registration = dict(offline.get("registration") or {})
        evidence = dict(registration.get("oof_promotion_evidence") or {})
        metadata = dict(registration.get("metadata") or {})
        failed_gates = evidence.get("failed_gates")
        checksum_value = str(row.get("checksum") or registration.get("checksum") or "")
        candidate_type = str(row.get("candidate_type") or "")
        version = str(row.get("version") or "")
        canonical_source_id = f"{model_name}:{version}:{candidate_type}"
        valid = (
            str(row.get("training_run_id") or "") == expected_run_id
            and str(row.get("artifact_id") or "") == canonical_source_id
            and str(row.get("state") or "") in {"offline_passed", "offline_strong_pass"}
            and str(row.get("offline_gate_decision") or "") in {"PASS", "STRONG_PASS"}
            and evidence.get("schema_version") == "model-cpcv-evidence-v1"
            and evidence.get("method") == "outer_purged_walk_forward_rank_ic"
            and evidence.get("decision") == "PASS"
            and evidence.get("passed") is True
            and not failed_gates
            and int(evidence.get("folds") or 0) >= 5
            and str(metadata.get("target_semantic_version") or "") == target_semantic
            and checksum_value.startswith("sha256:")
        )
        if not valid:
            errors.append(f"{model_name}:oof_release_alias_source_invalid")
            continue
        evidence["validation_design"] = {
            "schema_version": "active8-oof-validation-design-v1",
            "chronological": True,
            "refit_each_fold": True,
            "refit_inside_test": False,
            "purge_horizon_sessions": 5,
            "fold_count": len(windows),
            "window_ids": [str(window.get("window_id")) for window in windows],
        }
        model_release_validation = dict(
            (release_validation_by_model or {}).get(model_name) or {}
        )
        if not model_release_validation:
            errors.append(f"{model_name}:oof_release_validation_missing")
            continue
        registration["oof_promotion_evidence"] = evidence
        registration["oof_release_validation"] = model_release_validation
        registration["model_cpcv"] = evidence
        registration["oof_lifecycle_resume"] = {
            "schema_version": "active8-oof-lifecycle-resume-v1",
            "cohort_id": cohort_id,
            "source_manifest_checksum": checksum,
            "knowledge_cutoff_date": knowledge_cutoff_date,
            "cadence": lifecycle_cadence,
        }
        offline["registration"] = registration
        offline["pbo"] = model_release_validation["pbo"]
        offline["validation_packet"] = model_release_validation
        release_passed = model_release_validation.get("decision") == "PASS"
        row["candidate_type"] = "oof_full_fit_release"
        row["state"] = row.get("state") if release_passed else "offline_failed"
        row["offline_gate_status"] = "passed" if release_passed else "failed"
        row["offline_gate_decision"] = (
            row.get("offline_gate_decision") if release_passed else "FAIL"
        )
        row["offline_gate_failed_gates"] = json.dumps(
            [] if release_passed else model_release_validation.get("failed_gates") or []
        )
        row["artifact_id"] = f"{model_name}:{row.get('version')}:oof_full_fit_release"
        row["offline_evidence_json"] = json.dumps(offline, sort_keys=True)
        row["promotion_decision"] = "not_evaluated"
        row["approval_state"] = "not_required"
        upsert_artifact_record(row)
        written.append(row["artifact_id"])
        (passed_models if release_passed else failed_models).append(model_name)
    if errors or len(written) != len(eligible):
        raise RuntimeError(
            "oof_release_alias_incomplete:"
            + ",".join(errors or [f"written={len(written)} expected={len(eligible)}"])
        )
    return {
        "status": "materialized",
        "candidate_type": "oof_full_fit_release",
        "written": len(written),
        "artifact_ids": written,
        "passed_models": sorted(passed_models),
        "failed_models": sorted(failed_models),
        "cohort_id": cohort_id,
        "manifest_checksum": checksum,
    }


async def dispatch_oof_full_fit_training(
    *,
    manifest: dict[str, Any],
    knowledge_cutoff_date: str,
    bucket: Any,
    lifecycle_cadence: str,
) -> dict[str, Any]:
    from services import d1_client

    plan = build_oof_full_fit_dispatch_plan(manifest)
    if plan["status"] != "ready":
        return plan

    cohort_id = str(manifest.get("cohort_id") or "")
    feature_pool_contract: dict[str, Any] = {}
    if plan["tree_models"]:
        feature_consensus = dict(plan.get("feature_consensus") or {})
        feature_pool_path = (
            f"walk_forward/oof_cohorts/{cohort_id}/full_fit/feature_pool.json"
        )
        bucket.blob(feature_pool_path).upload_from_string(
            json.dumps(feature_consensus, sort_keys=True),
            content_type="application/json",
        )
        feature_pool_contract = {
            "path": feature_pool_path,
            "artifact_checksum": feature_consensus["artifact_checksum"],
            "selected_count": feature_consensus["selected_count"],
            "fold_count": feature_consensus["fold_count"],
            "min_votes": feature_consensus["min_votes"],
        }
    receipt_path = (
        f"walk_forward/oof_cohorts/{cohort_id}/full_fit/"
        f"{knowledge_cutoff_date}.json"
    )
    receipt_blob = bucket.blob(receipt_path)
    receipt: dict[str, Any] = {}
    if receipt_blob.exists():
        receipt = json.loads(receipt_blob.download_as_text())

    attempt = int(receipt.get("attempt") or 0)
    prior_run_id = str(receipt.get("run_id") or "")
    if prior_run_id:
        rows = d1_client.query(
            """
            SELECT *
            FROM model_artifact_registry
            WHERE training_run_id = ?
            """,
            [prior_run_id],
        )
        by_model = {str(row.get("model_name") or ""): str(row.get("state") or "") for row in rows}
        missing = sorted(set(plan["eligible_models"]) - set(by_model))
        failed = sorted(
            model_name for model_name, state in by_model.items()
            if model_name in plan["eligible_models"]
            and state in {"registration_failed", "offline_failed", "rejected"}
        )
        if not missing and not failed:
            release_registry = _materialize_completed_oof_release_aliases(
                manifest=manifest,
                registry_rows=rows,
                expected_run_id=prior_run_id,
                knowledge_cutoff_date=knowledge_cutoff_date,
                lifecycle_cadence=lifecycle_cadence,
                eligible_models=plan["eligible_models"],

                bucket=bucket,
            )
            completed = {
                **receipt,
                "release_registry": release_registry,
                "schema_version": "active8-oof-full-fit-receipt-v1",
                "status": "completed",
                "eligible_models": plan["eligible_models"],
                "artifact_states": by_model,
                "reason": "artifact_registry_complete",
                "missing_models": [],
                "failed_models": [],
                "retry_required": False,
            }
            receipt_blob.upload_from_string(
                json.dumps(completed, sort_keys=True),
                content_type="application/json",
            )
            return {**plan, **completed, "retry_required": False, "receipt_path": receipt_path}

        webhook = d1_client.query(
            "SELECT status, payload_summary FROM webhook_log WHERE idempotency_key = ? LIMIT 1",
            [prior_run_id],
        )
        webhook_row = webhook[0] if webhook else {}
        webhook_status = str(webhook_row.get("status") or "").lower()
        registry_repair: dict[str, Any] | None = None
        if webhook_status == "completed" and missing:
            registry_repair = _repair_completed_oof_registry_owner(
                payload_summary=webhook_row.get("payload_summary"),
                expected_run_id=prior_run_id,
                expected_cohort_id=cohort_id,
                expected_manifest_checksum=str(manifest.get("manifest_checksum") or ""),
                expected_knowledge_cutoff_date=knowledge_cutoff_date,
                expected_models=plan["eligible_models"],
            )
            if registry_repair["status"] == "repaired":
                rows = d1_client.query(
                    """
                    SELECT *
                    FROM model_artifact_registry
                    WHERE training_run_id = ?
                    """,
                    [prior_run_id],
                )
                by_model = {
                    str(row.get("model_name") or ""): str(row.get("state") or "")
                    for row in rows
                }
                missing = sorted(set(plan["eligible_models"]) - set(by_model))
                failed = sorted(
                    model_name for model_name, state in by_model.items()
                    if model_name in plan["eligible_models"]
                    and state in {"registration_failed", "offline_failed", "rejected"}
                )
                if not missing and not failed:
                    release_registry = _materialize_completed_oof_release_aliases(
                        manifest=manifest,
                        registry_rows=rows,
                        expected_run_id=prior_run_id,
                        knowledge_cutoff_date=knowledge_cutoff_date,
                        lifecycle_cadence=lifecycle_cadence,
                        eligible_models=plan["eligible_models"],

                        bucket=bucket,
                    )
                    completed = {
                        **receipt,
                        "release_registry": release_registry,
                        "schema_version": "active8-oof-full-fit-receipt-v1",
                        "status": "completed",
                        "eligible_models": plan["eligible_models"],
                        "artifact_states": by_model,
                        "reason": "artifact_registry_complete",
                        "missing_models": [],
                        "failed_models": [],
                        "retry_required": False,
                        "registry_repair": registry_repair,
                    }
                    receipt_blob.upload_from_string(
                        json.dumps(completed, sort_keys=True),
                        content_type="application/json",
                    )
                    return {
                        **plan,
                        **completed,
                        "retry_required": False,
                        "receipt_path": receipt_path,
                    }
        terminal_failure = webhook_status == "error" or bool(failed) or (
            webhook_status == "completed" and bool(missing)
        )
        if not terminal_failure:
            return {
                **plan,
                **receipt,
                "status": "pending",
                "missing_models": missing,
                "retry_required": True,
                "receipt_path": receipt_path,
            }
        if attempt >= 3:
            blocked = {
                **receipt,
                "status": "blocked",
                "reason": "full_fit_retry_limit_reached",
                "missing_models": missing,
                "failed_models": failed,
                "webhook_status": webhook_status,
                "registry_repair": registry_repair,
                "retry_required": True,
                "receipt_path": receipt_path,
            }
            receipt_blob.upload_from_string(
                json.dumps(blocked, sort_keys=True),
                content_type="application/json",
            )
            return {**plan, **blocked}

    from routers.retrain_trigger import UniversalRetrainTriggerRequest, trigger_universal_retrain

    target_semantic = str(manifest.get("target_semantic_version") or "")
    lifecycle_contracts = {
        name: target_semantic for name in plan["artifact_lifecycle_targets"]
    }
    request = UniversalRetrainTriggerRequest(
        limit=2500,
        force_monthly=False,
        run_date=knowledge_cutoff_date,
        candidate_type="oof_full_fit_release",
        drift_target_models=plan["eligible_models"],
        train_model_groups=plan["train_model_groups"],
        artifact_lifecycle_targets=plan["artifact_lifecycle_targets"],
        artifact_lifecycle_contracts=lifecycle_contracts,
        artifact_lifecycle_only=not plan["train_model_groups"],
        require_exact_dataset_snapshot=True,
        prebuilt_prep_gcs_prefix=str(manifest.get("prep_gcs_prefix") or "") or None,
        prebuilt_prep_manifest_checksum=str((manifest.get("prep_manifest") or {}).get("manifest_checksum") or "") or None,
        prebuilt_prep_target_semantic_version=target_semantic or None,
        prebuilt_prep_source_cohort_id=cohort_id,
        prebuilt_prep_source_manifest_checksum=str(manifest.get("manifest_checksum") or "") or None,
        prebuilt_feature_pool_path=str(feature_pool_contract.get("path") or "") or None,
        prebuilt_feature_pool_checksum=str(feature_pool_contract.get("artifact_checksum") or "") or None,
        prebuilt_sequence_manifest_checksum=str((manifest.get("sequence_manifest") or {}).get("artifact_checksum") or "") or None,
        prebuilt_sequence_batch_checksums=dict((manifest.get("sequence_manifest") or {}).get("batch_checksums") or {}),
        oof_lifecycle_resume={
            "schema_version": "active8-oof-lifecycle-resume-v1",
            "cohort_id": cohort_id,
            "source_manifest_checksum": str(manifest.get("manifest_checksum") or ""),
            "knowledge_cutoff_date": knowledge_cutoff_date,
            "cadence": lifecycle_cadence,
        },
        sequence_gcs_prefix=str(manifest.get("sequence_gcs_prefix") or "") or None,
        sequence_batch_count=int(manifest.get("sequence_batch_count") or 0) or None,
        register_challengers=bool(plan["tree_models"]),
        promotion_allowed_models=plan["eligible_models"],
        oof_promotion_evidence=plan["promotion_evidence"],
    )
    result = await trigger_universal_retrain(request, request=None)
    if not isinstance(result, dict):
        raise RuntimeError("oof_full_fit_dispatch_invalid_response")
    if result.get("error"):
        raise RuntimeError(f"oof_full_fit_dispatch_failed:{result['error']}")
    if str(result.get("status") or "").lower() == "skipped":
        return {
            **plan,
            "status": "pending",
            "reason": result.get("reason") or "universal_retrain_lock_active",
            "retry_required": True,
            "dispatch": result,
            "receipt_path": receipt_path,
        }

    run_id = str(result.get("run_id") or "")
    if not run_id:
        raise RuntimeError("oof_full_fit_dispatch_run_id_missing")
    dispatched = {
        "schema_version": "active8-oof-full-fit-receipt-v1",
        "status": "dispatched",
        "cohort_id": cohort_id,
        "knowledge_cutoff_date": knowledge_cutoff_date,
        "run_id": run_id,
        "attempt": attempt + 1,
        "eligible_models": plan["eligible_models"],
        "feature_pool": feature_pool_contract,
        "dispatch": result,
    }
    receipt_blob.upload_from_string(
        json.dumps(dispatched, sort_keys=True),
        content_type="application/json",
    )
    return {
        **plan,
        **dispatched,
        "retry_required": True,
        "receipt_path": receipt_path,
    }


@router.post("/walk_forward/oof/materialize")
async def materialize_walk_forward_oof(req: OofMaterializeRequest):
    """Verify one OOF manifest and build the L4/Fusion offline evidence chain."""

    if not req.dry_run and not req.confirm:
        raise HTTPException(status_code=400, detail="non-dry OOF materialization requires confirm=true")
    if req.forward_extension_manifest_path and (not req.dry_run or req.promote):
        raise HTTPException(
            status_code=400,
            detail="frozen forward extension is dry-run shadow evidence only and requires promote=false",
        )
    from services.walk_forward_retrain import _get_bucket
    from services.active8_oof_cohort_materializer import (
        build_oof_snapshot_rows,
        build_fusion_oof_rows,
        archive_ev_candidate_artifacts,
        load_native_pit_component_rows,
        load_fundamental_quality_pit_by_key,
        load_oof_forward_prediction_rows,
        load_oof_prediction_rows,
        load_verified_oof_forward_extension,
        load_verified_oof_manifest,
        persist_oof_cohort,
    )
    from services.l4_alpha_ev_artifact_builder import (
        build_l4_alpha_ev_artifact_from_rows,
        build_l4_chronological_oof_predictions,
    )
    from services.allocator_ev_fusion_artifact_builder import (
        build_allocator_ev_fusion_artifact_from_rows,
    )
    from services.fusion_market_context import load_pit_market_contexts
    from services import d1_client

    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable")
    path = req.manifest_path or f"walk_forward/oof_cohorts/{req.cohort_id}/manifest.json"
    try:
        manifest, _raw = load_verified_oof_manifest(path, bucket=bucket)
        if manifest["cohort_id"] != req.cohort_id:
            raise ValueError("requested_cohort_manifest_mismatch")
        prediction_rows = load_oof_prediction_rows(manifest, bucket=bucket)
        forward_extension = None
        forward_prediction_rows: list[dict[str, Any]] = []
        if req.forward_extension_manifest_path:
            forward_extension = load_verified_oof_forward_extension(
                req.forward_extension_manifest_path,
                bucket=bucket,
                base_manifest=manifest,
            )
            forward_prediction_rows = load_oof_forward_prediction_rows(
                forward_extension,
                bucket=bucket,
                materialized_cohort=req.cohort_id,
            )
            prediction_rows.extend(forward_prediction_rows)
        native_rows = load_native_pit_component_rows(prediction_rows)
        prediction_dates = sorted({
            str(row.get("prediction_date") or "")[:10]
            for row in prediction_rows if row.get("prediction_date")
        })
        market_context_by_date = load_pit_market_contexts(d1_client.query, prediction_dates)
        fundamental_quality_by_key = load_fundamental_quality_pit_by_key(prediction_rows)
        snapshot_rows, snapshot_evidence = build_oof_snapshot_rows(
            prediction_rows,
            native_rows,
            cohort_id=req.cohort_id,
            source_manifest_checksum=manifest["manifest_checksum"],
            fundamental_quality_by_key=fundamental_quality_by_key,
            market_context_by_date=market_context_by_date,
        )
        l4_result = build_l4_alpha_ev_artifact_from_rows(
            snapshot_rows,
            trained_until=req.knowledge_cutoff_date,
            generation_mode="purged_oof",
            cohort_id=req.cohort_id,
        )
        l4_predictions, l4_prediction_evidence = build_l4_chronological_oof_predictions(
            snapshot_rows,
            cohort_id=req.cohort_id,
        )
        fusion_rows = build_fusion_oof_rows(
            snapshot_rows,
            l4_predictions,
            knowledge_cutoff_date=req.knowledge_cutoff_date,
        )
        fusion_result = build_allocator_ev_fusion_artifact_from_rows(
            fusion_rows,
            trained_until=req.knowledge_cutoff_date,
            knowledge_cutoff_date=req.knowledge_cutoff_date,
            generation_mode="purged_oof",
            cohort_id=req.cohort_id,
        )
        if forward_extension:
            for result in (l4_result, fusion_result):
                artifact = result.get("artifact") if isinstance(result, dict) else None
                if isinstance(artifact, dict):
                    artifact["generation_mode"] = "purged_oof_plus_frozen_forward_oos_shadow"
                    artifact["promotion_state"] = "shadow_only"
                packet = result.get("validation_packet") if isinstance(result, dict) else None
                if isinstance(packet, dict):
                    packet["decision"] = "FAIL"
                    failed = list(packet.get("failed_gates") or [])
                    if "frozen_forward_oos_shadow_only" not in failed:
                        failed.append("frozen_forward_oos_shadow_only")
                    packet["failed_gates"] = failed
                    packet["forward_extension"] = {
                        "manifest_path": req.forward_extension_manifest_path,
                        "manifest_checksum": forward_extension["manifest_checksum"],
                        "rows": len(forward_prediction_rows),
                        "dates": forward_extension["dates"],
                        "promotion_eligible": False,
                    }
        full_fit_plan = build_oof_full_fit_dispatch_plan(manifest)
        persistence = persist_oof_cohort(
            manifest=manifest,
            prediction_rows=prediction_rows,
            snapshot_rows=snapshot_rows,
            l4_predictions=l4_predictions,
            bucket=bucket,
            knowledge_cutoff_date=req.knowledge_cutoff_date,
            dry_run=req.dry_run,
            prediction_storage_mode=req.prediction_storage_mode,
        )
        parity = None
        promoted = False
        promotion_error = None
        candidate_artifacts = None
        promotion_receipts = None
        promotion_receipt_error = None
        notification_sent = False
        opb_refresh: dict[str, Any] | None = None
        l4_artifact = l4_result.get("artifact") if isinstance(l4_result, dict) else None
        fusion_artifact = fusion_result.get("artifact") if isinstance(fusion_result, dict) else None
        l4_decision = str((l4_result.get("validation_packet") or {}).get("decision") or "")
        fusion_decision = str((fusion_result.get("validation_packet") or {}).get("decision") or "")
        fusion_tier = str(
            ((fusion_result.get("validation_packet") or {}).get("promotion") or {}).get("tier")
            or (fusion_artifact or {}).get("promotion_tier")
            or ""
        )
        if (
            not req.dry_run
            and l4_decision == "PASS"
            and fusion_decision == "PASS"
            and fusion_tier == "primary"
        ):
            from services.ev_operational_parity import assess_ev_operational_parity
            from services.worker_config_client import worker_fetch

            latest = d1_client.query(
                """
                SELECT MAX(date) prediction_date
                FROM daily_recommendations
                WHERE json_extract(score_components, '$.semanticVersion') = ?
                """,
                ["score-v2-active8-components-v3"],
            )
            latest_date = str((latest[0] if latest else {}).get("prediction_date") or "")
            parity_rows = load_native_pit_component_rows([{"prediction_date": latest_date}]) if latest_date else []
            parity = assess_ev_operational_parity(
                l4_artifact=l4_artifact,
                fusion_artifact=fusion_artifact,
                native_rows=parity_rows,
            )
            candidate_artifacts = archive_ev_candidate_artifacts(
                bucket=bucket,
                cohort_id=req.cohort_id,
                source_run_date=req.knowledge_cutoff_date,
                manifest_path=path,
                l4_result=l4_result,
                fusion_result=fusion_result,
                parity=parity,
                promoted=False,
            )
            if req.promote and parity.get("decision") == "PASS":
                serving_l4 = {
                    **l4_artifact,
                    "promotion_state": "production_approved",
                    "approval_state": "production_approved",
                    "operational_parity": parity,
                }
                serving_fusion = {
                    **fusion_artifact,
                    "promotion_state": "production_primary",
                    "promotion_tier": "primary",
                    "primary_expected_return_allowed": True,
                    "operational_parity_required": False,
                    "operational_parity": parity,
                }
                try:
                    await worker_fetch(
                        "/api/admin/config",
                        method="PUT",
                        json_body={
                            "ensemble_v2": {
                                "l4AlphaEv": serving_l4,
                                "l4_alpha_ev": serving_l4,
                                "allocatorEvFusion": serving_fusion,
                                "allocator_ev_fusion": serving_fusion,
                            },
                            "meta": {
                                "source": "active8_oof_automatic_promotion",
                                "push_id": f"active8_oof:{req.cohort_id}:{req.knowledge_cutoff_date}",
                                "promotion_reason": "offline_oof_quality_pass_and_native_operational_parity_pass",
                            },
                        },
                        timeout=30.0,
                    )
                    promoted = True
                    try:
                        opb_refresh = await worker_fetch(
                            "/api/admin/trigger/opb-arm-prior-refresh"
                            f"?sync=1&date={req.knowledge_cutoff_date}"
                            "&expected_return_owner=allocator_ev_fusion",
                            method="POST",
                            timeout=120.0,
                        )
                    except Exception as exc:  # noqa: BLE001 - EV promotion is durable; daily lifecycle retries OPB.
                        opb_refresh = {"status": "failed", "error": str(exc)}
                    try:
                        from services.discord_alert import alert_lifecycle

                        notification_sent = await asyncio.to_thread(
                            alert_lifecycle,
                            event="promote",
                            model_name="L4+Fusion OOF",
                            from_status="offline_candidate",
                            to_status="production",
                            reason="purged OOF quality PASS and native operational parity PASS",
                            metrics={
                                "cohort_id": req.cohort_id,
                                "knowledge_cutoff_date": req.knowledge_cutoff_date,
                                "l4_serving_coverage": parity.get("l4_serving_coverage"),
                                "fusion_serving_coverage": parity.get("fusion_serving_coverage"),
                                "feature_mismatch_count": parity.get("feature_mismatch_count"),
                            },
                        )
                    except Exception:  # noqa: BLE001 - alert is non-blocking after durable promotion evidence.
                        notification_sent = False
                except Exception as exc:  # noqa: BLE001
                    promotion_error = str(exc)
            if promoted:
                try:
                    promotion_receipts = archive_ev_candidate_artifacts(
                        bucket=bucket,
                        cohort_id=req.cohort_id,
                        source_run_date=req.knowledge_cutoff_date,
                        manifest_path=path,
                        l4_result=l4_result,
                        fusion_result=fusion_result,
                        parity=parity,
                        promoted=True,
                    )
                except Exception as exc:  # noqa: BLE001 - config mutation already has Worker audit snapshot.
                    promotion_receipt_error = str(exc)
        full_fit_dispatch = full_fit_plan
        if not req.dry_run and req.promote:
            full_fit_dispatch = await dispatch_oof_full_fit_training(
                manifest=manifest,
                knowledge_cutoff_date=req.knowledge_cutoff_date,
                bucket=bucket,
                lifecycle_cadence=req.lifecycle_cadence,
            )
        if not req.dry_run and candidate_artifacts is None:
            candidate_artifacts = archive_ev_candidate_artifacts(
                bucket=bucket,
                cohort_id=req.cohort_id,
                source_run_date=req.knowledge_cutoff_date,
                manifest_path=path,
                l4_result=l4_result,
                fusion_result=fusion_result,
                parity=parity,
                promoted=False,
            )
        return {
            "status": "dry_run" if req.dry_run else "materialized",
            "cohort_id": req.cohort_id,
            "prediction_rows": len(prediction_rows),
            "base_prediction_rows": len(prediction_rows) - len(forward_prediction_rows),
            "forward_prediction_rows": len(forward_prediction_rows),
            "forward_extension": forward_extension,
            "native_pit_rows": len(native_rows),
            "fundamental_pit_rows": len(fundamental_quality_by_key),
            "snapshot_evidence": snapshot_evidence,
            "l4_result": l4_result,
            "l4_prediction_evidence": l4_prediction_evidence,
            "fusion_result": fusion_result,
            "fusion_rows": len(fusion_rows),
            "persistence": persistence,
            "operational_parity": parity,
            "promoted": promoted,
            "promotion_error": promotion_error,
            "candidate_artifacts": candidate_artifacts,
            "promotion_receipts": promotion_receipts,
            "promotion_receipt_error": promotion_receipt_error,
            "notification_sent": notification_sent,
            "opb_refresh": opb_refresh,
            "full_fit_dispatch": full_fit_dispatch,
            "full_fit_retry_required": bool(full_fit_dispatch.get("retry_required")),
            "promotion_allowed": bool(parity and parity.get("decision") == "PASS"),
            "fusion_promotion_tier": fusion_tier,
            "promotion_reason": (
                "offline_oof_quality_pass_and_native_operational_parity_pass"
                if promoted
                else "quality_or_operational_parity_not_passed"
            ),
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class OofLifecycleRequest(BaseModel):
    cadence: str = "daily"
    end_date: str | None = None
    dry_run: bool = False
    promote: bool = True
    expected_cohort_id: str | None = None


OOF_TRAIN_SESSIONS = 60
OOF_TEST_SESSIONS = 10
OOF_PROMOTION_MIN_FOLDS = 5
OOF_LABEL_PURGE_SESSIONS = 5
OOF_MIN_MATURE_SESSIONS = (
    OOF_TRAIN_SESSIONS + OOF_TEST_SESSIONS * OOF_PROMOTION_MIN_FOLDS
)
OOF_LIFECYCLE_RECEIPT_SCHEMA_VERSION = "active8-oof-lifecycle-receipt-v2-rematerialize"
OOF_LIFECYCLE_MIN_SESSIONS = OOF_MIN_MATURE_SESSIONS
_OOF_TARGET_SEMANTIC_VERSION = (
    "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
)


def _latest_canonical_prep_prefix(bucket: object) -> str | None:
    candidates: list[tuple[str, str]] = []
    for blob in bucket.list_blobs(prefix="universal/canonical_adjusted"):
        if not str(blob.name).endswith("/prep/manifest.json"):
            continue
        try:
            manifest = json.loads(blob.download_as_text())
        except Exception:  # noqa: BLE001 - invalid prep candidates are ignored.
            continue
        if (
            manifest.get("schema_version") == "active8-canonical-adjusted-prep-v1"
            and manifest.get("status") == "ready"
            and manifest.get("target_semantic_version") == _OOF_TARGET_SEMANTIC_VERSION
            and float(manifest.get("roundtrip_cost_bps") or 0.0) == 18.0
        ):
            candidates.append((str(manifest.get("created_at") or ""), str(manifest.get("output_gcs_prefix") or "")))
    if not candidates:
        return None
    prefix = max(candidates)[1].strip().rstrip("/")
    return prefix or None


def _oof_lifecycle_calendar(
    end_date: str | None,
    *,
    bucket: object,
    prep_gcs_prefix: str,
) -> tuple[list[str], dict[str, object]]:
    import hashlib
    import io
    from collections import Counter
    from datetime import datetime, timedelta, timezone

    import numpy as np

    cutoff = end_date or datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    prefix = str(prep_gcs_prefix or "").strip().rstrip("/")
    if not prefix or prefix == "universal":
        raise ValueError("oof_lifecycle_immutable_prep_prefix_missing")
    manifest_path = f"{prefix}/prep/manifest.json"
    manifest = json.loads(bucket.blob(manifest_path).download_as_text())
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    actual_manifest_checksum = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True).encode("utf-8")
    ).hexdigest()
    if (
        manifest.get("schema_version") != "active8-canonical-adjusted-prep-v1"
        or manifest.get("status") != "ready"
        or str(manifest.get("output_gcs_prefix") or "").rstrip("/") != prefix
        or manifest.get("target_semantic_version") != _OOF_TARGET_SEMANTIC_VERSION
        or float(manifest.get("roundtrip_cost_bps") or 0.0) != 18.0
        or manifest.get("manifest_checksum") != actual_manifest_checksum
    ):
        raise ValueError("oof_lifecycle_immutable_prep_manifest_invalid")

    output_checksums = dict(manifest.get("output_checksums") or {})
    batch_rows = [int(value) for value in (manifest.get("batch_rows") or [])]
    expected_paths = [f"{prefix}/prep/batch_{index}.npz" for index in range(len(batch_rows))]
    if not batch_rows or sorted(output_checksums) != sorted(expected_paths):
        raise ValueError("oof_lifecycle_immutable_prep_inventory_invalid")

    coverage_by_date: Counter[str] = Counter()
    mature_rows = 0
    for path in expected_paths:
        raw = bucket.blob(path).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != str(output_checksums.get(path) or ""):
            raise ValueError(f"oof_lifecycle_immutable_prep_checksum_mismatch:{path}")
        data = np.load(io.BytesIO(raw), allow_pickle=True)
        required = {"dates", "markets", "label_known_dates"}
        if not required.issubset(data.files):
            raise ValueError(f"oof_lifecycle_immutable_prep_lineage_missing:{path}")
        dates = np.asarray(data["dates"]).astype(str)
        markets = np.asarray(data["markets"]).astype(str)
        known_dates = np.asarray(data["label_known_dates"]).astype(str)
        if len({len(dates), len(markets), len(known_dates)}) != 1:
            raise ValueError(f"oof_lifecycle_immutable_prep_array_mismatch:{path}")
        for signal_date, market, known_date in zip(dates, markets, known_dates):
            signal = str(signal_date)[:10]
            known = str(known_date)[:10]
            if signal and market and known and signal <= cutoff and known <= cutoff:
                coverage_by_date[signal] += 1
                mature_rows += 1

    counts = list(coverage_by_date.values())
    reference = float(statistics.median(counts)) if counts else 0.0
    threshold = max(1, int(reference * 0.20))
    dates = sorted(date for date, count in coverage_by_date.items() if count >= threshold)
    return dates, {
        "cutoff": cutoff,
        "calendar_source": "immutable_canonical_adjusted_prep",
        "prep_gcs_prefix": prefix,
        "prep_manifest_checksum": actual_manifest_checksum,
        "sequence_gcs_prefix": str(manifest.get("sequence_gcs_prefix") or ""),
        "observed_dates": len(coverage_by_date),
        "mature_dates": len(dates),
        "mature_rows": mature_rows,
        "coverage_reference_rows": reference,
        "coverage_threshold_rows": threshold,
    }

def _latest_ready_oof_manifest(bucket: object) -> tuple[str, dict] | None:
    import json

    ready: list[tuple[str, dict]] = []
    for blob in bucket.list_blobs(prefix="walk_forward/oof_cohorts/"):
        if not str(blob.name).endswith("/manifest.json"):
            continue
        try:
            manifest = json.loads(blob.download_as_text())
        except Exception:  # noqa: BLE001 - corrupt candidates are ignored, never promoted.
            continue
        if manifest.get("status") == "ready" and manifest.get("generation_mode") == "purged_oof":
            ready.append((str(blob.name), manifest))
    if not ready:
        return None
    by_path = {path: manifest for path, manifest in ready}
    superseded_paths: set[str] = set()
    for _path, manifest in ready:
        revision = (
            manifest.get("evidence_revision")
            if isinstance(manifest.get("evidence_revision"), dict)
            else {}
        )
        base_path = str(revision.get("base_manifest_path") or "").strip()
        base_checksum = str(revision.get("base_manifest_checksum") or "").strip()
        base = by_path.get(base_path)
        if (
            revision.get("schema_version") == "active8-oof-evidence-revision-v1"
            and base is not None
            and len(base_checksum) == 64
            and str(base.get("manifest_checksum") or "") == base_checksum
        ):
            superseded_paths.add(base_path)
    eligible = [item for item in ready if item[0] not in superseded_paths]
    return max(
        eligible,
        key=lambda item: (
            str(item[1].get("end_date") or ""),
            str(item[1].get("generated_at") or item[1].get("completed_at") or ""),
            item[0],
        ),
    )


@router.post("/walk_forward/oof/lifecycle")
async def run_walk_forward_oof_lifecycle(req: OofLifecycleRequest):
    """Idempotent cadence owner for OOF generation, materialization and promotion."""

    import json
    from datetime import datetime, timezone
    from services.walk_forward_retrain import _get_bucket

    cadence = str(req.cadence or "daily").strip().lower()
    if cadence not in {"daily", "weekly", "monthly"}:
        raise HTTPException(status_code=400, detail="OOF lifecycle cadence must be daily, weekly, or monthly")
    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable")
    parent = _latest_ready_oof_manifest(bucket)
    parent_manifest = parent[1] if parent is not None else {}
    prep_gcs_prefix = str(parent_manifest.get("prep_gcs_prefix") or "").strip().rstrip("/")
    if not prep_gcs_prefix or prep_gcs_prefix == "universal":
        prep_gcs_prefix = _latest_canonical_prep_prefix(bucket) or ""
    if not prep_gcs_prefix:
        raise HTTPException(status_code=422, detail="OOF lifecycle immutable canonical prep unavailable")
    try:
        dates, calendar_evidence = _oof_lifecycle_calendar(
            req.end_date,
            bucket=bucket,
            prep_gcs_prefix=prep_gcs_prefix,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if len(dates) < OOF_LIFECYCLE_MIN_SESSIONS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"OOF lifecycle requires {OOF_LIFECYCLE_MIN_SESSIONS} mature immutable-prep sessions "
                f"for {OOF_PROMOTION_MIN_FOLDS} purged folds, found {len(dates)}"
            ),
        )
    knowledge_cutoff_date = str(calendar_evidence["cutoff"])

    selected: tuple[str, dict] | None = None
    if cadence == "daily":
        selected = parent
        if selected is None:
            return {
                "status": "skipped",
                "reason": "no_ready_purged_oof_manifest",
                "cadence": cadence,
                "calendar": calendar_evidence,
            }
    else:
        from services.backtest_engine import walk_forward_windows

        mature_dates = dates
        resume_manifest_path = None
        sequence_gcs_prefix = str(
            parent_manifest.get("sequence_gcs_prefix")
            or calendar_evidence.get("sequence_gcs_prefix")
            or "universal/sequence_long/latest"
        )
        if parent is not None:
            parent_path, parent_manifest = parent
            parent_start = str(parent_manifest.get("start_date") or "")[:10]
            compatible_parent = (
                parent_start in mature_dates
                and int(parent_manifest.get("train_window_days") or 0) == 60
                and int(parent_manifest.get("test_window_days") or 0) == 10
                and parent_manifest.get("target_semantic_version")
                == "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
            )
        else:
            parent_path, parent_manifest, parent_start, compatible_parent = None, {}, "", False

        if compatible_parent:
            parent_windows = list(parent_manifest.get("windows") or [])
            parent_fold_count = len(parent_windows)
            parent_end = str(parent_manifest.get("end_date") or "")[:10]
            new_mature_dates = [date for date in mature_dates if date > parent_end]
            if parent_fold_count < OOF_PROMOTION_MIN_FOLDS:
                parent_start_index = mature_dates.index(parent_start)
                prepend_sessions = OOF_TEST_SESSIONS * (
                    OOF_PROMOTION_MIN_FOLDS - parent_fold_count
                )
                cohort_start_index = parent_start_index - prepend_sessions
                if cohort_start_index < 0:
                    raise HTTPException(
                        status_code=422,
                        detail="OOF immutable prep lacks enough earlier mature sessions",
                    )
                start_date = mature_dates[cohort_start_index]
                signal_end_date = parent_end
            elif len(new_mature_dates) >= OOF_TEST_SESSIONS:
                start_date = parent_start
                signal_end_date = new_mature_dates[OOF_TEST_SESSIONS - 1]
            else:
                start_date = parent_start
                signal_end_date = parent_end

            if start_date == parent_start and signal_end_date == parent_end:
                cohort_id = str(parent_manifest["cohort_id"])
                manifest_path = str(parent_path)
            else:
                cohort_id = (
                    f"active8-oof-v5-{start_date}-{signal_end_date}-"
                    f"tr{OOF_TRAIN_SESSIONS}-te{OOF_TEST_SESSIONS}"
                )
                manifest_path = f"walk_forward/oof_cohorts/{cohort_id}/manifest.json"
                resume_manifest_path = str(parent_path)
                prep_gcs_prefix = str(parent_manifest.get("prep_gcs_prefix") or "")
                sequence_gcs_prefix = str(parent_manifest.get("sequence_gcs_prefix") or "")
        else:
            cohort_dates = mature_dates[-OOF_MIN_MATURE_SESSIONS:]
            start_date = cohort_dates[0]
            signal_end_date = cohort_dates[-1]
            cohort_id = (
                f"active8-oof-v5-{start_date}-{signal_end_date}-"
                f"tr{OOF_TRAIN_SESSIONS}-te{OOF_TEST_SESSIONS}"
            )
            manifest_path = f"walk_forward/oof_cohorts/{cohort_id}/manifest.json"
        manifest_blob = bucket.blob(manifest_path)
        if manifest_blob.exists():
            manifest = json.loads(manifest_blob.download_as_text())
            if manifest.get("status") == "ready":
                selected = (manifest_path, manifest)
            else:
                return {
                    "status": "pending",
                    "reason": "cohort_manifest_not_ready",
                    "cadence": cadence,
                    "cohort_id": cohort_id,
                    "manifest_status": manifest.get("status"),
                }
        else:
            dispatch_path = f"walk_forward/oof_cohorts/{cohort_id}/dispatch.json"
            dispatch_blob = bucket.blob(dispatch_path)
            if dispatch_blob.exists():
                dispatch = json.loads(dispatch_blob.download_as_text())
                spawned_at = str(dispatch.get("spawned_at") or "")
                try:
                    age_seconds = (
                        datetime.now(timezone.utc)
                        - datetime.fromisoformat(spawned_at.replace("Z", "+00:00"))
                    ).total_seconds()
                except ValueError:
                    age_seconds = 24 * 3600
                if dispatch.get("status") == "spawned" and age_seconds < 6 * 3600:
                    return {
                        "status": "pending",
                        "reason": "cohort_orchestrator_active",
                        "cadence": cadence,
                        "cohort_id": cohort_id,
                        "function_call_id": dispatch.get("function_call_id"),
                    }
            plan = WalkForwardRequest(
                start_date=start_date,
                end_date=signal_end_date,
                train_window_days=OOF_TRAIN_SESSIONS,
                test_window_days=OOF_TEST_SESSIONS,
                cohort_id=cohort_id,
                confirm=not req.dry_run,
                concurrent_windows=2,
                prep_gcs_prefix=prep_gcs_prefix,
                sequence_gcs_prefix=sequence_gcs_prefix,
                resume_manifest_path=resume_manifest_path,
            )
            if req.dry_run:
                preview = await walk_forward_dry_run(plan)
                return {"status": "dry_run", "cadence": cadence, "plan": preview}
            dispatch_blob.upload_from_string(
                json.dumps({
                    "schema_version": "active8-oof-dispatch-v1",
                    "status": "dispatching",
                    "cohort_id": cohort_id,
                    "cadence": cadence,
                    "spawned_at": datetime.now(timezone.utc).isoformat(),
                }, sort_keys=True),
                content_type="application/json",
            )
            try:
                spawned = await walk_forward_run(plan)
            except Exception as exc:
                dispatch_blob.upload_from_string(
                    json.dumps({
                        "schema_version": "active8-oof-dispatch-v1",
                        "status": "failed",
                        "cohort_id": cohort_id,
                        "cadence": cadence,
                        "error": str(exc),
                        "spawned_at": datetime.now(timezone.utc).isoformat(),
                    }, sort_keys=True),
                    content_type="application/json",
                )
                raise
            dispatch_blob.upload_from_string(
                json.dumps({
                    "schema_version": "active8-oof-dispatch-v1",
                    "status": "spawned",
                    "cohort_id": cohort_id,
                    "cadence": cadence,
                    "function_call_id": spawned.get("fn_call_id"),
                    "spawned_at": datetime.now(timezone.utc).isoformat(),
                }, sort_keys=True),
                content_type="application/json",
            )
            return {"status": "spawned", "cadence": cadence, **spawned}

    manifest_path, manifest = selected
    cohort_id = str(manifest.get("cohort_id") or "")
    if req.expected_cohort_id and cohort_id != req.expected_cohort_id:
        raise HTTPException(
            status_code=409,
            detail=(
                "OOF lifecycle cohort changed before durable resume: "
                f"expected={req.expected_cohort_id} selected={cohort_id}"
            ),
        )
    lifecycle_path = (
        f"walk_forward/oof_cohorts/{cohort_id}/lifecycle/"
        f"{knowledge_cutoff_date}.json"
    )
    lifecycle_blob = bucket.blob(lifecycle_path)
    if lifecycle_blob.exists():
        receipt = json.loads(lifecycle_blob.download_as_text())
        if receipt.get("schema_version") == OOF_LIFECYCLE_RECEIPT_SCHEMA_VERSION:
            return {
                "status": "idempotent_complete",
                "cadence": cadence,
                "cohort_id": cohort_id,
                "knowledge_cutoff_date": knowledge_cutoff_date,
                "receipt": receipt,
            }
    if not req.dry_run and os.environ.get("OOF_MATERIALIZE_JOB_EXECUTION", "").strip() != "1":
        from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError

        job_name = os.environ.get("OOF_MATERIALIZE_JOB_NAME", "active8-oof-materialize").strip()
        callback_task = f"active8-oof-{cadence}"
        run_id = f"{callback_task}:{knowledge_cutoff_date}:{cohort_id}"
        try:
            execution = CloudRunJobsClient(job_name=job_name).run_job(
                env_overrides={
                    "OOF_MATERIALIZE_CADENCE": cadence,
                    "OOF_MATERIALIZE_END_DATE": req.end_date or knowledge_cutoff_date,
                    "OOF_MATERIALIZE_PROMOTE": "1" if req.promote else "0",
                    "OOF_MATERIALIZE_RUN_ID": run_id,
                    "OOF_MATERIALIZE_CALLBACK_TASK": callback_task,
                    "OOF_MATERIALIZE_EXPECTED_COHORT_ID": cohort_id,
                },
            )
        except JobAlreadyRunningError as exc:
            return {
                "status": "pending",
                "reason": "materialization_job_active",
                "cadence": cadence,
                "cohort_id": cohort_id,
                "knowledge_cutoff_date": knowledge_cutoff_date,
                "execution_id": exc.execution.execution_id,
                "execution_name": exc.execution.execution_name,
            }
        except Exception as exc:  # noqa: BLE001 - dispatch errors must remain visible to scheduler.
            raise HTTPException(
                status_code=502,
                detail=f"OOF materialization job dispatch failed: {type(exc).__name__}: {exc}",
            ) from exc
        return {
            "status": "spawned",
            "reason": "durable_materialization_job_dispatched",
            "cadence": cadence,
            "cohort_id": cohort_id,
            "knowledge_cutoff_date": knowledge_cutoff_date,
            "execution_id": execution.execution_id,
            "execution_name": execution.execution_name,
            "run_id": run_id,
        }
    result = await materialize_walk_forward_oof(OofMaterializeRequest(
        cohort_id=cohort_id,
        knowledge_cutoff_date=knowledge_cutoff_date,
        manifest_path=manifest_path,
        dry_run=req.dry_run,
        confirm=not req.dry_run,
        promote=req.promote,
        lifecycle_cadence=cadence,
    ))
    opb_failed = (
        isinstance(result.get("opb_refresh"), dict)
        and result["opb_refresh"].get("status") == "failed"
    )
    full_fit_retry_required = bool(result.get("full_fit_retry_required"))
    dependency_retry_required = opb_failed or full_fit_retry_required
    if not req.dry_run and not dependency_retry_required:
        lifecycle_blob.upload_from_string(
            json.dumps({
                "schema_version": OOF_LIFECYCLE_RECEIPT_SCHEMA_VERSION,
                "status": result.get("status"),
                "cohort_id": cohort_id,
                "cadence": cadence,
                "knowledge_cutoff_date": knowledge_cutoff_date,
                "promoted": bool(result.get("promoted")),
                "promotion_reason": result.get("promotion_reason"),
                "opb_refresh": result.get("opb_refresh"),
                "full_fit_dispatch": result.get("full_fit_dispatch"),
                "persistence": result.get("persistence"),
                "snapshot_evidence": result.get("snapshot_evidence"),
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }, sort_keys=True),
            content_type="application/json",
        )
    return {"cadence": cadence, "dependency_retry_required": dependency_retry_required, **result}

@router.post("/walk_forward/analyze")
async def walk_forward_analyze(req: AnalyzeRequest):
    """Rebuild report for an already-persisted run (no retrain)."""
    from services.walk_forward_retrain import (
        WalkForwardRun,
        WalkForwardWindowResult,
        load_current_universal_ic,
        build_report,
        _get_bucket,
    )
    import json

    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable")
    cohort_id = f"active8-oof-{req.start_date}-{req.end_date}"
    blob = bucket.blob(f"walk_forward/oof_cohorts/{cohort_id}/manifest.json")
    if not blob.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No persisted OOF cohort manifest for {cohort_id}",
        )

    data = json.loads(blob.download_as_text())
    run = WalkForwardRun(
        start_date=data["start_date"],
        end_date=data["end_date"],
        train_window_days=data.get("train_window_days", 60),
        test_window_days=data.get("test_window_days", 30),
    )
    for w in data.get("windows", []):
        tr = w.get("train_range") or [None, None]
        te = w.get("test_range") or [None, None]
        run.windows.append(WalkForwardWindowResult(
            window_id=w.get("window_id"),
            train_range=(tr[0], tr[1]),
            test_range=(te[0], te[1]),
            model_metrics=w.get("model_metrics", {}),
            error=w.get("error"),
        ))
    run.aggregate = data.get("aggregate", {})

    report = build_report(run, current_universal_ic=load_current_universal_ic())
    return Response(content=report, media_type="text/markdown")


@router.get("/walk_forward/report/{start_date}/{end_date}")
async def walk_forward_report(start_date: str, end_date: str):
    """Fetch the raw JSON for a persisted run."""
    from services.walk_forward_retrain import _get_bucket
    bucket = _get_bucket()
    if bucket is None:
        raise HTTPException(status_code=500, detail="GCS unavailable")
    cohort_id = f"active8-oof-{start_date}-{end_date}"
    blob = bucket.blob(f"walk_forward/oof_cohorts/{cohort_id}/manifest.json")
    if not blob.exists():
        raise HTTPException(status_code=404, detail="run not found")
    import json
    return json.loads(blob.download_as_text())
