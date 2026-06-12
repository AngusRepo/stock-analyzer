from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from services.model_upgrade_research_track import build_research_benchmark_manifest

SCHEMA_VERSION = "stockvision-local-prod-ready-audit-v1"

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
)

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


def _scheduler_checks(root: Path) -> list[dict[str, Any]]:
    manifest = _load_json(root, "infra/gcp-scheduler-jobs.json")
    jobs = {str(job.get("id")) for job in manifest.get("jobs") or []}
    return [
        _check(job in jobs, f"scheduler_manifest:{job}", "required local scheduler job is present")
        for job in REQUIRED_SCHEDULER_JOBS
    ]


def _runtime_pin_checks(root: Path) -> list[dict[str, Any]]:
    requirements = _read_text(root, "ml-service/requirements.txt")
    return [
        _check(pin in requirements, f"runtime_pin:{pin}", "reviewed official/stable runtime pin is present")
        for pin in REQUIRED_RUNTIME_PINS
    ]


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
    timesfm25 = manifest.get("TimesFM25")
    checks.append(_check(
        isinstance(timesfm25, dict) and timesfm25.get("status") == "benchmark_only",
        "timesfm25_track:benchmark_only",
        "TimesFM25 remains a migration benchmark, not a second production voter",
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
        *_model_track_checks(),
        *_ui_contract_checks(root),
        *_replay_checks(root),
    ]
    failed = [row for row in checks if row["status"] != "pass"]
    local_done = not failed
    return {
        "schema_version": SCHEMA_VERSION,
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
