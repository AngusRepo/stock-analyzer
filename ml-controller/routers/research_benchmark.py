"""Research benchmark endpoints for model-family candidates."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.research_model_benchmark import build_model_family_benchmark_report


router = APIRouter()


class ResearchModelBenchmarkRequest(BaseModel):
    experiment_id: str
    candidate_id: str
    start_date: str | None = None
    end_date: str | None = None
    data_slice: dict[str, Any] = {}
    metrics: list[str] = []
    executor_result: dict[str, Any] | None = None
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    persist_confirm: bool = False
    confirm: bool = False


@router.post("/research/model-benchmark/dry-run")
async def research_model_benchmark_dry_run(req: ResearchModelBenchmarkRequest):
    """Build a non-mutating benchmark evidence packet.

    This endpoint is deliberately fail-closed: without real executor fold
    metrics, PBO/CPCV, cost, and data-slice evidence, the report is blocked.
    """
    if req.mutation_allowed or req.persist_results or req.persist_confirm:
        raise HTTPException(status_code=400, detail="research benchmark dry-run cannot mutate or persist production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="use a reviewed benchmark executor for non-dry-run model training")
    return build_model_family_benchmark_report(
        candidate_id=req.candidate_id,
        experiment_id=req.experiment_id,
        start_date=req.start_date,
        end_date=req.end_date,
        data_slice=req.data_slice,
        executor_result=req.executor_result,
    )


@router.post("/research/model-benchmark/run")
async def research_model_benchmark_run(req: ResearchModelBenchmarkRequest):
    """Run a reviewed research benchmark executor and wrap it as evidence.

    This route may call Modal, but it remains research-only. It does not promote
    artifacts, deploy, or mutate trading state.
    """
    if req.mutation_allowed or req.persist_confirm:
        raise HTTPException(status_code=400, detail="research benchmark cannot mutate production state")
    if not req.confirm:
        raise HTTPException(status_code=400, detail="research benchmark run requires confirm=true")

    from services import modal_client

    executor_result = await modal_client.research_model_benchmark({
        "experiment_id": req.experiment_id,
        "candidate_id": req.candidate_id,
        "start_date": req.start_date,
        "end_date": req.end_date,
        "data_slice": req.data_slice,
        "metrics": req.metrics,
        "executor_result": req.executor_result,
        "production_mutation_allowed": False,
    })
    return build_model_family_benchmark_report(
        candidate_id=req.candidate_id,
        experiment_id=req.experiment_id,
        start_date=req.start_date,
        end_date=req.end_date,
        data_slice=req.data_slice,
        executor_result=executor_result,
    )
