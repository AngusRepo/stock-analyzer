from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
from services.allocator_ev_fusion_artifact_builder import (
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_oof_training_rows,
    load_allocator_ev_fusion_training_rows,
)
from services.allocator_ev_feature_snapshot_backfill import backfill_allocator_ev_feature_snapshots
from services.l4_alpha_ev_resolver import (
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
)
from services.model_artifact_registry import upsert_artifact_record
from services.trading_session_maturity import fifth_session_maturity_cutoff


router = APIRouter(prefix="/allocator_ev_fusion", tags=["allocator_ev_fusion"])
LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)


DIRECT_REFRESH_PROMOTION_OWNER = "active8_oof_lifecycle"
DIRECT_REFRESH_PROMOTION_ENDPOINT = "/walk_forward/oof/lifecycle"
DIRECT_REFRESH_PROMOTION_DETAIL = "direct_refresh_promotion_disabled_use_active8_oof_lifecycle"


class AllocatorEvFusionRefreshReq(BaseModel):
    end_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    cadence: Literal["weekly", "monthly", "manual"] = "weekly"
    evidence_mode: Literal["native", "purged_oof"] = "native"
    cohort_id: str | None = Field(default=None, min_length=1, max_length=200)
    lookback_days: int | None = Field(default=None, ge=30, le=365)
    min_samples: int | None = Field(default=None, ge=100, le=10000)
    min_dates: int | None = Field(default=None, ge=5, le=252)
    limit: int | None = Field(default=None, ge=500, le=20000)
    promote: bool = False
    dry_run: bool = False
    trigger_source: str = "worker_scheduler"

    search_trial_count: int = Field(default=1, ge=1, le=10000)
    multiple_testing_evidence: dict[str, Any] | None = None
    benchmark_panel_id: str | None = Field(default=None, max_length=200)

class AllocatorEvFeatureSnapshotBackfillReq(BaseModel):
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    next_session_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    dry_run: bool = True
    candidate_limit: int = Field(default=1000, ge=1, le=5000)
    l4_lookback_days: int = Field(default=90, ge=30, le=365)
    l4_min_samples: int = Field(default=500, ge=50, le=10000)
    l4_min_dates: int = Field(default=20, ge=5, le=252)
    l4_training_limit: int = Field(default=6000, ge=500, le=20000)
    durable: bool = False
    upstream_run_id: str | None = None


def _latest_mature_feature_date(max_date: str | None) -> str:
    cutoff = max_date or "now"
    mature_cutoff = fifth_session_maturity_cutoff(cutoff)
    if not mature_cutoff:
        raise HTTPException(status_code=409, detail="allocator_ev_fusion_market_calendar_insufficient")
    rows = LEARNING_D1_CLIENT.query(
        """
        SELECT MAX(date(fs.snapshot_date)) AS end_date
        FROM allocator_ev_feature_snapshots fs
        WHERE fs.snapshot_source = ?
          AND fs.as_of_guard = ?
          AND date(fs.snapshot_date) <= date(?)
        """,
        [
            SNAPSHOT_BACKFILL_SOURCE,
            SNAPSHOT_BACKFILL_AS_OF_GUARD,
            mature_cutoff,
        ],
    )
    end_date = str((rows[0] if rows else {}).get("end_date") or "").strip()
    if not end_date:
        raise HTTPException(status_code=409, detail="allocator_ev_fusion_no_mature_feature_snapshots")
    return end_date


def _defaults_for_cadence(cadence: str) -> dict[str, int]:
    if cadence == "monthly":
        return {"lookback_days": 180, "min_samples": 1000, "min_dates": 35}
    return {"lookback_days": 90, "min_samples": 500, "min_dates": 20}


def _latest_ready_oof_cohort() -> str:
    rows = LEARNING_D1_CLIENT.query(
        """
        SELECT c.cohort_id
        FROM active8_oof_cohorts c
        JOIN active8_oof_materialized_artifacts a
          ON a.cohort_id = c.cohort_id
         AND a.source_manifest_checksum = c.artifact_manifest_checksum
        WHERE c.status = 'ready'
          AND c.generation_mode = 'purged_oof'
          AND c.prediction_storage_mode = 'gcs_indexed_v1'
          AND a.artifact_kind IN ('allocator_ev_snapshots', 'l4_predictions')
        GROUP BY c.cohort_id, c.ready_at, c.updated_at
        HAVING COUNT(DISTINCT a.artifact_kind) = 2
        ORDER BY COALESCE(c.ready_at, c.updated_at) DESC, c.cohort_id DESC
        LIMIT 1
        """,
        [],
    )
    cohort_id = str((rows[0] if rows else {}).get("cohort_id") or "").strip()
    if not cohort_id:
        raise HTTPException(status_code=409, detail="allocator_ev_fusion_ready_oof_cohort_missing")
    return cohort_id


def _get_oof_bucket() -> Any:
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket_name:
        raise HTTPException(status_code=500, detail="GCS_BUCKET_NAME_not_configured")
    try:
        from google.cloud import storage
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="google_cloud_storage_not_available") from exc
    return storage.Client().bucket(bucket_name)


def _artifact_checksum(artifact: dict[str, Any]) -> str:
    payload = json.dumps(artifact, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _registry_lifecycle_state(*, decision: str) -> str:
    return "offline_passed" if decision == "PASS" else "offline_failed"


def _registry_record(
    *,
    artifact: dict[str, Any],
    validation: dict[str, Any],
    cadence: str,
    end_date: str,
    lookback_days: int,
    rows_loaded: int,
) -> dict[str, Any]:
    model_version = str(artifact.get("model_version") or "unknown")
    decision = str(validation.get("decision") or "PENDING").upper()
    failed_gates = validation.get("failed_gates") if isinstance(validation.get("failed_gates"), list) else []
    artifact_checksum = _artifact_checksum(artifact)
    evidence = {
        "identity_schema_version": "expected-return-candidate-identity-v1",
        "expected_return_owner": artifact.get("expected_return_owner"),
        "model_version": model_version,
        "cadence": cadence,
        "end_date": end_date,
        "lookback_days": lookback_days,
        "rows_loaded": rows_loaded,
        "promotion_tier": artifact.get("promotion_tier"),
        "primary_expected_return_allowed": artifact.get("primary_expected_return_allowed"),
        "artifact_contract_version": artifact.get("artifact_contract_version"),
        "feature_semantic_version": artifact.get("feature_semantic_version"),
        "label_schema_version": artifact.get("label_schema_version"),
        "validation_packet": validation,
        "training_data": artifact.get("training_data"),
        "direct_refresh_mode": "candidate_research_only",
        "production_mutation_allowed": False,
        "promotion_owner": DIRECT_REFRESH_PROMOTION_OWNER,
    }
    return {
        "artifact_id": f"allocator_ev_fusion:{model_version}",
        "model_name": "allocator_ev_fusion",
        "version": model_version,
        "candidate_type": "allocator_ev_fusion_refresh",
        "state": _registry_lifecycle_state(decision=decision),
        "artifact_path": None,
        "metadata_path": None,
        "training_run_id": f"allocator_ev_fusion_refresh:{cadence}:{end_date}",
        "training_manifest_path": None,
        "trained_from_snapshot": artifact.get("feature_snapshot_version"),
        "evaluation_baseline_version": None,
        "final_compared_to": None,
        "feature_policy_version": artifact.get("feature_snapshot_version"),
        "checksum": artifact_checksum,
        "source_run_date": end_date,
        "is_monthly": 1 if cadence == "monthly" else 0,
        "offline_gate_status": "passed" if decision == "PASS" else "failed",
        "offline_gate_decision": decision,
        "offline_gate_failed_gates": json.dumps(failed_gates, ensure_ascii=False),
        "offline_evidence_json": json.dumps(evidence, ensure_ascii=False),
        "live_gate_status": "not_started",
        "live_evidence_json": json.dumps(
            {"production_mutation_allowed": False, "promotion_owner": DIRECT_REFRESH_PROMOTION_OWNER},
            ensure_ascii=False,
        ),
        "promotion_decision": "active8_oof_lifecycle_only",
        "approval_state": "not_required",
    }


@router.post("/refresh")
async def refresh_allocator_ev_fusion_artifact(req: AllocatorEvFusionRefreshReq) -> dict[str, Any]:
    """Build and persist a research candidate; Active8 OOF lifecycle owns promotion."""

    if req.promote:
        raise HTTPException(
            status_code=409,
            detail={
                "code": DIRECT_REFRESH_PROMOTION_DETAIL,
                "promotion_owner": DIRECT_REFRESH_PROMOTION_OWNER,
                "promotion_endpoint": DIRECT_REFRESH_PROMOTION_ENDPOINT,
            },
        )
    defaults = _defaults_for_cadence(req.cadence)
    lookback_days = req.lookback_days or defaults["lookback_days"]
    min_samples = req.min_samples or defaults["min_samples"]
    min_dates = req.min_dates or defaults["min_dates"]
    row_limit = req.limit or (20000 if req.evidence_mode == "purged_oof" else 6000)
    cohort_id: str | None = None
    generation_mode = "native"
    if req.evidence_mode == "purged_oof":
        cohort_id = str(req.cohort_id or "").strip() or _latest_ready_oof_cohort()
        if not req.end_date:
            raise HTTPException(
                status_code=422,
                detail="purged_oof_requires_knowledge_cutoff_end_date",
            )
        try:
            rows = load_allocator_ev_fusion_oof_training_rows(
                LEARNING_D1_CLIENT.query,
                cohort_id=cohort_id,
                knowledge_cutoff_date=req.end_date,
                limit=row_limit,
                bucket=_get_oof_bucket(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        generation_mode = "purged_oof"
        end_date = max(
            str(row.get("prediction_date") or row.get("snapshot_date") or "")[:10]
            for row in rows
        )
        knowledge_cutoff_date = req.end_date
    else:
        end_date = _latest_mature_feature_date(req.end_date)
        knowledge_cutoff_date = req.end_date or end_date
        rows = load_allocator_ev_fusion_training_rows(
            LEARNING_D1_CLIENT.query,
            core_query_fn=CORE_D1_CLIENT.query,
            end_date=end_date,
            lookback_days=lookback_days,
            limit=row_limit,
            knowledge_cutoff_date=knowledge_cutoff_date,
        )
    if not rows:
        raise HTTPException(
            status_code=409,
            detail=f"allocator_ev_fusion_{req.evidence_mode}_training_rows_empty",
        )
    result = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until=end_date,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_dates=min_dates,
        knowledge_cutoff_date=knowledge_cutoff_date,
        generation_mode=generation_mode,
        cohort_id=cohort_id,
        search_trial_count=req.search_trial_count,
        multiple_testing_evidence=req.multiple_testing_evidence,
        benchmark_panel_id=req.benchmark_panel_id,
    )
    artifact = result.get("artifact") if isinstance(result, dict) else None
    validation = result.get("validation_packet") if isinstance(result, dict) else None
    decision = str((validation or {}).get("decision") or "").upper()
    registry_error: str | None = None
    if isinstance(artifact, dict) and not req.dry_run:
        try:
            upsert_artifact_record(
                _registry_record(
                    artifact=artifact,
                    validation=validation if isinstance(validation, dict) else {},
                    cadence=req.cadence,
                    end_date=end_date,
                    lookback_days=lookback_days,
                    rows_loaded=len(rows),
                )
            )
        except Exception as exc:  # noqa: BLE001 - surface candidate registry persistence failure.
            registry_error = str(exc)

    status = "validated" if decision == "PASS" else "failed_validation"

    return {
        **result,
        "status": status,
        "cadence": req.cadence,
        "evidence_mode": req.evidence_mode,
        "cohort_id": cohort_id,
        "end_date": end_date,
        "lookback_days": lookback_days,
        "min_samples": min_samples,
        "min_dates": min_dates,
        "row_limit": row_limit,
        "rows_loaded": len(rows),
        "promoted": False,
        "existing_champion_preserved": True,
        "registry_error": registry_error,
        "production_mutation_allowed": False,
        "promotion_owner": DIRECT_REFRESH_PROMOTION_OWNER,
        "promotion_endpoint": DIRECT_REFRESH_PROMOTION_ENDPOINT,
        "summary": (
            f"allocator_ev_fusion_refresh status={status} cadence={req.cadence} "
            f"evidence_mode={req.evidence_mode} cohort_id={cohort_id or 'none'} "
            f"end_date={end_date} model_version={(artifact or {}).get('model_version', 'unknown')} "
            f"decision={decision or 'UNKNOWN'} tier={(artifact or {}).get('promotion_tier', 'unknown')} "
            "mode=candidate_research_only"
        ),
    }


@router.post("/feature_snapshots/backfill")
async def backfill_allocator_ev_feature_snapshots_route(req: AllocatorEvFeatureSnapshotBackfillReq) -> dict[str, Any]:
    """Build no-leakage day-t L0-L4 feature snapshots for Fusion training.

    This route writes an independent training snapshot table only. It never
    mutates historical daily_recommendations rows.
    """

    if (
        req.durable
        and not req.dry_run
        and os.environ.get("OOF_MATERIALIZE_JOB_EXECUTION", "").strip() != "1"
    ):
        from services.cloud_run_jobs_client import CloudRunJobsClient

        job_name = os.environ.get("OOF_MATERIALIZE_JOB_NAME", "active8-oof-materialize").strip()
        run_id = req.upstream_run_id or (
            "allocator-ev-feature-snapshot-backfill:"
            f"{req.start_date}:{req.end_date}:{int(time.time())}"
        )
        execution = CloudRunJobsClient(job_name=job_name).run_job(
            env_overrides={
                "OOF_MATERIALIZE_MODE": "allocator_snapshot",
                "OOF_MATERIALIZE_START_DATE": req.start_date,
                "OOF_MATERIALIZE_END_DATE": req.end_date,
                "OOF_MATERIALIZE_NEXT_SESSION_DATE": req.next_session_date or "",
                "OOF_MATERIALIZE_CANDIDATE_LIMIT": str(req.candidate_limit),
                "OOF_MATERIALIZE_L4_LOOKBACK_DAYS": str(req.l4_lookback_days),
                "OOF_MATERIALIZE_L4_MIN_SAMPLES": str(req.l4_min_samples),
                "OOF_MATERIALIZE_L4_MIN_DATES": str(req.l4_min_dates),
                "OOF_MATERIALIZE_L4_TRAINING_LIMIT": str(req.l4_training_limit),
                "OOF_MATERIALIZE_RUN_ID": run_id,
                "OOF_MATERIALIZE_CALLBACK_TASK": "allocator-ev-feature-snapshot-backfill",
            },
            reject_if_running=False,
        )
        return {
            "status": "spawned",
            "reason": "durable_snapshot_job_dispatched",
            "start_date": req.start_date,
            "end_date": req.end_date,
            "execution_id": execution.execution_id,
            "execution_name": execution.execution_name,
            "run_id": run_id,
            "summary": (
                "allocator_ev_feature_snapshot_backfill status=spawned "
                f"range={req.start_date}..{req.end_date} execution_id={execution.execution_id}"
            ),
        }

    result = backfill_allocator_ev_feature_snapshots(
        start_date=req.start_date,
        end_date=req.end_date,
        next_session_date=req.next_session_date,
        dry_run=req.dry_run,
        candidate_limit=req.candidate_limit,
        l4_lookback_days=req.l4_lookback_days,
        l4_min_samples=req.l4_min_samples,
        l4_min_dates=req.l4_min_dates,
        l4_training_limit=req.l4_training_limit,
    )
    return {
        **result,
        "summary": (
            "allocator_ev_feature_snapshot_backfill "
            f"status={result.get('status')} dry_run={1 if req.dry_run else 0} "
            f"range={req.start_date}..{req.end_date} built={result.get('snapshots_built')} "
            f"written={result.get('written')} skipped_days={result.get('skipped_days')} "
            "l4_backfill_only_days="
            f"{result.get('l4_snapshot_backfill_only_days')} "
            f"candidate_time_s12_features={result.get('candidate_time_s12_feature_count')} "
            "skip_reasons="
            f"{json.dumps(result.get('skip_reasons') or {}, separators=(',', ':'))}"
        ),
    }
