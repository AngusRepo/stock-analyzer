from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

BACKTEST_RESEARCH_BUNDLE_SCHEMA_VERSION = "backtest-research-bundle-v1"

REQUIRED_BACKTEST_RESEARCH_STEPS = (
    "backtest",
    "monte_carlo_paper",
    "monte_carlo_backtest",
    "pbo_backtest",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _step_status(result: Any) -> str:
    if not isinstance(result, dict):
        return "error"
    raw = str(result.get("status") or "").strip().lower()
    if raw in {"error", "failed", "fail"}:
        return "error"
    return "success"


def _safe_result(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    return {"status": "error", "error": f"invalid_result_type:{type(result).__name__}"}


def build_backtest_research_bundle(
    *,
    run_id: str,
    steps: dict[str, Any],
    params: dict[str, Any] | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Build one callback/readback payload for backtest + MC + PBO.

    This is an artifact contract only; it does not lower MC simulations, PBO
    partitions, backtest universe, or validation scope.
    """

    normalized_steps = {
        step: {
            "status": _step_status(steps.get(step)),
            "result": _safe_result(steps.get(step)),
        }
        for step in REQUIRED_BACKTEST_RESEARCH_STEPS
    }
    failures = [
        step
        for step, payload in normalized_steps.items()
        if payload["status"] != "success"
    ]
    return {
        "schema_version": BACKTEST_RESEARCH_BUNDLE_SCHEMA_VERSION,
        "run_id": str(run_id),
        "generated_at": generated_at or _utc_now(),
        "status": "error" if failures else "success",
        "required_steps": list(REQUIRED_BACKTEST_RESEARCH_STEPS),
        "failed_steps": failures,
        "params": dict(params or {}),
        "steps": normalized_steps,
        "quality_contract": {
            "backtest_universe_reduced": False,
            "monte_carlo_simulations_reduced": False,
            "pbo_partitions_reduced": False,
            "production_config_mutated": False,
        },
    }


def validate_backtest_research_bundle(bundle: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if bundle.get("schema_version") != BACKTEST_RESEARCH_BUNDLE_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not bundle.get("run_id"):
        errors.append("run_id_missing")
    steps = bundle.get("steps")
    if not isinstance(steps, dict):
        errors.append("steps_missing")
        steps = {}
    for step in REQUIRED_BACKTEST_RESEARCH_STEPS:
        payload = steps.get(step)
        if not isinstance(payload, dict):
            errors.append(f"{step}_missing")
            continue
        if payload.get("status") not in {"success", "error"}:
            errors.append(f"{step}_status_invalid")
        if not isinstance(payload.get("result"), dict):
            errors.append(f"{step}_result_missing")
    quality = bundle.get("quality_contract")
    if not isinstance(quality, dict):
        errors.append("quality_contract_missing")
    else:
        for key in (
            "backtest_universe_reduced",
            "monte_carlo_simulations_reduced",
            "pbo_partitions_reduced",
            "production_config_mutated",
        ):
            if quality.get(key) is not False:
                errors.append(f"{key}_must_be_false")
    return errors
