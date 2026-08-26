"""
POST /retrain/followup

Run-level monthly retrain callback receiver.

ml-service / Modal orchestrator reports the final retrain outcome here so the
controller can:
1. upsert one authoritative status row in D1 webhook_log
2. release the long-running retrain lock
3. expose success/failure truth for later cron / UI / debugging
"""
from __future__ import annotations

import json
import logging
import os
import hmac
import hashlib
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from services import d1_client, retrain_lock
from services.active8_release_training_contract import (
    ACTIVE8_MODEL_NAMES,
    reconcile_release_artifact_receipts_from_immutable_metadata,
)
from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
from services.model_artifact_registry import (
    build_artifact_records_from_retrain_followup,
    hydrate_retrain_followup_artifact_metadata,
    is_production_artifact_model,
    list_artifacts_by_ids,
    list_artifact_registry,
    upsert_artifact_records,
)
from services.dataset_snapshots import latest_dataset_snapshot
from services.foundation_forecast_evidence import (
    attach_timesfm_foundation_evidence_to_followup_payload,
)
from services.cost_tracker import record_modal_call
from services.modal_client import _modal_resource_spec

logger = logging.getLogger("retrain_followup")
OPS_D1_CLIENT = client_proxy_for_domain(D1DataDomain.OPS)
router = APIRouter()
WORKER_URL = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
WORKER_AUTH = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()


async def _resume_oof_full_fit_lifecycle(context: dict[str, Any]) -> dict[str, Any]:
    if context.get("schema_version") != "active8-oof-lifecycle-resume-v1":
        raise ValueError("oof_lifecycle_resume_schema_invalid")
    cohort_id = str(context.get("cohort_id") or "").strip()
    expected_checksum = str(context.get("source_manifest_checksum") or "").strip()
    cutoff = str(context.get("knowledge_cutoff_date") or "").strip()
    cadence = str(context.get("cadence") or "").strip().lower()
    if not cohort_id or len(expected_checksum) != 64 or len(cutoff) != 10:
        raise ValueError("oof_lifecycle_resume_identity_incomplete")
    if cadence not in {"daily", "weekly", "monthly"}:
        raise ValueError("oof_lifecycle_resume_cadence_invalid")

    from routers.walk_forward import OofLifecycleRequest, run_walk_forward_oof_lifecycle
    from services.walk_forward_retrain import _get_bucket

    bucket = _get_bucket()
    manifest_path = f"walk_forward/oof_cohorts/{cohort_id}/manifest.json"
    manifest = json.loads(bucket.blob(manifest_path).download_as_text())
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    actual_checksum = hashlib.sha256(
        json.dumps(unsigned, sort_keys=True).encode("utf-8")
    ).hexdigest()
    if (
        str(manifest.get("cohort_id") or "") != cohort_id
        or str(manifest.get("manifest_checksum") or "") != expected_checksum
        or actual_checksum != expected_checksum
    ):
        raise ValueError("oof_lifecycle_resume_manifest_identity_mismatch")

    result = await run_walk_forward_oof_lifecycle(OofLifecycleRequest(
        cadence=cadence,
        end_date=cutoff,
        dry_run=False,
        promote=True,
        expected_cohort_id=cohort_id,
    ))
    if str(result.get("status") or "") not in {
        "spawned", "pending", "materialized", "idempotent_complete"
    }:
        raise RuntimeError(f"oof_lifecycle_resume_unexpected_status:{result}")
    return result

class RetrainFollowupPayload(BaseModel):
    run_id: str | None = None
    trained_at: str | None = Field(default=None, description="ISO8601 UTC fallback idempotency key")
    lock_key: str | None = None
    run_date: str | None = None
    candidate_type: str | None = None
    batch_count: int | None = None
    gcs_prefix: str = "universal"
    candidate_version: str | None = None
    training_run_id: str | None = None
    training_manifest_path: str | None = None
    challenger_registrations: dict[str, Any] = Field(default_factory=dict)
    promotion_eligible_models: list[str] = Field(default_factory=list)
    oof_promotion_evidence: dict[str, dict] = Field(default_factory=dict)
    oof_lifecycle_resume: dict[str, Any] = Field(default_factory=dict)
    window_id: int | None = None
    total_samples: int = 0
    train_samples: int = 0
    feature_count: int = 0
    elapsed_s: float = 0.0
    circuit_breaker: bool = False
    ic_summary: dict[str, float | None] = Field(default_factory=dict)
    modal_telemetry: list[dict[str, Any]] = Field(default_factory=list)
    status: str = "completed"
    error: str | None = None
    stages: dict[str, Any] = Field(default_factory=dict)


class RetrainFollowupReleaseRebuildRequest(BaseModel):
    run_id: str
    dry_run: bool = True


_ENVIRONMENT = os.environ.get("ENVIRONMENT", "development").strip().lower()


def _valid_service_tokens() -> list[str]:
    dedicated = os.environ.get("RETRAIN_CALLBACK_TOKEN", "").strip()
    if dedicated:
        return [dedicated]

    tokens = [
        os.environ.get("INTERNAL_TOKEN", ""),
        os.environ.get("ML_CONTROLLER_TOKEN", ""),
        os.environ.get("ML_CONTROLLER_SECRET", ""),
        # Backward compatibility for currently deployed Modal secrets.
        os.environ.get("STOCKVISION_AUTH_TOKEN", ""),
    ]
    return list(dict.fromkeys(token.strip() for token in tokens if token and token.strip()))


def _check_token(request: Request) -> None:
    tokens = _valid_service_tokens()
    if not tokens:
        if _ENVIRONMENT == "production":
            raise HTTPException(status_code=500, detail="retrain followup token not configured")
        return
    provided = (
        request.headers.get("X-Service-Token", "")
        or request.headers.get("X-Controller-Token", "")
        or request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    )
    if not any(hmac.compare_digest(provided, token) for token in tokens):
        raise HTTPException(status_code=401, detail="invalid service token")


def _scheduler_status(status: str) -> str:
    normalized = str(status or "").strip().lower()
    if normalized in {"completed", "complete", "success", "succeeded", "ok"}:
        return "success"
    if normalized in {"skipped", "skip", "locked"}:
        return "skipped"
    if normalized in {"running", "triggered"}:
        return normalized
    return "error"


def _build_scheduler_callback_payload(payload: RetrainFollowupPayload) -> dict[str, Any]:
    if str(payload.candidate_type or "").strip() != "oof_full_fit_release":
        return {}
    cadence = str((payload.oof_lifecycle_resume or {}).get("cadence") or "").strip().lower()
    if cadence not in {"daily", "weekly", "monthly"}:
        raise ValueError("oof_release_scheduler_cadence_invalid")
    scheduler_status = _scheduler_status(payload.status)
    summary_bits = [
        f"run_id={payload.run_id or payload.trained_at or '-'}",
        f"cadence={cadence}",
        f"batches={payload.batch_count if payload.batch_count is not None else '-'}",
        f"samples={payload.total_samples}",
        f"features={payload.feature_count}",
    ]
    if payload.candidate_version:
        summary_bits.append(f"candidate={payload.candidate_version}")
    if payload.error:
        summary_bits.append(f"error={payload.error}")
    callback: dict[str, Any] = {
        "task": f"active8-oof-{cadence}",
        "status": scheduler_status,
        "summary": "Active-8 OOF release followup " + " ".join(summary_bits),
        "duration_ms": int(max(float(payload.elapsed_s or 0.0), 0.0) * 1000),
        "run_id": payload.run_id or payload.trained_at,
        "run_date": payload.run_date,
    }
    if payload.error or scheduler_status == "error":
        callback["error"] = payload.error or f"retrain status={payload.status}"
    return {key: value for key, value in callback.items() if value is not None}

def _safe_callback_detail(value: Any, *, max_chars: int = 300) -> str:
    text = f"{type(value).__name__}: {value}" if isinstance(value, BaseException) else str(value)
    if WORKER_AUTH:
        text = text.replace(WORKER_AUTH, "[REDACTED]")
    lowered = text.lower()
    bearer_at = lowered.find("bearer ")
    if bearer_at >= 0:
        token_end = text.find(" ", bearer_at + 7)
        text = text[:bearer_at] + "Bearer [REDACTED]" + (text[token_end:] if token_end >= 0 else "")
    return text[:max_chars]


async def _callback_worker_scheduler(payload: RetrainFollowupPayload) -> dict[str, Any]:
    if not WORKER_URL:
        return {"attempted": False, "ok": False, "reason": "STOCKVISION_WORKER_URL missing"}

    callback_payload = _build_scheduler_callback_payload(payload)
    if not callback_payload:
        return {"attempted": False, "ok": True, "reason": "noncanonical_candidate_no_scheduler_ticket"}

    url = f"{WORKER_URL.rstrip('/')}/api/admin/scheduler-callback"
    headers = {"Content-Type": "application/json"}
    if WORKER_AUTH:
        headers["Authorization"] = f"Bearer {WORKER_AUTH}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=callback_payload)
        return {
            "attempted": True,
            "ok": resp.status_code == 200,
            "status_code": resp.status_code,
            "task": callback_payload.get("task"),
            "response": _safe_callback_detail(resp.text),
        }
    except Exception as exc:  # noqa: BLE001 - followup persistence remains authoritative.
        safe_error = _safe_callback_detail(exc)
        logger.warning("[RetrainFollowup] Worker scheduler callback failed: %s", safe_error)
        return {
            "attempted": True,
            "ok": False,
            "task": callback_payload.get("task"),
            "error": safe_error,
        }


async def _record_modal_telemetry(events: list[dict[str, Any]]) -> dict[str, Any]:
    recorded = 0
    skipped = 0
    errors: list[str] = []

    for event in events or []:
        function_name = str(event.get("function_name") or "").strip()
        compute_sec = float(event.get("compute_sec") or 0.0)
        if not function_name or compute_sec <= 0:
            skipped += 1
            continue

        spec = _modal_resource_spec(function_name)
        meta = dict(event.get("meta") or {})
        if event.get("wall_sec") is not None:
            meta["wall_sec"] = float(event["wall_sec"])
        if event.get("status"):
            meta["status"] = event.get("status")

        try:
            await record_modal_call(
                source=str(event.get("source") or "modal_followup"),
                function_name=function_name,
                compute_sec=round(compute_sec, 3),
                cpu=float(event.get("cpu") or spec["cpu"]),
                memory_mb=int(event.get("memory_mb") or spec["memory_mb"]),
                gpu=event.get("gpu", spec.get("gpu")),
                meta=meta,
            )
            recorded += 1
        except Exception as exc:  # noqa: BLE001 - callback success must not depend on telemetry.
            errors.append(f"{function_name}: {exc}")

    return {
        "recorded": recorded,
        "skipped": skipped,
        "errors": errors,
    }


@router.post("/retrain/followup")
async def retrain_followup(payload: RetrainFollowupPayload, request: Request) -> dict[str, Any]:
    _check_token(request)

    foundation_evidence = {"attempted": False, "updated": False}
    try:
        payload_dict = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
        foundation_evidence = attach_timesfm_foundation_evidence_to_followup_payload(payload_dict)
        if foundation_evidence.get("updated"):
            payload = RetrainFollowupPayload(**payload_dict)
    except Exception as exc:  # noqa: BLE001 - followup persistence remains authoritative.
        foundation_evidence = {
            "attempted": True,
            "updated": False,
            "error": str(exc),
        }
        logger.warning("[RetrainFollowup] TimesFM foundation evidence enrichment failed: %s", exc)

    received_at = datetime.now(timezone.utc).isoformat()
    idem_key = payload.run_id or payload.trained_at
    if not idem_key:
        raise HTTPException(status_code=400, detail="run_id or trained_at is required")

    lock_release = {
        "attempted": False,
        "released": False,
        "error": None,
    }

    downstream_notes = "no_lock_key"
    if payload.lock_key:
        lock_release["attempted"] = True
        try:
            retrain_lock.release(
                payload.lock_key,
                expected_metadata={"run_id": payload.run_id} if payload.run_id else None,
            )
            lock_release["released"] = True
            downstream_notes = "lock_released"
        except Exception as e:
            lock_release["error"] = str(e)
            downstream_notes = "lock_release_failed"
            logger.error(f"[RetrainFollowup] lock release failed: key={payload.lock_key} error={e}")

    summary = json.dumps(
        {
            "run_id": payload.run_id,
            "trained_at": payload.trained_at,
            "lock_key": payload.lock_key,
            "run_date": payload.run_date,
            "candidate_type": payload.candidate_type,
            "batch_count": payload.batch_count,
            "gcs_prefix": payload.gcs_prefix,
            "candidate_version": payload.candidate_version,
            "challenger_registrations": payload.challenger_registrations,
            "promotion_eligible_models": payload.promotion_eligible_models,
            "oof_promotion_evidence": payload.oof_promotion_evidence,
            "oof_lifecycle_resume": payload.oof_lifecycle_resume,
            "window_id": payload.window_id,
            "total_samples": payload.total_samples,
            "train_samples": payload.train_samples,
            "feature_count": payload.feature_count,
            "elapsed_s": payload.elapsed_s,
            "circuit_breaker": payload.circuit_breaker,
            "ic_summary": payload.ic_summary,
            "modal_telemetry": payload.modal_telemetry,
            "status": payload.status,
            "error": payload.error,
            "stages": payload.stages,
        },
        ensure_ascii=False,
    )

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

    try:
        res = OPS_D1_CLIENT.execute(
            sql,
            [
                idem_key,
                received_at,
                "ml-service",
                "retrain_followup",
                summary,
                payload.status,
                downstream_notes,
            ],
        )
    except Exception as e:
        logger.error(f"[RetrainFollowup] D1 execute failed: {e}")
        raise HTTPException(status_code=502, detail=f"D1 write failed: {e}")

    changes = 0
    try:
        meta = res.get("meta", {}) if isinstance(res, dict) else {}
        changes = int(meta.get("changes", 0))
    except Exception:
        changes = 0

    write_status = "upserted" if changes > 0 else "unchanged"
    telemetry_status = await _record_modal_telemetry(payload.modal_telemetry)
    artifact_registry = {"attempted": 0, "written": 0, "errors": []}
    artifact_records: list[dict[str, Any]] = []
    try:
        artifact_records = build_artifact_records_from_retrain_followup(payload)
        artifact_registry = upsert_artifact_records(artifact_records)
    except Exception as exc:  # noqa: BLE001 - followup persistence remains authoritative.
        artifact_registry = {
            "attempted": 0,
            "written": 0,
            "errors": [str(exc)],
        }
    oof_lifecycle_resume: dict[str, Any] | None = None
    if payload.status == "completed" and not payload.error and payload.oof_lifecycle_resume:
        try:
            oof_lifecycle_resume = await _resume_oof_full_fit_lifecycle(
                payload.oof_lifecycle_resume
            )
        except Exception as exc:  # noqa: BLE001 - full-fit completion must resume its bound lifecycle.
            logger.exception("[RetrainFollowup] OOF full-fit lifecycle resume failed")
            raise HTTPException(
                status_code=502,
                detail=f"OOF full-fit completed but lifecycle resume failed: {exc}",
            ) from exc

    scheduler_callback = await _callback_worker_scheduler(payload)
    logger.info(
        f"[RetrainFollowup] {idem_key} status={payload.status} write={write_status} "
        f"gcs={payload.gcs_prefix} wid={payload.window_id} lock={payload.lock_key} "
        f"telemetry={telemetry_status['recorded']}/{len(payload.modal_telemetry or [])} "
        f"artifact_registry={artifact_registry['written']}/{artifact_registry['attempted']} "
        f"scheduler_callback={scheduler_callback}"
    )

    return {
        "status": payload.status,
        "write_status": write_status,
        "idempotency_key": idem_key,
        "received_at": received_at,
        "action": "retrain_followup",
        "lock_release": lock_release,
        "modal_telemetry": telemetry_status,
        "foundation_evidence": foundation_evidence,
        "artifact_registry": artifact_registry,
        "scheduler_callback": scheduler_callback,
        "oof_lifecycle_resume": oof_lifecycle_resume,
        "summary": {
            "run_id": payload.run_id,
            "trained_at": payload.trained_at,
            "lock_key": payload.lock_key,
            "run_date": payload.run_date,
            "candidate_type": payload.candidate_type,
            "batch_count": payload.batch_count,
            "gcs_prefix": payload.gcs_prefix,
            "window_id": payload.window_id,
            "feature_count": payload.feature_count,
            "error": payload.error,
        },
    }


def _reconcile_release_completion_payload(
    payload_dict: dict[str, Any],
    *,
    dataset_snapshot: dict[str, Any],
) -> dict[str, Any]:
    if str(payload_dict.get("candidate_type") or "") != "oof_full_fit_release":
        return {"attempted": False, "status": "not_applicable"}
    resume = payload_dict.get("oof_lifecycle_resume")
    if not isinstance(resume, dict) or resume.get("schema_version") != "active8-oof-lifecycle-resume-v1":
        raise ValueError("release_completion_rebuild_resume_identity_invalid")

    stages = payload_dict.get("stages")
    if not isinstance(stages, dict):
        raise ValueError("release_completion_rebuild_stages_invalid")
    current_completion = stages.get("release_model_completion")
    if isinstance(current_completion, dict) and current_completion.get("status") == "complete":
        return {"attempted": False, "status": "already_complete"}

    train = stages.get("train") if isinstance(stages.get("train"), dict) else {}
    registrations = (
        train.get("artifact_registrations")
        if isinstance(train.get("artifact_registrations"), dict)
        else {}
    )
    lifecycle = (
        stages.get("artifact_lifecycle")
        if isinstance(stages.get("artifact_lifecycle"), dict)
        else {}
    )
    lifecycle_results = (
        lifecycle.get("results")
        if isinstance(lifecycle.get("results"), dict)
        else {}
    )
    raw_receipts = {
        model: registrations.get(model) or lifecycle_results.get(model) or {}
        for model in ACTIVE8_MODEL_NAMES
    }
    completion = reconcile_release_artifact_receipts_from_immutable_metadata(
        contract_stage=(
            stages.get("release_training_contract")
            if isinstance(stages.get("release_training_contract"), dict)
            else {}
        ),
        run_date=str(payload_dict.get("run_date") or ""),
        dataset_snapshot=dataset_snapshot,
        raw_receipts=raw_receipts,
    )
    completion["reconciliation"] = {
        "schema_version": "active8-release-completion-rebuild-v1",
        "source": "webhook_log+immutable_gcs_metadata+immutable_dataset_snapshot",
        "original_callback_status": payload_dict.get("status"),
        "original_callback_error": payload_dict.get("error"),
        "original_completion": current_completion if isinstance(current_completion, dict) else None,
        "production_effect": False,
        "retrain_started": False,
    }
    stages["release_model_completion"] = completion
    payload_dict["status"] = "completed"
    payload_dict["error"] = None
    return {
        "attempted": True,
        "status": "complete",
        "contract_checksum": completion["contract_checksum"],
        "models_completed": completion["models_completed"],
    }


@router.post("/retrain/followup/release-rebuild")
async def retrain_followup_release_rebuild(req: RetrainFollowupReleaseRebuildRequest, request: Request) -> dict[str, Any]:
    """Rebuild the canonical Active-8 registry from one immutable followup payload.

    This intentionally does not update webhook_log.received_at, release retrain
    locks, or callback scheduler state. It is for deterministic registry reconstruction
    after the registry table is introduced.
    """
    _check_token(request)
    run_id = str(req.run_id or "").strip()
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")

    rows = OPS_D1_CLIENT.query(
        """
        SELECT idempotency_key, payload_summary
        FROM webhook_log
        WHERE action='retrain_followup'
          AND idempotency_key=?
        ORDER BY received_at DESC
        LIMIT 1
        """,
        [run_id],
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"retrain followup payload not found: {run_id}")

    try:
        payload_dict = json.loads(rows[0]["payload_summary"])
    except Exception as exc:  # noqa: BLE001 - make operator-facing error explicit.
        raise HTTPException(status_code=500, detail=f"payload_summary JSON parse failed: {exc}")

    run_date = str(payload_dict.get("run_date") or "").strip()
    if not run_date:
        raise HTTPException(status_code=409, detail="followup payload is missing run_date")
    snapshot = latest_dataset_snapshot(
        kind="backtest_dataset",
        business_date=run_date,
        access_tier="compute",
    )
    if not snapshot:
        raise HTTPException(status_code=409, detail=f"exact backtest dataset snapshot not found for {run_date}")
    manifest_errors = list(snapshot.get("manifest_errors") or [])
    if manifest_errors:
        raise HTTPException(
            status_code=409,
            detail=f"backtest dataset snapshot invalid: {','.join(manifest_errors)}",
        )

    stages = payload_dict.setdefault("stages", {})
    if not isinstance(stages, dict):
        raise HTTPException(status_code=409, detail="followup stages payload is invalid")
    stages["dataset_snapshot"] = snapshot
    payload_dict = hydrate_retrain_followup_artifact_metadata(payload_dict)
    try:
        release_completion_rebuild = _reconcile_release_completion_payload(
            payload_dict,
            dataset_snapshot=snapshot,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Active-8 release completion rebuild failed: {exc}",
        ) from exc
    artifact_records = build_artifact_records_from_retrain_followup(payload_dict)
    result = {
        "attempted": len(artifact_records),
        "written": 0,
        "errors": [],
        "dry_run": bool(req.dry_run),
    }
    if not req.dry_run:
        result = {
            **upsert_artifact_records(artifact_records),
            "dry_run": False,
        }
        if release_completion_rebuild.get("status") == "complete":
            expected_models = set(ACTIVE8_MODEL_NAMES)
            actual_models = {str(row.get("model_name") or "") for row in artifact_records}
            if actual_models != expected_models or len(artifact_records) != len(expected_models):
                raise HTTPException(
                    status_code=409,
                    detail="Active-8 release completion rebuild artifact set mismatch",
                )
            if result.get("errors") or result.get("written") != len(expected_models):
                raise HTTPException(
                    status_code=502,
                    detail=f"Active-8 release completion rebuild registry write failed: {result}",
                )
            expected_by_id = {str(row["artifact_id"]): row for row in artifact_records}
            readback = list_artifacts_by_ids(list(expected_by_id))
            readback_by_id = {str(row.get("artifact_id") or ""): row for row in readback}
            mismatches = []
            for artifact_id, expected in expected_by_id.items():
                actual = readback_by_id.get(artifact_id) or {}
                if (
                    str(actual.get("training_run_id") or "") != run_id
                    or str(actual.get("checksum") or "") != str(expected.get("checksum") or "")
                    or str(actual.get("source_run_date") or "") != run_date
                ):
                    mismatches.append(artifact_id)
            if len(readback_by_id) != len(expected_by_id) or mismatches:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "Active-8 release completion rebuild registry readback mismatch:"
                        + ",".join(sorted(mismatches))
                    ),
                )

            receipt_id = f"{run_id}:active8-release-completion-rebuild-v1"
            receipt_summary = json.dumps(
                {
                    "schema_version": "active8-release-completion-rebuild-v1",
                    "source_event_run_id": run_id,
                    "run_date": run_date,
                    "dataset_snapshot_id": snapshot.get("snapshot_id"),
                    "contract_checksum": release_completion_rebuild.get("contract_checksum"),
                    "artifacts": [
                        {
                            "artifact_id": artifact_id,
                            "checksum": expected_by_id[artifact_id].get("checksum"),
                            "training_run_id": run_id,
                        }
                        for artifact_id in sorted(expected_by_id)
                    ],
                    "source_evidence_read_only": True,
                    "registry_reconciliation_only": True,
                    "retrain_started": False,
                    "scheduler_callback": False,
                    "production_effect": False,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            OPS_D1_CLIENT.execute(
                """
                INSERT INTO webhook_log
                  (idempotency_key, received_at, source, action, payload_summary, status, downstream_notes)
                VALUES (?, ?, 'ml-controller', 'active8_release_completion_rebuild', ?, 'completed',
                        'append_only_no_retrain_no_scheduler_callback')
                ON CONFLICT(idempotency_key) DO NOTHING
                """,
                [receipt_id, datetime.now(timezone.utc).isoformat(), receipt_summary],
            )
            receipt_rows = OPS_D1_CLIENT.query(
                """
                SELECT payload_summary, status
                FROM webhook_log
                WHERE idempotency_key=?
                  AND action='active8_release_completion_rebuild'
                LIMIT 2
                """,
                [receipt_id],
            )
            if (
                len(receipt_rows) != 1
                or str(receipt_rows[0].get("status") or "") != "completed"
                or str(receipt_rows[0].get("payload_summary") or "") != receipt_summary
            ):
                raise HTTPException(
                    status_code=502,
                    detail="Active-8 release completion rebuild receipt readback mismatch",
                )
            release_completion_rebuild["receipt_id"] = receipt_id
            release_completion_rebuild["production_effect"] = False

    return {
        "status": "ok",
        "run_id": run_id,
        "source": "webhook_log.payload_summary",
        "side_effects": {
            "webhook_log_updated": False,
            "scheduler_callback": False,
            "lock_release": False,
            "retrain_started": False,
        },
        "artifact_registry": result,
        "release_completion_rebuild": release_completion_rebuild,
        "dataset_snapshot": {
            "snapshot_id": snapshot.get("snapshot_id"),
            "business_date": snapshot.get("business_date"),
            "schema_version": snapshot.get("schema_version"),
            "row_count": snapshot.get("row_count"),
            "checksum": snapshot.get("checksum"),
            "manifest_errors": manifest_errors,
        },
        "artifacts": [
            {
                "artifact_id": row.get("artifact_id"),
                "model_name": row.get("model_name"),
                "version": row.get("version"),
                "candidate_type": row.get("candidate_type"),
                "state": row.get("state"),
                "offline_gate_decision": row.get("offline_gate_decision"),
                "feature_policy_version": row.get("feature_policy_version"),
                "checksum": row.get("checksum"),
                "training_manifest_path": row.get("training_manifest_path"),
                "trained_from_snapshot": row.get("trained_from_snapshot"),
            }
            for row in artifact_records
        ],
    }
