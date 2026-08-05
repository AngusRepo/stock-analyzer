from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import d1_client
from services.allocator_ev_fusion_artifact_builder import (
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_training_rows,
)
from services.allocator_ev_feature_snapshot_backfill import backfill_allocator_ev_feature_snapshots
from services.l4_alpha_ev_resolver import (
    SNAPSHOT_BACKFILL_AS_OF_GUARD,
    SNAPSHOT_BACKFILL_SOURCE,
)
from services.model_artifact_registry import upsert_artifact_record
from services.worker_config_client import worker_fetch


router = APIRouter(prefix="/allocator_ev_fusion", tags=["allocator_ev_fusion"])


class AllocatorEvFusionRefreshReq(BaseModel):
    end_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    cadence: Literal["weekly", "monthly", "manual"] = "weekly"
    lookback_days: int | None = Field(default=None, ge=30, le=365)
    min_samples: int | None = Field(default=None, ge=100, le=10000)
    min_dates: int | None = Field(default=None, ge=5, le=252)
    limit: int = Field(default=6000, ge=500, le=20000)
    promote: bool = True
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
    rows = d1_client.query(
        """
        WITH price_horizons AS (
            SELECT
                stock_id,
                date(date) AS price_date,
                LEAD(date(date), 5) OVER (
                    PARTITION BY stock_id ORDER BY date(date)
                ) AS exit_date
            FROM stock_prices
            WHERE date(date) <= date(?)
        )
        SELECT MAX(date(fs.snapshot_date)) AS end_date
        FROM allocator_ev_feature_snapshots fs
        JOIN price_horizons ph
          ON ph.stock_id = fs.stock_id
         AND ph.price_date = date(fs.snapshot_date)
        WHERE fs.snapshot_source = ?
          AND fs.as_of_guard = ?
          AND date(fs.snapshot_date) <= date(?)
          AND date(ph.exit_date) <= date(?)
        """,
        [
            cutoff,
            SNAPSHOT_BACKFILL_SOURCE,
            SNAPSHOT_BACKFILL_AS_OF_GUARD,
            cutoff,
            cutoff,
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


def _artifact_checksum(artifact: dict[str, Any]) -> str:
    payload = json.dumps(artifact, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _promotion_config_allowed(artifact: dict[str, Any] | None, decision: str) -> bool:
    if not isinstance(artifact, dict) or decision != "PASS":
        return False
    state = str(artifact.get("promotion_state") or "").strip()
    tier = str(artifact.get("promotion_tier") or "").strip()
    if state == "production_primary" and tier == "primary":
        return artifact.get("primary_expected_return_allowed") is True
    return False


def _registry_lifecycle_state(*, decision: str, promoted: bool, promotion_error: str | None) -> str:
    if promoted:
        return "production"
    if promotion_error:
        return "approval_required"
    return "offline_passed" if decision == "PASS" else "offline_failed"


def _registry_record(
    *,
    artifact: dict[str, Any],
    validation: dict[str, Any],
    cadence: str,
    end_date: str,
    lookback_days: int,
    rows_loaded: int,
    promoted: bool = False,
    promotion_error: str | None = None,
) -> dict[str, Any]:
    model_version = str(artifact.get("model_version") or "unknown")
    decision = str(validation.get("decision") or "PENDING").upper()
    failed_gates = validation.get("failed_gates") if isinstance(validation.get("failed_gates"), list) else []
    promotion_state = str(artifact.get("promotion_state") or "shadow")
    evidence = {
        "cadence": cadence,
        "end_date": end_date,
        "lookback_days": lookback_days,
        "rows_loaded": rows_loaded,
        "promotion_state": promotion_state,
        "promotion_tier": artifact.get("promotion_tier"),
        "primary_expected_return_allowed": artifact.get("primary_expected_return_allowed"),
        "validation_packet": validation,
        "training_data": artifact.get("training_data"),
        "promoted_to_trading_config": promoted,
        "promotion_error": promotion_error,
    }
    return {
        "artifact_id": f"allocator_ev_fusion:{model_version}",
        "model_name": "allocator_ev_fusion",
        "version": model_version,
        "candidate_type": "allocator_ev_fusion_refresh",
        "state": _registry_lifecycle_state(
            decision=decision,
            promoted=promoted,
            promotion_error=promotion_error,
        ),
        "artifact_path": None,
        "metadata_path": None,
        "training_run_id": f"allocator_ev_fusion_refresh:{cadence}:{end_date}",
        "training_manifest_path": None,
        "trained_from_snapshot": artifact.get("feature_snapshot_version"),
        "evaluation_baseline_version": None,
        "final_compared_to": None,
        "feature_policy_version": artifact.get("feature_snapshot_version"),
        "checksum": _artifact_checksum(artifact),
        "source_run_date": end_date,
        "is_monthly": 1 if cadence == "monthly" else 0,
        "offline_gate_status": "passed" if decision == "PASS" else "failed",
        "offline_gate_decision": decision,
        "offline_gate_failed_gates": json.dumps(failed_gates, ensure_ascii=False),
        "offline_evidence_json": json.dumps(evidence, ensure_ascii=False),
        "live_gate_status": "promoted" if promoted else ("promotion_failed" if promotion_error else "not_started"),
        "live_evidence_json": json.dumps(
            {"promoted_to_trading_config": promoted, "promotion_error": promotion_error},
            ensure_ascii=False,
        ),
        "promotion_decision": str(artifact.get("promotion_tier") or "shadow"),
        "approval_state": promotion_state,
    }


@router.post("/refresh")
async def refresh_allocator_ev_fusion_artifact(req: AllocatorEvFusionRefreshReq) -> dict[str, Any]:
    """Build and optionally promote the allocator EV fusion artifact.

    This artifact is the sole production allocator expected-return owner. It estimates
    next-session S12 policy value from day-t L0-L4/ScoreV2/market features; S12 enters
    only through mature historical replay labels. Promotion is fail-closed:
    only a PASS validation packet with a production_primary
    artifact mutates Worker trading:config.
    """

    defaults = _defaults_for_cadence(req.cadence)
    end_date = _latest_mature_feature_date(req.end_date)
    lookback_days = req.lookback_days or defaults["lookback_days"]
    min_samples = req.min_samples or defaults["min_samples"]
    min_dates = req.min_dates or defaults["min_dates"]

    rows = load_allocator_ev_fusion_training_rows(
        d1_client.query,
        end_date=end_date,
        lookback_days=lookback_days,
        limit=req.limit,
        knowledge_cutoff_date=req.end_date or end_date,
    )
    result = build_allocator_ev_fusion_artifact_from_rows(
        rows,
        trained_until=end_date,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_dates=min_dates,
        knowledge_cutoff_date=req.end_date or end_date,
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
        except Exception as exc:  # noqa: BLE001 - config promotion gate remains authoritative.
            registry_error = str(exc)

    promoted = False
    promotion_error: str | None = None
    stale_config_cleared = False
    stale_config_clear_error: str | None = None
    if req.promote and not req.dry_run:
        if not _promotion_config_allowed(artifact, decision):
            return {
                **result,
                "status": "failed_validation",
                "promoted": False,
                "existing_champion_preserved": True,
                "stale_config_cleared": False,
                "stale_config_clear_error": None,
                "registry_error": registry_error,
                "production_mutation_allowed": False,
                "summary": (
                    "allocator_ev_fusion_refresh failed_validation "
                    f"cadence={req.cadence} end_date={end_date} decision={decision or 'UNKNOWN'} "
                    "existing_champion_preserved=1"
                ),
            }
        try:
            await worker_fetch(
                "/api/admin/config",
                method="PUT",
                json_body={
                    "ensemble_v2": {
                        "allocatorEvFusion": artifact,
                        "allocator_ev_fusion": artifact,
                    },
                    "meta": {
                        "source": "allocator_ev_fusion_refresh",
                        "push_id": f"allocator_ev_fusion:{req.cadence}:{end_date}:{(artifact or {}).get('model_version', 'unknown')}",
                    },
                },
                timeout=30.0,
            )
            promoted = True
        except Exception as exc:  # noqa: BLE001 - surface Worker details to scheduler.
            promotion_error = str(exc)

    status = "promoted" if promoted else ("validated" if decision == "PASS" else "failed_validation")
    if promotion_error:
        status = "promotion_failed"
    if isinstance(artifact, dict) and (promoted or promotion_error):
        try:
            upsert_artifact_record(
                _registry_record(
                    artifact=artifact,
                    validation=validation if isinstance(validation, dict) else {},
                    cadence=req.cadence,
                    end_date=end_date,
                    lookback_days=lookback_days,
                    rows_loaded=len(rows),
                    promoted=promoted,
                    promotion_error=promotion_error,
                )
            )
        except Exception as exc:  # noqa: BLE001 - surface registry failure without masking promotion result.
            registry_error = registry_error or str(exc)

    return {
        **result,
        "status": status,
        "cadence": req.cadence,
        "end_date": end_date,
        "lookback_days": lookback_days,
        "min_samples": min_samples,
        "min_dates": min_dates,
        "rows_loaded": len(rows),
        "promoted": promoted,
        "promotion_error": promotion_error,
        "stale_config_cleared": stale_config_cleared,
        "stale_config_clear_error": stale_config_clear_error,
        "registry_error": registry_error,
        "production_mutation_allowed": bool(req.promote and not req.dry_run and decision == "PASS"),
        "summary": (
            f"allocator_ev_fusion_refresh status={status} cadence={req.cadence} "
            f"end_date={end_date} model_version={(artifact or {}).get('model_version', 'unknown')} "
            f"decision={decision or 'UNKNOWN'} tier={(artifact or {}).get('promotion_tier', 'unknown')} "
            f"promoted={1 if promoted else 0}"
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
