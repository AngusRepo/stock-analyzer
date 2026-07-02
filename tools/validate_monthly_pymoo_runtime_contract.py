from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "output" / "feature_universe_triage" / "monthly_pymoo_runtime_contract_validation_20260618.json"

VALIDATION_INPUTS = (
    "infra/gcp-scheduler-jobs.json",
    "worker/src/lib/adminTriggerGcpTasks.ts",
    "worker/src/routes/adminTriggerRoutes.ts",
    "worker/src/lib/schedulerPolicy.ts",
    "worker/src/lib/schedulerStatus.ts",
    "worker/src/lib/schedulerRunLogger.ts",
    "worker/src/routes/scheduleReadRoutes.ts",
    "worker/src/lib/schedulerDependencyMap.ts",
    "ml-controller/main.py",
    "ml-controller/routers/strategy_mining.py",
    "ml-controller/services/modal_client.py",
    "ml-service/modal_app.py",
    "worker/migration_strategy_mining_ledger_2026_06_18.sql",
    "tools/finlab_alpha_miner_bakeoff.py",
    "data/feature_registry/alpha_mining_promotion_contract_v1.json",
    "output/feature_universe_triage/feature_registry_local_closure_20260617.json",
)


def _read(path: str) -> str:
    return ROOT.joinpath(path).read_text(encoding="utf-8", errors="ignore")


def _load_json(path: str) -> dict[str, Any]:
    return json.loads(ROOT.joinpath(path).read_text(encoding="utf-8-sig"))


def _check(condition: bool, reason: str, errors: list[str]) -> None:
    if not condition:
        errors.append(reason)


def _source_fingerprint(paths: tuple[str, ...]) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for rel_path in paths:
        path = ROOT / rel_path
        data = path.read_bytes()
        entries.append({
            "path": rel_path,
            "sha256": hashlib.sha256(data).hexdigest(),
            "size_bytes": len(data),
        })
    canonical = json.dumps(entries, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "algorithm": "sha256",
        "digest": hashlib.sha256(canonical).hexdigest(),
        "inputs": entries,
    }


def build_validation_payload() -> dict[str, Any]:
    errors: list[str] = []
    manifest = _load_json("infra/gcp-scheduler-jobs.json")
    jobs = manifest.get("jobs") or []
    monthly = next((job for job in jobs if job.get("id") == "monthly-strategy-mining"), None)
    _check(monthly is not None, "missing_monthly_strategy_mining_scheduler_job", errors)
    if monthly:
        _check(monthly.get("task") == "monthly-strategy-mining", "monthly_strategy_mining_task_mismatch", errors)
        _check(str(monthly.get("schedule") or "").startswith("first saturday"), "monthly_strategy_mining_not_first_saturday_groc", errors)
        _check(monthly.get("timeZone") == "Asia/Taipei", "monthly_strategy_mining_timezone_not_taipei", errors)
        _check(monthly.get("query") == "sync=1&persist=1", "monthly_strategy_mining_query_not_sync_persist", errors)

    file_checks = {
        "worker/src/lib/adminTriggerGcpTasks.ts": [
            "monthly-strategy-mining",
            "runMonthlyStrategyMining",
        ],
        "worker/src/routes/adminTriggerRoutes.ts": [
            "monthly-strategy-mining",
            "requires sync=1",
        ],
        "worker/src/lib/schedulerPolicy.ts": [
            "monthly-strategy-mining",
            "monthly pymoo NSGA-III",
        ],
        "worker/src/lib/schedulerStatus.ts": [
            "monthly-strategy-mining",
            "Monthly Strategy Mining",
        ],
        "worker/src/lib/schedulerRunLogger.ts": [
            "monthly-strategy-mining",
            "Monthly Strategy Mining",
        ],
        "worker/src/routes/scheduleReadRoutes.ts": [
            "monthly-strategy-mining",
            "promotion ledger evidence",
        ],
        "worker/src/lib/schedulerDependencyMap.ts": [
            "monthly-strategy-mining",
            "strategy_mining_runs",
            "strategy_promotion_ledger",
        ],
        "ml-controller/main.py": [
            "strategy_mining",
            "app.include_router(strategy_mining.router",
        ],
        "ml-controller/routers/strategy_mining.py": [
            "@router.post(\"/monthly_pymoo/run\")",
            "STRATEGY_MINING_EXECUTION_ENABLED",
            "STRATEGY_MINING_BACKEND",
            "modal_client.strategy_mining_research",
            "production_mutation_allowed",
            "strategy_mining_runs",
            "strategy_promotion_ledger",
        ],
        "ml-controller/services/modal_client.py": [
            "async def strategy_mining_research",
            "_lookup(\"strategy_mining_research\")",
            "\"backend\": \"modal\"",
        ],
        "ml-service/modal_app.py": [
            "def strategy_mining_research",
            "strategy_mining_job_main",
            "STRATEGY_MINING_RUN_DATE",
        ],
        "worker/migration_strategy_mining_ledger_2026_06_18.sql": [
            "CREATE TABLE IF NOT EXISTS strategy_mining_runs",
            "CREATE TABLE IF NOT EXISTS strategy_mining_candidates",
            "CREATE TABLE IF NOT EXISTS strategy_backtest_results",
            "CREATE TABLE IF NOT EXISTS active_strategy_backtest_results",
            "CREATE TABLE IF NOT EXISTS strategy_similarity_matrix",
            "CREATE TABLE IF NOT EXISTS strategy_promotion_ledger",
            "real_trading_effect TEXT NOT NULL DEFAULT 'none'",
        ],
        "tools/finlab_alpha_miner_bakeoff.py": [
            '"algorithm": "pymoo"',
            '"factor_universe": "unified_registry_v1"',
            '"random_trials": 0',
            '"optuna_trials": 0',
            '"deap_population": 0',
            'parser.add_argument("--algorithm", choices=["all", "random", "optuna", "deap", "pymoo"], default="pymoo")',
            'parser.add_argument("--random-trials", type=int, default=0)',
            'parser.add_argument("--optuna-trials", type=int, default=0)',
            'parser.add_argument("--deap-population", type=int, default=0)',
        ],
    }
    for path, needles in file_checks.items():
        text = _read(path)
        for needle in needles:
            _check(needle in text, f"missing:{path}:{needle}", errors)

    promotion = _load_json("data/feature_registry/alpha_mining_promotion_contract_v1.json")
    closure = _load_json("output/feature_universe_triage/feature_registry_local_closure_20260617.json")
    monthly_policy = promotion.get("monthly_search_policy") or {}
    feature_pool = promotion.get("feature_pool_policy") or {}
    closure_counts = closure.get("counts") or {}
    feature_view_counts = closure_counts.get("feature_view_counts") or {}
    expected_alpha_pool = int(
        feature_view_counts.get("alpha_mining_view")
        or closure_counts.get("formal_alpha_mining_features")
        or 0
    )
    actual_alpha_pool = int(feature_pool.get("eligible_for_alpha_mining") or 0)
    _check(promotion.get("decision_effect") == "governance_contract_only", "promotion_contract_has_runtime_effect", errors)
    _check(monthly_policy.get("cadence") == "monthly", "promotion_cadence_not_monthly", errors)
    _check(monthly_policy.get("requires_finlab_backtest") is True, "promotion_finlab_backtest_not_required", errors)
    _check(monthly_policy.get("algorithm") == "pymoo", "promotion_algorithm_not_pymoo", errors)
    _check(actual_alpha_pool > 0, "alpha_mining_feature_pool_empty", errors)
    _check(
        expected_alpha_pool <= 0 or actual_alpha_pool == expected_alpha_pool,
        f"alpha_mining_feature_pool_mismatch:{actual_alpha_pool}!={expected_alpha_pool}",
        errors,
    )

    return {
        "schema_version": "stockvision-monthly-pymoo-runtime-contract-v1",
        "status": "pass" if not errors else "fail",
        "errors": errors,
        "validated_cases": [
            "monthly_strategy_mining_scheduler",
            "worker_controller_route_surface",
            "modal_strategy_mining_compute_owner",
            "strategy_mining_ledger_schema",
            "alpha_miner_cli_defaults_pymoo_only",
            "promotion_contract_monthly_pymoo",
            "feature_pool_matches_local_closure",
        ],
        "scheduler_job": monthly,
        "monthly_search_policy": {
            "cadence": monthly_policy.get("cadence"),
            "algorithm": monthly_policy.get("algorithm"),
            "requires_finlab_backtest": monthly_policy.get("requires_finlab_backtest"),
        },
        "feature_pool": {
            "eligible_for_alpha_mining": actual_alpha_pool,
            "expected_from_local_closure": expected_alpha_pool,
        },
        "source_fingerprint": _source_fingerprint(VALIDATION_INPUTS),
        "decision_effect": "local_validation_only",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate the monthly pymoo runtime contract.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--no-write", action="store_true", help="Print JSON only; do not write the evidence artifact.")
    args = parser.parse_args(argv)

    result = build_validation_payload()
    if not args.no_write:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not result.get("errors") else 1


if __name__ == "__main__":
    raise SystemExit(main())
