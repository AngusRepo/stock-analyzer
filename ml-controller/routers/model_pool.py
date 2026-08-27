"""Canonical model artifact registry, D1 champion pointers, IC, and research overlays."""

from __future__ import annotations
import logging
import os
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.active8_release_training_contract import ACTIVE8_MODEL_NAMES
from services.d1_domain_client import D1DataDomain, client_for_domain
from services import discord_alert  # 2026-04-19 Stage 5
from services.model_artifact_registry import (
    build_candidate_selection,
    build_live_shadow_candidate_selection,
    build_promotion_queue,
    list_artifact_registry,
    list_champion_pointers,
    list_active8_ensemble_artifacts,
    load_active8_ensemble_serving_bundle,
    run_active8_ensemble_bundle_promotion_controller,
    run_feature_release_promotion_controller,
    run_promotion_controller,
)
from services.model_serving_resolver import load_d1_champion_pool
from services.model_upgrade_research_track import build_research_benchmark_manifest

LEARNING_D1_CLIENT = client_for_domain(D1DataDomain.LEARNING)
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/model_pool", tags=["model_pool"])


def _bucket_name() -> str:
    name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not name:
        raise HTTPException(status_code=500, detail="GCS_BUCKET_NAME not configured")
    return name


class PromotionControllerRequest(BaseModel):
    artifact_id: str
    confirm: bool = False
    approved: bool = False
    approved_by: str | None = None
    reason: str = "promotion_controller"
    manual_override: bool = False


class AutoPromotionRequest(BaseModel):
    confirm: bool = True
    max_candidates: int = 16
    reason: str = "scheduled_evidence_based_auto_promotion"


class Active8BundlePromotionControllerRequest(BaseModel):
    training_run_id: str
    confirm: bool = False
    reason: str = "active8_ensemble_atomic_bundle"


class FeatureReleasePromotionControllerRequest(BaseModel):
    training_run_id: str
    confirm: bool = False
    approved: bool = False
    approved_by: str | None = None
    reason: str = "feature_release_bundle_controller"

# Canonical rolling IC writer. D1 registry and exact champion pointers are the
# only lifecycle authority; this endpoint never mutates serving identity outside D1.
class ComputeWeeklyICRequest(BaseModel):
    lookback_days: int = 35
    min_samples: int = 50
    min_dates: int = 10
    append_history: bool = True
    run_date: str | None = None


@router.post("/compute_weekly_ic")
async def compute_weekly_ic(req: ComputeWeeklyICRequest):
    from services.model_artifact_registry import update_live_gate_from_ic
    from services.model_ic_tracker import compute_weekly_ic_from_rows, tracked_model_names

    t0 = time.time()
    all_tracked = tracked_model_names()
    pool = load_d1_champion_pool()
    expected_artifact_versions: dict[str, str] = {}
    expected_artifact_identities: dict[str, dict[str, str]] = {}
    for name, entry in (pool.get("models") or {}).items():
        if not isinstance(entry, dict):
            continue
        version = str(entry.get("version") or "").strip()
        artifact_id = str(entry.get("serving_artifact_id") or "").strip()
        checksum = str(entry.get("checksum") or "").strip().lower()
        if version:
            expected_artifact_versions[str(name)] = version
        if artifact_id and checksum:
            expected_artifact_identities[str(name)] = {
                "artifact_id": artifact_id,
                "checksum": checksum,
            }

    registry_shadow_selection = build_live_shadow_candidate_selection(
        list_artifact_registry(limit=1000),
        champion_pointers=list_champion_pointers(),
    )
    for candidate in registry_shadow_selection.get("selected") or []:
        if not isinstance(candidate, dict):
            continue
        model_name = str(candidate.get("model_name") or "").strip()
        version = str(candidate.get("version") or "").strip()
        artifact_id = str(candidate.get("artifact_id") or "").strip()
        checksum = str(candidate.get("checksum") or "").strip().lower()
        if model_name and version and artifact_id and checksum:
            tracked_name = f"{model_name}::challenger"
            expected_artifact_versions[tracked_name] = version
            expected_artifact_identities[tracked_name] = {
                "artifact_id": artifact_id,
                "checksum": checksum,
            }

    placeholders = ",".join(["?"] * len(all_tracked))
    if req.run_date:
        sql = f"""
            SELECT id, stock_id, model_name, direction_accuracy, forecast_data,
                   actual_return_pct, verified_at, prediction_date, generated_at,
                   verification_label_schema_version,
                   verification_label_entry_price,
                   verification_label_end_date,
                   verification_label_known_date
            FROM predictions
            WHERE model_name IN ({placeholders})
              AND date(prediction_date) <= date(?)
              AND date(verification_label_known_date) <= date(?)
              AND date(prediction_date) >= date(?, ?)
        """
        rows = LEARNING_D1_CLIENT.query(
            sql,
            [*all_tracked, req.run_date, req.run_date, req.run_date, f"-{req.lookback_days} days"],
        )
    else:
        sql = f"""
            SELECT id, stock_id, model_name, direction_accuracy, forecast_data,
                   actual_return_pct, verified_at, prediction_date, generated_at,
                   verification_label_schema_version,
                   verification_label_entry_price,
                   verification_label_end_date,
                   verification_label_known_date
            FROM predictions
            WHERE model_name IN ({placeholders})
              AND date(verification_label_known_date) <= date('now')
              AND date(prediction_date) >= date('now', ?)
        """
        rows = LEARNING_D1_CLIENT.query(sql, [*all_tracked, f"-{req.lookback_days} days"])

    per_model_ic = compute_weekly_ic_from_rows(
        rows,
        min_samples=req.min_samples,
        min_dates=req.min_dates,
        all_tracked=all_tracked,
        expected_artifact_versions=expected_artifact_versions,
        expected_artifact_identities=expected_artifact_identities,
    )
    for info in per_model_ic.values():
        contract = info.get("evaluation_contract")
        if isinstance(contract, dict):
            contract.update({
                "requested_run_date": req.run_date,
                "lookback_days": req.lookback_days,
                "append_history": req.append_history,
                "lifecycle_owner": "model_artifact_registry/model_champion_pointers",
            })
    try:
        registry_updates = update_live_gate_from_ic(per_model_ic, min_samples=req.min_samples)
    except Exception as exc:
        logger.exception("canonical artifact registry live IC update failed")
        raise HTTPException(status_code=500, detail=f"artifact_registry_live_gate_failed:{exc}") from exc
    return {
        "status": "ok",
        "source_of_truth": "model_artifact_registry/model_champion_pointers",
        "run_date": req.run_date,
        "lookback_days": req.lookback_days,
        "min_dates": req.min_dates,
        "n_rows_total": len(rows),
        "per_model_ic": per_model_ic,
        "artifact_registry_updates": registry_updates,
        "elapsed_s": round(time.time() - t0, 1),
    }


# ---------------------------------------------------------------------------
# Stage 6: State-space hyperparams pool (KalmanFilter / MarkovSwitching)
# ---------------------------------------------------------------------------


_DEFAULT_STATE_SPACE = {
    "KalmanFilter": {
        "process_noise": 1e-4,
        "observation_noise": 1e-2,
        "init_cov_scale": 1.0,
        "smoothing": False,
    },
    "MarkovSwitching": {
        "n_regimes": 2,
        "transition_prior": 0.95,
        "switching_vol": True,
        "ar_order": 1,
    },
}


class PutStateSpaceHyperparamsRequest(BaseModel):
    model_name: str           # 'KalmanFilter' or 'MarkovSwitching'
    hyperparams: dict
    version: str = "v1"
    confirm: bool = False


@router.post("/state_space/put_hyperparams")
async def put_state_space_hyperparams(req: PutStateSpaceHyperparamsRequest):
    """Stage 6.1: persist shared hyperparams for a state-space model.

    State-space models can't be 'universal' (each stock needs own state),
    but hyperparameters CAN be shared. This endpoint writes the pool's
    canonical hyperparams JSON to GCS at:
      per_stock_state_space/{kalman|markov_switching}/hyperparams_v{N}.json

    Used by:
      - Initial bootstrap (Stage 6.1, manual put with default values)
      - Future Stage 6.3 Optuna search (writes search-optimal values)
      - Research/Optuna writes versioned hyperparameters; serving loads the exact requested version
    """
    if not req.confirm:
        raise HTTPException(status_code=400, detail="put_state_space_hyperparams requires confirm=true")
    if req.model_name not in _DEFAULT_STATE_SPACE:
        raise HTTPException(status_code=400, detail=f"{req.model_name} is not a state-space model; expected one of {list(_DEFAULT_STATE_SPACE)}")
    expected = set(_DEFAULT_STATE_SPACE[req.model_name].keys())
    missing = expected - set(req.hyperparams.keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing keys for {req.model_name}: {sorted(missing)}")

    import json as _json
    from datetime import datetime, timezone
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    folder = "kalman" if req.model_name == "KalmanFilter" else "markov_switching"
    path = f"per_stock_state_space/{folder}/hyperparams_{req.version}.json"
    payload = dict(req.hyperparams)
    payload["_meta"] = {
        "model": req.model_name,
        "version": req.version,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "schema_version": "1.0",
    }
    bucket.blob(path).upload_from_string(
        _json.dumps(payload, indent=2, ensure_ascii=False),
        content_type="application/json",
    )
    logger.info(f"[Stage 6] put_hyperparams saved {path}")
    return {"status": "ok", "path": path, "hyperparams": payload}


@router.get("/state_space/hyperparams/{model_name}")
async def get_state_space_hyperparams(model_name: str, version: str = "v1"):
    """Read state-space hyperparams for the exact requested version."""
    if model_name not in _DEFAULT_STATE_SPACE:
        raise HTTPException(status_code=400, detail=f"{model_name} is not a state-space model")
    import json as _json
    from google.cloud import storage
    bucket = storage.Client().bucket(_bucket_name())
    folder = "kalman" if model_name == "KalmanFilter" else "markov_switching"
    blob = bucket.blob(f"per_stock_state_space/{folder}/hyperparams_{version}.json")
    if not blob.exists():
        return {"status": "default", "model": model_name, "version": version,
                "hyperparams": _DEFAULT_STATE_SPACE[model_name],
                "note": "no GCS file; serving in-code defaults"}
    return {"status": "loaded", "model": model_name, "version": version,
            "hyperparams": _json.loads(blob.download_as_text().lstrip("\ufeff"))}


@router.get("/status")
async def status():
    """Return the exact D1 champion snapshot used by production serving."""
    try:
        pool = load_d1_champion_pool()
        pool["research_benchmarks"] = build_research_benchmark_manifest(
            datetime.now(timezone.utc).date().isoformat()
        )
        return pool
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"D1 champion read failed: {exc}") from exc


@router.get("/artifact_registry")
async def artifact_registry(
    model_name: str | None = None,
    state: str | None = None,
    candidate_type: str | None = None,
    limit: int = 100,
):
    """Read registered retrain artifacts and gate states.

    Production serving still uses model_pool active/champion pointers. This
    endpoint exposes the release-train registry so UI/OBS can show why a
    retrain artifact is registered, offline-passed, shadowing, or archived.
    """
    try:
        rows = list_artifact_registry(
            model_name=model_name,
            state=state,
            candidate_type=candidate_type,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"artifact_registry failed: {e}")
    return {
        "status": "ok",
        "source_of_truth": "model_artifact_registry",
        "count": len(rows),
        "artifacts": rows,
    }


@router.get("/artifact_registry/selection")
async def artifact_registry_selection(model_name: str | None = None, limit: int = 200):
    """Read-only release-train candidate selection.

    This does not promote or shadow anything. It explains which registered
    monthly/weekly artifacts are eligible for the next gate.
    """
    try:
        rows = list_artifact_registry(model_name=model_name, limit=limit)
        pointers = list_champion_pointers(model_name=model_name)
        return build_candidate_selection(rows, champion_pointers=pointers)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"artifact_registry selection failed: {e}")


@router.get("/artifact_registry/promotion_queue")
async def artifact_registry_promotion_queue(model_name: str | None = None, limit: int = 200):
    """Read-only promotion queue owned by D1 registry and exact champion pointers."""
    try:
        rows = list_artifact_registry(model_name=model_name, limit=limit)
        pointers = list_champion_pointers(model_name=model_name)
        champion_versions = {
            str(pointer.get("model_name") or ""): str(pointer.get("champion_version") or "")
            for pointer in pointers
            if pointer.get("model_name") and pointer.get("champion_version")
        }
        return build_promotion_queue(rows, champion_versions=champion_versions)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"artifact_registry promotion queue failed: {e}")

@router.post("/artifact_registry/promotion_controller")
async def artifact_registry_promotion_controller(req: PromotionControllerRequest):
    """Compare against and optionally update the exact D1 champion pointer."""
    if not req.artifact_id:
        raise HTTPException(status_code=400, detail="artifact_id is required")
    try:
        rows = list_artifact_registry(limit=500)
        pointers = list_champion_pointers()
        result = run_promotion_controller(
            artifact_id=req.artifact_id,
            registry_rows=rows,
            d1_pointers=pointers,
            confirm=req.confirm,
            approved=req.approved,
            approved_by=req.approved_by,
            reason=req.reason,
            manual_override=req.manual_override,
        )
        if req.confirm and (
            result.get("can_promote") is True
            or result.get("status") == "already_promoted"
        ):
            pointer = next(
                (
                    row for row in list_champion_pointers()
                    if str(row.get("model_name") or "") == str(result.get("model_name") or "")
                ),
                None,
            )
            if (
                not pointer
                or str(pointer.get("champion_artifact_id") or "") != req.artifact_id
                or str(pointer.get("champion_version") or "") != str(result.get("candidate_version") or "")
            ):
                raise RuntimeError("d1_champion_pointer_readback_mismatch")
        return {
            **result,
            "serving_reader": "model_champion_pointers/model_artifact_registry",
            "serving_model_pool_updated": False,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"artifact_registry promotion controller failed: {e}")

@router.post("/artifact_registry/auto_promote")
async def artifact_registry_auto_promote(req: AutoPromotionRequest = AutoPromotionRequest()):
    """Promote evidence-complete candidates through atomic D1 pointer updates."""
    if not req.confirm:
        raise HTTPException(status_code=400, detail="auto_promote requires confirm=true; use promotion_queue for dry-run")
    try:
        rows = list_artifact_registry(limit=1000)
        pointers = list_champion_pointers()
        champion_versions = {
            str(pointer.get("model_name") or ""): str(pointer.get("champion_version") or "")
            for pointer in pointers
            if pointer.get("model_name") and pointer.get("champion_version")
        }
        queue = build_promotion_queue(rows, champion_versions=champion_versions)
        eligible = [
            row for row in queue.get("queue") or []
            if row.get("promotion_decision") == "auto_promote_candidate"
            and row.get("approval_required") is not True
        ][:max(1, min(int(req.max_candidates), 64))]
        by_id = {str(row.get("artifact_id")): dict(row) for row in rows}
        results: list[dict] = []
        promoted_artifacts: list[dict] = []

        feature_runs = sorted({
            str(by_id.get(str(item.get("artifact_id")), {}).get("training_run_id") or "")
            for item in eligible
            if str(item.get("candidate_type") or "") == "timesfm_l175_l2_feature_release"
        } - {""})
        for training_run_id in feature_runs:
            result = run_feature_release_promotion_controller(
                training_run_id=training_run_id,
                registry_rows=rows,
                d1_pointers=pointers,
                confirm=True,
                approved=False,
                approved_by="artifact_auto_promotion",
                reason=req.reason,
            )
            artifacts = [dict(row) for row in result.pop("artifacts", [])]
            results.append(result)
            if result.get("can_promote") is True:
                promoted_artifacts.extend(artifacts)

        active8_candidates = [
            row for row in list_active8_ensemble_artifacts()
            if str(row.get("state") or "") == "candidate"
            and str(row.get("training_run_id") or "")
        ]
        # Query order is updated_at DESC. Only the newest candidate may own
        # automatic promotion; an older bundle must never overwrite a newer one.
        active8_runs = (
            [str(active8_candidates[0].get("training_run_id") or "")]
            if active8_candidates
            else []
        )
        for training_run_id in active8_runs:
            result = run_active8_ensemble_bundle_promotion_controller(
                training_run_id=training_run_id,
                registry_rows=rows,
                d1_pointers=pointers,
                confirm=True,
                reason=req.reason,
            )
            artifacts = [dict(row) for row in result.pop("artifacts", [])]
            results.append(result)
            if result.get("can_promote") is True:
                promoted_artifacts.extend(artifacts)
        seen_models: set[str] = set()
        for item in eligible:
            if str(item.get("candidate_type") or "") in {"timesfm_l175_l2_feature_release", "oof_full_fit_release"}:
                continue
            model_name = str(item.get("model_name") or "")
            if not model_name or model_name in seen_models:
                continue
            seen_models.add(model_name)
            artifact_id = str(item.get("artifact_id") or "")
            result = run_promotion_controller(
                artifact_id=artifact_id,
                registry_rows=rows,
                d1_pointers=pointers,
                confirm=True,
                approved=False,
                approved_by="artifact_auto_promotion",
                reason=req.reason,
            )
            results.append(result)
            if result.get("can_promote") is True:
                promoted_artifacts.append(by_id[artifact_id])

        readback_by_model = {
            str(pointer.get("model_name") or ""): pointer
            for pointer in list_champion_pointers()
            if pointer.get("model_name")
        }
        readback_errors: list[str] = []
        for artifact in promoted_artifacts:
            model_name = str(artifact.get("model_name") or "")
            pointer = readback_by_model.get(model_name) or {}
            if str(pointer.get("champion_version") or "") != str(artifact.get("version") or ""):
                readback_errors.append(f"version_mismatch:{model_name}")
            if str(pointer.get("champion_artifact_id") or "") != str(artifact.get("artifact_id") or ""):
                readback_errors.append(f"artifact_id_mismatch:{model_name}")
        if readback_errors:
            raise RuntimeError("d1_champion_pointer_readback_failed:" + ",".join(readback_errors))

        for artifact in promoted_artifacts:
            discord_alert.alert_lifecycle(
                "promote",
                str(artifact.get("model_name") or "unknown"),
                from_status="candidate",
                to_status="active",
                reason=req.reason,
                metrics={
                    "artifact_id": artifact.get("artifact_id"),
                    "version": artifact.get("version"),
                    "offline_gate": artifact.get("offline_gate_decision"),
                    "live_gate": artifact.get("live_gate_status"),
                    "promotion_basis": "canonical_oof_evidence_and_exact_d1_pointer_comparison",
                },
            )
        return {
            "status": "ok",
            "eligible": len(eligible),
            "promoted": len(promoted_artifacts),
            "results": results,
            "serving_reader": "model_champion_pointers/model_artifact_registry",
            "readback_verified": not readback_errors,
        }
    except Exception as e:
        logger.exception("artifact auto promotion failed")
        raise HTTPException(status_code=500, detail=f"artifact_registry auto promotion failed: {e}")

@router.post("/artifact_registry/active8_bundle_promotion_controller")
async def artifact_registry_active8_bundle_promotion_controller(
    req: Active8BundlePromotionControllerRequest,
):
    if not req.training_run_id.strip():
        raise HTTPException(status_code=400, detail="training_run_id is required")
    try:
        rows = list_artifact_registry(limit=1000)
        result = run_active8_ensemble_bundle_promotion_controller(
            training_run_id=req.training_run_id,
            registry_rows=rows,
            d1_pointers=list_champion_pointers(),
            confirm=req.confirm,
            reason=req.reason,
        )
        artifacts = [dict(row) for row in result.pop("artifacts", [])]
        if req.confirm and result.get("can_promote") is True:
            readback = {
                str(pointer.get("model_name") or ""): pointer
                for pointer in list_champion_pointers()
                if pointer.get("model_name")
            }
            mismatches = [
                str(row.get("model_name") or "")
                for row in artifacts
                if str((readback.get(str(row.get("model_name") or "")) or {}).get("champion_artifact_id") or "")
                != str(row.get("artifact_id") or "")
            ]
            ensemble_pointer = LEARNING_D1_CLIENT.query(
                "SELECT artifact_id FROM active8_ensemble_pointer_v1 WHERE singleton_id=1"
            )
            if (
                mismatches
                or len(ensemble_pointer) != 1
                or str(ensemble_pointer[0].get("artifact_id") or "")
                != str(result.get("ensemble_artifact_id") or "")
            ):
                raise RuntimeError("active8_bundle_d1_pointer_readback_mismatch:" + ",".join(mismatches))
        return {
            **result,
            "serving_reader": "model_champion_pointers+active8_ensemble_pointer_v1",
            "readback_verified": bool(req.confirm and result.get("can_promote") is True),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Active8 bundle promotion controller failed: {e}")

@router.post("/artifact_registry/feature_release_promotion_controller")
async def artifact_registry_feature_release_promotion_controller(
    req: FeatureReleasePromotionControllerRequest,
):
    """Promote a complete TimesFM feature cohort through one atomic D1 batch."""
    if not req.training_run_id.strip():
        raise HTTPException(status_code=400, detail="training_run_id is required")
    try:
        rows = list_artifact_registry(limit=500)
        result = run_feature_release_promotion_controller(
            training_run_id=req.training_run_id,
            registry_rows=rows,
            d1_pointers=list_champion_pointers(),
            confirm=req.confirm,
            approved=req.approved,
            approved_by=req.approved_by,
            reason=req.reason,
        )
        artifacts = [dict(row) for row in result.pop("artifacts", [])]
        if req.confirm and result.get("can_promote") is True:
            readback = {
                str(pointer.get("model_name") or ""): pointer
                for pointer in list_champion_pointers()
                if pointer.get("model_name")
            }
            errors = [
                str(artifact.get("model_name") or "")
                for artifact in artifacts
                if (
                    str((readback.get(str(artifact.get("model_name") or "")) or {}).get("champion_artifact_id") or "")
                    != str(artifact.get("artifact_id") or "")
                    or str((readback.get(str(artifact.get("model_name") or "")) or {}).get("champion_version") or "")
                    != str(artifact.get("version") or "")
                )
            ]
            if errors:
                raise RuntimeError("feature_release_d1_pointer_readback_mismatch:" + ",".join(errors))
        return {
            **result,
            "serving_reader": "model_champion_pointers/model_artifact_registry",
            "readback_verified": bool(req.confirm and result.get("can_promote") is True),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"feature release promotion controller failed: {e}")

@router.get("/artifact_registry/champion_pointers")
async def artifact_registry_champion_pointers(model_name: str | None = None, limit: int = 200):
    """Return the V5 serving bundle plus legacy pointers as audit lineage."""
    try:
        pointers = list_champion_pointers(model_name=model_name)
        rows = list_artifact_registry(model_name=model_name, limit=limit)
        artifacts_by_id = {
            str(row.get("artifact_id") or ""): row
            for row in rows
            if row.get("artifact_id")
        }
        bundle = load_active8_ensemble_serving_bundle()
        base_artifacts = bundle.get("base_artifacts") if isinstance(bundle.get("base_artifacts"), dict) else {}
        pointer_by_model = {
            str(pointer.get("model_name") or ""): pointer
            for pointer in pointers
            if pointer.get("model_name")
        }
        model_names = sorted(set(ACTIVE8_MODEL_NAMES) | set(pointer_by_model) | set(base_artifacts))
        models = {}
        for name in model_names:
            pointer = pointer_by_model.get(name) or {}
            serving = base_artifacts.get(name) if isinstance(base_artifacts.get(name), dict) else {}
            is_serving = bundle.get("production_effect") is True and bool(serving)
            models[name] = {
                "serving_version": serving.get("version") if is_serving else None,
                "serving_artifact_id": serving.get("artifact_id") if is_serving else None,
                "serving_checksum": serving.get("checksum") if is_serving else None,
                "d1_pointer_version": pointer.get("champion_version"),
                "d1_pointer_artifact_id": pointer.get("champion_artifact_id"),
                "artifact_link_status": "v5_bundle_bound" if is_serving else "legacy_audit_only",
                "readiness": "v5_serving" if is_serving else "evidence_only_no_action",
                "next_action": (
                    "V5 bundle is the production serving owner."
                    if is_serving
                    else "Wait for a validated V5 bundle; the legacy champion pointer is rollback/audit lineage only."
                ),
            }
        return {
            "status": "ok",
            "source_of_truth": "active8_ensemble_pointer_v1/model_artifact_registry",
            "target_source_of_truth": "active8_ensemble_pointer_v1",
            "production_reader": "active8_ensemble_pointer_v1",
            "migration_ready": bundle.get("production_effect") is True,
            "ready_count": sum(1 for row in models.values() if row["readiness"] == "v5_serving"),
            "model_count": len(models),
            "count": len(pointers),
            "models": models,
            "active8_bundle": bundle,
            "pointers": [
                {
                    **pointer,
                    "artifact": artifacts_by_id.get(str(pointer.get("champion_artifact_id") or "")),
                    "authority": "legacy_rollback_audit_only",
                }
                for pointer in pointers
            ],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"artifact_registry champion pointers failed: {e}")

@router.get("/lineage")
async def lineage():
    """Return the exact D1 champion serving lineage."""
    try:
        pool = load_d1_champion_pool()
        models = {
            name: {
                "status": entry.get("status"),
                "model_slot_status": entry.get("model_slot_status"),
                "serving_eligible": entry.get("serving_eligible"),
                "version": entry.get("version"),
                "gcs_path": entry.get("gcs_path"),
                "metadata_path": entry.get("metadata_path"),
                "serving_owner": entry.get("serving_owner"),
                "serving_artifact_id": entry.get("serving_artifact_id"),
                "serving_block_reason": entry.get("serving_block_reason"),
                "target_semantic_version": entry.get("target_semantic_version"),
                "offline_gate_decision": entry.get("offline_gate_decision"),
                "live_gate_status": entry.get("live_gate_status"),
                "serving_ic_prior": entry.get("serving_ic_prior"),
                "serving_ic_source": entry.get("serving_ic_source"),
                "rolling_ic": entry.get("rolling_ic"),
                "weekly_ic": entry.get("weekly_ic") or [],
                "ic_4w_avg": entry.get("ic_4w_avg"),
                "last_ic_status": entry.get("last_ic_status"),
                "last_ic_root_cause": entry.get("last_ic_root_cause"),
                "last_ic_sample_count": entry.get("last_ic_sample_count") or 0,
            }
            for name, entry in (pool.get("models") or {}).items()
        }
        return {
            "status": "ok",
            "schema_version": pool.get("schema_version"),
            "last_updated": pool.get("last_updated"),
            "source_of_truth": "model_champion_pointers/model_artifact_registry",
            "production_reader": "model_champion_pointers/model_artifact_registry",
            "models": models,
            "l2_feature_sidecars": pool.get("l2_feature_sidecars") or {},
            "research_benchmarks": build_research_benchmark_manifest(
                datetime.now(timezone.utc).date().isoformat()
            ),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"D1 champion lineage read failed: {e}")
