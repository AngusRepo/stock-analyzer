from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = "stockvision-production-cutover-remote-preflight-v1"
LOCAL_CUTOVER_PACKET_PATH = "ml-service/benchmark_results/production_cutover_packet_20260618.json"

LEDGER_TABLES = {
    "strategy_mining_runs",
    "strategy_mining_candidates",
    "strategy_backtest_results",
    "active_strategy_backtest_results",
    "strategy_similarity_matrix",
    "strategy_promotion_ledger",
}
ALPHA_MINER_IDS = {
    "alpha_miner_pymoo_nsga3_novelty_0081",
    "alpha_miner_pymoo_nsga3_novelty_0187",
    "alpha_miner_pymoo_nsga3_novelty_0193",
}


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)


def _run(cmd: list[str], cwd: Path) -> dict[str, Any]:
    executable = shutil.which(cmd[0])
    if executable is None and os.name == "nt":
        for suffix in (".cmd", ".exe", ".bat"):
            executable = shutil.which(f"{cmd[0]}{suffix}")
            if executable:
                break
    if executable is None:
        return {
            "cmd": cmd,
            "returncode": 127,
            "stdout": "",
            "stderr": f"executable_not_found:{cmd[0]}",
        }
    proc = subprocess.run([executable, *cmd[1:]], cwd=str(cwd), capture_output=True, check=False)
    return {
        "cmd": cmd,
        "returncode": proc.returncode,
        "stdout": _strip_ansi((proc.stdout or b"").decode("utf-8", errors="replace")),
        "stderr": _strip_ansi((proc.stderr or b"").decode("utf-8", errors="replace")),
    }


def _parse_json_output(text: str) -> Any:
    cleaned = _strip_ansi(text).strip()
    for idx, ch in enumerate(cleaned):
        if ch not in "[{":
            continue
        candidate = cleaned[idx:].strip()
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError("json_payload_not_found")


def _wrangler_results(run: dict[str, Any]) -> list[dict[str, Any]]:
    if run["returncode"] != 0:
        return []
    try:
        payload = _parse_json_output(run["stdout"])
    except ValueError:
        return []
    if not isinstance(payload, list) or not payload:
        return []
    first = payload[0] if isinstance(payload[0], dict) else {}
    rows = first.get("results") if isinstance(first, dict) else []
    return rows if isinstance(rows, list) else []


def _manifest_jobs(root: Path) -> dict[str, dict[str, Any]]:
    manifest = json.loads((root / "infra" / "gcp-scheduler-jobs.json").read_text(encoding="utf-8-sig"))
    return {str(job.get("id")): job for job in manifest.get("jobs") or [] if isinstance(job, dict)}


def _scheduler_state(root: Path, location: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    run = _run(
        [
            "gcloud",
            "scheduler",
            "jobs",
            "list",
            "--location",
            location,
            "--format=json(name,schedule,timeZone,description,httpTarget.uri)",
        ],
        root,
    )
    if run["returncode"] != 0:
        return [], run
    try:
        payload = _parse_json_output(run["stdout"])
    except ValueError:
        return [], run
    jobs = payload if isinstance(payload, list) else []
    return [job for job in jobs if isinstance(job, dict)], run


def _job_id(job: dict[str, Any]) -> str:
    name = str(job.get("name") or "")
    return name.rsplit("/", 1)[-1] if name else ""


def _env_map(service: dict[str, Any]) -> dict[str, str]:
    containers = (((service.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or []
    if not containers:
        return {}
    env_rows = containers[0].get("env") or []
    out: dict[str, str] = {}
    for row in env_rows:
        if not isinstance(row, dict) or "name" not in row:
            continue
        out[str(row["name"])] = "secret" if "valueFrom" in row else str(row.get("value") or "")
    return out


def _cloud_run_state(root: Path, region: str) -> tuple[dict[str, Any], dict[str, Any]]:
    run = _run(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            "ml-controller",
            "--region",
            region,
            "--format=json(status.url,status.latestReadyRevisionName,spec.template.spec.containers[0].env)",
        ],
        root,
    )
    if run["returncode"] != 0:
        return {}, run
    try:
        payload = _parse_json_output(run["stdout"])
    except ValueError:
        return {}, run
    return payload if isinstance(payload, dict) else {}, run


def _d1_query(root: Path, sql: str) -> dict[str, Any]:
    return _run(
        [
            "npx",
            "wrangler@4",
            "d1",
            "execute",
            "stockvision-db",
            "--remote",
            "--command",
            sql,
        ],
        root / "worker",
    )


def _build_checks(root: Path, location: str, region: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    manifest = _manifest_jobs(root)
    scheduler_jobs, scheduler_run = _scheduler_state(root, location)
    scheduler_by_id = {_job_id(job): job for job in scheduler_jobs}

    service, cloud_run = _cloud_run_state(root, region)
    env = _env_map(service)

    ledger_sql = (
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
        "('strategy_mining_runs','strategy_mining_candidates','strategy_backtest_results',"
        "'active_strategy_backtest_results','strategy_similarity_matrix','strategy_promotion_ledger',"
        "'strategy_spec_registry') ORDER BY name;"
    )
    ledger_run = _d1_query(root, ledger_sql)
    table_rows = _wrangler_results(ledger_run)
    remote_tables = {str(row.get("name")) for row in table_rows if isinstance(row, dict) and row.get("name")}

    alpha_sql = (
        "SELECT strategy_id,status,updated_at FROM strategy_spec_registry "
        "WHERE strategy_id LIKE 'alpha_miner_pymoo_nsga3_novelty_%' ORDER BY strategy_id;"
    )
    alpha_run = _d1_query(root, alpha_sql)
    alpha_rows = _wrangler_results(alpha_run)
    alpha_ids = {str(row.get("strategy_id")) for row in alpha_rows if isinstance(row, dict) and row.get("strategy_id")}
    alpha_active_ids = {
        str(row.get("strategy_id"))
        for row in alpha_rows
        if isinstance(row, dict) and row.get("status") == "active" and row.get("strategy_id")
    }

    schema_run = _d1_query(root, "PRAGMA table_info(strategy_spec_registry);")
    schema_rows = _wrangler_results(schema_run)
    schema_cols = {str(row.get("name")) for row in schema_rows if isinstance(row, dict) and row.get("name")}

    expected_monthly = manifest.get("monthly-strategy-mining") or {}
    remote_monthly = scheduler_by_id.get("monthly-strategy-mining")
    expected_optuna = manifest.get("monthly-optuna") or {}
    remote_optuna = scheduler_by_id.get("monthly-optuna")
    missing_ledgers = sorted(LEDGER_TABLES - remote_tables)
    missing_alpha = sorted(ALPHA_MINER_IDS - alpha_ids)
    inactive_alpha = sorted(ALPHA_MINER_IDS - alpha_active_ids)
    strategy_backend = str(env.get("STRATEGY_MINING_BACKEND") or "modal").strip().lower() or "modal"
    strategy_env_present = (
        "STRATEGY_MINING_EXECUTION_ENABLED" in env
        and strategy_backend in {"modal", "modal_only"}
    )

    checks = [
        {
            "id": "gcp_scheduler_monthly_strategy_mining",
            "status": "present" if remote_monthly else "missing",
            "evidence": {
                "expected_schedule": expected_monthly.get("schedule"),
                "expected_timeZone": expected_monthly.get("timeZone"),
                "remote": remote_monthly,
            },
        },
        {
            "id": "gcp_scheduler_monthly_optuna_timezone",
            "status": (
                "present"
                if remote_optuna and remote_optuna.get("timeZone") == expected_optuna.get("timeZone")
                else "drift"
            ),
            "evidence": {
                "expected_schedule": expected_optuna.get("schedule"),
                "expected_timeZone": expected_optuna.get("timeZone"),
                "remote": remote_optuna,
            },
        },
        {
            "id": "ml_controller_strategy_mining_env",
            "status": "present" if strategy_env_present else "missing",
            "evidence": {
                "latestReadyRevisionName": (service.get("status") or {}).get("latestReadyRevisionName"),
                "url": (service.get("status") or {}).get("url"),
                "STRATEGY_MINING_EXECUTION_ENABLED": env.get("STRATEGY_MINING_EXECUTION_ENABLED"),
                "STRATEGY_MINING_BACKEND": env.get("STRATEGY_MINING_BACKEND") or "modal",
            },
        },
        {
            "id": "d1_strategy_mining_ledger_tables",
            "status": "present" if not missing_ledgers else "missing",
            "evidence": {
                "remote_tables": sorted(remote_tables),
                "missing_tables": missing_ledgers,
            },
        },
        {
            "id": "d1_alpha_miner_strategy_seed",
            "status": "present" if not missing_alpha and not inactive_alpha else "partial",
            "evidence": {
                "rows": alpha_rows,
                "missing_ids": missing_alpha,
                "inactive_ids": inactive_alpha,
            },
        },
        {
            "id": "d1_strategy_spec_registry_schema",
            "status": "present" if "family_id" in schema_cols else "drift",
            "evidence": {
                "columns": sorted(schema_cols),
                "family_id_present": "family_id" in schema_cols,
                "family_column_present": "family" in schema_cols,
            },
        },
    ]
    command_runs = {
        "scheduler": {k: scheduler_run[k] for k in ("cmd", "returncode", "stderr")},
        "cloud_run": {k: cloud_run[k] for k in ("cmd", "returncode", "stderr")},
        "d1_tables": {k: ledger_run[k] for k in ("cmd", "returncode", "stderr")},
        "d1_alpha": {k: alpha_run[k] for k in ("cmd", "returncode", "stderr")},
        "d1_schema": {k: schema_run[k] for k in ("cmd", "returncode", "stderr")},
    }
    return checks, command_runs


def _local_cutover_packet_summary(root: Path) -> dict[str, Any]:
    path = root / LOCAL_CUTOVER_PACKET_PATH
    if not path.exists():
        return {
            "path": LOCAL_CUTOVER_PACKET_PATH,
            "exists": False,
            "cutover_ready_for_review": False,
            "production_mutation_allowed": None,
            "blocked_reason": "local_cutover_packet_missing",
        }
    try:
        packet = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "path": LOCAL_CUTOVER_PACKET_PATH,
            "exists": True,
            "cutover_ready_for_review": False,
            "production_mutation_allowed": None,
            "blocked_reason": f"local_cutover_packet_invalid:{type(exc).__name__}",
        }
    return {
        "path": LOCAL_CUTOVER_PACKET_PATH,
        "exists": True,
        "cutover_ready_for_review": packet.get("cutover_ready_for_review") is True,
        "production_mutation_allowed": packet.get("production_mutation_allowed"),
        "blocked_reason": packet.get("blocked_reason"),
    }


def build_remote_preflight(root: Path, location: str, region: str) -> dict[str, Any]:
    checks, command_runs = _build_checks(root, location, region)
    incomplete = [row for row in checks if row["status"] not in {"present"}]
    local_packet = _local_cutover_packet_summary(root)
    already_present = [
        row["id"]
        for row in checks
        if row["status"] == "present"
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "decision_effect": "read_only_observation",
        "production_mutation_allowed": False,
        "location": location,
        "region": region,
        "checks": checks,
        "summary": {
            "local_cutover_packet_ready_for_review": local_packet["cutover_ready_for_review"],
            "local_cutover_packet_path": local_packet["path"],
            "local_cutover_packet_blocked_reason": local_packet["blocked_reason"],
            "remote_cutover_complete": not incomplete,
            "incomplete_remote_check_ids": [row["id"] for row in incomplete],
            "already_present_remote": already_present,
            "remaining_remote_actions_requiring_wei_approval": [
                "deploy_ml_controller_strategy_mining_route",
                "apply_strategy_mining_ledger_migration",
                "sync_gcp_scheduler_manifest",
                "set STRATEGY_MINING_BACKEND=modal and STRATEGY_MINING_EXECUTION_ENABLED=true after Wei approval",
                "feature_selection_retrain_release remains blocked until explicit retrain/release approval",
            ],
        },
        "command_runs": command_runs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build read-only StockVision production cutover remote preflight JSON.")
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--location", default="asia-east1")
    parser.add_argument("--region", default="asia-east1")
    parser.add_argument("--output")
    parser.add_argument("--fail-on-incomplete", action="store_true")
    args = parser.parse_args()

    packet = build_remote_preflight(Path(args.repo), args.location, args.region)
    text = json.dumps(packet, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text + "\n", encoding="utf-8")
    print(text)
    if args.fail_on_incomplete and not packet["summary"]["remote_cutover_complete"]:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
