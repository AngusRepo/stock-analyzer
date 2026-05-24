"""Cloud Run Job entrypoint for weekly/monthly Optuna research sweeps.

The controller service only triggers this Job. The Job owns the long-running
research lifecycle and posts the final scheduler callback to Worker.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

from routers.optuna import OptunaResearchSweepReq, PerRegimeReq, execute_research_sweep, run_per_regime
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


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_json_dict(name: str) -> dict[str, Any]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def _env_json_list(name: str) -> list[str]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(item) for item in parsed if str(item).strip()]
    except json.JSONDecodeError:
        pass
    return [item.strip() for item in raw.split(",") if item.strip()]


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


def _build_per_regime_request() -> PerRegimeReq:
    return PerRegimeReq(
        target=os.environ.get("OPTUNA_PER_REGIME_TARGET", "sltp"),
        n_trials=_env_int("OPTUNA_N_TRIALS", 50),
        subset_size=_env_int("OPTUNA_SUBSET_SIZE", 400),
        window_days=_env_int("OPTUNA_WINDOW_DAYS", 365),
        cadence=os.environ.get("OPTUNA_CADENCE") or "queue",
        run_date=os.environ.get("OPTUNA_RUN_DATE") or None,
        trigger_source=os.environ.get("OPTUNA_TRIGGER_SOURCE") or "queue",
        trigger_id=os.environ.get("OPTUNA_TRIGGER_ID") or None,
        research_data_source=os.environ.get("OPTUNA_RESEARCH_DATA_SOURCE", "snapshot"),
        push_kv=_env_bool("OPTUNA_PUSH_KV", True),
        dry_run=_env_bool("OPTUNA_DRY_RUN", False),
    )


def _build_parameter_validation_request():
    from routers.config_pool import ParameterCandidateValidationChainRequest

    return ParameterCandidateValidationChainRequest(
        candidate_ids=_env_json_list("PARAMETER_VALIDATION_CANDIDATE_IDS"),
        cadence=os.environ.get("PARAMETER_VALIDATION_CADENCE") or None,
        run_date=os.environ.get("PARAMETER_VALIDATION_RUN_DATE") or None,
        run_id=os.environ.get("PARAMETER_VALIDATION_RUN_ID") or os.environ.get("OPTUNA_RUN_ID") or None,
        source=os.environ.get("PARAMETER_VALIDATION_SOURCE") or "parameter_validation_job",
        metadata=_env_json_dict("PARAMETER_VALIDATION_METADATA"),
        start_date=os.environ.get("PARAMETER_VALIDATION_START_DATE") or None,
        end_date=os.environ.get("PARAMETER_VALIDATION_END_DATE") or None,
        lookback_days=_env_int("PARAMETER_VALIDATION_LOOKBACK_DAYS", 180),
        initial_capital=_env_float("PARAMETER_VALIDATION_INITIAL_CAPITAL", 1_000_000.0),
        mc_simulations=_env_int("PARAMETER_VALIDATION_MC_SIMULATIONS", 1000),
        limit=_env_int("PARAMETER_VALIDATION_LIMIT", 20),
        persist=_env_bool("PARAMETER_VALIDATION_PERSIST", True),
    )


def _summarize_result(result: dict[str, Any]) -> str:
    results = result.get("results") if isinstance(result, dict) else None
    if isinstance(results, list) and results:
        parts = [str(item.get("summary") or f"{item.get('source')}:{item.get('status')}") for item in results]
        return ", ".join(parts)[:1200]
    return str(result.get("summary") or result.get("status") or "completed")[:1200]


def _compact_push_result(item: dict[str, Any]) -> dict[str, Any]:
    push = item.get("push") if isinstance(item.get("push"), dict) else {}
    return {
        "source": item.get("source"),
        "status": item.get("status"),
        "target": push.get("target"),
        "success": push.get("success"),
        "sandbox_id": push.get("sandbox_id"),
        "candidate_id": push.get("candidate_id"),
        "candidate_status": push.get("candidate_status"),
        "audit_key": push.get("audit_key"),
        "updated_keys": push.get("updatedKeys"),
        "promotion": push.get("promotion"),
    }


def _extract_candidate_ids(result: dict[str, Any] | None) -> list[str]:
    if not isinstance(result, dict):
        return []
    ids: list[str] = []
    for item in result.get("results") or []:
        if not isinstance(item, dict):
            continue
        push = item.get("push") if isinstance(item.get("push"), dict) else {}
        candidate_id = push.get("candidate_id")
        if candidate_id:
            ids.append(str(candidate_id))
    return sorted(set(ids))


def _build_research_metadata(
    result: dict[str, Any] | None,
    *,
    job_kind: str,
    cadence: str,
    run_id: str,
    run_date: str,
) -> dict[str, Any]:
    results = result.get("results") if isinstance(result, dict) and isinstance(result.get("results"), list) else []
    push_results = [_compact_push_result(item) for item in results if isinstance(item, dict)]
    return {
        "source": "optuna_research_sweep",
        "executor": "cloud_run_job",
        "job_kind": job_kind,
        "cadence": cadence,
        "run_id": run_id,
        "run_date": run_date or None,
        "candidate_ids": _extract_candidate_ids(result),
        "push_results": push_results,
        "snapshot": {
            "status": result.get("status") if isinstance(result, dict) else None,
            "results_count": len(results),
            "failures_count": len(result.get("failures") or []) if isinstance(result, dict) else 0,
            "sources": [item.get("source") for item in results if isinstance(item, dict)],
        },
    }


def _build_parameter_validation_metadata(
    result: dict[str, Any] | None,
    *,
    job_kind: str,
    run_id: str,
) -> dict[str, Any]:
    results = result.get("results") if isinstance(result, dict) and isinstance(result.get("results"), list) else []
    return {
        "source": "parameter_candidate_validation",
        "executor": "cloud_run_job",
        "job_kind": job_kind,
        "run_id": run_id,
        "status": result.get("status") if isinstance(result, dict) else None,
        "total": result.get("total") if isinstance(result, dict) else None,
        "ready": result.get("ready") if isinstance(result, dict) else None,
        "blocked": result.get("blocked") if isinstance(result, dict) else None,
        "validation_run_id": result.get("validation_run_id") if isinstance(result, dict) else None,
        "candidate_ids": [item.get("candidate_id") for item in results if isinstance(item, dict)],
        "results": [
            {
                "candidate_id": item.get("candidate_id"),
                "source": item.get("source"),
                "status": item.get("status"),
                "decision": item.get("decision"),
                "promotion_packet_id": item.get("promotion_packet_id"),
                "failed_gates": item.get("failed_gates"),
                "pbo_method": item.get("pbo_method"),
            }
            for item in results
            if isinstance(item, dict)
        ],
    }


async def _run() -> int:
    job_kind = os.environ.get("OPTUNA_JOB_KIND", "research_sweep").strip() or "research_sweep"
    if job_kind == "per_regime":
        req = _build_per_regime_request()
        cadence = req.cadence or "queue"
        task = os.environ.get("OPTUNA_CALLBACK_TASK", "optuna-queue")
    elif job_kind == "parameter_validation":
        req = _build_parameter_validation_request()
        cadence = req.cadence or "weekly"
        task = "parameter-candidate-validation"
    else:
        req = _build_request()
        cadence = req.cadence
        task = f"{cadence}-optuna"
    run_id = (
        os.environ.get("OPTUNA_RUN_ID")
        or os.environ.get("CLOUD_RUN_EXECUTION")
        or f"optuna-{job_kind}-{cadence}-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    )
    run_date = os.environ.get("OPTUNA_RUN_DATE", "") or ""
    if job_kind == "parameter_validation":
        run_id = getattr(req, "run_id", None) or run_id
        run_date = getattr(req, "run_date", None) or run_date

    logger.info(
        "[OptunaJob] start kind=%s task=%s run_id=%s trials=%s subset=%s parallel=%s",
        job_kind,
        task,
        run_id,
        getattr(req, "n_trials", None),
        getattr(req, "subset_size", None),
        getattr(req, "max_parallel_sources", 1),
    )

    t0 = time.time()
    status = "error"
    summary = ""
    error: str | None = None
    result: dict[str, Any] | None = None

    try:
        if job_kind == "per_regime":
            result = await asyncio.to_thread(run_per_regime, req)
        elif job_kind == "parameter_validation":
            from routers.config_pool import parameter_candidates_validation_chain

            result = await parameter_candidates_validation_chain(req)
        else:
            result = await asyncio.to_thread(execute_research_sweep, req)
        failures = result.get("failures") if isinstance(result, dict) else None
        if job_kind == "parameter_validation" and isinstance(result, dict) and result.get("status") in {"NO_CANDIDATE"}:
            status = "skipped"
        elif isinstance(result, dict) and result.get("status") in {"completed", "NO_CANDIDATE"} and not failures:
            status = "success"
        else:
            status = "error"
            error = "; ".join(str(item) for item in (failures or [])) or str(result)
        if job_kind == "parameter_validation" and isinstance(result, dict):
            summary = (
                f"candidate_validation status={result.get('status', 'completed')} "
                f"total={result.get('total', 0)} ready={result.get('ready', 0)} "
                f"blocked={result.get('blocked', 0)} validation_run_id={result.get('validation_run_id') or run_id}"
            )[:1200]
        else:
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
    if job_kind == "per_regime" and isinstance(result, dict):
        payload["metadata"] = {
            "source": "per_regime_robust",
            "executor": "cloud_run_job",
            "trigger_source": getattr(req, "trigger_source", None),
            "trigger_id": getattr(req, "trigger_id", None),
            "robust_sharpe": result.get("robust_sharpe"),
            "weighted_sharpe": result.get("weighted_sharpe"),
            "weighted_max_dd": result.get("weighted_max_dd"),
            "best_trial": result.get("best_trial"),
            "kv_push_ok": result.get("kv_push_ok"),
            "n_trials_completed": result.get("n_trials_completed"),
            "n_pareto": result.get("n_pareto"),
            "regimes_with_data": result.get("regimes_with_data"),
            "warnings": result.get("warnings"),
            "window": result.get("window"),
        }
    elif job_kind == "research_sweep":
        payload["metadata"] = _build_research_metadata(
            result,
            job_kind=job_kind,
            cadence=str(cadence),
            run_id=run_id,
            run_date=run_date,
        )
    elif job_kind == "parameter_validation":
        payload["metadata"] = _build_parameter_validation_metadata(
            result,
            job_kind=job_kind,
            run_id=run_id,
        )
    if run_date:
        payload["run_date"] = run_date
    if error:
        payload["error"] = error[:1200]

    await _callback_worker(payload)
    logger.info("[OptunaJob] finished task=%s status=%s", task, status)
    return 0 if status in {"success", "skipped"} else 1


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
