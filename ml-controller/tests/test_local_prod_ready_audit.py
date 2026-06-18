from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.local_prod_ready_audit import (
    CUTOVER_PACKET_FRESHNESS_DEPENDENCIES,
    _production_cutover_packet_checks,
    build_local_prod_ready_audit,
)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_cutover_freshness_dependencies(root: Path) -> None:
    managed_elsewhere = {
        "ml-controller/services/production_cutover_packet.py",
        "tools/production_cutover_remote_preflight.py",
        "ml-service/benchmark_results/production_cutover_remote_preflight_20260618.json",
    }
    for rel_path in CUTOVER_PACKET_FRESHNESS_DEPENDENCIES:
        if rel_path in managed_elsewhere:
            continue
        path = root / rel_path
        if path.exists():
            continue
        if rel_path.endswith(".sql"):
            _write(path, "-- local test migration fixture\n")
        elif rel_path.endswith(".json"):
            _write(path, json.dumps({"status": "pass"}))
        else:
            _write(path, "local test evidence fixture\n")


def _write_remote_preflight_fixture(root: Path) -> None:
    _write(
        root / "ml-service/benchmark_results/production_cutover_remote_preflight_20260618.json",
        json.dumps({
            "decision_effect": "read_only_observation",
            "production_mutation_allowed": False,
            "summary": {"remote_cutover_complete": False},
            "checks": [
                {"id": "gcp_scheduler_monthly_strategy_mining", "status": "missing"},
                {"id": "gcp_scheduler_monthly_optuna_timezone", "status": "drift"},
                {"id": "ml_controller_strategy_mining_env", "status": "missing"},
                {"id": "d1_strategy_mining_ledger_tables", "status": "missing"},
                {"id": "d1_alpha_miner_strategy_seed", "status": "present"},
                {"id": "d1_strategy_spec_registry_schema", "status": "present"},
            ],
        }),
    )


def _write_production_cutover_packet_fixture(root: Path) -> None:
    _write(
        root / "ml-service/benchmark_results/production_cutover_packet_20260618.json",
        json.dumps({
            "cutover_ready_for_review": True,
            "production_mutation_allowed": False,
            "actions_allowed_without_wei_approval": [],
            "remote_cutover_complete": False,
            "remote_preflight_summary": {
                "remote_cutover_complete": False,
                "incomplete_remote_check_ids": ["gcp_scheduler_monthly_strategy_mining"],
            },
            "evidence_health": [
                {
                    "id": "feature_registry_local_closure_pass",
                    "passed": True,
                    "detail": {
                        "artifact_fresh": True,
                        "derived_artifact_freshness": {"feature_views": {"fresh": True}},
                    },
                },
                {
                    "id": "unified137_materialization_pass",
                    "passed": True,
                    "detail": {"artifact_fresh": True},
                },
                {
                    "id": "ml_feature_migration_preflight_ready",
                    "passed": True,
                    "detail": {
                        "materialization_audit_fresh": "pass",
                        "materialization_contract_ready": "pass",
                    },
                },
                {
                    "id": "alpha_mining_promotion_contract_governance_only",
                    "passed": True,
                    "detail": {"source_contracts_fresh": True},
                },
                {"id": "strategy_feature_refs_no_blockers", "passed": True, "detail": {"blockers": 0}},
                {
                    "id": "local_audit_monthly_pymoo_runtime_contract_gates",
                    "passed": True,
                    "detail": {
                        "missing_check_ids": [],
                        "failed_check_ids": [],
                    },
                },
            ],
            "approval_required_actions": [
                {"id": "deploy_worker_and_frontend"},
                {"id": "deploy_ml_controller_strategy_mining_route"},
                {"id": "apply_strategy_registry_alpha_miner_migration"},
                {"id": "apply_strategy_mining_ledger_migration"},
                {"id": "sync_gcp_scheduler_manifest"},
                {"id": "write_or_promote_gcs_model_artifacts"},
                {"id": "update_model_pool_champion_pointers"},
                {"id": "remove_challenger_pointers_after_approved_cutover"},
                {"id": "enable_strategy_mining_execution_env"},
                {"id": "feature_selection_retrain_release"},
            ],
        }),
    )


def _write_cutover_tool_sources(root: Path) -> None:
    _write(
        root / "ml-controller/services/production_cutover_packet.py",
        "\n".join([
            "local_prod_ready_audit_20260618.json",
            "production_cutover_remote_preflight_20260618.json",
            "remote_cutover_complete",
            "deploy_ml_controller_strategy_mining_route",
            "apply_strategy_mining_ledger_migration",
            "enable_strategy_mining_execution_env",
            "feature_selection_retrain_release",
        ]),
    )
    _write(
        root / "tools/production_cutover_remote_preflight.py",
        "\n".join([
            "stockvision-production-cutover-remote-preflight-v1",
            "gcp_scheduler_monthly_strategy_mining",
            "ml_controller_strategy_mining_env",
            "d1_strategy_mining_ledger_tables",
            "d1_alpha_miner_strategy_seed",
            "production_mutation_allowed",
            "read_only_observation",
            "local_cutover_packet_path",
            "local_cutover_packet_ready_for_review",
        ]),
    )


def test_local_prod_ready_audit_marks_done_when_local_gates_are_closed(tmp_path):
    _write(
        tmp_path / "infra/gcp-scheduler-jobs.json",
        json.dumps({
            "jobs": [
                {"id": "weekly-optuna"},
                {"id": "adaptive-meta-policy-replay"},
                {"id": "linucb-multiplier-replay"},
                {"id": "monthly-optuna"},
                {"id": "monthly-strategy-mining"},
                {"id": "optuna-queue"},
            ]
        }),
    )
    _write(
        tmp_path / "scripts/sync_gcp_scheduler.ps1",
        "\n".join([
            "$currentJobs = gcloud scheduler jobs list --project $Project --location $Location --format 'value(name.basename())'",
            "$exists = $currentIds.Contains([string]$job.id)",
            "if ($DeleteStale) {",
            "DRY_RUN_AUTH_TOKEN_PLACEHOLDER",
            "https://dry-run-worker-base-url.invalid",
            "scheduler jobs delete",
        ]),
    )
    _write(
        tmp_path / "ml-service/requirements.txt",
        "\n".join([
            "scikit-learn==1.9.0",
            "networkx==3.6.1",
            "scikit-learn-extra==0.3.0",
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
    _write(tmp_path / "ml-service/Dockerfile", "FROM python:3.11-slim\n")
    _write(
        tmp_path / "ml-controller/requirements.txt",
        "\n".join([
            "optuna==4.9.0",
            "scikit-learn==1.9.0",
            "networkx==3.6.1",
        ]),
    )
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
            "pickLastFormalLayer2Step",
            "pickLastByStage(steps, 'l15_ml_slate_queue')",
            "legacyLayer2Seed",
            "layer15_ml_slate_queue",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/marketScreener.ts",
        "\n".join([
            "stage: 'l15_ml_slate_queue'",
            "worker_seed_only: true",
            "downstream_owner: 'ml-controller'",
            "downstream_stage: 'layer2_coarse_ml_gate'",
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
        "weekly-optuna monthly-optuna monthly-strategy-mining optuna-queue adaptive-meta-policy-replay linucb-multiplier-replay",
    )
    _write(
        tmp_path / "worker/src/lib/controllerResearchWorkflows.ts",
        "runMonthlyStrategyMining /strategy_mining/monthly_pymoo/run monthly_pymoo_strategy_mining preflight_ready production_effect=none",
    )
    _write(
        tmp_path / "ml-controller/routers/strategy_mining.py",
        (
            '@router.post("/monthly_pymoo/run") STRATEGY_MINING_EXECUTION_ENABLED '
            'STRATEGY_MINING_BACKEND modal_client.strategy_mining_research '
            'production_mutation_allowed research_only strategy_mining_runs strategy_promotion_ledger'
        ),
    )
    _write(
        tmp_path / "worker/migration_strategy_mining_ledger_2026_06_18.sql",
        "\n".join([
            "CREATE TABLE IF NOT EXISTS strategy_mining_runs",
            "CREATE TABLE IF NOT EXISTS strategy_mining_candidates",
            "CREATE TABLE IF NOT EXISTS strategy_backtest_results",
            "CREATE TABLE IF NOT EXISTS strategy_similarity_matrix",
            "CREATE TABLE IF NOT EXISTS strategy_promotion_ledger",
            "real_trading_effect TEXT NOT NULL DEFAULT 'none'",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/postMarketChainContract.test.ts",
        "runModelIcRollingRefresh runLinUcbRewardLedgerRefresh runAdaptiveUpdate runMetaLearningShadowClosure runStrategyLearningClosureTask root chain closed after post-verify",
    )
    _write(
        tmp_path / "worker/src/lib/strategyLearning.ts",
        "\n".join([
            "requires_wei_approval l3_requires_wei_approval status_must_enter_shadow_before_promotion",
            "stage = 'l1_candidate_seed_after_overlay' AND decision = 'selected'",
            "stage = 'layer1_strategy_breadth_gate' AND decision = 'pass'",
        ]),
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
        "\n".join([
            "sparse_tangent_inverse_risk_final_allocation DEFAULT_SPARSE_ALLOCATION_CONTROLLER = 'OnlinePortfolioBandit'",
            "selection_reason sparse_diagnostics expected_return_source risk_estimate_source positive_expected_edge",
        ]),
    )
    _write(
        tmp_path / "ml-controller/services/recommendation_service.py",
        "\n".join([
            "selection_reason",
            "selected_positive_edge_sparse_weight",
            "no_positive_expected_edge",
            "zero_sparse_weight_after_inverse_risk",
            "sparse_diagnostics",
            "expected_return_source",
            "risk_estimate_source",
            "cluster_id",
            "cluster_exposure",
            "max_cluster_weight",
            "covariance_method",
            "cluster_penalty_applied",
            "single_name_weight",
            "single_name_weight_limit",
            "drawdown_state",
            "live_backtest_divergence",
            "turnover_pressure",
        ]),
    )
    _write(
        tmp_path / "ml-controller/services/similarity_evidence.py",
        "SIMILARITY_EVIDENCE_VERSION networkx LedoitWolf evidence_only hdbscan_research_audit sklearn.cluster.HDBSCAN outlier_score cluster_stability research_shadow_only",
    )
    _write(
        tmp_path / "ml-service/app/strategy_similarity_evidence.py",
        "\n".join([
            "STRATEGY_SIMILARITY_EVIDENCE_VERSION",
            "ml-service-modal-python",
            "networkx.Graph+networkx.connected_components",
            "sklearn_extra.cluster.KMedoids",
            "method=\"pam\"",
            "kmedoids_pam_preflight_status",
            "global_k_hardcoded",
            "production_selector",
            "self_implemented_algorithm",
        ]),
    )
    _write(
        tmp_path / "ml-service/modal_app.py",
        "def strategy_similarity_evidence(payload):\n    from app.strategy_similarity_evidence import build_strategy_similarity_evidence\n    \"\"\"L1.25 strategy similarity graph evidence owned by Modal/Python.\"\"\"\n",
    )
    _write(
        tmp_path / "ml-service/app/gnn_batch_runtime.py",
        "\n".join([
            "build_multi_similarity_edge_index",
            '"edge_source": "multi_similarity_graph_v1"',
            '"production_edge_replaces": "price_correlation_v1"',
            '"allowed_use": "production_gnn_edge_context"',
            '"production_edge_active": True',
            '"selector": False',
            "import networkx as nx",
            "strategy_co_hit",
            "sector_factor_similarity",
            "finlab_chip_flow_similarity",
            "regime_co_movement",
            "threshold_quantile=threshold_quantile",
            "context_records=context_records",
        ]),
    )
    _write(
        tmp_path / "ml-service/app/batch_prediction.py",
        "\n".join([
            "_build_gnn_similarity_context_record",
            "strategy_hit_vector",
            "family_affinity_vector",
            "sector_factor",
            "finlab_chip_flow",
            "context_records=context_records",
            "runtime_options[\"gnn_batch_context\"] = graph_report",
        ]),
    )
    _write(
        tmp_path / "ml-controller/routers/strategy_similarity.py",
        'router = APIRouter(prefix="/l125")\n"/strategy_similarity_evidence"\nmodal_client.strategy_similarity_evidence\n"/hdbscan_research_audit"\nmutation_allowed\nproduction_decision_path\nresearch_shadow_only\n# fail closed\n',
    )
    _write(
        tmp_path / "ml-controller/main.py",
        "\n".join([
            "_strategy_similarity_warmup_payload",
            '"strategy_similarity_evidence": modal_client.strategy_similarity_evidence',
            "kmedoids_pam_preflight_status",
            "ml-service-modal-python",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/adminTriggerWorkerDomainTasks.ts",
        "\n".join([
            "summarizeMlControllerWarmupTargets",
            "strategy_similarity_evidence",
            "kmedoids_pam_preflight_status",
            "ML Controller warmup ${targets.ok ? 'ok' : 'degraded'}",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/marketScreener.ts",
        "\n".join([
            "stage: 'l15_ml_slate_queue'",
            "worker_seed_only: true",
            "downstream_owner: 'ml-controller'",
            "downstream_stage: 'layer2_coarse_ml_gate'",
            "buildStrategySimilarityEvidencePayload",
            "'/l125/strategy_similarity_evidence'",
            "coerceModalStrategySimilarityGraphEvidence",
            "strategySimilarityGraphEvidence: strategySimilarityEvidence.evidence",
            "strategy_similarity_evidence_status",
            "buildL0RawSignalCoverageAudit",
            "l0RawSignalCoverageAudit",
            "fundamental_loader_error",
            "rawCoverage",
            "canonicalCoverageBaseline",
            "listed_otc_finlab_broker_transactions:not_materialized",
            "ORDER BY stock_id, available_date DESC, period DESC",
            "telemetry.canonicalErrors.push",
            "telemetry.revenueErrors.push",
            "finlab.fundamental_features",
            "finlab.monthly_revenue",
            "finlab_style_cs_sector_rank_zscore_winsor_sector_neutral_v2",
            "zScoreKey",
            "winsorizedKey",
            "sectorNeutralRankKey",
            "finlabInverseVolatilityWeight",
            "finlabIndustryCapWeight",
            "finlabTurnoverControlWeight",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/strategyPortfolioMetrics.ts",
        "\n".join([
            "kmedoids_pam_preflight_status",
            "cleanText(record.status) !== 'computed'",
            "cleanText(preflight.status) !== 'pass'",
            "record.self_implemented_algorithm !== false",
            "factor_return",
            "factorReturn",
            "centrality",
            "factor_centrality",
            "graph_centrality",
            "shapley_contribution",
            "rank_ic",
        ]),
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
            "pickLastFormalLayer2Step",
            "pickLastByStage(steps, 'l15_ml_slate_queue')",
            "legacyLayer2Seed",
            "layer15_ml_slate_queue",
            "strategy_similarity_evidence_status",
            "strategy_similarity_evidence_source",
            "strategy_similarity_algorithm_owner",
            "strategy_similarity_medoid_algorithm",
            "strategy_similarity_degraded_count",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/multiStrategyPleRouter.ts",
        "strategy_similarity_graph strategy_cluster_crowding_score strategy_cluster_uniqueness_score effective_strategy_count "
        "strategy_prior_weight family_prior_weight strategy_reliability strategy_crowding_score "
        "strategy_diversification_value factor_return centrality "
        "training_teacher_labels_offline_runtime_teacher_evidence_optional "
        "previous_trading_day_or_latest_verified_cache_no_same_day_l2_l3_dependency "
        "missing_runtime_teacher_cache historical_verified_cache",
    )
    _write(
        tmp_path / "ml-controller/services/promotion_gate_contract.py",
        "SIMILARITY_PROMOTION_REQUIRED_GATES no_new_selector no_hardcoded_cluster_count no_topk_fallback l15_pairwise_corr_not_worse",
    )
    _write(
        tmp_path / "worker/src/lib/updateOrchestrator.ts",
        "\n".join([
            "FinLab primary canonical ready",
            "TWSE/TPEX supplemental refresh complete",
            "source_role=supplemental_after_finlab_canonical",
            "TWSE/TPEX supplemental fetch",
        ]),
    )
    _write(
        tmp_path / "worker/src/routes/other.ts",
        "strategy_portfolio_intelligence_health 'l15_ml_slate_queue' 'layer2_coarse_ml_gate'",
    )
    _write(
        tmp_path / "tools/finlab_v4_remote_backfill.py",
        "\n".join([
            "lane=\"broker_flow_diversity\"",
            "kind=\"broker_aggregate\"",
            "normalize_broker_transactions_daily",
            "broker_transactions",
            "finlab.broker_transactions",
        ]),
    )
    _write(
        tmp_path / "ml-controller/services/finlab_canonical_materializer.py",
        "\n".join([
            "build_listed_broker_flow_rows",
            '"raw" / lane / "broker_daily.parquet"',
            "finlab.broker_transactions",
            "canonical_broker_flow_daily",
        ]),
    )
    _write(
        tmp_path / "worker/src/lib/screenerMarketData.ts",
        "\n".join([
            "CanonicalScreenerPrice",
            "CanonicalScreenerChip",
            "@deprecated Use CanonicalScreenerPrice",
            "@deprecated Use CanonicalScreenerChip",
            "'broker_flow'",
        ]),
    )
    _write(
        tmp_path / "ml-service/benchmark_results/evening_chain_rerun_20260615/report_20260615_v1_vs_rerun.md",
        "# 2026-06-15 V1 vs rerun\n",
    )
    _write(
        tmp_path / "tools/export_active_strategy_specs_from_d1.py",
        "\n".join([
            "read_only_d1_export",
            "production_mutation_allowed",
            "strategy_spec_registry",
            "SELECT_ACTIVE_STRATEGIES_SQL_ONE_LINE",
        ]),
    )
    _write(
        tmp_path / "tools/finlab_alpha_miner_bakeoff.py",
        "\n".join([
            "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed",
            "similarity_matrix_missing_internal_pairs",
            "similarity_matrix_missing_archive_pairs",
            "def _missing_similarity_pair_count",
            '"algorithm": "pymoo"',
            '"factor_universe": "unified_registry_v1"',
            '"random_trials": 0',
            '"optuna_trials": 0',
            '"deap_population": 0',
            'parser.add_argument("--algorithm", choices=["all", "random", "optuna", "deap", "pymoo"], default="pymoo")',
            'parser.add_argument("--random-trials", type=int, default=0)',
            'parser.add_argument("--optuna-trials", type=int, default=0)',
            'parser.add_argument("--deap-population", type=int, default=0)',
        ]),
    )
    _write(
        tmp_path / "tools/validate_alpha_mining_similarity_novelty.py",
        "\n".join([
            "missing_pair_fail_closed",
            "similarity_matrix_missing_internal_pairs",
            "matrix_only_fail_closed",
        ]),
    )
    _write(
        tmp_path / "tools/validate_monthly_pymoo_runtime_contract.py",
        "\n".join([
            "stockvision-monthly-pymoo-runtime-contract-v1",
            "monthly_strategy_mining_scheduler",
            "alpha_miner_cli_defaults_pymoo_only",
            "feature_pool_matches_local_closure",
        ]),
    )
    _write(
        tmp_path / "output/feature_universe_triage/alpha_mining_similarity_novelty_validation_20260618.json",
        json.dumps({
            "schema_version": "stockvision-alpha-mining-similarity-novelty-validation-v1",
            "status": "pass",
            "decision_effect": "local_validation_only",
            "method": "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed",
            "cases": {
                "missing_pair_fail_closed": {
                    "max_similarity": 1.0,
                    "similarity_matrix_missing_internal_pairs": 1,
                },
            },
        }),
    )
    _write(
        tmp_path / "output/feature_universe_triage/monthly_pymoo_runtime_contract_validation_20260618.json",
        json.dumps({
            "schema_version": "stockvision-monthly-pymoo-runtime-contract-v1",
            "status": "pass",
            "decision_effect": "local_validation_only",
            "monthly_search_policy": {
                "cadence": "monthly",
                "algorithm": "pymoo",
                "requires_finlab_backtest": True,
            },
            "feature_pool": {
                "eligible_for_alpha_mining": 137,
                "expected_from_local_closure": 137,
            },
        }),
    )
    _write(
        tmp_path / "output/finlab_strategy_backtests/current_active_11_strategy_specs.json",
        json.dumps([
            {
                "id": "trend_following_seed_v1",
                "version": "strategy-spec-v1",
                "status": "active",
                "owner": "strategy",
                "ownerType": "strategy",
                "promotionStatus": "production",
                "supportedRegimes": ["bull"],
                "thresholds": {"minPrice": 10},
                "candidatePolicy": {"poolQuota": 14},
                "riskNotes": ["fixture"],
            }
            for _ in range(11)
        ]),
    )
    _write(
        tmp_path / "output/finlab_strategy_backtests/current_active_11_strategy_specs_summary.json",
        json.dumps({
            "schema_version": "stockvision-active-strategy-spec-export-v1",
            "decision_effect": "read_only_d1_export",
            "production_mutation_allowed": False,
            "strategy_count": 11,
            "errors": [],
            "json": "output/finlab_strategy_backtests/current_active_11_strategy_specs.json",
        }),
    )
    _write(
        tmp_path / "output/finlab_strategy_backtests/finlab_strategy_spec_active11_20230101_20260615_summary.json",
        json.dumps({
            "strategy_count": 11,
            "ok": 8,
            "no_signal": 3,
            "errors": [],
        }),
    )
    for name in (
        "adaptive_meta_policy_replay_20260605_20260611.json",
        "linucb_multiplier_replay_20260605_20260611.json",
    ):
        _write(
            tmp_path / f"ml-service/benchmark_results/{name}",
            json.dumps({"status": "fail", "allowed_use": "research_only", "production_effect": False}),
        )
    _write(
        tmp_path / "ml-controller/services/production_cutover_packet.py",
        "\n".join([
            "local_prod_ready_audit_20260618.json",
            "production_cutover_remote_preflight_20260618.json",
            "remote_cutover_complete",
            "deploy_ml_controller_strategy_mining_route",
            "apply_strategy_mining_ledger_migration",
            "enable_strategy_mining_execution_env",
            "feature_selection_retrain_release",
        ]),
    )
    _write(
        tmp_path / "tools/production_cutover_remote_preflight.py",
        "\n".join([
            "stockvision-production-cutover-remote-preflight-v1",
            "gcp_scheduler_monthly_strategy_mining",
            "ml_controller_strategy_mining_env",
            "d1_strategy_mining_ledger_tables",
            "d1_alpha_miner_strategy_seed",
            "production_mutation_allowed",
            "read_only_observation",
            "local_cutover_packet_path",
            "local_cutover_packet_ready_for_review",
        ]),
    )
    _write(
        tmp_path / "ml-service/benchmark_results/production_cutover_packet_20260618.json",
        json.dumps({
            "cutover_ready_for_review": True,
            "production_mutation_allowed": False,
            "actions_allowed_without_wei_approval": [],
            "remote_cutover_complete": False,
            "remote_preflight_summary": {
                "remote_cutover_complete": False,
                "incomplete_remote_check_ids": ["gcp_scheduler_monthly_strategy_mining"],
            },
            "evidence_health": [
                {"id": "feature_registry_local_closure_pass", "passed": True},
                {"id": "unified137_materialization_pass", "passed": True},
            ],
            "approval_required_actions": [
                {"id": "deploy_worker_and_frontend"},
                {"id": "deploy_ml_controller_strategy_mining_route"},
                {"id": "apply_strategy_registry_alpha_miner_migration"},
                {"id": "apply_strategy_mining_ledger_migration"},
                {"id": "sync_gcp_scheduler_manifest"},
                {"id": "write_or_promote_gcs_model_artifacts"},
                {"id": "update_model_pool_champion_pointers"},
                {"id": "remove_challenger_pointers_after_approved_cutover"},
                {"id": "enable_strategy_mining_execution_env"},
                {"id": "feature_selection_retrain_release"},
            ],
        }),
    )
    _write(
        tmp_path / "ml-service/benchmark_results/production_cutover_remote_preflight_20260618.json",
        json.dumps({
            "decision_effect": "read_only_observation",
            "production_mutation_allowed": False,
            "summary": {"remote_cutover_complete": False},
            "checks": [
                {"id": "gcp_scheduler_monthly_strategy_mining", "status": "missing"},
                {"id": "gcp_scheduler_monthly_optuna_timezone", "status": "drift"},
                {"id": "ml_controller_strategy_mining_env", "status": "missing"},
                {"id": "d1_strategy_mining_ledger_tables", "status": "missing"},
                {"id": "d1_alpha_miner_strategy_seed", "status": "present"},
                {"id": "d1_strategy_spec_registry_schema", "status": "present"},
            ],
        }),
    )

    _write_cutover_freshness_dependencies(tmp_path)
    _write_remote_preflight_fixture(tmp_path)
    _write_production_cutover_packet_fixture(tmp_path)
    _write(
        tmp_path / "output/feature_universe_triage/monthly_pymoo_runtime_contract_validation_20260618.json",
        json.dumps({
            "schema_version": "stockvision-monthly-pymoo-runtime-contract-v1",
            "status": "pass",
            "decision_effect": "local_validation_only",
            "monthly_search_policy": {
                "cadence": "monthly",
                "algorithm": "pymoo",
                "requires_finlab_backtest": True,
            },
            "feature_pool": {
                "eligible_for_alpha_mining": 137,
                "expected_from_local_closure": 137,
            },
        }),
    )
    _write_production_cutover_packet_fixture(tmp_path)

    audit = build_local_prod_ready_audit(tmp_path)

    assert audit["local_closure"] == "done", audit["failed_checks"]
    assert audit["local_prod_ready"] == "done", audit["failed_checks"]
    assert audit["promotion_allowed"] is False
    assert audit["production_mutation_allowed"] is False
    assert audit["failed_checks"] == []
    assert "sync_gcp_scheduler_manifest" in audit["production_cutover_requires_wei_approval"]
    assert "deploy_ml_controller_strategy_mining_route" in audit["production_cutover_requires_wei_approval"]
    assert "apply_strategy_mining_ledger_migration" in audit["production_cutover_requires_wei_approval"]
    assert "feature_selection_retrain_release" in audit["production_cutover_requires_wei_approval"]


def test_production_cutover_packet_checks_fail_when_packet_is_stale(tmp_path):
    _write_cutover_tool_sources(tmp_path)
    _write_remote_preflight_fixture(tmp_path)
    _write_cutover_freshness_dependencies(tmp_path)
    _write_production_cutover_packet_fixture(tmp_path)

    packet_path = tmp_path / "ml-service/benchmark_results/production_cutover_packet_20260618.json"
    source_path = tmp_path / "ml-controller/services/production_cutover_packet.py"
    os.utime(packet_path, (100, 100))
    os.utime(source_path, (200, 200))

    checks = _production_cutover_packet_checks(tmp_path)
    statuses = {row["id"]: row["status"] for row in checks}

    assert statuses["roadmap:p12:production_cutover_packet_artifact_fresh"] == "fail"
