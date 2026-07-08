from __future__ import annotations

import hashlib
import json
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import d1_client
from services.l4_alpha_ev_artifact_builder import (
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)
from services.model_artifact_registry import upsert_artifact_record
from services.worker_config_client import worker_fetch


router = APIRouter(prefix="/l4_alpha_ev", tags=["l4_alpha_ev"])


class L4AlphaEvRefreshReq(BaseModel):
    end_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    cadence: Literal["weekly", "monthly", "manual"] = "weekly"
    lookback_days: int | None = Field(default=None, ge=30, le=365)
    min_samples: int | None = Field(default=None, ge=100, le=10000)
    min_dates: int | None = Field(default=None, ge=5, le=252)
    limit: int = Field(default=6000, ge=500, le=20000)
    promote: bool = True
    dry_run: bool = False
    trigger_source: str = "worker_scheduler"


def _latest_verified_end_date(max_date: str | None) -> str:
    where = ""
    params: list[Any] = []
    if max_date:
        where = "AND date(prediction_date) <= date(?)"
        params.append(max_date)
    rows = d1_client.query(
        f"""
        SELECT MAX(date(prediction_date)) AS end_date
        FROM predictions
        WHERE model_name = 'ensemble'
          AND verified_at IS NOT NULL
          AND actual_return_pct IS NOT NULL
          {where}
        """,
        params,
    )
    end_date = str((rows[0] if rows else {}).get("end_date") or "").strip()
    if not end_date:
        raise HTTPException(status_code=409, detail="l4_alpha_ev_no_verified_ensemble_outcomes")
    return end_date


def _defaults_for_cadence(cadence: str) -> dict[str, int]:
    if cadence == "monthly":
        return {"lookback_days": 180, "min_samples": 1000, "min_dates": 35}
    return {"lookback_days": 90, "min_samples": 500, "min_dates": 20}


def _artifact_checksum(artifact: dict[str, Any]) -> str:
    payload = json.dumps(artifact, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
    promotion_state = str(artifact.get("promotion_state") or "approval_required")
    evidence = {
        "cadence": cadence,
        "end_date": end_date,
        "lookback_days": lookback_days,
        "rows_loaded": rows_loaded,
        "promotion_state": promotion_state,
        "validation_packet": validation,
        "training_data": artifact.get("training_data"),
        "promoted_to_trading_config": promoted,
        "promotion_error": promotion_error,
    }
    return {
        "artifact_id": f"l4_alpha_ev:{model_version}",
        "model_name": "l4_alpha_ev",
        "version": model_version,
        "candidate_type": "l4_alpha_ev_refresh",
        "state": promotion_state,
        "artifact_path": None,
        "metadata_path": None,
        "training_run_id": f"l4_alpha_ev_refresh:{cadence}:{end_date}",
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
        "promotion_decision": "primary" if promotion_state == "production_approved" else "shadow",
        "approval_state": promotion_state,
    }


@router.post("/refresh")
async def refresh_l4_alpha_ev_artifact(req: L4AlphaEvRefreshReq) -> dict[str, Any]:
    """Build and optionally promote the formal L4 alpha EV artifact.

    This is intentionally separate from universal retrain and Optuna research:
    L4 alpha EV is a downstream selection expected-return calibrator. The route
    promotes only a production-approved PASS artifact and otherwise preserves
    the existing trading config.
    """

    defaults = _defaults_for_cadence(req.cadence)
    end_date = _latest_verified_end_date(req.end_date)
    lookback_days = req.lookback_days or defaults["lookback_days"]
    min_samples = req.min_samples or defaults["min_samples"]
    min_dates = req.min_dates or defaults["min_dates"]

    rows = load_l4_alpha_ev_training_rows(
        d1_client.query,
        end_date=end_date,
        lookback_days=lookback_days,
        limit=req.limit,
    )
    result = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until=end_date,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_dates=min_dates,
    )
    artifact = result.get("artifact") if isinstance(result, dict) else None
    validation = result.get("validation_packet") if isinstance(result, dict) else None
    decision = str((validation or {}).get("decision") or "").upper()
    promotion_state = str((artifact or {}).get("promotion_state") or "")
    registry_error: str | None = None
    if isinstance(artifact, dict):
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
    if req.promote and not req.dry_run:
        if not isinstance(artifact, dict) or promotion_state != "production_approved" or decision != "PASS":
            return {
                **result,
                "status": "failed_validation",
                "promoted": False,
                "registry_error": registry_error,
                "production_mutation_allowed": False,
                "summary": (
                    "l4_alpha_ev_refresh failed_validation "
                    f"cadence={req.cadence} end_date={end_date} decision={decision or 'UNKNOWN'}"
                ),
            }
        try:
            await worker_fetch(
                "/api/admin/config",
                method="PUT",
                json_body={
                    "ensemble_v2": {
                        "l4AlphaEv": artifact,
                        "l4_alpha_ev": artifact,
                    },
                    "meta": {
                        "source": "l4_alpha_ev_refresh",
                        "push_id": f"l4_alpha_ev:{req.cadence}:{end_date}:{(artifact or {}).get('model_version', 'unknown')}",
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
        "registry_error": registry_error,
        "production_mutation_allowed": bool(req.promote and not req.dry_run and decision == "PASS"),
        "summary": (
            f"l4_alpha_ev_refresh status={status} cadence={req.cadence} "
            f"end_date={end_date} model_version={(artifact or {}).get('model_version', 'unknown')} "
            f"decision={decision or 'UNKNOWN'} promoted={1 if promoted else 0}"
        ),
    }
