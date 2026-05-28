"""Research benchmark endpoints for model-family candidates."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.adoption_decision import build_adoption_decision_packet
from services.alpha_agent_evo import build_alpha_agent_evo_trajectory_report
from services.alpha_agent_evo_runtime import (
    run_alpha_agent_evo_evolution,
    run_alpha_agent_evo_historical_evolution,
)
from services.code_retirement_approval_manifest import build_code_retirement_approval_manifest
from services.code_retirement_inventory import build_code_retirement_inventory
from services.code_retirement_planner import build_code_retirement_plan
from services.code_retirement_review import build_code_retirement_review
from services.code_retirement_workflow import build_code_retirement_report
from services.conformal_risk_gate import build_conformal_risk_gate
from services.direct_allocation_benchmark import build_direct_allocation_benchmark
from services.finance_llm_eval_gate import build_finance_llm_eval_gate
from services.market_state_benchmark import build_market_state_benchmark_report
from services.portfolio_allocation import build_portfolio_allocation_benchmark
from services.portfolio_allocation_replacement import (
    activate_sparse_tangent_owner,
    run_historical_replacement_report,
)
from services.research_model_benchmark import build_model_family_benchmark_report
from services.validation_governance import build_validation_ladder_packet


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


class PortfolioAllocationBenchmarkRequest(BaseModel):
    candidates: list[dict[str, Any]]
    return_history: dict[str, list[float]]
    top_k: int = 5
    max_weight: float = 0.55
    min_sharpe_delta: float = 0.20
    max_mdd_delta: float = 0.02
    min_history_days: int = 20
    selection_pool_size: int | None = None
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class AlphaAgentEvoTrajectoryRequest(BaseModel):
    candidates: list[dict[str, Any]]
    champion_id: str | None = None
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class AlphaAgentEvoEvolutionRunRequest(BaseModel):
    recommendation_rows: list[dict[str, Any]] = []
    price_rows: list[dict[str, Any]] = []
    seed_expressions: list[dict[str, Any]] | None = None
    feature_catalog: list[str] | None = None
    generations: int = 3
    offspring_per_parent: int = 4
    survivors_per_generation: int = 3
    top_k: int = 3
    min_evaluation_days: int = 20
    min_sharpe_delta: float = 0.20
    max_mdd_delta: float = 0.02
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class AlphaAgentEvoHistoricalRunRequest(BaseModel):
    start_date: str
    end_date: str
    seed_expressions: list[dict[str, Any]] | None = None
    feature_catalog: list[str] | None = None
    generations: int = 3
    offspring_per_parent: int = 4
    survivors_per_generation: int = 3
    top_k: int = 3
    lookback_days: int = 60
    min_evaluation_days: int = 20
    min_sharpe_delta: float = 0.20
    max_mdd_delta: float = 0.02
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class PortfolioAllocationProductionReplaceRequest(BaseModel):
    start_date: str
    end_date: str
    top_k: int = 3
    selection_pool_size: int = 30
    lookback_days: int = 60
    max_weight: float = 0.55
    min_history_days: int = 20
    min_sharpe_delta: float = 0.20
    max_mdd_delta: float = 0.02
    mutation_allowed: bool = False
    confirm: bool = False


class MarketStateBenchmarkRequest(BaseModel):
    current_regime_rows: list[dict[str, Any]]
    candidate_state_rows: list[dict[str, Any]]
    realized_rows: list[dict[str, Any]]
    min_accuracy_delta: float = 0.05
    min_transition_recall_delta: float = 0.0
    max_brier_delta: float = 0.0
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class DirectAllocationBenchmarkRequest(BaseModel):
    returns_by_date: dict[str, dict[str, Any]]
    baseline_weights_by_date: dict[str, dict[str, Any]]
    candidate_weights_by_date: dict[str, dict[str, Any]]
    baseline_metadata_by_date: dict[str, dict[str, Any]] | None = None
    candidate_metadata_by_date: dict[str, dict[str, Any]] | None = None
    min_common_days: int = 6
    min_sharpe_delta: float = 0.20
    max_mdd_delta: float = 0.02
    max_turnover_delta: float = 0.25
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class ConformalRiskGateRequest(BaseModel):
    prediction_rows: list[dict[str, Any]]
    realized_rows: list[dict[str, Any]]
    target_coverage: float = 0.90
    max_tail_loss_rate: float = 0.10
    max_cvar_5: float = 0.08
    tail_loss_threshold: float = -0.05
    min_samples: int = 30
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class ValidationLadderRequest(BaseModel):
    candidate_id: str
    candidate_type: str = "unknown"
    evidence: dict[str, Any]
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class FinanceLlmEvalGateRequest(BaseModel):
    evaluation: dict[str, Any]
    min_samples: int = 100
    min_accuracy_delta: float = 0.05
    max_calibration_error: float = 0.10
    min_source_timestamp_coverage: float = 0.90
    min_class_samples: int = 10
    min_citation_coverage: float = 0.80
    min_counterfactual_consistency: float = 0.60
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class AdoptionDecisionRequest(BaseModel):
    candidate_id: str
    candidate_type: str = "unknown"
    baseline_id: str
    benchmark_report: dict[str, Any]
    validation_ladder_packet: dict[str, Any] | None = None
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class CodeRetirementPlanRequest(BaseModel):
    adoption_decision_packet: dict[str, Any]
    code_inventory: list[dict[str, Any]]
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class CodeRetirementInventoryRequest(BaseModel):
    adoption_decision_packet: dict[str, Any]
    repo_root: str
    candidate_paths: list[str] | None = None
    owner_tokens: list[str] | None = None
    replacement_owner: str | None = None
    parallel_readback_passed: bool = False
    rollback_path: str = ""
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class CodeRetirementReportRequest(BaseModel):
    adoption_decision_packet: dict[str, Any]
    repo_root: str
    candidate_paths: list[str] | None = None
    owner_tokens: list[str] | None = None
    replacement_owner: str | None = None
    parallel_readback_passed: bool = False
    rollback_path: str = ""
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class CodeRetirementApprovalManifestRequest(BaseModel):
    retirement_report: dict[str, Any]
    reviewer: str = "Wei"
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
    confirm: bool = False


class CodeRetirementReviewRequest(BaseModel):
    adoption_decision_packet: dict[str, Any]
    repo_root: str
    candidate_paths: list[str] | None = None
    owner_tokens: list[str] | None = None
    replacement_owner: str | None = None
    parallel_readback_passed: bool = False
    rollback_path: str = ""
    reviewer: str = "Wei"
    dry_run: bool = True
    mutation_allowed: bool = False
    persist_results: bool = False
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


@router.post("/research/alpha-agent-evo/dry-run")
async def research_alpha_agent_evo_dry_run(req: AlphaAgentEvoTrajectoryRequest):
    """Build a non-mutating self-evolving alpha trajectory report."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="AlphaAgentEvo dry-run cannot mutate or persist production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="AlphaAgentEvo promotion requires reviewed validation gates")
    return build_alpha_agent_evo_trajectory_report(
        candidates=req.candidates,
        champion_id=req.champion_id,
    )


@router.post("/research/alpha-agent-evo/evolve/dry-run")
async def research_alpha_agent_evo_evolve_dry_run(req: AlphaAgentEvoEvolutionRunRequest):
    """Run the full AlphaAgentEvo trajectory loop over supplied historical rows."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="AlphaAgentEvo evolution dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="AlphaAgentEvo production promotion requires reviewed gates")
    if not req.recommendation_rows:
        raise HTTPException(status_code=400, detail="recommendation_rows are required")
    return run_alpha_agent_evo_evolution(
        recommendation_rows=req.recommendation_rows,
        price_rows=req.price_rows,
        seed_expressions=req.seed_expressions,
        feature_catalog=req.feature_catalog,
        generations=req.generations,
        offspring_per_parent=req.offspring_per_parent,
        survivors_per_generation=req.survivors_per_generation,
        top_k=req.top_k,
        min_evaluation_days=req.min_evaluation_days,
        min_sharpe_delta=req.min_sharpe_delta,
        max_mdd_delta=req.max_mdd_delta,
    )


@router.post("/research/alpha-agent-evo/historical/dry-run")
async def research_alpha_agent_evo_historical_dry_run(req: AlphaAgentEvoHistoricalRunRequest):
    """Load D1 history and run the full AlphaAgentEvo trajectory loop without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="AlphaAgentEvo historical dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="AlphaAgentEvo production promotion requires reviewed gates")
    return run_alpha_agent_evo_historical_evolution(
        start_date=req.start_date,
        end_date=req.end_date,
        seed_expressions=req.seed_expressions,
        feature_catalog=req.feature_catalog,
        generations=req.generations,
        offspring_per_parent=req.offspring_per_parent,
        survivors_per_generation=req.survivors_per_generation,
        top_k=req.top_k,
        lookback_days=req.lookback_days,
        min_evaluation_days=req.min_evaluation_days,
        min_sharpe_delta=req.min_sharpe_delta,
        max_mdd_delta=req.max_mdd_delta,
    )


@router.post("/research/portfolio-allocation/dry-run")
async def research_portfolio_allocation_dry_run(req: PortfolioAllocationBenchmarkRequest):
    """Compare rank-topK against sparse-tangent allocation without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="portfolio allocation benchmark cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="portfolio allocation replacement requires reviewed promotion gate")
    return build_portfolio_allocation_benchmark(
        candidates=req.candidates,
        return_history=req.return_history,
        top_k=req.top_k,
        max_weight=req.max_weight,
        min_sharpe_delta=req.min_sharpe_delta,
        max_mdd_delta=req.max_mdd_delta,
        min_history_days=req.min_history_days,
        selection_pool_size=req.selection_pool_size,
    )


@router.post("/research/portfolio-allocation/production-replace/run")
async def research_portfolio_allocation_production_replace_run(req: PortfolioAllocationProductionReplaceRequest):
    """Replay history and, if confirmed, replace the production allocation owner."""
    if req.mutation_allowed and not req.confirm:
        raise HTTPException(status_code=400, detail="production replacement requires confirm=true")
    report = run_historical_replacement_report(
        start_date=req.start_date,
        end_date=req.end_date,
        top_k=req.top_k,
        selection_pool_size=req.selection_pool_size,
        lookback_days=req.lookback_days,
        max_weight=req.max_weight,
        min_history_days=req.min_history_days,
        min_sharpe_delta=req.min_sharpe_delta,
        max_mdd_delta=req.max_mdd_delta,
    )
    if not req.mutation_allowed:
        report["activation"] = {
            "status": "not_requested",
            "reason": "mutation_allowed=false",
        }
        return report
    report["activation"] = await activate_sparse_tangent_owner(
        report=report,
        top_k=req.top_k,
        selection_pool_size=req.selection_pool_size,
        max_weight=req.max_weight,
        min_history_days=req.min_history_days,
    )
    return report


@router.post("/research/market-state-benchmark/dry-run")
async def research_market_state_benchmark_dry_run(req: MarketStateBenchmarkRequest):
    """Compare current regime state against JEPA latent states without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="market-state benchmark cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="market-state fusion requires reviewed promotion gate")
    return build_market_state_benchmark_report(
        current_regime_rows=req.current_regime_rows,
        candidate_state_rows=req.candidate_state_rows,
        realized_rows=req.realized_rows,
        min_accuracy_delta=req.min_accuracy_delta,
        min_transition_recall_delta=req.min_transition_recall_delta,
        max_brier_delta=req.max_brier_delta,
    )


@router.post("/research/direct-allocation-benchmark/dry-run")
async def research_direct_allocation_benchmark_dry_run(req: DirectAllocationBenchmarkRequest):
    """Compare direct allocation models against predict-then-optimize without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="direct allocation benchmark cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="direct allocation replacement requires reviewed promotion gate")
    return build_direct_allocation_benchmark(
        returns_by_date=req.returns_by_date,
        baseline_weights_by_date=req.baseline_weights_by_date,
        candidate_weights_by_date=req.candidate_weights_by_date,
        baseline_metadata_by_date=req.baseline_metadata_by_date,
        candidate_metadata_by_date=req.candidate_metadata_by_date,
        min_common_days=req.min_common_days,
        min_sharpe_delta=req.min_sharpe_delta,
        max_mdd_delta=req.max_mdd_delta,
        max_turnover_delta=req.max_turnover_delta,
    )


@router.post("/research/conformal-risk-gate/dry-run")
async def research_conformal_risk_gate_dry_run(req: ConformalRiskGateRequest):
    """Evaluate conformal uncertainty and Kelly/CVaR controls without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="conformal risk gate cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="conformal risk attachment requires reviewed promotion gate")
    return build_conformal_risk_gate(
        prediction_rows=req.prediction_rows,
        realized_rows=req.realized_rows,
        target_coverage=req.target_coverage,
        max_tail_loss_rate=req.max_tail_loss_rate,
        max_cvar_5=req.max_cvar_5,
        tail_loss_threshold=req.tail_loss_threshold,
        min_samples=req.min_samples,
    )


@router.post("/research/validation-ladder/dry-run")
async def research_validation_ladder_dry_run(req: ValidationLadderRequest):
    """Map candidate evidence to L0-L10 adoption ladder without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="validation ladder dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="validation ladder promotion requires reviewed approval")
    return build_validation_ladder_packet(
        candidate_id=req.candidate_id,
        candidate_type=req.candidate_type,
        evidence=req.evidence,
    )


@router.post("/research/finance-llm-eval-gate/dry-run")
async def research_finance_llm_eval_gate_dry_run(req: FinanceLlmEvalGateRequest):
    """Evaluate finance LLM bias/leakage/XAI limits without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="finance LLM eval gate cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="finance LLM fusion requires reviewed evidence gate")
    return build_finance_llm_eval_gate(
        req.evaluation,
        min_samples=req.min_samples,
        min_accuracy_delta=req.min_accuracy_delta,
        max_calibration_error=req.max_calibration_error,
        min_source_timestamp_coverage=req.min_source_timestamp_coverage,
        min_class_samples=req.min_class_samples,
        min_citation_coverage=req.min_citation_coverage,
        min_counterfactual_consistency=req.min_counterfactual_consistency,
    )


@router.post("/research/adoption-decision/dry-run")
async def research_adoption_decision_dry_run(req: AdoptionDecisionRequest):
    """Normalize benchmark evidence into replace/fuse/enhance/reject without mutation."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="adoption decision dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="adoption decision requires reviewed manual approval")
    return build_adoption_decision_packet(
        candidate_id=req.candidate_id,
        candidate_type=req.candidate_type,
        baseline_id=req.baseline_id,
        benchmark_report=req.benchmark_report,
        validation_ladder_packet=req.validation_ladder_packet,
    )


@router.post("/research/code-retirement-plan/dry-run")
async def research_code_retirement_plan_dry_run(req: CodeRetirementPlanRequest):
    """Build a non-mutating code retirement checklist from adoption evidence."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="code retirement plan dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="code deletion requires Wei approval outside the dry-run planner")
    return build_code_retirement_plan(
        adoption_decision_packet=req.adoption_decision_packet,
        code_inventory=req.code_inventory,
    )


@router.post("/research/code-retirement-inventory/dry-run")
async def research_code_retirement_inventory_dry_run(req: CodeRetirementInventoryRequest):
    """Build read-only code inventory evidence for retirement planning."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="code retirement inventory dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="code retirement inventory must remain dry-run/read-only")
    return build_code_retirement_inventory(
        adoption_decision_packet=req.adoption_decision_packet,
        repo_root=req.repo_root,
        candidate_paths=req.candidate_paths,
        owner_tokens=req.owner_tokens,
        replacement_owner=req.replacement_owner,
        parallel_readback_passed=req.parallel_readback_passed,
        rollback_path=req.rollback_path,
    )


@router.post("/research/code-retirement-report/dry-run")
async def research_code_retirement_report_dry_run(req: CodeRetirementReportRequest):
    """Build inventory plus retirement plan in one read-only report."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="code retirement report dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="code retirement report must remain dry-run/read-only")
    return build_code_retirement_report(
        adoption_decision_packet=req.adoption_decision_packet,
        repo_root=req.repo_root,
        candidate_paths=req.candidate_paths,
        owner_tokens=req.owner_tokens,
        replacement_owner=req.replacement_owner,
        parallel_readback_passed=req.parallel_readback_passed,
        rollback_path=req.rollback_path,
    )


@router.post("/research/code-retirement-approval-manifest/dry-run")
async def research_code_retirement_approval_manifest_dry_run(req: CodeRetirementApprovalManifestRequest):
    """Build a manual approval manifest without granting delete permission."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="code retirement approval manifest cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="code retirement approval manifest must remain dry-run/read-only")
    return build_code_retirement_approval_manifest(
        retirement_report=req.retirement_report,
        reviewer=req.reviewer,
    )


@router.post("/research/code-retirement-review/dry-run")
async def research_code_retirement_review_dry_run(req: CodeRetirementReviewRequest):
    """Run the full read-only retirement review workflow in one call."""
    if req.mutation_allowed or req.persist_results or req.confirm:
        raise HTTPException(status_code=400, detail="code retirement review dry-run cannot mutate production state")
    if req.dry_run is False:
        raise HTTPException(status_code=400, detail="code retirement review must remain dry-run/read-only")
    return build_code_retirement_review(
        adoption_decision_packet=req.adoption_decision_packet,
        repo_root=req.repo_root,
        candidate_paths=req.candidate_paths,
        owner_tokens=req.owner_tokens,
        replacement_owner=req.replacement_owner,
        parallel_readback_passed=req.parallel_readback_passed,
        rollback_path=req.rollback_path,
        reviewer=req.reviewer,
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
