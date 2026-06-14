from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.local_prod_ready_audit import build_local_prod_ready_audit


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_local_prod_ready_audit_marks_done_when_local_gates_are_closed(tmp_path):
    _write(
        tmp_path / "infra/gcp-scheduler-jobs.json",
        json.dumps({
            "jobs": [
                {"id": "weekly-optuna"},
                {"id": "adaptive-meta-policy-replay"},
                {"id": "linucb-multiplier-replay"},
                {"id": "monthly-optuna"},
                {"id": "optuna-queue"},
            ]
        }),
    )
    _write(
        tmp_path / "ml-service/requirements.txt",
        "\n".join([
            "scikit-learn==1.9.0",
            "xgboost==3.2.0",
            "lightgbm==4.6.0",
            "torch==2.12.0",
            "torch-geometric==2.8.0",
            "neuralforecast==3.1.9",
            "tabm==0.0.3",
            "timesfm[torch]==2.0.1",
            "optuna==4.9.0",
        ]),
    )
    _write(tmp_path / "ml-controller/requirements.txt", "optuna==4.9.0")
    _write(
        tmp_path / "worker/package.json",
        json.dumps({
            "dependencies": {"hono": "4.12.25"},
            "devDependencies": {
                "wrangler": "4.100.0",
                "typescript": "6.0.3",
            },
        }),
    )
    _write(
        tmp_path / "frontend/src/pages/ModelPoolPage.tsx",
        (
            "ModelPoolNewFlowWorkbench !isRetiredModelName(name) "
            "Promotion & Parameter Governance allocator controllers emit parameter candidates champion pointer"
        ),
    )
    _write(
        tmp_path / "frontend/src/components/model-pool/ModelPoolNewFlowWorkbench.tsx",
        "\n".join([
            "adaptive-meta-policy-replay linucb-multiplier-replay",
            "const TREE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])",
            "const SEQUENCE_MODELS = new Set(['DLinear', 'PatchTST', 'iTransformer', 'TimesFM'])",
            "const GRAPH_MODELS = new Set(['GNN'])",
            "const TABULAR_NEURAL_MODELS = new Set(['TabM'])",
            "function modelFamily(name: string): 'Tree' | 'TabM' | 'Sequence' | 'GNN' | 'Other' { return 'Tree' }",
            "Fleet status Meta boundary Active-9 confidence hook LinUCB, NeuralUCB, NeuralTS, and NeuCB",
        ]),
    )
    _write(
        tmp_path / "ml-controller/tests/test_optuna_script_contracts.py",
        'assert "adaptive_l2" not in OPTUNA_SCRIPT_CONTRACTS\nassert "optuna_adaptive_l2.py"\n',
    )
    _write(
        tmp_path / "worker/src/lib/screenerFunnelEvidence.ts",
        "\n".join([
            "const L2_COARSE_MODELS = ['LightGBM', 'XGBoost', 'ExtraTrees']",
            "const L3_FORMAL_MODELS = ['TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer', 'TimesFM']",
            "const ACTIVE_9_ML_TEACHER_MODELS = [...L2_COARSE_MODELS, ...L3_FORMAL_MODELS]",
            "layer2_3ml_coarse_summary_v1 layer3_6ml_formal_summary_v1",
            "three_ml_coarse_screen_not_final_ranker six_ml_formal_family_vote_not_topk",
            "expected_teacher_count teacher_label_scope",
            "layer1_strategy_labeler_summary_v1",
            "layer125_finlab_portfolio_intelligence_summary_v1",
            "layer15_multi_strategy_router_summary_v1",
            "layer35_evidence_fusion_v1",
            "daily_strategy_portfolio_intelligence_health_v1",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/metaLearningResearchTrack.ts",
        "\n".join([
            "Rules: LinUCB remains the interpretable production baseline; NeuralUCB and NeuralTS are shadow challengers; NeuCB may emit research-only shadow evidence; portfolio bandit stays in L4 Strategy Lab until execution evidence exists.",
            "shadow_challenger research_only partial_fill_replay decision_queue_status",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/tradingConfigChampionContract.test.ts",
        "sparse_tangent_inverse_risk OnlinePortfolioBandit legacy top-k override must stay disabled",
    )
    _write(
        tmp_path / "ml-controller/services/adaptive.py",
        'OnlinePortfolioBandit": "production allocator controller for sparse_tangent_inverse_risk knobs; production-capable without replacing the final weight engine',
    )
    _write(
        tmp_path / "worker/src/lib/adaptiveConfig.ts",
        "OnlinePortfolioBandit: 'production allocator controller for sparse_tangent_inverse_risk knobs; production-capable without replacing the final weight engine",
    )
    _write(
        tmp_path / "ml-controller/services/active9_dataset_policy.py",
        "\n".join([
            "ACTIVE_ALPHA_MODELS",
            "LightGBM XGBoost ExtraTrees TabM GNN DLinear PatchTST iTransformer TimesFM",
            "RETIRED_ALPHA_MODELS",
            "CatBoost FT-Transformer Chronos",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/adaptiveMetaPolicyReplayRunner.ts",
        "LightGBM XGBoost ExtraTrees TabM GNN DLinear PatchTST iTransformer TimesFM p.verified_at IS NOT NULL active_models: [...ACTIVE_MODELS]",
    )
    _write(
        tmp_path / "worker/src/lib/adaptiveEngineContract.test.ts",
        "active_9_quality_30d LightGBM TabM iTransformer TimesFM !allBinds.includes('CatBoost')",
    )
    _write(
        tmp_path / "ml-controller/tests/test_model_ic_tracker.py",
        '"CatBoost" not in tracked\n"FT-Transformer" not in tracked\n"Chronos" not in tracked\n',
    )
    _write(
        tmp_path / "worker/src/lib/weeklyResearchClosureContract.test.ts",
        "\n".join([
            "'/optuna/research_sweep/run'",
            "not Worker fan-out across nine endpoints",
            "run_date: options.runDate",
            "research_data_source: 'snapshot'",
            "timeoutMs: 60_000",
            "max_parallel_sources: 3",
            "manual/approval-gated",
        ]),
    )
    _write(
        tmp_path / "ml-controller/routers/optuna.py",
        'Synchronous Optuna research sweep is disabled\n@router.post("/research_sweep/run")\nCloud Run Job\n25-dim (minus 5 bandit defer) L2/circuit Optuna search against Mode B replay\n',
    )
    _write(
        tmp_path / "worker/src/lib/schedulerPolicy.ts",
        "weekly-optuna monthly-optuna optuna-queue adaptive-meta-policy-replay linucb-multiplier-replay",
    )
    _write(
        tmp_path / "worker/src/lib/postMarketChainContract.test.ts",
        "runModelIcRollingRefresh runLinUcbRewardLedgerRefresh runAdaptiveUpdate runMetaLearningShadowClosure runStrategyLearningClosureTask root chain closed after post-verify",
    )
    _write(
        tmp_path / "worker/src/lib/strategyLearning.ts",
        "requires_wei_approval l3_requires_wei_approval status_must_enter_shadow_before_promotion",
    )
    _write(
        tmp_path / "frontend/src/pages/StrategyLabPage.tsx",
        "approved_for_shadow requires_wei_approval l3_requires_wei_approval",
    )
    _write(
        tmp_path / "ml-controller/services/model_artifact_registry.py",
        "active-9 production artifact set production promotion must use an active-9 model",
    )
    _write(
        tmp_path / "worker/src/routes/paper.ts",
        "pending_buy_execution_policy_v1 execution_pool_policy: 'l4_sparse_final_buy_only' allocation_engine: 'sparse_tangent_inverse_risk' watch_fallback_allowed: false raw_recommendation_rows_executable: false",
    )
    _write(
        tmp_path / "worker/src/lib/pendingBuyOrchestrator.ts",
        "execution_pool_policy: 'l4_sparse_final_buy_only' json_extract(dr.alpha_allocation, '$.engine') = 'sparse_tangent_inverse_risk'",
    )
    _write(
        tmp_path / "worker/src/lib/dataQualityMonitor.ts",
        "pending_buy_l4_allocator_owner sparse_tangent_inverse_risk",
    )
    _write(
        tmp_path / "worker/src/lib/recommendationContext.ts",
        "sparse_tangent_inverse_risk_final_allocation DEFAULT_SPARSE_ALLOCATION_CONTROLLER = 'OnlinePortfolioBandit'",
    )
    _write(
        tmp_path / "worker/src/routes/other.ts",
        "strategy_portfolio_intelligence_health",
    )
    for name in (
        "adaptive_meta_policy_replay_20260605_20260611.json",
        "linucb_multiplier_replay_20260605_20260611.json",
    ):
        _write(
            tmp_path / f"ml-service/benchmark_results/{name}",
            json.dumps({"status": "fail", "allowed_use": "research_only", "production_effect": False}),
        )

    audit = build_local_prod_ready_audit(tmp_path)

    assert audit["local_closure"] == "done"
    assert audit["local_prod_ready"] == "done"
    assert audit["promotion_allowed"] is False
    assert audit["production_mutation_allowed"] is False
    assert audit["failed_checks"] == []
    assert "sync_gcp_scheduler_manifest" in audit["production_cutover_requires_wei_approval"]
