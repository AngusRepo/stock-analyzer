"""Read-only Score V2 news/theme handoff readiness diagnostics."""

from __future__ import annotations

import math
from typing import Any


SCHEMA_VERSION = "score-v2-news-theme-handoff-v1"

REQUIRED_REPO_CONTRACTS = (
    "worker_applies_news_theme_adjustment",
    "worker_persists_news_theme_score_components",
    "worker_seed_preserves_news_theme",
    "python_projection_preserves_news_theme",
)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _int(value: Any) -> int:
    number = _number(value)
    return int(number) if number is not None else 0


def _check(checks: list[dict[str, Any]], check_id: str, passed: bool, value: Any, expected: Any) -> None:
    checks.append({
        "id": check_id,
        "passed": bool(passed),
        "value": value,
        "expected": expected,
    })


def _check_value(report: dict[str, Any] | None, check_id: str) -> dict[str, Any] | None:
    if not isinstance(report, dict):
        return None
    for check in report.get("checks") or []:
        if isinstance(check, dict) and check.get("id") == check_id:
            return check
    return None


def _live_snapshot_from_readiness(report: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(report, dict):
        return {}

    news_inputs_check = _check_value(report, "news_theme_inputs") or {}
    news_inputs = news_inputs_check.get("value") if isinstance(news_inputs_check.get("value"), dict) else {}
    component_nonzero = report.get("component_nonzero") if isinstance(report.get("component_nonzero"), dict) else {}
    input_summary = report.get("input_summary") if isinstance(report.get("input_summary"), dict) else {}

    return {
        "latest_daily_date": report.get("latest_daily_date"),
        "latest_daily_rows": report.get("latest_daily_rows"),
        "latest_news_nonzero": component_nonzero.get("newsTheme"),
        "news_inputs": news_inputs,
        "buzz_evidence_rows": news_inputs.get("buzz_evidence_rows", input_summary.get("buzz_evidence_rows")),
        "source_schema": report.get("schema_version"),
        "source_decision": report.get("decision"),
    }


def _news_input_total(news_inputs: dict[str, Any]) -> int:
    return sum(_int(value) for value in news_inputs.values())


def build_score_v2_news_theme_handoff_report(
    *,
    repo_contracts: dict[str, Any],
    contribution_readiness_report: dict[str, Any] | None = None,
    live_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Evaluate whether newsTheme is only waiting for production handoff.

    This deliberately does not query or mutate production. Callers provide repo
    contract scan results and an optional live read-only readiness snapshot.
    """

    checks: list[dict[str, Any]] = []
    root_causes: list[str] = []
    snapshot = {
        **_live_snapshot_from_readiness(contribution_readiness_report),
        **dict(live_snapshot or {}),
    }

    contract_failures: list[str] = []
    for contract in REQUIRED_REPO_CONTRACTS:
        passed = bool(repo_contracts.get(contract))
        _check(checks, contract, passed, passed, True)
        if not passed:
            contract_failures.append(contract)

    latest_daily_date = snapshot.get("latest_daily_date")
    latest_daily_rows = _int(snapshot.get("latest_daily_rows"))
    latest_news_nonzero = _int(snapshot.get("latest_news_nonzero"))
    news_inputs = snapshot.get("news_inputs") if isinstance(snapshot.get("news_inputs"), dict) else {}
    buzz_evidence_rows = _int(snapshot.get("buzz_evidence_rows"))
    news_input_total = _news_input_total(news_inputs)
    news_inputs_available = news_input_total > 0

    _check(
        checks,
        "live_news_theme_inputs",
        news_inputs_available,
        news_inputs,
        "> 0 news/theme input rows",
    )
    _check(
        checks,
        "live_buzz_evidence_rows",
        buzz_evidence_rows > 0,
        buzz_evidence_rows,
        "> 0 screener funnel buzz_evidence rows",
    )
    _check(
        checks,
        "latest_daily_rows",
        latest_daily_rows > 0,
        {"date": latest_daily_date, "rows": latest_daily_rows},
        "> 0 latest daily recommendation rows",
    )
    _check(
        checks,
        "latest_daily_news_theme_nonzero",
        latest_daily_rows > 0 and latest_news_nonzero > 0,
        {"date": latest_daily_date, "rows": latest_daily_rows, "news_nonzero": latest_news_nonzero},
        "> 0 latest daily recommendations with newsTheme > 0",
    )

    if contract_failures:
        root_causes.append("repo_news_theme_contract_missing")
        decision = "BLOCK"
        allowed_next_action = "repair_repo_contract"
    elif latest_daily_rows <= 0:
        root_causes.append("latest_daily_recommendations_missing")
        decision = "BLOCK"
        allowed_next_action = "restore_daily_recommendation_readback"
    elif not news_inputs_available:
        root_causes.append("news_theme_inputs_missing")
        decision = "BLOCK"
        allowed_next_action = "wait_for_news_theme_inputs"
    elif buzz_evidence_rows <= 0:
        root_causes.append("news_theme_adjustment_evidence_missing")
        decision = "BLOCK"
        allowed_next_action = "verify_screener_buzz_evidence_runtime"
    elif latest_news_nonzero <= 0:
        root_causes.extend(["production_handoff_not_live", "news_theme_live_zero"])
        decision = "WAITING_DEPLOY"
        allowed_next_action = "deploy_worker_and_rerun_screener_after_approval"
    else:
        decision = "PASS"
        allowed_next_action = "run_score_v2_rollout_gate"

    failed_checks = [check["id"] for check in checks if not check["passed"]]
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "read_only",
        "decision": decision,
        "passed": decision == "PASS",
        "failed_checks": failed_checks,
        "root_causes": list(dict.fromkeys(root_causes)),
        "checks": checks,
        "contract_failures": contract_failures,
        "live_snapshot": {
            "latest_daily_date": latest_daily_date,
            "latest_daily_rows": latest_daily_rows,
            "latest_news_nonzero": latest_news_nonzero,
            "news_input_total": news_input_total,
            "news_inputs": news_inputs,
            "buzz_evidence_rows": buzz_evidence_rows,
            "source_schema": snapshot.get("source_schema"),
            "source_decision": snapshot.get("source_decision"),
        },
        "allowed_next_action": allowed_next_action,
    }
