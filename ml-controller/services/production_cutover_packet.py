from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "stockvision-production-cutover-packet-v1"

DEFAULT_LOCAL_AUDIT_PATH = "ml-service/benchmark_results/local_prod_ready_audit_20260614.json"

REQUIRED_EVIDENCE_FILES = (
    DEFAULT_LOCAL_AUDIT_PATH,
    "ml-service/benchmark_results/adaptive_meta_policy_replay_20260605_20260611.json",
    "ml-service/benchmark_results/linucb_multiplier_replay_20260605_20260611.json",
)

APPROVAL_REQUIRED_ACTIONS = (
    {
        "id": "deploy_worker_and_frontend",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "Cloudflare Worker / frontend production deploy",
    },
    {
        "id": "sync_gcp_scheduler_manifest",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "GCP Scheduler production job create/update",
    },
    {
        "id": "write_or_promote_gcs_model_artifacts",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "GCS model artifact write or champion artifact promotion",
    },
    {
        "id": "update_model_pool_champion_pointers",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "production model_pool champion pointer update",
    },
    {
        "id": "remove_challenger_pointers_after_approved_cutover",
        "approval_gate": "wei_explicit_approval_required",
        "mutation_scope": "production challenger/shadow pointer cleanup",
    },
)

REMOTE_PREFLIGHT_CHECKS = (
    {
        "id": "scheduler_actual_matches_manifest",
        "check_type": "remote_read_only",
        "expected": "weekly-optuna, monthly-optuna, optuna-queue, adaptive-meta-policy-replay, linucb-multiplier-replay exist in GCP Scheduler",
    },
    {
        "id": "sequence_artifacts_are_neuralforecast_zip",
        "check_type": "remote_read_only",
        "expected": "PatchTST and iTransformer production artifact slots point to NeuralForecast-backed zip artifacts",
    },
    {
        "id": "timesfm_active_slot_uses_25_config",
        "check_type": "remote_read_only",
        "expected": "TimesFM production slot config references google/timesfm-2.5-200m-pytorch and max_context >= 1024",
    },
    {
        "id": "active9_model_pool_has_no_retired_champion",
        "check_type": "remote_read_only",
        "expected": "production model_pool champion set contains only the active-9 ML families",
    },
    {
        "id": "challenger_cleanup_scope_is_explicit",
        "check_type": "remote_read_only",
        "expected": "shadow/challenger rows are removed only after approved champion cutover evidence is captured",
    },
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _resolve(root: Path, rel_path: str) -> Path:
    path = Path(rel_path)
    return path if path.is_absolute() else root / path


def _evidence_inventory(root: Path) -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for rel_path in REQUIRED_EVIDENCE_FILES:
        path = _resolve(root, rel_path)
        inventory.append({
            "path": rel_path,
            "required": True,
            "exists": path.exists(),
        })
    return inventory


def _local_gate(audit: dict[str, Any], audit_path: str) -> dict[str, Any]:
    failed_checks = audit.get("failed_checks") or []
    passed = (
        audit.get("local_closure") == "done"
        and audit.get("local_prod_ready") == "done"
        and len(failed_checks) == 0
    )
    return {
        "audit_path": audit_path,
        "local_closure": audit.get("local_closure"),
        "local_prod_ready": audit.get("local_prod_ready"),
        "failed_check_count": len(failed_checks),
        "passed": passed,
    }


def build_production_cutover_packet(
    repo_root: Path | None = None,
    local_audit_path: str = DEFAULT_LOCAL_AUDIT_PATH,
) -> dict[str, Any]:
    root = repo_root or _repo_root()
    audit_file = _resolve(root, local_audit_path)
    audit_exists = audit_file.exists()
    audit = _read_json(audit_file) if audit_exists else {}

    local_gate = _local_gate(audit, local_audit_path)
    evidence = _evidence_inventory(root)
    evidence_ready = all(item["exists"] for item in evidence)
    audit_is_non_mutating = (
        audit.get("promotion_allowed") is False
        and audit.get("production_mutation_allowed") is False
    )
    ready_for_review = bool(
        audit_exists
        and local_gate["passed"]
        and evidence_ready
        and audit_is_non_mutating
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "cutover_ready_for_review": ready_for_review,
        "production_mutation_allowed": False,
        "actions_allowed_without_wei_approval": [],
        "local_gate": local_gate,
        "evidence_inventory": evidence,
        "approval_required_actions": list(APPROVAL_REQUIRED_ACTIONS),
        "remote_preflight_checks": list(REMOTE_PREFLIGHT_CHECKS),
        "blocked_reason": None if ready_for_review else {
            "audit_exists": audit_exists,
            "local_gate_passed": local_gate["passed"],
            "evidence_ready": evidence_ready,
            "audit_is_non_mutating": audit_is_non_mutating,
        },
    }
