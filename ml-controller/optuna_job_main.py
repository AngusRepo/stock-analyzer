"""Cloud Run Job entrypoint for weekly/monthly Optuna research sweeps.

The controller service only triggers this Job. The Job owns the long-running
research lifecycle and posts the final scheduler callback to Worker.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any

from routers.optuna import OptunaResearchSweepReq, execute_research_sweep
from routers.pipeline import _callback_worker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("optuna_job")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _build_request() -> OptunaResearchSweepReq:
    return OptunaResearchSweepReq(
        cadence=os.environ.get("OPTUNA_CADENCE", "weekly"),
        n_trials=_env_int("OPTUNA_N_TRIALS", 200),
        subset_size=_env_int("OPTUNA_SUBSET_SIZE", 1000),
        max_parallel_sources=_env_int("OPTUNA_MAX_PARALLEL_SOURCES", 3),
        ga_population_size=_env_int("OPTUNA_GA_POPULATION_SIZE", 24),
        ga_generations=_env_int("OPTUNA_GA_GENERATIONS", 8),
        research_data_source=os.environ.get("OPTUNA_RESEARCH_DATA_SOURCE", "snapshot"),
        push_kv=_env_bool("OPTUNA_PUSH_KV", True),
        dry_run=_env_bool("OPTUNA_DRY_RUN", False),
    )


def _summarize_result(result: dict[str, Any]) -> str:
    results = result.get("results") if isinstance(result, dict) else None
    if isinstance(results, list) and results:
        parts = [str(item.get("summary") or f"{item.get('source')}:{item.get('status')}") for item in results]
        return ", ".join(parts)[:1200]
    return str(result.get("summary") or result.get("status") or "completed")[:1200]


async def _run() -> int:
    req = _build_request()
    cadence = req.cadence
    task = f"{cadence}-optuna"
    run_id = os.environ.get(
        "CLOUD_RUN_EXECUTION",
        f"optuna-{cadence}-{int(time.time())}-{uuid.uuid4().hex[:8]}",
    )
    run_date = os.environ.get("OPTUNA_RUN_DATE", "") or ""

    logger.info(
        "[OptunaJob] start task=%s run_id=%s trials=%s subset=%s parallel=%s",
        task,
        run_id,
        req.n_trials,
        req.subset_size,
        req.max_parallel_sources,
    )

    t0 = time.time()
    status = "error"
    summary = ""
    error: str | None = None
    result: dict[str, Any] | None = None

    try:
        result = await asyncio.to_thread(execute_research_sweep, req)
        failures = result.get("failures") if isinstance(result, dict) else None
        if isinstance(result, dict) and result.get("status") == "completed" and not failures:
            status = "success"
        else:
            status = "error"
            error = "; ".join(str(item) for item in (failures or [])) or str(result)
        summary = _summarize_result(result if isinstance(result, dict) else {})
    except Exception as exc:  # noqa: BLE001
        logger.exception("[OptunaJob] failed")
        error = f"{type(exc).__name__}: {exc}"
        summary = error[:1200]

    payload: dict[str, Any] = {
        "task": task,
        "status": status,
        "summary": summary,
        "duration_ms": int((time.time() - t0) * 1000),
        "run_id": run_id,
    }
    if run_date:
        payload["run_date"] = run_date
    if error:
        payload["error"] = error[:1200]

    await _callback_worker(payload)
    logger.info("[OptunaJob] finished task=%s status=%s", task, status)
    return 0 if status == "success" else 1


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
