from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "feature_registry"
OUT_DIR = ROOT / "output" / "feature_universe_triage"

MONTHLY_CONFIG = DATA_DIR / "pymoo_monthly_mining_config_v1.json"
PROMOTION_CONTRACT = DATA_DIR / "alpha_mining_promotion_contract_v1.json"
LOCAL_CLOSURE = OUT_DIR / "feature_registry_local_closure_20260617.json"
ML_MIGRATION_PREFLIGHT = DATA_DIR / "ml_feature_migration_preflight_v1.json"
LEDGER_MIGRATION = ROOT / "worker" / "migration_strategy_mining_ledger_2026_06_18.sql"

router = APIRouter(prefix="/strategy_mining", tags=["strategy_mining"])


class MonthlyPymooRunReq(BaseModel):
    run_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    cadence: str = Field(default="monthly", pattern="^monthly$")
    persist: bool = True
    dry_run: bool = False
    trigger_source: str = "worker_scheduler"


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise HTTPException(status_code=503, detail=f"missing_contract:{path}")
    with path.open("r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise HTTPException(status_code=503, detail=f"invalid_contract:{path}")
    return data


def _preflight_packet(req: MonthlyPymooRunReq) -> dict[str, Any]:
    monthly = _load_json(MONTHLY_CONFIG)
    promotion = _load_json(PROMOTION_CONTRACT)
    closure = _load_json(LOCAL_CLOSURE)
    migration = _load_json(ML_MIGRATION_PREFLIGHT)
    if not LEDGER_MIGRATION.exists():
        raise HTTPException(status_code=503, detail=f"missing_ledger_migration:{LEDGER_MIGRATION}")

    closure_status = closure.get("status")
    migration_status = migration.get("status")
    promotion_errors = promotion.get("errors") or []
    closure_counts = closure.get("counts") or {}
    defaults = monthly.get("defaults") or {}
    schedule = monthly.get("schedule") or {}
    feature_pool = promotion.get("feature_pool_policy") or {}
    feature_view_counts = closure_counts.get("feature_view_counts") or {}
    expected_alpha_pool = int(
        feature_view_counts.get("alpha_mining_view")
        or closure_counts.get("formal_alpha_mining_features")
        or 0
    )
    actual_alpha_pool = int(feature_pool.get("eligible_for_alpha_mining") or 0)

    errors: list[str] = []
    if closure_status != "pass":
        errors.append(f"feature_registry_closure_not_pass:{closure_status}")
    if migration_status != "preflight_ready":
        errors.append(f"ml_feature_migration_not_ready:{migration_status}")
    if promotion.get("decision_effect") != "governance_contract_only":
        errors.append("promotion_contract_has_runtime_effect")
    if schedule.get("cadence") != "monthly":
        errors.append("monthly_schedule_not_monthly")
    if schedule.get("requires_finlab_backtest") is not True:
        errors.append("monthly_finlab_backtest_not_required")
    if defaults.get("algorithm") != "pymoo":
        errors.append("monthly_algorithm_not_pymoo")
    if actual_alpha_pool <= 0:
        errors.append("alpha_mining_feature_pool_empty")
    if expected_alpha_pool > 0 and actual_alpha_pool != expected_alpha_pool:
        errors.append(f"alpha_mining_feature_pool_mismatch:{actual_alpha_pool}!={expected_alpha_pool}")
    if promotion_errors:
        errors.append(f"promotion_contract_errors:{len(promotion_errors)}")

    status = "preflight_ready" if not errors else "blocked"
    return {
        "status": status,
        "errors": errors,
        "decision_effect": "research_only",
        "production_mutation_allowed": False,
        "request": req.model_dump(),
        "contracts": {
            "monthly_config": str(MONTHLY_CONFIG),
            "promotion_contract": str(PROMOTION_CONTRACT),
            "feature_registry_closure": str(LOCAL_CLOSURE),
            "ml_feature_migration_preflight": str(ML_MIGRATION_PREFLIGHT),
            "ledger_migration": str(LEDGER_MIGRATION),
        },
        "feature_pool": {
            "eligible_for_alpha_mining": actual_alpha_pool,
            "expected_from_local_closure": expected_alpha_pool,
            "formal_pool": feature_pool.get("formal_pool"),
            "selector_role_counts": feature_pool.get("selector_role_counts"),
        },
        "monthly_search_policy": promotion.get("monthly_search_policy"),
        "required_evidence": promotion.get("required_evidence"),
        "promotion_guardrails": promotion.get("promotion_guardrails"),
        "ledger_tables": [
            "strategy_mining_runs",
            "strategy_mining_candidates",
            "strategy_backtest_results",
            "strategy_similarity_matrix",
            "strategy_promotion_ledger",
        ],
    }


def _strategy_mining_job_client() -> CloudRunJobsClient:
    job_name = os.environ.get("STRATEGY_MINING_JOB_NAME", "").strip()
    return CloudRunJobsClient(job_name=job_name)


@router.post("/monthly_pymoo/run")
async def run_monthly_pymoo_strategy_mining(req: MonthlyPymooRunReq):
    packet = _preflight_packet(req)
    if packet["status"] != "preflight_ready":
        return packet

    execution_enabled = os.environ.get("STRATEGY_MINING_EXECUTION_ENABLED", "").strip().lower() in {"1", "true", "yes"}
    if req.dry_run or not execution_enabled:
        return {
            **packet,
            "status": "preflight_ready",
            "triggered": False,
            "trigger_reason": "dry_run_or_execution_disabled",
            "summary": (
                "monthly_pymoo_strategy_mining preflight_ready; "
                "execution disabled until STRATEGY_MINING_EXECUTION_ENABLED=1"
            ),
        }

    try:
        execution = _strategy_mining_job_client().run_job({
            "STRATEGY_MINING_RUN_DATE": req.run_date or "",
            "STRATEGY_MINING_CADENCE": req.cadence,
            "STRATEGY_MINING_PERSIST": "1" if req.persist else "0",
            "STRATEGY_MINING_TRIGGER_SOURCE": req.trigger_source,
        })
    except JobAlreadyRunningError as exc:
        return {
            **packet,
            "status": "already_running",
            "triggered": False,
            "execution_id": exc.execution.execution_id,
            "summary": f"monthly_pymoo_strategy_mining already running execution_id={exc.execution.execution_id}",
        }
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"strategy_mining_job_trigger_failed:{exc}") from exc

    return {
        **packet,
        "status": "triggered",
        "triggered": True,
        "execution_id": execution.execution_id,
        "execution_name": execution.execution_name,
        "summary": f"monthly_pymoo_strategy_mining triggered execution_id={execution.execution_id} callback expected",
    }
