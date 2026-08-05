from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(relative_path: str) -> str:
    return REPO_ROOT.joinpath(relative_path).read_text(encoding="utf-8")


def test_l0_to_l4_layers_remain_and_no_topk_is_added_by_fusion_v13_cutover():
    screener = _read("worker/src/lib/marketScreener.ts")
    strategy_pool = _read("worker/src/lib/strategyCandidatePool.ts")
    pipeline = _read("ml-controller/graphs/daily_pipeline_v2.py")
    funnel_evidence = _read("worker/src/lib/screenerFunnelEvidence.ts")
    recommendation_context = _read("worker/src/lib/recommendationContext.ts")

    assert "layer1_strategy_breadth_gate" in screener
    assert "finlab_portfolio_intelligence_version" in screener
    assert "stage: 'l15_ml_slate_queue'" in screener
    assert "route_floor_decision_universe_no_capacity_admission" in strategy_pool
    assert "researchOnlyQueue" in strategy_pool
    assert 'g.add_node("l2_timesfm_enrich"' in pipeline
    assert 'g.add_node("l3_formal_predict"' in pipeline
    assert 'g.add_edge("l2_timesfm_enrich",   "l3_formal_predict")' in pipeline
    assert "layer35_evidence_fusion" in funnel_evidence
    assert "no_candidate_drop_no_topk_no_minimum_fill" in funnel_evidence
    assert "l4_sparse_allocation_summary_v1" in recommendation_context
    assert "legacy_topk_fallback_allowed" in recommendation_context


def test_s12_has_no_evening_candidate_or_expected_return_serving_owner():
    orchestrator = _read("worker/src/lib/updateOrchestrator.ts")
    paper_tasks = _read("worker/src/lib/paperEntryTasks.ts")
    recommendation = _read("ml-controller/services/recommendation_service.py")
    parity = _read("ml-controller/services/ev_operational_parity.py")

    assert "runS12CandidateStructureSnapshots" not in orchestrator
    assert "runS12IntradaySetupWatch" not in paper_tasks
    assert '"s12_trade_ev",\n        "risk_abstention"' not in recommendation
    assert 'parsed_row["s12_trade_ev"]' not in parity


def test_fusion_v13_is_one_artifact_with_exactly_two_serving_heads():
    materializer = _read("ml-controller/services/allocator_ev_fusion.py")
    builder = _read("ml-controller/services/allocator_ev_fusion_artifact_builder.py")
    contracts = _read("ml-controller/services/evidence_contracts.py")
    router = _read("ml-controller/routers/allocator_ev_fusion.py")

    assert "allocator-ev-fusion-contract-v13" in contracts
    assert '"policy_value_head_count": 2' in builder
    assert '"execution_probability_model"' in builder
    assert '"conditional_execution_return_model"' in builder
    assert "execution_probability * raw_execution_residual" in materializer
    assert "candidate_time_s12_feature_forbidden" in materializer
    assert "production_assistive" not in materializer
    assert "assistive_" not in router
    assert "L4/S12 feature snapshots" not in router
    assert "ASSISTIVE_" not in builder
    assert "assistive_floor" not in builder


def test_jobs_and_observability_drop_s12_candidate_stage_but_keep_research_replay():
    orchestrator = _read("worker/src/lib/updateOrchestrator.ts")
    scheduler = _read("worker/src/lib/schedulerDependencyMap.ts")
    panel = _read("frontend/src/components/observability/ExecutionChainPanel.tsx")

    assert "runS12ResearchStructureSnapshots" in orchestrator
    assert "s12_research_recovery" in orchestrator
    assert "s12_candidate_snapshot" not in scheduler
    assert "s12_candidate_snapshot" not in panel
