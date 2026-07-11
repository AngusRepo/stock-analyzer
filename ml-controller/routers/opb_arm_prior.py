from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.model_artifact_registry import upsert_artifact_record
from services.opb_counterfactual_prior import (
    build_opb_arm_prior_artifact,
    load_opb_counterfactual_inputs,
)
from services.worker_config_client import worker_fetch

router = APIRouter(prefix="/opb_arm_prior", tags=["opb_arm_prior"])


class OpbArmPriorRefreshReq(BaseModel):
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_return_owner: Literal["l4_alpha_ev", "allocator_ev_fusion"] = "l4_alpha_ev"
    lookback_days: int = Field(default=120, ge=30, le=365)
    min_dates: int = Field(default=20, ge=10, le=252)
    limit: int = Field(default=10000, ge=500, le=20000)
    roundtrip_cost_bps: float = Field(default=18.0, ge=0.0, le=100.0)
    promote: bool = False
    dry_run: bool = True
    trigger_source: str = "manual"


def _checksum(artifact: dict[str, Any]) -> str:
    payload = json.dumps(artifact, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _registry_record(artifact: dict[str, Any], *, promoted: bool, promotion_error: str | None) -> dict[str, Any]:
    validation = artifact.get("validation") if isinstance(artifact.get("validation"), dict) else {}
    passed = str(validation.get("decision") or "").upper() == "PASS"
    version = str(artifact.get("model_version") or "unknown")
    state = "production" if promoted else "approval_required" if promotion_error else "offline_passed" if passed else "offline_failed"
    return {
        "artifact_id": artifact.get("artifact_id") or f"opb_arm_prior:{version}",
        "model_name": "opb_arm_prior",
        "version": version,
        "candidate_type": "opb_arm_prior_refresh",
        "state": state,
        "artifact_path": None,
        "metadata_path": None,
        "training_run_id": f"opb_arm_prior_refresh:{artifact.get('trained_until')}:{artifact.get('expected_return_owner')}",
        "training_manifest_path": None,
        "trained_from_snapshot": "allocator_ev_feature_snapshots",
        "evaluation_baseline_version": None,
        "final_compared_to": None,
        "feature_policy_version": artifact.get("expected_return_owner"),
        "checksum": _checksum(artifact),
        "source_run_date": artifact.get("trained_until"),
        "is_monthly": 0,
        "offline_gate_status": "passed" if passed else "failed",
        "offline_gate_decision": validation.get("decision"),
        "offline_gate_failed_gates": json.dumps(validation.get("failed_checks") or []),
        "offline_evidence_json": json.dumps(artifact, ensure_ascii=False),
        "live_gate_status": "promoted" if promoted else "promotion_failed" if promotion_error else "not_started",
        "live_evidence_json": json.dumps({"promoted": promoted, "promotion_error": promotion_error}),
        "promotion_decision": "production_prior" if promoted else "shadow_prior",
        "approval_state": "approved" if promoted else "not_required",
    }


@router.post("/refresh")
async def refresh_opb_arm_prior(req: OpbArmPriorRefreshReq) -> dict[str, Any]:
    rows, price_rows = load_opb_counterfactual_inputs(
        end_date=req.end_date,
        lookback_days=req.lookback_days,
        limit=req.limit,
    )
    result = build_opb_arm_prior_artifact(
        rows,
        price_rows,
        expected_return_owner=req.expected_return_owner,
        trained_until=req.end_date,
        min_dates=req.min_dates,
        roundtrip_cost_bps=req.roundtrip_cost_bps,
    )
    artifact = result["artifact"]
    passed = str((artifact.get("validation") or {}).get("decision") or "").upper() == "PASS"
    promoted = False
    promotion_error: str | None = None
    if req.promote and not req.dry_run and passed:
        try:
            await worker_fetch(
                "/api/admin/config",
                method="PUT",
                json_body={
                    "alphaFramework": {
                        "allocation": {
                            "opbArmPrior": artifact,
                            "opb_arm_prior": artifact,
                        }
                    },
                    "meta": {
                        "source": "opb_arm_prior_refresh",
                        "push_id": artifact.get("artifact_id"),
                    },
                },
                timeout=30.0,
            )
            promoted = True
        except Exception as exc:  # noqa: BLE001 - return promotion failure to scheduler.
            promotion_error = str(exc)
    registry_error: str | None = None
    try:
        upsert_artifact_record(_registry_record(artifact, promoted=promoted, promotion_error=promotion_error))
    except Exception as exc:  # noqa: BLE001
        registry_error = str(exc)
    return {
        **result,
        "rows_loaded": len(rows),
        "price_rows_loaded": len(price_rows),
        "promoted": promoted,
        "promotion_error": promotion_error,
        "registry_error": registry_error,
        "production_mutation_allowed": bool(req.promote and not req.dry_run and passed),
    }
