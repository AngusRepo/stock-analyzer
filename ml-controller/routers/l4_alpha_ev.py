from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import d1_client
from services.l4_alpha_ev_artifact_builder import (
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)
from services.l4_alpha_ev_producer import assess_l4_artifact_cutover
from services.ev_lineage_contract import (
    load_model_champion_history,
    reconstruct_rows_with_point_in_time_lineage,
)
from services.model_artifact_registry import upsert_artifact_record


router = APIRouter(prefix="/l4_alpha_ev", tags=["l4_alpha_ev"])


DIRECT_REFRESH_PROMOTION_OWNER = "active8_oof_lifecycle"
DIRECT_REFRESH_PROMOTION_ENDPOINT = "/walk_forward/oof/lifecycle"
DIRECT_REFRESH_PROMOTION_DETAIL = "direct_refresh_promotion_disabled_use_active8_oof_lifecycle"


class L4AlphaEvRefreshReq(BaseModel):
    end_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    cadence: Literal["weekly", "monthly", "manual"] = "weekly"
    lookback_days: int | None = Field(default=None, ge=30, le=365)
    min_samples: int | None = Field(default=None, ge=100, le=10000)
    min_dates: int | None = Field(default=None, ge=5, le=252)
    limit: int = Field(default=6000, ge=500, le=20000)
    promote: bool = False
    dry_run: bool = False
    trigger_source: str = "worker_scheduler"


def _latest_mature_prediction_date(max_date: str | None) -> str:
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
        SELECT MAX(date(p.prediction_date)) AS end_date
        FROM predictions p
        JOIN daily_recommendations dr
          ON dr.stock_id = p.stock_id
         AND dr.date = p.prediction_date
        JOIN price_horizons ph
          ON ph.stock_id = p.stock_id
         AND ph.price_date = date(p.prediction_date)
        WHERE p.model_name = 'ensemble'
          AND p.forecast_data IS NOT NULL
          AND dr.score_components IS NOT NULL
          AND date(p.prediction_date) <= date(?)
          AND date(ph.exit_date) <= date(?)
        """,
        [cutoff, cutoff, cutoff],
    )
    end_date = str((rows[0] if rows else {}).get("end_date") or "").strip()
    if not end_date:
        raise HTTPException(status_code=409, detail="l4_alpha_ev_no_mature_executable_labels")
    return end_date


def _defaults_for_cadence(cadence: str) -> dict[str, int]:
    if cadence == "monthly":
        return {"lookback_days": 180, "min_samples": 1000, "min_dates": 35}
    return {"lookback_days": 90, "min_samples": 500, "min_dates": 20}


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
        "artifact_id": f"l4_alpha_ev:{model_version}",
        "model_name": "l4_alpha_ev",
        "version": model_version,
        "candidate_type": "l4_alpha_ev_refresh",
        "state": _registry_lifecycle_state(decision=decision),
        "artifact_path": None,
        "metadata_path": None,
        "training_run_id": f"l4_alpha_ev_refresh:{cadence}:{end_date}",
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
async def refresh_l4_alpha_ev_artifact(req: L4AlphaEvRefreshReq) -> dict[str, Any]:
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
    knowledge_cutoff_date = req.end_date or datetime.now(timezone.utc).date().isoformat()
    end_date = _latest_mature_prediction_date(knowledge_cutoff_date)
    lookback_days = req.lookback_days or defaults["lookback_days"]
    min_samples = req.min_samples or defaults["min_samples"]
    min_dates = req.min_dates or defaults["min_dates"]

    rows = load_l4_alpha_ev_training_rows(
        d1_client.query,
        end_date=end_date,
        knowledge_cutoff_date=knowledge_cutoff_date,
        lookback_days=lookback_days,
        limit=req.limit,
    )
    generated_values = sorted(
        str(row.get("prediction_generated_at") or "").strip()
        for row in rows
        if str(row.get("prediction_generated_at") or "").strip()
    )
    history_start = generated_values[0] if generated_values else f"{end_date}T00:00:00Z"
    history_end = generated_values[-1] if generated_values else f"{end_date}T23:59:59Z"
    champion_events, champion_history_load = load_model_champion_history(
        d1_client.query,
        start_at=history_start,
        end_at=history_end,
    )
    lineage_rows, lineage_audit = reconstruct_rows_with_point_in_time_lineage(
        rows,
        champion_events=champion_events,
    )
    result = build_l4_alpha_ev_artifact_from_rows(
        lineage_rows,
        trained_until=end_date,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_dates=min_dates,
    )
    artifact = result.get("artifact") if isinstance(result, dict) else None
    validation = result.get("validation_packet") if isinstance(result, dict) else None
    if isinstance(artifact, dict):
        training_data = artifact.get("training_data") if isinstance(artifact.get("training_data"), dict) else {}
        artifact["training_data"] = {
            **training_data,
            "lineage_reconstruction": lineage_audit,
            "champion_history_load": champion_history_load,
        }
    cutover_readiness = assess_l4_artifact_cutover(artifact if isinstance(artifact, dict) else None)
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
        "end_date": end_date,
        "lookback_days": lookback_days,
        "min_samples": min_samples,
        "min_dates": min_dates,
        "rows_loaded": len(rows),
        "lineage_rows_accepted": len(lineage_rows),
        "lineage_rows_rejected": max(0, len(rows) - len(lineage_rows)),
        "lineage_reconstruction": lineage_audit,
        "champion_history_load": champion_history_load,
        "promoted": False,
        "registry_error": registry_error,
        "cutover_readiness": cutover_readiness,
        "production_mutation_allowed": False,
        "promotion_owner": DIRECT_REFRESH_PROMOTION_OWNER,
        "promotion_endpoint": DIRECT_REFRESH_PROMOTION_ENDPOINT,
        "summary": (
            f"l4_alpha_ev_refresh status={status} cadence={req.cadence} "
            f"end_date={end_date} model_version={(artifact or {}).get('model_version', 'unknown')} "
            f"decision={decision or 'UNKNOWN'} lineage={len(lineage_rows)}/{len(rows)} "
            "mode=candidate_research_only"
        ),
    }
