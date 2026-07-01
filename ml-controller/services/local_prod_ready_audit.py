from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

CONTROLLER_ROOT = Path(__file__).resolve().parents[1]
if str(CONTROLLER_ROOT) not in sys.path:
    sys.path.insert(0, str(CONTROLLER_ROOT))

from services.model_upgrade_research_track import build_research_benchmark_manifest
from services.production_cutover_packet import (
    ALPHA_MINING_SIMILARITY_AUDIT_CHECK_IDS,
    APPROVAL_REQUIRED_ACTIONS,
    DEFAULT_LOCAL_AUDIT_PATH,
    MONTHLY_PYMOO_RUNTIME_AUDIT_CHECK_IDS,
    REQUIRED_EVIDENCE_FILES,
)

SCHEMA_VERSION = "stockvision-local-prod-ready-audit-v2"
ROADMAP_SCOPE_VERSION = "planscope-full-session-root-2026-06-14"

ACTIVE_8_DIRECT_ALPHA = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)

TIMESFM_L2_SIDECAR = ("TimesFM",)

MODEL_POOL_REQUIRED_MODELS = (
    *ACTIVE_8_DIRECT_ALPHA,
    *TIMESFM_L2_SIDECAR,
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
    "monthly-strategy-mining",
    "optuna-queue",
)

REQUIRED_RUNTIME_PINS = (
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
)

REQUIRED_CONTROLLER_RUNTIME_PINS = (
    "optuna==4.9.0",
    "scikit-learn==1.9.0",
    "networkx==3.6.1",
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

CUTOVER_PACKET_FRESHNESS_DEPENDENCIES = (
    "ml-controller/services/production_cutover_packet.py",
    "tools/production_cutover_remote_preflight.py",
    *tuple(rel_path for rel_path in REQUIRED_EVIDENCE_FILES if rel_path != DEFAULT_LOCAL_AUDIT_PATH),
)
ARTIFACT_LIFECYCLE_REPAIR_PACKET = "ml-service/benchmark_results/artifact_lifecycle_repair_packet_20260621.json"
ARTIFACT_LIFECYCLE_REPAIR_PACKET_DEPENDENCIES = (
    "ml-controller/services/artifact_lifecycle_repair_packet.py",
    "ml-controller/scripts/artifact_lifecycle_repair_packet.py",
    "ml-service/benchmark_results/production_retrain_release_20260621.json",
)

ALPHA_MINING_SIMILARITY_VALIDATION_ARTIFACT = "output/feature_universe_triage/alpha_mining_similarity_novelty_validation_20260618.json"
ALPHA_MINING_SIMILARITY_VALIDATION_DEPENDENCIES = (
    "tools/validate_alpha_mining_similarity_novelty.py",
    "tools/finlab_alpha_miner_bakeoff.py",
)
MONTHLY_PYMOO_RUNTIME_VALIDATION_ARTIFACT = "output/feature_universe_triage/monthly_pymoo_runtime_contract_validation_20260618.json"
MONTHLY_PYMOO_RUNTIME_VALIDATION_DEPENDENCIES = (
    "tools/validate_monthly_pymoo_runtime_contract.py",
    "tools/finlab_alpha_miner_bakeoff.py",
    "data/feature_registry/pymoo_monthly_mining_config_v1.json",
    "data/feature_registry/alpha_mining_promotion_contract_v1.json",
    "output/feature_universe_triage/feature_registry_local_closure_20260617.json",
    "infra/gcp-scheduler-jobs.json",
    "ml-controller/routers/strategy_mining.py",
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


def _check_artifact_fresh_against(
    root: Path,
    artifact_rel_path: str,
    dependency_rel_paths: tuple[str, ...],
    check_id: str,
    detail: str,
) -> dict[str, Any]:
    artifact_path = root / artifact_rel_path
    if not artifact_path.exists():
        return _check(False, check_id, f"{detail}; missing_artifact={artifact_rel_path}")

    artifact_mtime = artifact_path.stat().st_mtime
    stale_against: list[str] = []
    missing_dependencies: list[str] = []
    for dependency_rel_path in dependency_rel_paths:
        dependency_path = root / dependency_rel_path
        if not dependency_path.exists():
            missing_dependencies.append(dependency_rel_path)
            continue
        if artifact_mtime + 1e-6 < dependency_path.stat().st_mtime:
            stale_against.append(dependency_rel_path)

    if stale_against or missing_dependencies:
        return _check(
            False,
            check_id,
            (
                f"{detail}; stale_against={stale_against[:8]}; "
                f"missing_dependencies={missing_dependencies[:8]}"
            ),
        )
    return _check(True, check_id, detail)


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


def _check_file_absent(
    root: Path,
    rel_path: str,
    check_id: str,
    detail: str,
) -> dict[str, Any]:
    path = root.joinpath(rel_path)
    return _check(not path.exists(), check_id, detail if not path.exists() else f"{detail}; legacy_file={rel_path}")


def _scheduler_checks(root: Path) -> list[dict[str, Any]]:
    manifest = _load_json(root, "infra/gcp-scheduler-jobs.json")
    jobs = {str(job.get("id")) for job in manifest.get("jobs") or []}
    checks = [
        _check(job in jobs, f"scheduler_manifest:{job}", "required local scheduler job is present")
        for job in REQUIRED_SCHEDULER_JOBS
    ]
    checks.extend([
        _check_text_contains(
            root,
            "scripts/sync_gcp_scheduler.ps1",
            (
                "$currentJobs = gcloud scheduler jobs list",
                "$exists = $currentIds.Contains([string]$job.id)",
                "if ($DeleteStale)",
                "DRY_RUN_AUTH_TOKEN_PLACEHOLDER",
                "https://dry-run-worker-base-url.invalid",
            ),
            "scheduler_sync:dry_run_uses_remote_state",
            "GCP Scheduler dry-run reads remote job state and does not require production scheduler secrets",
        ),
        _check_text_regex_absent(
            root,
            "scripts/sync_gcp_scheduler.ps1",
            r"\$exists\s*=\s*\$DryRun\s*-or",
            "scheduler_sync:no_dryrun_exists_shortcut",
            "GCP Scheduler dry-run must not pretend every manifest job already exists",
        ),
    ])
    return checks


def _runtime_pin_checks(root: Path) -> list[dict[str, Any]]:
    requirements = _read_text(root, "ml-service/requirements.txt")
    controller_requirements = _read_text(root, "ml-controller/requirements.txt")
    ml_service_dockerfile = _read_text(root, "ml-service/Dockerfile")
    checks = [
        _check(pin in requirements, f"runtime_pin:{pin}", "reviewed official/stable runtime pin is present")
        for pin in REQUIRED_RUNTIME_PINS
    ]
    checks.append(_check(
        "FROM python:3.11-slim" in ml_service_dockerfile and "FROM python:3.12-slim" not in ml_service_dockerfile,
        "runtime_image:ml_service_python311_sklearn_extra_wheel",
        "ml-service runtime is Python 3.11 so official sklearn-extra KMedoids/PAM resolves from a manylinux wheel",
    ))
    checks.extend([
        _check(
            pin in controller_requirements,
            f"controller_runtime_pin:{pin}",
            "controller dependency is pinned to reviewed official/stable version",
        )
        for pin in REQUIRED_CONTROLLER_RUNTIME_PINS
    ])
    checks.append(_check(
        "scikit-learn-extra" not in controller_requirements,
        "controller_runtime_owner:no_sklearn_extra_hard_pin",
        "KMedoids/PAM official dependency is owned by ml-service/Modal, not ml-controller proxy runtime",
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
    for name in ACTIVE_8_DIRECT_ALPHA:
        entry = manifest.get(name)
        checks.append(_check(
            isinstance(entry, dict) and entry.get("status") == "production_slot_member",
            f"active8_track:{name}",
            "active direct-alpha model is a production_slot_member in the backend track",
        ))
    timesfm = manifest.get("TimesFM")
    checks.append(_check(
        isinstance(timesfm, dict)
        and timesfm.get("status") == "l2_feature_sidecar_member"
        and timesfm.get("model_type") == "foundation_time_series_timesfm25",
        "timesfm_l2_sidecar_track:TimesFM:timesfm25",
        "TimesFM is backed by the TimesFM 2.5 runtime/config as an L2 feature sidecar, not a direct L3 voter",
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
            "legacy adaptive_l2 formula constants remain separated from TimesFM L2 feature sidecar naming",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/screenerFunnelEvidence.ts",
            (
                "const L2_TIMESFM_MODELS = ['TimesFM']",
                "const L3_FORMAL_MODELS = ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer']",
                "ACTIVE_8_DIRECT_ALPHA_TEACHER_MODELS",
                "layer2_timesfm_enrichment_summary_v1",
                "layer3_8ml_formal_summary_v1",
                "timesfm_sequence_sidecar_feature_enrichment_not_selector",
                "eight_ml_formal_family_evidence_not_topk",
            ),
            "roadmap:p0:l2_l3_semantics",
            "L2 is TimesFM feature enrichment and L3 is 8ML formal family evidence, not a single top-k ranker",
        ),
        _check_text_contains(
            root,
            "ml-controller/graphs/daily_pipeline_v2.py",
            (
                "node_l2_timesfm_enrich",
                "TimesFM L2 sidecar",
                "g.add_edge(\"l2_timesfm_enrich\",   \"l3_formal_predict\")",
                "apply_l2_timesfm_evidence",
            ),
            "roadmap:p0:l2_timesfm_active_name",
            "Daily pipeline runs TimesFM as L2 feature enrichment before full-slate L3 formal inference",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/recommendation_service.py",
            (
                "write_layer2_timesfm_enrichment_audit",
                "\"schema_version\": \"l2_timesfm_enrichment_evidence_v1\"",
                "\"source\": \"timesfm_l2_sidecar\"",
                "\"selection_role\": \"feature_enrichment_not_gate\"",
            ),
            "roadmap:p0:l2_timesfm_enrichment_audit_schema",
            "Layer2 D1 audit persists TimesFM feature-enrichment evidence, not tree shortlist gate rows",
        ),
        _check_text_contains(
            root,
            "frontend/src/components/model-pool/ModelPoolNewFlowWorkbench.tsx",
            (
                "const TREE_MODELS = new Set(['LightGBM', 'XGBoost', 'ExtraTrees'])",
                "const SEQUENCE_MODELS = new Set(['DLinear', 'PatchTST', 'iTransformer'])",
                "const L2_SIDECAR_MODELS = new Set(['TimesFM'])",
                "const GRAPH_MODELS = new Set(['GNN'])",
                "const TABULAR_NEURAL_MODELS = new Set(['TabM'])",
                "function modelFamily",
                "'Tree' | 'TabM' | 'Sequence' | 'GNN' | 'Sidecar' | 'Other'",
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


def _active8_data_chain_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "ml-controller/services/active_model_policy.py",
            (*ACTIVE_8_DIRECT_ALPHA, *TIMESFM_L2_SIDECAR, *RETIRED_MODELS, "ACTIVE_ALPHA_MODELS", "MODEL_POOL_REQUIRED_MODELS", "TIMESFM_L2_SIDECAR_MODELS", "RETIRED_ALPHA_MODELS"),
            "roadmap:p1:active8_dataset_policy",
            "active-8 direct-alpha dataset policy keeps TimesFM as required L2 sidecar and retired model exclusions",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/adaptiveMetaPolicyReplayRunner.ts",
            (*ACTIVE_8_DIRECT_ALPHA, "p.verified_at IS NOT NULL", "active_models: [...ACTIVE_MODELS]"),
            "roadmap:p1:active8_verified_replay_source",
            "adaptive meta replay uses verified active-8 direct-alpha prediction rows only",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/adaptiveEngineContract.test.ts",
            ("active_9_quality_30d", "LightGBM", "TabM", "iTransformer", "!allBinds.includes('TimesFM')", "!allBinds.includes('CatBoost')"),
            "roadmap:p1:active8_confidence_hook",
            "adaptive confidence hook is scoped to active-8 direct-alpha evidence and excludes TimesFM/CatBoost",
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
            ("ACTIVE_8_DIRECT_ALPHA_TEACHER_MODELS", "expected_teacher_count", "teacher_label_scope"),
            "roadmap:p1:active8_teacher_labels",
            "PLE/Listwise router evidence expects active-8 direct-alpha teacher labels without fake backfill",
        ),
    ]


def _optuna_scheduler_checks(root: Path) -> list[dict[str, Any]]:
    checks = [
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
            ("weekly-optuna", "monthly-optuna", "monthly-strategy-mining", "optuna-queue", "adaptive-meta-policy-replay", "linucb-multiplier-replay"),
            "roadmap:p1:scheduler_policy_surface",
            "scheduler policy exposes required Optuna/adaptive replay tasks",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/controllerResearchWorkflows.ts",
            (
                "runMonthlyStrategyMining",
                "/strategy_mining/monthly_pymoo/run",
                "monthly_pymoo_strategy_mining preflight_ready",
                "production_effect=none",
            ),
            "roadmap:p8:monthly_strategy_mining_worker_surface",
            "Worker exposes monthly pymoo strategy mining as a scheduler-triggered, research-only controller workflow",
        ),
        _check_text_contains(
            root,
            "ml-controller/routers/strategy_mining.py",
            (
                "@router.post(\"/monthly_pymoo/run\")",
                "STRATEGY_MINING_EXECUTION_ENABLED",
                "STRATEGY_MINING_BACKEND",
                "modal_client.strategy_mining_research",
                "production_mutation_allowed",
                "research_only",
                "strategy_mining_runs",
                "active_strategy_backtest_results",
                "strategy_promotion_ledger",
            ),
            "roadmap:p8:monthly_strategy_mining_controller_surface",
            "Controller exposes fail-closed monthly pymoo strategy mining preflight and Modal trigger surface",
        ),
        _check_text_contains(
            root,
            "tools/finlab_alpha_miner_bakeoff.py",
            (
                '"algorithm": "pymoo"',
                '"factor_universe": "unified_registry_v1"',
                '"random_trials": 0',
                '"optuna_trials": 0',
                '"deap_population": 0',
                'parser.add_argument("--algorithm", choices=["all", "random", "optuna", "deap", "pymoo"], default="pymoo")',
                'parser.add_argument("--random-trials", type=int, default=0)',
                'parser.add_argument("--optuna-trials", type=int, default=0)',
                'parser.add_argument("--deap-population", type=int, default=0)',
            ),
            "roadmap:p8:monthly_alpha_miner_cli_defaults_pymoo_only",
            "alpha miner CLI defaults are config-aligned pymoo-only; random/optuna/deap require explicit research invocation",
        ),
        _check_text_contains(
            root,
            "worker/migration_strategy_mining_ledger_2026_06_18.sql",
            (
                "CREATE TABLE IF NOT EXISTS strategy_mining_runs",
                "CREATE TABLE IF NOT EXISTS strategy_mining_candidates",
                "CREATE TABLE IF NOT EXISTS strategy_backtest_results",
                "CREATE TABLE IF NOT EXISTS active_strategy_backtest_results",
                "CREATE TABLE IF NOT EXISTS strategy_similarity_matrix",
                "CREATE TABLE IF NOT EXISTS strategy_promotion_ledger",
                "real_trading_effect TEXT NOT NULL DEFAULT 'none'",
            ),
            "roadmap:p9:strategy_mining_ledger_migration",
            "Pymoo/FinLab strategy mining has local D1 ledger tables for runs, candidates, backtests, similarity, and promotion decisions",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/postMarketChainContract.test.ts",
            (
                "runModelIcRollingRefresh",
                "runLinUcbRewardLedgerRefresh",
                "runAdaptiveUpdate",
                "runMetaLearningShadowClosure",
                "strategy_learning_materialize",
                "waiting for queued strategy-learning",
                "root chain closed after post-verify",
            ),
            "roadmap:p1:post_verify_chain",
            "post-verify chain closes rolling IC, reward ledger, adaptive params, shadow evidence, and strategy learning",
        ),
    ]
    checks.append(_check_artifact_fresh_against(
        root,
        MONTHLY_PYMOO_RUNTIME_VALIDATION_ARTIFACT,
        MONTHLY_PYMOO_RUNTIME_VALIDATION_DEPENDENCIES,
        "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact_fresh",
        "monthly pymoo runtime contract validation artifact is newer than scheduler, miner, promotion, closure, and route contracts",
    ))
    try:
        artifact = _load_json(root, MONTHLY_PYMOO_RUNTIME_VALIDATION_ARTIFACT)
    except (OSError, json.JSONDecodeError) as exc:
        checks.append(_check(
            False,
            "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact",
            f"monthly pymoo runtime contract validation artifact parses as JSON; error={type(exc).__name__}",
        ))
        return checks

    feature_pool = artifact.get("feature_pool") if isinstance(artifact.get("feature_pool"), dict) else {}
    monthly_policy = artifact.get("monthly_search_policy") if isinstance(artifact.get("monthly_search_policy"), dict) else {}
    checks.append(_check(
        artifact.get("status") == "pass"
        and artifact.get("decision_effect") == "local_validation_only"
        and monthly_policy.get("algorithm") == "pymoo"
        and int(feature_pool.get("eligible_for_alpha_mining") or -1)
        == int(feature_pool.get("expected_from_local_closure") or -2),
        "roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact",
        "monthly pymoo runtime validation artifact proves pymoo-only monthly policy and feature-pool closure alignment",
    ))
    return checks


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
            ("active-8 direct-alpha production artifact set", "production promotion must use an active-8 direct-alpha model"),
            "roadmap:p2:active8_artifact_promotion_blocker",
            "artifact promotion blocks non-active-8 direct-alpha models from production selection",
        ),
    ]


def _allocator_learning_candidate_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "ml-service/app/linucb_multiplier_replay.py",
            (
                "ADAPTIVE_CANDIDATE_SCHEMA_VERSION = \"adaptive-params-candidate-v1\"",
                "ALLOCATOR_LEARNING_CANDIDATE_SCHEMA_VERSION = \"allocator-learning-policy-candidate-v1\"",
                "\"candidate_type\": \"linucb_bandit_l2_constants\"",
                "\"candidate_type\": \"linucb_model_learning_weight_multipliers\"",
                "\"adaptive_params_candidate\": adaptive_params_candidate",
                "\"allocator_policy_candidate\": allocator_policy_candidate",
                "\"requires_wei_approval\": True",
                "\"allowed_target\": \"ml:adaptive_params.bandit_l2_constants\"",
                "\"allowed_target\": \"ml:adaptive_params.model_allocator.learning_weight_policy\"",
                "\"proposed_production_effect\": \"capped_production_effect\"",
                "\"proposed_production_effect\": \"learning_weight_only\"",
            ),
            "roadmap:p5:linucb_replay_adaptive_params_candidate",
            "LinUCB replay emits approval-gated adaptive_params and allocator learning-weight candidates without direct production mutation",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/ensemble_v2.py",
            (
                "model-allocator-learning-ledger-v1",
                "\"production_weight\"",
                "\"learning_weight\"",
                "\"reject_reason\"",
                "\"learning_policy_effect\"",
                "\"production_effect\": False",
            ),
            "roadmap:p4:full_allocator_learning_ledger",
            "Ensemble V2 emits per-model production/learning/rejected allocator learning ledger",
        ),
        _check_text_contains(
            root,
            "ml-service/app/adaptive_meta_policy_replay.py",
            (
                "ALLOCATOR_CANDIDATE_SCHEMA_VERSION = \"allocator-policy-candidate-v1\"",
                "ALLOCATOR_POLICY_CAP = 0.15",
                "\"candidate_type\": \"family_allocator_model_weight_multipliers\"",
                "\"model_weight_multipliers\": model_weight_multipliers",
                "\"risk_off_cash_bias\":",
                "\"allowed_target\": \"ml:adaptive_params.model_allocator\"",
                "\"requires_wei_approval\": True",
                "\"proposed_production_effect\": \"capped_production_effect\"",
            ),
            "roadmap:p5:adaptive_meta_allocator_policy_candidate",
            "Adaptive Meta replay emits a capped allocator_policy candidate with Wei approval required",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/linucbMultiplierReplayRunner.ts",
            (
                "adaptive_candidate=${report.adaptive_params_candidate?.status ?? 'none'}",
                "allocator_candidate=${report.allocator_policy_candidate?.status ?? 'none'}",
                "production_effect: false",
                "mutation_allowed: false",
                "real_trading_allowed: false",
                "meta:linucb_multiplier_replay:latest",
            ),
            "roadmap:p5:linucb_runner_evidence_only_candidate_persistence",
            "LinUCB replay runner preserves candidate evidence while only writing meta replay keys",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/adaptiveMetaPolicyReplayRunner.ts",
            (
                "allocator_candidate=${report.allocator_policy_candidate?.status ?? 'none'}",
                "production_effect: false",
                "mutation_allowed: false",
                "real_trading_allowed: false",
                "meta:adaptive_policy_replay:latest",
            ),
            "roadmap:p5:adaptive_meta_runner_evidence_only_candidate_persistence",
            "Adaptive Meta replay runner preserves allocator candidate evidence while only writing meta replay keys",
        ),
        _check_text_contains(
            root,
            "ml-service/app/ensemble.py",
            (
                "def score_to_signal(",
                "def rank_to_signal(*args: Any, **kwargs: Any) -> EnsembleResult:",
                "Deprecated compatibility alias for score_to_signal",
            ),
            "roadmap:p5:score_to_signal_active_name_with_legacy_alias",
            "ML service active signal translation is named score_to_signal with rank_to_signal kept only as a compatibility alias",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/portfolio_allocation.py",
            (
                "def _expected_return(row: dict[str, Any]) -> float:",
                "explicit = row.get(\"expected_return\")",
                "explicit = row.get(\"predicted_return\")",
                "return 0.0",
            ),
            "roadmap:p7:sparse_allocator_no_score_expected_return_fallback",
            "Sparse allocator utility does not convert score/rank into expected return fallback",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/recommendation_service.py",
            (
                "\"schema_version\": \"canonical_chip_evidence_v2\"",
                "\"brokerEvidenceStatus\": broker_evidence_status",
                "\"brokerFlowUsed\": True",
                "\"materialized_bullish_broker_chip_evidence\"",
                "\"materialized_bearish_broker_chip_evidence\"",
            ),
            "roadmap:p1_p2:canonical_chip_broker_status_materialized",
            "Recommendation score_components materialize canonical chip/broker evidence status instead of hiding present evidence behind chip_score=0",
        ),
        _check_text_contains(
            root,
            "ml-service/app/prediction_runtime.py",
            (
                "from .ensemble import load_ic_weights, merge_with_time_series, score_to_signal",
                "result = score_to_signal(",
                "\"score_signal_thresholds\"",
                "\"score_scores\"",
            ),
            "roadmap:p5:prediction_runtime_uses_score_to_signal",
            "Prediction runtime calls score_to_signal and emits score_* aliases for UI/OBS",
        ),
        _check_text_regex_absent(
            root,
            "ml-service/app/prediction_runtime.py",
            r"\brank_to_signal\b",
            "roadmap:p5:prediction_runtime_no_legacy_rank_to_signal_call",
            "Prediction runtime no longer imports or calls rank_to_signal",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/recommendationContext.ts",
            (
                "scoreSignalThresholds",
                "ev2.score_signal_thresholds",
                "rankSignalThresholds: scoreSignalThresholds",
            ),
            "roadmap:p5:worker_ml_diagnostics_score_threshold_alias",
            "Worker ML diagnostics prefers score_signal_thresholds while preserving the legacy UI field",
        ),
    ]


def _alpha_mining_similarity_checks(root: Path) -> list[dict[str, Any]]:
    checks = [
        _check_text_contains(
            root,
            "tools/finlab_alpha_miner_bakeoff.py",
            (
                "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed",
                "similarity_matrix_missing_internal_pairs",
                "similarity_matrix_missing_archive_pairs",
                "def _missing_similarity_pair_count",
            ),
            "roadmap:p2:alpha_mining_similarity_matrix_only_fail_closed",
            "alpha mining novelty uses formal137 pairwise matrix only and exposes missing-pair evidence",
        ),
        _check_text_regex_absent(
            root,
            "tools/finlab_alpha_miner_bakeoff.py",
            r"cluster_fallback|with_cluster_fallback",
            "roadmap:p2:alpha_mining_no_self_similarity_fill",
            "alpha mining novelty must not fill missing pairwise similarity from registry cluster leaders",
        ),
        _check_text_contains(
            root,
            "tools/validate_alpha_mining_similarity_novelty.py",
            (
                "missing_pair_fail_closed",
                "similarity_matrix_missing_internal_pairs",
                "matrix_only_fail_closed",
            ),
            "roadmap:p2:alpha_mining_similarity_validator",
            "alpha mining novelty validator covers high duplicate, low similarity, archive duplicate, and missing-pair fail-closed cases",
        ),
    ]
    checks.append(_check_artifact_fresh_against(
        root,
        ALPHA_MINING_SIMILARITY_VALIDATION_ARTIFACT,
        ALPHA_MINING_SIMILARITY_VALIDATION_DEPENDENCIES,
        "roadmap:p2:alpha_mining_similarity_validation_artifact_fresh",
        "alpha mining similarity novelty validation artifact is newer than validator and miner source",
    ))
    try:
        artifact = _load_json(root, ALPHA_MINING_SIMILARITY_VALIDATION_ARTIFACT)
    except (OSError, json.JSONDecodeError) as exc:
        checks.append(_check(
            False,
            "roadmap:p2:alpha_mining_similarity_validation_artifact",
            f"alpha mining similarity novelty validation artifact parses as JSON; error={type(exc).__name__}",
        ))
        return checks

    cases = artifact.get("cases") if isinstance(artifact.get("cases"), dict) else {}
    missing_case = cases.get("missing_pair_fail_closed") if isinstance(cases.get("missing_pair_fail_closed"), dict) else {}
    checks.append(_check(
        artifact.get("status") == "pass"
        and artifact.get("method") == "formal137_pairwise_abs_rank_corr_matrix_only_fail_closed"
        and missing_case.get("max_similarity") == 1.0
        and int(missing_case.get("similarity_matrix_missing_internal_pairs") or 0) >= 1,
        "roadmap:p2:alpha_mining_similarity_validation_artifact",
        "alpha mining similarity novelty validation artifact proves missing pair fail-closed behavior",
    ))
    return checks


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
                "input_candidate_pool_policy",
                "full_eligible_pool_no_buy_signal_rank_gate",
                "buy_signal_count_role",
                "maximum_selected_count_not_preallocation_rank_cut",
                "allocation_rank_policy",
                "diagnostic_only_not_capacity_gate",
            ),
            "roadmap:p2:l4_sparse_zero_selection_diagnostics",
            "L4 sparse allocation writes per-candidate diagnostics, allows zero selection, and evaluates the full eligible pool before sparse allocation",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/similarity_evidence.py",
            (
                "SIMILARITY_EVIDENCE_VERSION",
                "networkx",
                "LedoitWolf",
                "evidence_only",
                "hdbscan_research_audit",
                "sklearn.cluster.HDBSCAN",
                "outlier_score",
                "cluster_stability",
                "research_shadow_only",
            ),
            "roadmap:v4:shared_similarity_evidence",
            "Shared controller similarity evidence uses official graph/covariance/HDBSCAN surfaces without becoming a selector",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/recommendation_service.py",
            (
                "cluster_id",
                "cluster_exposure",
                "max_cluster_weight",
                "covariance_method",
                "cluster_penalty_applied",
            ),
            "roadmap:v4:l4_cluster_covariance_evidence",
            "L4 sparse allocation persists cluster exposure and LedoitWolf covariance evidence",
        ),
        _check_text_contains(
            root,
            "ml-service/app/strategy_similarity_evidence.py",
            (
                "STRATEGY_SIMILARITY_EVIDENCE_VERSION",
                "ml-service-modal-python",
                "networkx.Graph+networkx.connected_components",
                "sklearn_extra.cluster.KMedoids",
                "method=\"pam\"",
                "kmedoids_pam_preflight_status",
                "global_k_hardcoded",
                "production_selector",
                "self_implemented_algorithm",
            ),
            "roadmap:v4:l125_modal_strategy_similarity_owner",
            "L1.25 strategy similarity graph is owned by Modal/Python with official NetworkX and sklearn-extra PAM evidence",
        ),
        _check_text_contains(
            root,
            "ml-service/modal_app.py",
            (
                "def strategy_similarity_evidence",
                "build_strategy_similarity_evidence",
                "L1.25 strategy similarity graph evidence owned by Modal/Python",
            ),
            "roadmap:v4:l125_modal_function_surface",
            "Modal app exposes the L1.25 strategy similarity evidence function",
        ),
        _check_text_contains(
            root,
            "ml-service/app/gnn_batch_runtime.py",
            (
                "build_multi_similarity_edge_index",
                "\"edge_source\": \"multi_similarity_graph_v1\"",
                "\"production_edge_replaces\": \"price_correlation_v1\"",
                "\"allowed_use\": \"production_gnn_edge_context\"",
                "\"production_edge_active\": True",
                "\"selector\": False",
                "import networkx as nx",
                "strategy_co_hit",
                "sector_factor_similarity",
                "finlab_chip_flow_similarity",
                "regime_co_movement",
                "threshold_quantile=threshold_quantile",
                "context_records=context_records",
            ),
            "roadmap:v4:gnn_multi_similarity_edge_production",
            "GNN production GraphSAGE uses NetworkX multi-source similarity graph edges without becoming a selector",
        ),
        _check_text_contains(
            root,
            "ml-service/app/batch_prediction.py",
            (
                "_build_gnn_similarity_context_record",
                "strategy_hit_vector",
                "family_affinity_vector",
                "sector_factor",
                "finlab_chip_flow",
                "context_records=context_records",
                "runtime_options[\"gnn_batch_context\"] = graph_report",
            ),
            "roadmap:v4:gnn_batch_context_source_wiring",
            "GNN batch prediction passes existing strategy/sector/chip/regime context into the production edge builder",
        ),
        _check_text_regex_absent(
            root,
            "ml-service/app/gnn_batch_runtime.py",
            r"shadow_edge_experiment|multi_similarity_graph_shadow|shadow_telemetry_only",
            "roadmap:v4:gnn_no_shadow_edge_path",
            "GNN multi-similarity edge integration must not remain a shadow-only path",
        ),
        _check_file_absent(
            root,
            "ml-service/app/gnn_shadow.py",
            "roadmap:v4:gnn_legacy_shadow_wrapper_removed",
            "Legacy GNN shadow wrapper must be removed after production multi-source edge promotion",
        ),
        _check_file_absent(
            root,
            "ml-service/app/gnn_model.py",
            "roadmap:v4:gnn_legacy_numpy_shadow_model_removed",
            "Legacy numpy-only shadow GNN model must be removed after GraphSAGE production owner is active",
        ),
        _check_text_contains(
            root,
            "ml-controller/routers/strategy_similarity.py",
            (
                "prefix=\"/l125\"",
                "/strategy_similarity_evidence",
                "modal_client.strategy_similarity_evidence",
                "/hdbscan_research_audit",
                "mutation_allowed",
                "production_decision_path",
                "research_shadow_only",
                "fail closed",
            ),
            "roadmap:v4:l125_controller_modal_proxy",
            "L1.25 strategy similarity route proxies to Modal and exposes HDBSCAN only as research/shadow evidence",
        ),
        _check_text_contains(
            root,
            "ml-controller/main.py",
            (
                "_strategy_similarity_warmup_payload",
                "\"strategy_similarity_evidence\": modal_client.strategy_similarity_evidence",
                "kmedoids_pam_preflight_status",
                "ml-service-modal-python",
            ),
            "roadmap:v4:l125_modal_warmup_preflight",
            "Controller warmup exercises Modal L1.25 strategy similarity evidence and reports official PAM preflight status",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/adminTriggerWorkerDomainTasks.ts",
            (
                "summarizeMlControllerWarmupTargets",
                "strategy_similarity_evidence",
                "kmedoids_pam_preflight_status",
                "ML Controller warmup ${targets.ok ? 'ok' : 'degraded'}",
            ),
            "roadmap:v4:l125_worker_warmup_fail_visible",
            "Worker admin warmup reports degraded when any controller warmup target, including L1.25 PAM preflight, is degraded",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/marketScreener.ts",
            (
                "buildStrategySimilarityEvidencePayload",
                "'/l125/strategy_similarity_evidence'",
                "coerceModalStrategySimilarityGraphEvidence",
                "strategySimilarityGraphEvidence: strategySimilarityEvidence.evidence",
                "strategy_similarity_evidence_status",
            ),
            "roadmap:v4:l125_worker_modal_wiring",
            "Worker production screener calls controller/Modal for L1.25 strategy similarity evidence before routing",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/strategyPortfolioMetrics.ts",
            (
                "kmedoids_pam_preflight_status",
                "cleanText(record.status) !== 'computed'",
                "cleanText(preflight.status) !== 'pass'",
                "record.self_implemented_algorithm !== false",
            ),
            "roadmap:v4:l125_modal_evidence_strict_coercion",
            "Worker rejects Modal L1.25 strategy similarity evidence unless official PAM preflight passed",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/screenerFunnelEvidence.ts",
            (
                "strategy_similarity_evidence_status",
                "strategy_similarity_evidence_source",
                "strategy_similarity_algorithm_owner",
                "strategy_similarity_medoid_algorithm",
                "strategy_similarity_degraded_count",
            ),
            "roadmap:v4:l125_similarity_observability",
            "Daily funnel summaries expose L1.25 Modal strategy similarity source/status/algorithm evidence",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/multiStrategyPleRouter.ts",
            (
                "strategy_similarity_graph",
                "strategy_cluster_crowding_score",
                "strategy_cluster_uniqueness_score",
                "effective_strategy_count",
            ),
            "roadmap:v4:l125_worker_consumes_strategy_similarity_fields",
            "Worker L1.25/L1.5 surface consumes strategy similarity fields but is not the formal algorithm owner",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/promotion_gate_contract.py",
            (
                "SIMILARITY_PROMOTION_REQUIRED_GATES",
                "no_new_selector",
                "no_hardcoded_cluster_count",
                "no_topk_fallback",
                "l15_pairwise_corr_not_worse",
            ),
            "roadmap:v4:similarity_promotion_gate",
            "Similarity/clustering evidence has explicit production promotion gates",
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
                "sourceRole: 'finlab_primary_canonical_mirror'",
                "source_role=${mirror.sourceRole}",
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
                "downstream_stage: 'layer2_timesfm_enrichment'",
            ),
            "roadmap:p3:l15_ml_slate_queue_stage",
            "Worker persists L1.5 ML slate queue as a pre-controller queue, not formal L2",
        ),
        _check_text_regex_absent(
            root,
            "worker/src/lib/marketScreener.ts",
            r"\bstage:\s*['\"]layer2_timesfm_enrichment['\"]",
            "roadmap:p3:worker_not_formal_l2_owner",
            "Worker screener must not write formal layer2_timesfm_enrichment stage rows",
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
            ("'l15_ml_slate_queue'", "'layer2_timesfm_enrichment'"),
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
            ("Fleet status", "Meta boundary", "Active-8 confidence hook", "LinUCB, NeuralUCB, NeuralTS, and NeuCB"),
            "roadmap:p3:model_pool_evidence_ui",
            "Model Pool UI surfaces active-8 direct-alpha fleet health and meta-policy evidence boundaries",
        ),
    ]


def _finlab_l0_p0_p9_closure_checks(root: Path) -> list[dict[str, Any]]:
    return [
        _check_text_contains(
            root,
            "worker/src/lib/marketScreener.ts",
            (
                "buildL0RawSignalCoverageAudit",
                "l0RawSignalCoverageAudit",
                "fundamental_loader_error",
                "rawCoverage",
                "canonicalCoverageBaseline",
                "listed_otc_finlab_broker_transactions:not_materialized",
            ),
            "finlab_p0:l0_raw_signal_coverage_audit",
            "P0/P9: L0 writes raw_signal coverage audit and explicitly marks missing listed broker materialization",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/marketScreener.ts",
            (
                "ORDER BY stock_id, available_date DESC, period DESC",
                "telemetry.canonicalErrors.push",
                "telemetry.revenueErrors.push",
                "finlab.fundamental_features",
                "finlab.monthly_revenue",
            ),
            "finlab_p1:fundamental_loader_non_silent_bulk",
            "P1/P3: L0 fundamental loader scans latest non-null rows and reports errors without silent fallback",
        ),
        _check_text_contains(
            root,
            "tools/finlab_v4_remote_backfill.py",
            (
                "lane=\"broker_flow_diversity\"",
                "kind=\"broker_aggregate\"",
                "normalize_broker_transactions_daily",
                "broker_transactions",
                "finlab.broker_transactions",
            ),
            "finlab_p2:broker_transactions_raw_materialization",
            "P2: remote backfill normalizes listed/OTC FinLab broker_transactions into broker_flow_diversity",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/finlab_canonical_materializer.py",
            (
                "build_listed_broker_flow_rows",
                "raw\" / lane / \"broker_daily.parquet",
                "finlab.broker_transactions",
                "canonical_broker_flow_daily",
            ),
            "finlab_p2:broker_transactions_canonical_materialization",
            "P2: canonical materializer writes listed/OTC broker flow rows into canonical_broker_flow_daily",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/screenerMarketData.ts",
            (
                "CanonicalScreenerPrice",
                "CanonicalScreenerChip",
                "@deprecated Use CanonicalScreenerPrice",
                "@deprecated Use CanonicalScreenerChip",
                "'broker_flow'",
            ),
            "finlab_p3:canonical_screener_adapter_boundary",
            "P3: Worker screener exposes canonical adapter types and keeps old FM names as aliases only",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/marketScreener.ts",
            (
                "finlab_style_cs_sector_rank_zscore_winsor_sector_neutral_v2",
                "zScoreKey",
                "winsorizedKey",
                "sectorNeutralRankKey",
                "finlabInverseVolatilityWeight",
                "finlabIndustryCapWeight",
                "finlabTurnoverControlWeight",
            ),
            "finlab_p4:factor_normalization_evidence",
            "P4: L0/L1 writes FinLab-style rank/z-score/winsor/sector-neutral/allocation evidence without selecting stocks",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/strategyPortfolioMetrics.ts",
            (
                "factor_return",
                "factorReturn",
                "centrality",
                "factor_centrality",
                "graph_centrality",
                "shapley_contribution",
                "rank_ic",
            ),
            "finlab_p5:l125_factor_analysis_metrics",
            "P5: L1.25 strategy metrics include factor return, centrality, RankIC, and Shapley evidence",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/multiStrategyPleRouter.ts",
            (
                "strategy_prior_weight",
                "family_prior_weight",
                "strategy_reliability",
                "strategy_crowding_score",
                "strategy_diversification_value",
                "factor_return",
                "centrality",
            ),
            "finlab_p6:l125_portfolio_intelligence_priors",
            "P6: L1.25 emits strategy/family priors, reliability, crowding, diversification, and factor-analysis evidence",
        ),
        _check_text_contains(
            root,
            "worker/src/lib/multiStrategyPleRouter.ts",
            (
                "training_teacher_labels_offline_runtime_teacher_evidence_optional",
                "previous_trading_day_or_latest_verified_cache_no_same_day_l2_l3_dependency",
                "missing_runtime_teacher_cache",
                "historical_verified_cache",
            ),
            "finlab_p7:teacher_label_runtime_contract",
            "P7: daily routing uses verified runtime teacher cache only and does not require same-day L2/L3",
        ),
        _check_text_contains(
            root,
            "ml-controller/services/recommendation_service.py",
            (
                "single_name_weight",
                "single_name_weight_limit",
                "drawdown_state",
                "live_backtest_divergence",
                "turnover_pressure",
            ),
            "finlab_p8:l4_risk_checklist_evidence",
            "P8: L4 sparse allocation records FinLab-style risk checklist evidence without becoming a selector",
        ),
        _check(
            root.joinpath("ml-service/benchmark_results/evening_chain_rerun_20260615/report_20260615_v1_vs_rerun.md").exists(),
            "finlab_p9:rerun_report_artifact_present",
            "P9: 2026-06-15 L0-L4 comparison report artifact is present for local audit",
        ),
        *_active_strategy_backtest_baseline_checks(root),
    ]


def _latest_by_mtime(paths: list[Path]) -> Path | None:
    return max(paths, key=lambda path: path.stat().st_mtime) if paths else None


def _active_strategy_backtest_baseline_checks(root: Path) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = [
        _check_text_contains(
            root,
            "tools/export_active_strategy_specs_from_d1.py",
            (
                "read_only_d1_export",
                "production_mutation_allowed",
                "strategy_spec_registry",
                "SELECT_ACTIVE_STRATEGIES_SQL_ONE_LINE",
            ),
            "strategy_baseline:active_spec_exporter_readonly",
            "active strategy specs are generated by a read-only D1 exporter, not by manual shell JSON shaping",
        )
    ]
    output_dir = root / "output/finlab_strategy_backtests"
    export_summary_path = _latest_by_mtime(list(output_dir.glob("current_active_*_strategy_specs_summary.json")))
    checks.append(_check(
        export_summary_path is not None,
        "strategy_baseline:active_spec_export_summary_present",
        "current active StrategySpec export summary exists",
    ))
    if export_summary_path is None:
        return checks

    try:
        export_summary = json.loads(export_summary_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        checks.append(_check(False, "strategy_baseline:active_spec_export_summary_json", f"active StrategySpec export summary parses as JSON; error={type(exc).__name__}"))
        return checks

    strategy_count = int(export_summary.get("strategy_count") or 0)
    checks.extend([
        _check(
            export_summary.get("decision_effect") == "read_only_d1_export"
            and export_summary.get("production_mutation_allowed") is False,
            "strategy_baseline:active_spec_export_readonly_summary",
            "active StrategySpec export summary is explicitly read-only/non-mutating",
        ),
        _check(
            strategy_count > 0 and not export_summary.get("errors"),
            "strategy_baseline:active_spec_export_no_errors",
            "active StrategySpec export has a positive strategy count and no validation errors",
        ),
    ])
    spec_rel = str(export_summary.get("json") or "").strip()
    spec_path = root / spec_rel if spec_rel else output_dir / f"current_active_{strategy_count}_strategy_specs.json"
    checks.append(_check(
        spec_path.exists(),
        "strategy_baseline:active_spec_json_present",
        f"active StrategySpec JSON exists at {spec_rel or spec_path.name}",
    ))
    if spec_path.exists():
        try:
            specs = json.loads(spec_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            checks.append(_check(False, "strategy_baseline:active_spec_json_parses", f"active StrategySpec JSON parses; error={type(exc).__name__}"))
            specs = []
        checks.extend([
            _check(
                isinstance(specs, list) and len(specs) == strategy_count,
                "strategy_baseline:active_spec_json_count_matches",
                "active StrategySpec JSON row count matches export summary",
            ),
            _check(
                isinstance(specs, list)
                and all(isinstance(spec.get("supportedRegimes"), list) and "value" not in spec.get("supportedRegimes", {}) for spec in specs if isinstance(spec, dict))
                and all(isinstance(spec.get("riskNotes"), list) and "value" not in spec.get("riskNotes", {}) for spec in specs if isinstance(spec, dict)),
                "strategy_baseline:active_spec_json_array_shape",
                "active StrategySpec JSON uses clean arrays for supportedRegimes and riskNotes",
            ),
        ])

    backtest_summary = output_dir / f"finlab_strategy_spec_active{strategy_count}_20230101_20260615_summary.json"
    checks.append(_check(
        backtest_summary.exists(),
        "strategy_baseline:active_finlab_backtest_summary_present",
        "FinLab backtest summary exists for the current active strategy count",
    ))
    if backtest_summary.exists():
        try:
            summary = json.loads(backtest_summary.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            checks.append(_check(False, "strategy_baseline:active_finlab_backtest_summary_json", f"active strategy backtest summary parses as JSON; error={type(exc).__name__}"))
            return checks
        ok = int(summary.get("ok") or 0)
        no_signal = int(summary.get("no_signal") or 0)
        unsupported_feature = int(summary.get("unsupported_feature") or 0)
        checks.extend([
            _check(
                int(summary.get("strategy_count") or 0) == strategy_count,
                "strategy_baseline:active_finlab_backtest_count_matches",
                "active strategy FinLab backtest count matches exported active StrategySpec count",
            ),
            _check(
                ok + no_signal + unsupported_feature == strategy_count and not summary.get("errors"),
                "strategy_baseline:active_finlab_backtest_no_errors",
                "active strategy FinLab backtest has no sim errors and accounts for every active strategy, including unsupported composite feature rows",
            ),
        ])
    return checks


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


def _packet_local_audit_group_self_refresh_only(
    packet: dict[str, Any],
    *,
    group_id: str,
    expected_check_ids: tuple[str, ...],
) -> bool:
    blocked = packet.get("blocked_reason") if isinstance(packet.get("blocked_reason"), dict) else {}
    if packet.get("cutover_ready_for_review") is True:
        return False
    if not (
        blocked.get("audit_exists") is True
        and blocked.get("local_gate_passed") is True
        and blocked.get("evidence_ready") is True
        and blocked.get("audit_is_non_mutating") is True
        and blocked.get("evidence_health_ready") is False
    ):
        return False

    failed_health = [
        row
        for row in packet.get("evidence_health") or []
        if isinstance(row, dict) and row.get("passed") is not True
    ]
    if len(failed_health) != 1 or failed_health[0].get("id") != group_id:
        return False

    detail = failed_health[0].get("detail") if isinstance(failed_health[0].get("detail"), dict) else {}
    missing = {str(check_id) for check_id in detail.get("missing_check_ids") or []}
    failed = {str(check_id) for check_id in detail.get("failed_check_ids") or []}
    stale_or_missing = missing | failed
    return bool(stale_or_missing) and stale_or_missing.issubset(set(expected_check_ids))


def _packet_audit_group_self_refresh_only(packet: dict[str, Any]) -> bool:
    return any((
        _packet_local_audit_group_self_refresh_only(
            packet,
            group_id="local_audit_alpha_mining_similarity_fail_closed_gates",
            expected_check_ids=ALPHA_MINING_SIMILARITY_AUDIT_CHECK_IDS,
        ),
        _packet_local_audit_group_self_refresh_only(
            packet,
            group_id="local_audit_monthly_pymoo_runtime_contract_gates",
            expected_check_ids=MONTHLY_PYMOO_RUNTIME_AUDIT_CHECK_IDS,
        ),
    ))


def _packet_local_gate_self_refresh_only(packet: dict[str, Any]) -> bool:
    blocked = packet.get("blocked_reason") if isinstance(packet.get("blocked_reason"), dict) else {}
    if packet.get("cutover_ready_for_review") is True:
        return False
    return (
        blocked.get("audit_exists") is True
        and blocked.get("local_gate_passed") is False
        and blocked.get("evidence_ready") is True
        and blocked.get("evidence_health_ready") is True
        and blocked.get("audit_is_non_mutating") is True
        and packet.get("production_mutation_allowed") is False
        and not [
            row
            for row in packet.get("evidence_health") or []
            if isinstance(row, dict) and row.get("passed") is not True
        ]
    )


def _production_cutover_packet_checks(root: Path) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = [
        _check_text_contains(
            root,
            "ml-controller/services/production_cutover_packet.py",
            (
                "local_prod_ready_audit_20260618.json",
                "production_cutover_remote_preflight_20260618.json",
                "remote_cutover_complete",
                "deploy_ml_controller_strategy_mining_route",
                "apply_strategy_mining_ledger_migration",
                "enable_strategy_mining_execution_env",
                "feature_selection_retrain_release",
            ),
            "roadmap:p12:production_cutover_packet_20260618_scope",
            "P12 cutover packet must use the 2026-06-18 Feature Registry evidence scope and new approval gates",
        ),
        _check_text_contains(
            root,
            "tools/production_cutover_remote_preflight.py",
            (
                "stockvision-production-cutover-remote-preflight-v1",
                "gcp_scheduler_monthly_strategy_mining",
                "ml_controller_strategy_mining_env",
                "d1_strategy_mining_ledger_tables",
                "d1_alpha_miner_strategy_seed",
                "production_mutation_allowed",
                "read_only_observation",
                "local_cutover_packet_path",
                "local_cutover_packet_ready_for_review",
            ),
            "roadmap:p12:remote_preflight_tool_read_only",
            "P12 remote preflight must be repeatable and read-only instead of a hand-written snapshot",
        ),
    ]

    cutover_path = root / "ml-service/benchmark_results/production_cutover_packet_20260618.json"
    remote_path = root / "ml-service/benchmark_results/production_cutover_remote_preflight_20260618.json"
    checks.append(_check(
        cutover_path.exists(),
        "roadmap:p12:production_cutover_packet_artifact_present",
        "P12 production cutover packet 2026-06-18 artifact is present",
    ))
    checks.append(_check(
        remote_path.exists(),
        "roadmap:p12:remote_preflight_artifact_present",
        "P12 remote preflight 2026-06-18 artifact is present",
    ))
    checks.append(_check_artifact_fresh_against(
        root,
        "ml-service/benchmark_results/production_cutover_packet_20260618.json",
        CUTOVER_PACKET_FRESHNESS_DEPENDENCIES,
        "roadmap:p12:production_cutover_packet_artifact_fresh",
        "P12 cutover packet artifact is newer than its non-circular upstream evidence",
    ))

    if cutover_path.exists():
        packet = json.loads(cutover_path.read_text(encoding="utf-8-sig"))
        packet_self_refresh = (
            _packet_audit_group_self_refresh_only(packet)
            or _packet_local_gate_self_refresh_only(packet)
        )
        evidence_health = packet.get("evidence_health") or []
        evidence_by_id = {
            str(row.get("id")): row
            for row in evidence_health
            if isinstance(row, dict) and row.get("id")
        }
        feature_closure_detail = (evidence_by_id.get("feature_registry_local_closure_pass") or {}).get("detail") or {}
        materialization_detail = (evidence_by_id.get("unified137_materialization_pass") or {}).get("detail") or {}
        migration_detail = (evidence_by_id.get("ml_feature_migration_preflight_ready") or {}).get("detail") or {}
        promotion_detail = (evidence_by_id.get("alpha_mining_promotion_contract_governance_only") or {}).get("detail") or {}
        action_ids = {str(row.get("id")) for row in packet.get("approval_required_actions") or [] if isinstance(row, dict)}
        required_action_ids = {str(row["id"]) for row in APPROVAL_REQUIRED_ACTIONS}
        checks.extend([
            _check(
                packet.get("cutover_ready_for_review") is True or packet_self_refresh,
                "roadmap:p12:cutover_ready_for_review",
                "P12 packet is ready for Wei review after local evidence checks pass",
            ),
            _check(
                packet.get("production_mutation_allowed") is False and packet.get("actions_allowed_without_wei_approval") == [],
                "roadmap:p12:cutover_non_mutating",
                "P12 packet remains non-mutating and allows no production action without Wei approval",
            ),
            _check(
                (
                    bool(evidence_health)
                    and all(isinstance(row, dict) and row.get("passed") is True for row in evidence_health)
                )
                or packet_self_refresh,
                "roadmap:p12:cutover_evidence_health_pass",
                "P12 packet evidence health checks all pass",
            ),
            _check(
                feature_closure_detail.get("artifact_fresh") is True
                and bool(feature_closure_detail.get("derived_artifact_freshness")),
                "roadmap:p12:cutover_feature_registry_evidence_source_fresh",
                "P12 packet carries source-fresh feature registry closure evidence",
            ),
            _check(
                materialization_detail.get("artifact_fresh") is True,
                "roadmap:p12:cutover_materialization_evidence_source_fresh",
                "P12 packet carries source-fresh unified137 materialization evidence",
            ),
            _check(
                migration_detail.get("materialization_audit_fresh") == "pass"
                and migration_detail.get("materialization_contract_ready") == "pass",
                "roadmap:p12:cutover_ml_migration_evidence_source_fresh",
                "P12 packet carries source-fresh ML migration materialization gates",
            ),
            _check(
                promotion_detail.get("source_contracts_fresh") is True,
                "roadmap:p12:cutover_alpha_promotion_evidence_source_fresh",
                "P12 packet carries source-fresh alpha mining promotion evidence",
            ),
            _check(
                required_action_ids.issubset(action_ids),
                "roadmap:p12:cutover_approval_actions_synced",
                "P12 packet exposes the full approval-required action set",
            ),
            _check(
                "remote_cutover_complete" in packet and isinstance(packet.get("remote_preflight_summary"), dict),
                "roadmap:p12:cutover_remote_summary_present",
                "P12 packet carries remote preflight summary separately from local readiness",
            ),
        ])

    if remote_path.exists():
        remote = json.loads(remote_path.read_text(encoding="utf-8-sig"))
        check_ids = {str(row.get("id")) for row in remote.get("checks") or [] if isinstance(row, dict)}
        checks.extend([
            _check(
                remote.get("decision_effect") == "read_only_observation" and remote.get("production_mutation_allowed") is False,
                "roadmap:p12:remote_preflight_non_mutating",
                "P12 remote preflight artifact is explicitly read-only/non-mutating",
            ),
            _check(
                {
                    "gcp_scheduler_monthly_strategy_mining",
                    "gcp_scheduler_monthly_optuna_timezone",
                    "ml_controller_strategy_mining_env",
                    "d1_strategy_mining_ledger_tables",
                    "d1_alpha_miner_strategy_seed",
                    "d1_strategy_spec_registry_schema",
                }.issubset(check_ids),
                "roadmap:p12:remote_preflight_expected_checks",
                "P12 remote preflight covers Scheduler, controller env, D1 ledger, strategy seed, and registry schema",
            ),
        ])

    return checks


def _artifact_lifecycle_repair_packet_checks(root: Path) -> list[dict[str, Any]]:
    packet_path = root / ARTIFACT_LIFECYCLE_REPAIR_PACKET
    checks = [
        _check(
            packet_path.exists(),
            "artifact_lifecycle:p6:repair_packet_present",
            "P6 artifact lifecycle repair packet is present",
        ),
        _check_artifact_fresh_against(
            root,
            ARTIFACT_LIFECYCLE_REPAIR_PACKET,
            ARTIFACT_LIFECYCLE_REPAIR_PACKET_DEPENDENCIES,
            "artifact_lifecycle:p6:repair_packet_fresh",
            "P6 artifact lifecycle repair packet is newer than source evidence and builder",
        ),
    ]
    if not packet_path.exists():
        return checks

    packet = json.loads(packet_path.read_text(encoding="utf-8-sig"))
    actions = packet.get("actions") if isinstance(packet.get("actions"), list) else []
    actions_by_model = {
        str(action.get("model_name")): action
        for action in actions
        if isinstance(action, dict) and action.get("model_name")
    }
    summary = packet.get("summary") if isinstance(packet.get("summary"), dict) else {}
    checks.extend([
        _check(
            packet.get("schema_version") == "artifact-lifecycle-repair-packet-v1",
            "artifact_lifecycle:p6:repair_packet_schema",
            "P6 artifact lifecycle repair packet uses the expected schema",
        ),
        _check(
            packet.get("production_mutation_allowed") is False
            and all(
                isinstance(action, dict)
                and action.get("production_mutation_allowed") is False
                and action.get("requires_wei_approval") is True
                for action in actions
            ),
            "artifact_lifecycle:p6:repair_packet_non_mutating",
            "P6 repair packet is local-only and every action requires Wei approval",
        ),
        _check(
            {"PatchTST", "iTransformer"}.issubset(set(summary.get("production_pointer_fail_closed_repairs") or []))
            and actions_by_model.get("PatchTST", {}).get("root_cause") == "production_pointer_updated_despite_cpcv_coverage_contract_drift"
            and actions_by_model.get("iTransformer", {}).get("root_cause") == "production_pointer_updated_despite_true_performance_fail",
            "artifact_lifecycle:p6:sequence_repair_actions",
            "P6 repair packet separates PatchTST coverage-contract recompute from iTransformer true performance fail",
        ),
        _check(
            {"DLinear", "ExtraTrees", "LightGBM", "XGBoost"}.issubset(set(summary.get("offline_pass_pending_release") or [])),
            "artifact_lifecycle:p6:offline_pass_pending_release_actions",
            "P6 repair packet includes offline-pass candidates that need promotion-controller approval before release",
        ),
    ])
    return checks


def _formal137_repair_roadmap_checks(root: Path) -> list[dict[str, Any]]:
    validator_path = root / "tools/validate_formal137_repair_roadmap.py"
    if not validator_path.exists():
        return [_check(
            False,
            "formal137:p0_p10_repair_validator_present",
            "Formal137 P0-P10 repair validator exists",
        )]
    spec = importlib.util.spec_from_file_location("formal137_repair_validator", validator_path)
    if spec is None or spec.loader is None:
        return [_check(
            False,
            "formal137:p0_p10_repair_validator_loadable",
            "Formal137 P0-P10 repair validator is importable",
        )]
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    report = module.build_report(root)
    failed = report.get("failed_checks") if isinstance(report.get("failed_checks"), list) else []
    return [_check(
        report.get("status") == "pass" and report.get("local_prod_ready") == "done" and not failed,
        "formal137:p0_p10_repair_validator",
        f"Formal137 P0-P10 local repair validator status={report.get('status')} failed={len(failed)}",
    )]


def build_local_prod_ready_audit(repo_root: Path | None = None) -> dict[str, Any]:
    root = repo_root or _repo_root()
    checks = [
        *_scheduler_checks(root),
        *_runtime_pin_checks(root),
        *_worker_runtime_pin_checks(root),
        *_model_track_checks(),
        *_ui_contract_checks(root),
        *_semantic_boundary_checks(root),
        *_active8_data_chain_checks(root),
        *_optuna_scheduler_checks(root),
        *_replay_and_promotion_checks(root),
        *_allocator_learning_candidate_checks(root),
        *_alpha_mining_similarity_checks(root),
        *_l4_execution_checks(root),
        *_finlab_market_data_owner_checks(root),
        *_finlab_l0_p0_p9_closure_checks(root),
        *_l15_l2_owner_boundary_checks(root),
        *_observability_checks(root),
        *_replay_checks(root),
        *_production_cutover_packet_checks(root),
        *_artifact_lifecycle_repair_packet_checks(root),
        *_formal137_repair_roadmap_checks(root),
    ]
    failed = [row for row in checks if row["status"] != "pass"]
    local_done = not failed
    return {
        "schema_version": SCHEMA_VERSION,
        "roadmap_scope_version": ROADMAP_SCOPE_VERSION,
        "roadmap_scope": "full_session_root",
        "audit_scope": [
            "p0_source_of_truth_semantics",
            "p1_active8_data_chain",
            "p1_optuna_adaptive_search_scheduler",
            "p1_mode_b_confidence_bandit_replay",
            "p2_opb_l4_allocation",
            "p2_promotion_governance",
            "p2_alpha_mining_similarity_fail_closed",
            "p2_legacy_cleanup",
            "p3_model_pool_ui_observability",
            "finlab_p0_p9_l0_l125_l15_l4_raw_signal_portfolio_intelligence_closure",
            "formal137_p0_p10_repair_no_partial_local_closure",
            "artifact_lifecycle_p0_p8_repair_no_partial_local_closure",
            "p12_production_cutover_preflight_packet_and_remote_readonly_audit",
        ],
        "local_closure": "done" if local_done else "blocked",
        "local_prod_ready": "done" if local_done else "blocked",
        "promotion_allowed": False,
        "production_mutation_allowed": False,
        "checks": checks,
        "failed_checks": failed,
        "production_cutover_requires_wei_approval": [str(row["id"]) for row in APPROVAL_REQUIRED_ACTIONS],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the StockVision local prod-ready audit artifact.")
    parser.add_argument("--repo", default=str(_repo_root()))
    parser.add_argument("--output", default=DEFAULT_LOCAL_AUDIT_PATH)
    args = parser.parse_args(argv)

    audit = build_local_prod_ready_audit(Path(args.repo))
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "local_closure": audit["local_closure"],
        "local_prod_ready": audit["local_prod_ready"],
        "failed_checks": [row["id"] for row in audit["failed_checks"]],
        "promotion_allowed": audit["promotion_allowed"],
        "production_mutation_allowed": audit["production_mutation_allowed"],
    }, ensure_ascii=False, indent=2))
    return 0 if audit["local_prod_ready"] == "done" else 2


if __name__ == "__main__":
    raise SystemExit(main())
