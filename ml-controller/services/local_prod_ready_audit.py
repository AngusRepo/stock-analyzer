from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from services.model_upgrade_research_track import build_research_benchmark_manifest

SCHEMA_VERSION = "stockvision-local-prod-ready-audit-v2"
ROADMAP_SCOPE_VERSION = "planscope-full-session-root-2026-06-14"

ACTIVE_9 = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
    "TimesFM",
)

RETIRED_MODELS = (
    "CatBoost",
    "FT-Transformer",
    "Chronos",
)

REQUIRED_SCHEDULER_JOBS = (
    "weekly-optuna",
    "adaptive-meta-policy-replay",
    "linucb-multiplier-replay",
    "monthly-optuna",
    "optuna-queue",
)

REQUIRED_RUNTIME_PINS = (
    "scikit-learn==1.9.0",
    "xgboost==3.2.0",
    "lightgbm==4.6.0",
    "torch==2.12.0",
    "torch-geometric==2.8.0",
    "neuralforecast==3.1.9",
    "tabm==0.0.3",
    "timesfm[torch]==2.0.1",
    "optuna==4.9.0",
)

REQUIRED_WORKER_RUNTIME_PINS = {
    "dependencies.hono": "4.12.25",
    "devDependencies.wrangler": "4.100.0",
    "devDependencies.typescript": "6.0.3",
}

REPLAY_EVIDENCE_FILES = (
    "ml-service/benchmark_results/adaptive_meta_policy_replay_20260605_20260611.json",
    "ml-service/benchmark_results/linucb_multiplier_replay_20260605_20260611.json",
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _read_text(root: Path, rel_path: str) -> str:
    return root.joinpath(rel_path).read_text(encoding="utf-8", errors="ignore")


def _load_json(root: Path, rel_path: str) -> Any:
    return json.loads(root.joinpath(rel_path).read_text(encoding="utf-8-sig"))


def _check(condition: bool, check_id: str, detail: str) -> dict[str, Any]:
    return {
        "id": check_id,
        "status": "pass" if condition else "fail",
        "detail": detail,
    }


def _check_text_contains(
    root: Path,
    rel_path: str,
    needles: str | tuple[str, ...],
    check_id: str,
    detail: str,
) -> dict[str, Any]:
    try:
        text = _read_text(root, rel_path)
    except FileNotFoundError:
        return _check(False, check_id, f"{detail}; missing_file={rel_path}")

    required = (needles,) if isinstance(needles, str) else needles
    missing = [needle for needle in required if needle not in text]
    if missing:
        return _check(False, check_id, f"{detail}; missing={missing[:6]}")
    return _check(True, check_id, detail)


def _check_text_regex_absent(
    root: Path,
    rel_path: str,
    pattern: str,
    check_id: str,
    detail: str,
) -> dict[str, Any]:
    try:
        text = _read_text(root, rel_path)
    except FileNotFoundError:
        return _check(False, check_id, f"{detail}; missing_file={rel_path}")
    if re.search(pattern, text):
        return _check(False, check_id, f"{detail}; forbidden_pattern={pattern}")
    return _check(True, check_id, detail)


def _scheduler_checks(root: Path) -> list[dict[str, Any]]:
    manifest = _load_json(root, "infra/gcp-scheduler-jobs.json")
    jobs = {str(job.get("id")) for job in manifest.get("jobs") or []}
    return [
        _check(job in jobs, f"scheduler_manifest:{job}", "required local scheduler job is present")
        for job in REQUIRED_SCHEDULER_JOBS
    ]


def _runtime_pin_checks(root: Path) -> list[dict[str, Any]]:
    requirements = _read_text(root, "ml-service/requirements.txt")
    controller_requirements = _read_text(root, "ml-controller/requirements.txt")
    checks = [
        _check(pin in requirements, f"runtime_pin:{pin}", "reviewed official/stable runtime pin is present")
        for pin in REQUIRED_RUNTIME_PINS
    ]
    checks.append(_check(
        "optuna==4.9.0" in controller_requirements,
        "controller_runtime_pin:optuna==4.9.0",
        "controller Optuna/GA route dependency is pinned to reviewed official/stable version",
    ))
    return checks


def _worker_runtime_pin_checks(root: Path) -> list[dict[str, Any]]:
    package_json = _load_json(root, "worker/package.json")
    checks: list[dict[str, Any]] = []
    for key, expected in REQUIRED_WORKER_RUNTIME_PINS.items():
        section, name = key.split(".", 1)
        actual = str((package_json.get(section) or {}).get(name) or "")
        checks.append(_check(
            actual == expected,
            f"worker_runtime_pin:{name}=={expected}",
            f"reviewed Worker/meta runtime pin is present (actual={actual or 'missing'})",
        ))
    return checks


def _model_track_checks() -> list[dict[str, Any]]:
    manifest = build_research_benchmark_manifest("local-prod-ready-audit")
    checks: list[dict[str, Any]] = []
    for name in ACTIVE_9:
        entry = manifest.get(name)
        checks.append(_check(
            isinstance(entry, dict) and entry.get("status") == "production_slot_member",
            f"active9_track:{name}",
            "active-9 model is a production_slot_member in the backend track",
        ))
    timesfm = manifest.get("TimesFM")
    checks.append(_check(
        isinstance(timesfm, dict) and timesfm.get("model_type") == "foundation_time_series_timesfm25",
        "active9_track:TimesFM:timesfm25",
        "TimesFM production slot is backed by the TimesFM 2.5 runtime/config, not a separate TimesFM25 voter",
    ))
    return checks


def _ui_contract_checks(root: Path) -> list[dict[str, Any]]:
    page = _read_text(root, "frontend/src/pages/ModelPoolPage.tsx")
    workbench = _read_text(root, "frontend/src/components/model-pool/ModelPoolNewFlowWorkbench.tsx")
    return [
        _check("ModelPoolNewFlowWorkbench" in page, "ui:new_flow_workbench", "Model Pool renders the new workbench"),
        _check("!isRetiredModelName(name)" in page, "ui:retired_hidden", "retired ML are filtered from the main surface"),
        _check("adaptive-meta-policy-replay" in workbench, "ui:meta_replay_visible", "meta replay is visible in the evidence flow"),
        _check("linucb-multiplier-replay" in workbench, "ui:multiplier_replay_visible", "LinUCB multiplier replay is visible in the evidence flow"),
    ]


def _semantic_boundary_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "ml-controller/tests/test_optuna_script_contracts.py",
            ("adaptive_l2", "not in OPTUNA_SCRIPT_CONTRACTS", "optuna_adaptive_l2.py"),
            "roadmap:p0:adaptive_l2_name_boundary",
            "legacy adaptive_l2 formula constants remain separated from new L2 coarse ML gate/search naming",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/screenerFunnelEvidence.ts",
            (
                "const L2_COARSE_MODELS = ['LightGBM', 'XGBoost', 'ExtraTrees']",
                "const L3_FORMAL_MODELS = ['TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer', 'TimesFM']",
                "layer2_3ml_coarse_summary_v1",
                "layer3_6ml_formal_summary_v1",
                "three_ml_coarse_screen_not_final_ranker",
                "six_ml_formal_family_vote_not_topk",
            ),
            "roadmap:p0:l2_l3_semantics",
            "L2 is 3ML coarse and L3 is 6ML formal family evidence, not a single top-k ranker",
        ),
        _check_text_contains(
            root,
            "frontend/src/components/model-pool/ModelPoolNewFlowWorkbench.tsx",
            (
                "const TREE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])",
                "const SEQUENCE_MODELS = new Set(['DLinear', 'PatchTST', 'iTransformer', 'TimesFM'])",
                "const GRAPH_MODELS = new Set(['GNN'])",
                "const TABULAR_NEURAL_MODELS = new Set(['TabM'])",
                "function modelFamily",
                "'Tree' | 'TabM' | 'Sequence' | 'GNN' | 'Other'",
            ),
            "roadmap:p0:l3_family_view",
            "Model Pool exposes L3 by Tree/TabM/Sequence/GNN family semantics",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/metaLearningResearchTrack.ts",
            (
                "LinUCB remains the interpretable production baseline",
                "NeuralUCB and NeuralTS are shadow challengers",
                "NeuCB may emit research-only shadow evidence",
                "portfolio bandit stays in L4 Strategy Lab",
            ),
            "roadmap:p0:meta_policy_boundary",
            "LinUCB/NeuralUCB/NeuralTS/NeuCB are meta-policy research lanes with LinUCB as production baseline",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/tradingConfigChampionContract.test.ts",
            ("sparse_tangent_inverse_risk", "OnlinePortfolioBandit", "legacy top-k override must stay disabled"),
            "roadmap:p0:l4_allocator_boundary",
            "L4 sparse allocation is separated from meta-policy replay and legacy top-k override remains disabled",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/adaptive.py",
            "OnlinePortfolioBandit\": \"production allocator controller for sparse_tangent_inverse_risk knobs; production-capable without replacing the final weight engine",
            "roadmap:p0:opb_controller_ml_controller_surface",
            "ML controller adaptive surface describes OPB as the sparse tangent allocation controller, not a separate research owner",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/adaptiveConfig.ts",
            "OnlinePortfolioBandit: 'production allocator controller for sparse_tangent_inverse_risk knobs; production-capable without replacing the final weight engine",
            "roadmap:p0:opb_controller_worker_surface",
            "Worker adaptive governance describes OPB consistently with the controller surface",
        ),
    ]


def _active9_data_chain_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "ml-controller/services/active9_dataset_policy.py",
            (*ACTIVE_9, *RETIRED_MODELS, "ACTIVE_ALPHA_MODELS", "RETIRED_ALPHA_MODELS"),
            "roadmap:p1:active9_dataset_policy",
            "active-9 dataset policy includes all production slots and retired model exclusions",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/adaptiveMetaPolicyReplayRunner.ts",
            (*ACTIVE_9, "p.verified_at IS NOT NULL", "active_models: [...ACTIVE_MODELS]"),
            "roadmap:p1:active9_verified_replay_source",
            "adaptive meta replay uses verified active-9 prediction rows only",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/adaptiveEngineContract.test.ts",
            ("active_9_quality_30d", "LightGBM", "TabM", "iTransformer", "TimesFM", "!allBinds.includes('CatBoost')"),
            "roadmap:p1:active9_confidence_hook",
            "adaptive confidence hook is scoped to active-9 evidence and excludes retired CatBoost",
        ),
        _check_text_contains(
            root,
            "ml-controller/tests/test_model_ic_tracker.py",
            ('"CatBoost" not in tracked', '"FT-Transformer" not in tracked', '"Chronos" not in tracked'),
            "roadmap:p1:retired_models_not_ic_tracked",
            "retired models are not tracked as active model IC sources",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/screenerFunnelEvidence.ts",
            ("ACTIVE_9_ML_TEACHER_MODELS", "expected_teacher_count", "teacher_label_scope"),
            "roadmap:p1:active9_teacher_labels",
            "PLE/Listwise router evidence expects active-9 teacher labels without fake backfill",
        ),
    ]


def _optuna_scheduler_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "worker/src/lib/weeklyResearchClosureContract.test.ts",
            (
                "'/optuna/research_sweep/run'",
                "not Worker fan-out across nine endpoints",
                "run_date: options.runDate",
                "research_data_source: 'snapshot'",
                "timeoutMs: 60_000",
                "max_parallel_sources: 3",
                "manual/approval-gated",
            ),
            "roadmap:p1:optuna_worker_boundary",
            "Worker triggers controller-owned 9-source sweep Job; it does not fan out or mutate production",
        ),
        _check_text_contains(
            root,
            "ml-controller/routers/optuna.py",
            (
                "Synchronous Optuna research sweep is disabled",
                "@router.post(\"/research_sweep/run\")",
                "Cloud Run Job",
                "25-dim (minus 5 bandit defer) L2/circuit Optuna search against Mode B replay",
            ),
            "roadmap:p1:optuna_controller_boundary",
            "controller owns long-running research sweep and separates L2/circuit search from bandit dims",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/schedulerPolicy.ts",
            ("weekly-optuna", "monthly-optuna", "optuna-queue", "adaptive-meta-policy-replay", "linucb-multiplier-replay"),
            "roadmap:p1:scheduler_policy_surface",
            "scheduler policy exposes required Optuna/adaptive replay tasks",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/postMarketChainContract.test.ts",
            (
                "runModelIcRollingRefresh",
                "runLinUcbRewardLedgerRefresh",
                "runAdaptiveUpdate",
                "runMetaLearningShadowClosure",
                "runStrategyLearningClosureTask",
                "root chain closed after post-verify",
            ),
            "roadmap:p1:post_verify_chain",
            "post-verify chain closes rolling IC, reward ledger, adaptive params, shadow evidence, and strategy learning",
        ),
    ]


def _replay_and_promotion_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "worker/src/lib/metaLearningResearchTrack.ts",
            ("shadow_challenger", "research_only", "partial_fill_replay", "decision_queue_status"),
            "roadmap:p1:neural_shadow_replay_read_only",
            "NeuralUCB/NeuralTS/NeuCB shadow state is evidence/research, not production mutation",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/strategyLearning.ts",
            ("requires_wei_approval", "l3_requires_wei_approval", "status_must_enter_shadow_before_promotion"),
            "roadmap:p2:strategy_promotion_gate",
            "strategy promotion requires shadow-first evidence and Wei approval for production allocation",
        ),
        _check_text_contains(
            root,
            "frontend/src/pages/StrategyLabPage.tsx",
            ("approved_for_shadow", "requires_wei_approval", "l3_requires_wei_approval"),
            "roadmap:p2:strategy_lab_governance_ui",
            "Strategy Lab exposes shadow approval and Wei approval gates",
        ),
        _check_text_contains(
            root,
            "frontend/src/pages/ModelPoolPage.tsx",
            ("Promotion & Parameter Governance", "allocator controllers emit parameter candidates", "champion pointer"),
            "roadmap:p2:model_pool_promotion_governance",
            "Model Pool separates artifact/parameter governance from the L2/L3 alpha vote graph",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/model_artifact_registry.py",
            ("active-9 production artifact set", "production promotion must use an active-9 model"),
            "roadmap:p2:active9_artifact_promotion_blocker",
            "artifact promotion blocks non-active-9 models from production selection",
        ),
    ]


def _l4_execution_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "worker/src/routes/paper.ts",
            (
                "pending_buy_execution_policy_v1",
                "execution_pool_policy: 'l4_sparse_final_buy_only'",
                "allocation_engine: 'sparse_tangent_inverse_risk'",
                "watch_fallback_allowed: false",
                "raw_recommendation_rows_executable: false",
            ),
            "roadmap:p2:l4_pending_buy_policy",
            "pending-buy execution is owned by L4 sparse final BUY rows only",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/pendingBuyOrchestrator.ts",
            (
                "execution_pool_policy: 'l4_sparse_final_buy_only'",
                "json_extract(dr.alpha_allocation, '$.engine') = 'sparse_tangent_inverse_risk'",
            ),
            "roadmap:p2:l4_pending_buy_query",
            "pending-buy orchestrator filters executable rows to sparse tangent allocation output",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/dataQualityMonitor.ts",
            ("pending_buy_l4_allocator_owner", "sparse_tangent_inverse_risk"),
            "roadmap:p2:l4_data_quality_owner",
            "DataQuality has an explicit owner check for L4 allocator pending-buy execution",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/recommendationContext.ts",
            ("sparse_tangent_inverse_risk_final_allocation", "DEFAULT_SPARSE_ALLOCATION_CONTROLLER = 'OnlinePortfolioBandit'"),
            "roadmap:p2:l4_recommendation_context",
            "recommendation context exposes sparse final allocation evidence and controller provenance",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/recommendation_service.py",
            (
                "selection_reason",
                "selected_positive_edge_sparse_weight",
                "no_positive_expected_edge",
                "zero_sparse_weight_after_inverse_risk",
                "sparse_diagnostics",
                "expected_return_source",
                "risk_estimate_source",
            ),
            "roadmap:p2:l4_sparse_zero_selection_diagnostics",
            "L4 sparse allocation writes per-candidate diagnostics for selected and zero-selection outcomes",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/recommendationContext.ts",
            (
                "selection_reason",
                "sparse_diagnostics",
                "expected_return_source",
                "risk_estimate_source",
                "positive_expected_edge",
            ),
            "roadmap:p2:l4_sparse_api_diagnostics",
            "recommendation API exposes L4 sparse reason/edge/risk diagnostics",
        ),
    ]


def _finlab_market_data_owner_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "worker/src/lib/updateOrchestrator.ts",
            (
                "FinLab primary canonical ready",
                "TWSE/TPEX supplemental refresh complete",
                "source_role=supplemental_after_finlab_canonical",
                "TWSE/TPEX supplemental fetch",
            ),
            "roadmap:p3:finlab_primary_twse_supplemental_owner",
            "evening-chain market data logs keep FinLab canonical as primary and TWSE/TPEX as supplemental",
        ),
        _check_text_regex_absent(
            root,
            "worker/src/lib/updateOrchestrator.ts",
            r"before legacy fallback \+ indicator queue",
            "roadmap:p3:no_legacy_market_data_fallback_wording",
            "evening-chain must not describe TWSE/TPEX supplemental refresh as legacy fallback",
        ),
    ]


def _l15_l2_owner_boundary_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "worker/src/lib/marketScreener.ts",
            (
                "stage: 'l15_ml_slate_queue'",
                "worker_seed_only: true",
                "downstream_owner: 'ml-controller'",
                "downstream_stage: 'layer2_coarse_ml_gate'",
            ),
            "roadmap:p3:l15_ml_slate_queue_stage",
            "Worker persists L1.5 ML slate queue as a pre-controller queue, not formal L2",
        ),
        _check_text_regex_absent(
            root,
            "worker/src/lib/marketScreener.ts",
            r"\bstage:\s*['\"]layer2_coarse_ml_gate['\"]",
            "roadmap:p3:worker_not_formal_l2_owner",
            "Worker screener must not write formal layer2_coarse_ml_gate stage rows",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/screenerFunnelEvidence.ts",
            (
                "pickLastFormalLayer2Step",
                "pickLastByStage(steps, 'l15_ml_slate_queue')",
                "legacyLayer2Seed",
                "layer15_ml_slate_queue",
            ),
            "roadmap:p3:l15_l2_evidence_summary",
            "funnel evidence separates L1.5 slate queue from formal L2 while keeping legacy read compatibility",
        ),
        _check_text_contains(
            root,
            "worker/src/routes/other.ts",
            ("'l15_ml_slate_queue'", "'layer2_coarse_ml_gate'"),
            "roadmap:p3:daily_api_reads_l15_and_l2",
            "daily recommendation API reads both L1.5 slate queue and formal L2 evidence",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/strategyLearning.ts",
            (
                "stage = 'l1_candidate_seed_after_overlay' AND decision = 'selected'",
                "stage = 'layer1_strategy_breadth_gate' AND decision = 'pass'",
            ),
            "roadmap:p3:strategy_learning_l1_source",
            "strategy learning reads L1/L1.5 strategy evidence instead of L2 owner stages",
        ),
        _check_text_regex_absent(
            root,
            "worker/src/lib/strategyLearning.ts",
            r"stage\s*=\s*['\"]layer2_coarse_ml_gate['\"]\s+AND\s+decision\s*=\s*['\"]pass['\"]",
            "roadmap:p3:strategy_learning_not_l2_owner",
            "strategy learning must not treat formal L2 pass rows as its primary strategy evidence source",
        ),
    ]


def _observability_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "worker/src/lib/screenerFunnelEvidence.ts",
            (
                "layer1_strategy_labeler_summary_v1",
                "layer125_finlab_portfolio_intelligence_summary_v1",
                "layer15_multi_strategy_router_summary_v1",
                "layer35_evidence_fusion_v1",
                "daily_strategy_portfolio_intelligence_health_v1",
            ),
            "roadmap:p3:layered_funnel_evidence",
            "daily recommendation evidence exposes L1/L1.25/L1.5/L3.5 layer contracts",
        ),
        _check_text_contains(
            root,
            "worker/src/routes/other.ts",
            "strategy_portfolio_intelligence_health",
            "roadmap:p3:daily_health_observability",
            "daily recommendation API returns strategy portfolio intelligence health",
        ),
        _check_text_contains(
            root,
            "frontend/src/components/model-pool/ModelPoolNewFlowWorkbench.tsx",
            ("Fleet status", "Meta boundary", "Active-9 confidence hook", "LinUCB, NeuralUCB, NeuralTS, and NeuCB"),
            "roadmap:p3:model_pool_evidence_ui",
            "Model Pool UI surfaces active-9 fleet health and meta-policy evidence boundaries",
        ),
    ]


def _replay_checks(root: Path) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for rel_path in REPLAY_EVIDENCE_FILES:
        path = root.joinpath(rel_path)
        exists = path.exists()
        checks.append(_check(exists, f"replay_file:{path.name}", "read-only replay evidence file exists"))
        if not exists:
            continue
        report = json.loads(path.read_text(encoding="utf-8-sig"))
        checks.append(_check(
            report.get("production_effect") is False or report.get("allowed_use") in {"research_only", "roadmap_candidate"},
            f"replay_fail_closed:{path.name}",
            "replay evidence is explicitly non-mutating",
        ))
        checks.append(_check(
            report.get("status") in {"pass", "fail"},
            f"replay_status_terminal:{path.name}",
            "replay has a terminal gate status; fail is acceptable when fail-closed",
        ))
    return checks


def build_local_prod_ready_audit(repo_root: Path | None = None) -> dict[str, Any]:
    root = repo_root or _repo_root()
    checks = [
        *_scheduler_checks(root),
        *_runtime_pin_checks(root),
        *_worker_runtime_pin_checks(root),
        *_model_track_checks(),
        *_ui_contract_checks(root),
        *_semantic_boundary_checks(root),
        *_active9_data_chain_checks(root),
        *_optuna_scheduler_checks(root),
        *_replay_and_promotion_checks(root),
        *_l4_execution_checks(root),
        *_finlab_market_data_owner_checks(root),
        *_l15_l2_owner_boundary_checks(root),
        *_observability_checks(root),
        *_replay_checks(root),
    ]
    failed = [row for row in checks if row["status"] != "pass"]
    local_done = not failed
    return {
        "schema_version": SCHEMA_VERSION,
        "roadmap_scope_version": ROADMAP_SCOPE_VERSION,
        "roadmap_scope": "full_session_root",
        "audit_scope": [
            "p0_source_of_truth_semantics",
            "p1_active9_data_chain",
            "p1_optuna_adaptive_search_scheduler",
            "p1_mode_b_confidence_bandit_replay",
            "p2_opb_l4_allocation",
            "p2_promotion_governance",
            "p2_legacy_cleanup",
            "p3_model_pool_ui_observability",
        ],
        "local_closure": "done" if local_done else "blocked",
        "local_prod_ready": "done" if local_done else "blocked",
        "promotion_allowed": False,
        "production_mutation_allowed": False,
        "checks": checks,
        "failed_checks": failed,
        "production_cutover_requires_wei_approval": [
            "deploy_worker_and_frontend",
            "sync_gcp_scheduler_manifest",
            "write_or_promote_gcs_model_artifacts",
            "update_model_pool_champion_pointers",
            "remove_challenger_pointers_after approved cutover",
        ],
    }
