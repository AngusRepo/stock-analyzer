"""Cloud Run Job entrypoint for scheduled sweeps and targeted Optuna research.

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

from routers.optuna import (
    OptunaResearchSweepReq,
    PerRegimeReq,
    execute_research_sweep,
    run_per_regime,
)
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
        run_date=os.environ.get("OPTUNA_RUN_DATE") or None,
        push_kv=_env_bool("OPTUNA_PUSH_KV", True),
        dry_run=_env_bool("OPTUNA_DRY_RUN", False),
    )


def _build_per_regime_request() -> PerRegimeReq:
    return PerRegimeReq(
        target=os.environ.get("OPTUNA_PER_REGIME_TARGET", "sltp"),
        n_trials=_env_int("OPTUNA_N_TRIALS", 50),
        subset_size=_env_int("OPTUNA_SUBSET_SIZE", 400),
        window_days=_env_int("OPTUNA_WINDOW_DAYS", 365),
        cadence=os.environ.get("OPTUNA_CADENCE", "queue"),
        research_data_source=os.environ.get("OPTUNA_RESEARCH_DATA_SOURCE", "snapshot"),
        push_kv=_env_bool("OPTUNA_PUSH_KV", False),
        dry_run=_env_bool("OPTUNA_DRY_RUN", True),
        trigger_source=os.environ.get("OPTUNA_TRIGGER_SOURCE") or None,
        trigger_id=os.environ.get("OPTUNA_QUEUE_ENTRY_ID") or None,
        run_date=os.environ.get("OPTUNA_RUN_DATE") or None,
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


def _build_parameter_validation_metadata(
    result: dict[str, Any] | None,
    *,
    mode: str,
    run_id: str,
) -> dict[str, Any]:
    results = result.get("results") if isinstance(result, dict) and isinstance(result.get("results"), list) else []
    return {
        "source": "parameter_candidate_validation",
        "executor": "cloud_run_job",
        "mode": mode,
        "run_id": run_id,
        "status": result.get("status") if isinstance(result, dict) else None,
        "cadence": result.get("cadence") if isinstance(result, dict) else None,
        "run_date": result.get("end_date") if isinstance(result, dict) else None,
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
    mode = os.environ.get("OPTUNA_JOB_MODE", "research_sweep").strip().lower()
    if mode not in {"research_sweep", "per_regime", "parameter_validation"}:
        raise RuntimeError(f"unsupported OPTUNA_JOB_MODE={mode}")

    run_date = os.environ.get("OPTUNA_RUN_DATE", "") or ""
    queue_entry_id = os.environ.get("OPTUNA_QUEUE_ENTRY_ID", "") or ""
    trigger_source = os.environ.get("OPTUNA_TRIGGER_SOURCE", "") or ""
    if mode == "per_regime":
        req: Any = _build_per_regime_request()
        cadence = str(req.cadence or "queue")
        task = "optuna-per-regime"
        log_parallel = 1
    elif mode == "parameter_validation":
        req = _build_parameter_validation_request()
        cadence = str(req.cadence or "weekly")
        task = "parameter-candidate-validation"
        log_parallel = 1
    else:
        req = _build_request()
        cadence = req.cadence
        task = f"{cadence}-optuna"
        log_parallel = req.max_parallel_sources
    run_id = os.environ.get(
        "CLOUD_RUN_EXECUTION",
        f"optuna-{cadence}-{int(time.time())}-{uuid.uuid4().hex[:8]}",
    )
    if mode == "parameter_validation":
        run_id = req.run_id or run_id
        run_date = req.run_date or run_date

    logger.info(
        "[OptunaJob] start mode=%s task=%s run_id=%s trials=%s subset=%s parallel=%s",
        mode,
        task,
        run_id,
        getattr(req, "n_trials", None),
        getattr(req, "subset_size", None),
        log_parallel,
    )

    t0 = time.time()
    status = "error"
    summary = ""
    error: str | None = None
    result: dict[str, Any] | None = None

    try:
        if mode == "per_regime":
            result = await asyncio.to_thread(run_per_regime, req)
            if isinstance(result, dict) and result.get("status") in {"completed", "ok"}:
                status = "success"
            else:
                error = str(result)
            push = result.get("push") if isinstance(result, dict) else None
            summary = (
                f"per_regime:{getattr(req, 'target', 'unknown')}:{status} "
                f"push_target={push.get('target') if isinstance(push, dict) else 'not_pushed'}"
            )[:1200]
        elif mode == "parameter_validation":
            from routers.config_pool import parameter_candidates_validation_chain

            result = await parameter_candidates_validation_chain(req)
            if isinstance(result, dict) and result.get("status") == "NO_CANDIDATE":
                status = "skipped"
            elif isinstance(result, dict) and result.get("status") == "completed":
                status = "success"
            else:
                error = str(result)
            summary = (
                f"candidate_validation status={result.get('status', 'completed')} "
                f"total={result.get('total', 0)} ready={result.get('ready', 0)} "
                f"blocked={result.get('blocked', 0)} validation_run_id={result.get('validation_run_id') or run_id}"
            )[:1200]
        else:
            result = await asyncio.to_thread(execute_research_sweep, req)
            failures = result.get("failures") if isinstance(result, dict) else None
            if isinstance(result, dict) and result.get("status") == "completed" and not failures:
                status = "success"
            else:
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
    if mode == "per_regime":
        push = result.get("push") if isinstance(result, dict) and isinstance(result.get("push"), dict) else {}
        payload.update({
            "queue_entry_id": queue_entry_id or None,
            "trigger_source": trigger_source or None,
            "sandbox_id": push.get("sandbox_id"),
            "result": {
                "source": result.get("source") if isinstance(result, dict) else None,
                "robust_sharpe": result.get("robust_sharpe") if isinstance(result, dict) else None,
                "contract": result.get("contract") if isinstance(result, dict) else None,
                "push": push or None,
            },
        })
    elif mode == "parameter_validation":
        payload["metadata"] = _build_parameter_validation_metadata(
            result,
            mode=mode,
            run_id=run_id,
        )
    else:
        staging = result.get("staging") if isinstance(result, dict) and isinstance(result.get("staging"), dict) else {}
        composite = staging.get("composite") if isinstance(staging.get("composite"), dict) else {}
        candidate_record = (
            composite.get("candidate_record")
            if isinstance(composite.get("candidate_record"), dict)
            else {}
        )
        candidate_ids = [candidate_record.get("candidate_id")] if candidate_record.get("candidate_id") else []
        ga_learning_state = staging.get("ga_learning_state") if isinstance(staging.get("ga_learning_state"), dict) else {}
        payload["metadata"] = {
            "source": "optuna_research_sweep",
            "executor": "cloud_run_job",
            "mode": mode,
            "cadence": cadence,
            "candidate_ids": candidate_ids,
            "push_results": [item for item in (composite, ga_learning_state) if item],
            "snapshot": staging,
        }
        payload.update({
            "sandbox_id": composite.get("sandbox_id"),
            "candidate_id": candidate_record.get("candidate_id"),
            "staging_status": staging.get("status"),
            "result": {
                "staging": staging,
                "incomplete": result.get("incomplete") if isinstance(result, dict) else None,
            },
        })

    await _callback_worker(payload)
    logger.info("[OptunaJob] finished task=%s status=%s", task, status)
    return 0 if status in {"success", "skipped"} else 1


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
