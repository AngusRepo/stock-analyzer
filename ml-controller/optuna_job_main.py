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
from routers.pipeline import CallbackWorkerError, _callback_worker

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
        # Scheduled research sources share the same Learning D1 authority.
        # Serial is the safe default; operators may explicitly raise it after
        # confirming database headroom for a controlled research run.
        max_parallel_sources=_env_int("OPTUNA_MAX_PARALLEL_SOURCES", 1),
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

async def _run_weekly_backtest_bundle(run_date: str) -> dict[str, Any]:
    """Run canonical backtest/MC/PBO to completion and separate job health from risk gates."""
    from services.monte_carlo_service import run_monte_carlo_mdd
    from services.pbo_service import run_pbo_analysis
    from services.weekly_evidence_service import run_canonical_weekly_backtest, taiwan_today

    resolved_date = run_date or taiwan_today()
    backtest = await asyncio.to_thread(run_canonical_weekly_backtest, run_date=resolved_date)
    if not isinstance(backtest, dict) or backtest.get("status") != "success":
        return {
            "status": "error",
            "run_date": resolved_date,
            "failures": [f"backtest:{(backtest or {}).get('error', 'unexpected_result')}"],
            "backtest": backtest,
        }

    monte_carlo: dict[str, Any] = {}
    operational_failures: list[str] = []
    validation_blockers: list[str] = []
    simulations = _env_int("WEEKLY_BACKTEST_MONTE_CARLO_N", 1000)
    for source in ("paper", "backtest"):
        result = await run_monte_carlo_mdd(
            n_simulations=simulations,
            source=source,
            method="block_bootstrap",
            expected_run_date=resolved_date,
            persist=True,
            evidence_scope="canonical_current",
        )
        monte_carlo[source] = result
        result_status = str(result.get("status") or "").lower() if isinstance(result, dict) else "invalid"
        if result_status != "success":
            operational_failures.append(
                f"monte_carlo:{source}:{result.get('error', result_status) if isinstance(result, dict) else result_status}"
            )
            continue
        verdict = str(result.get("go_live_verdict") or "UNKNOWN").upper()
        tail_risk = str(result.get("tail_risk_status") or "UNKNOWN").upper()
        if verdict != "PASS":
            validation_blockers.append(f"monte_carlo:{source}:verdict={verdict}")
        if tail_risk != "FULL_SAMPLE_TAIL_RISK":
            validation_blockers.append(f"monte_carlo:{source}:tail_risk={tail_risk}")

    pbo = await run_pbo_analysis(
        n_partitions=_env_int("WEEKLY_BACKTEST_PBO_PARTITIONS", 10),
        source=os.environ.get("WEEKLY_BACKTEST_PBO_SOURCE", "backtest"),
        expected_run_date=resolved_date,
        persist=True,
        evidence_scope="canonical_current",
    )
    pbo_status = str(pbo.get("status") or "").lower() if isinstance(pbo, dict) else "invalid"
    if pbo_status == "insufficient_evidence":
        validation_blockers.append(
            "pbo:insufficient_evidence:"
            f"observed={pbo.get('observed_trades', 'unknown')}:"
            f"required={pbo.get('required_trades', 'unknown')}"
        )
    elif pbo_status != "success":
        operational_failures.append(
            f"pbo:{pbo.get('error', pbo_status) if isinstance(pbo, dict) else pbo_status}"
        )
    elif str(pbo.get("go_live_verdict") or "UNKNOWN").upper() != "PASS":
        validation_blockers.append(
            f"pbo:verdict={str(pbo.get('go_live_verdict') or 'UNKNOWN').upper()}"
        )

    if operational_failures:
        return {
            "status": "error",
            "run_date": resolved_date,
            "validation_status": "not_evaluated",
            "failures": operational_failures,
            "blockers": validation_blockers,
            "backtest": backtest,
            "monte_carlo": monte_carlo,
            "pbo": pbo,
        }

    validation_status = "blocked" if validation_blockers else "passed"
    return {
        "status": "completed",
        "run_date": resolved_date,
        "validation_status": validation_status,
        "promotion_gate_eligible": not validation_blockers,
        "failures": [],
        "blockers": validation_blockers,
        "summary": (
            f"weekly_backtest completed validation={validation_status} "
            f"trades={backtest.get('total_trades', 0)} "
            f"blockers={','.join(validation_blockers) if validation_blockers else 'none'}"
        )[:1200],
        "backtest": backtest,
        "monte_carlo": monte_carlo,
        "pbo": pbo,
    }


async def _callback_with_bounded_retry(
    payload: dict[str, Any],
    *,
    max_attempts_env: str,
    label: str,
) -> None:
    max_attempts = max(1, min(5, _env_int(max_attempts_env, 3)))
    for attempt in range(1, max_attempts + 1):
        try:
            await _callback_worker(payload)
            return
        except CallbackWorkerError as exc:
            message = str(exc)
            if attempt >= max_attempts or not _callback_failure_is_retryable(message):
                raise
            delay_seconds = min(8, 2 ** (attempt - 1))
            logger.warning(
                "[OptunaJob] %s callback retry attempt=%s/%s delay_seconds=%s error=%s",
                label,
                attempt,
                max_attempts,
                delay_seconds,
                message,
            )
            await asyncio.sleep(delay_seconds)


def _callback_failure_is_retryable(message: str) -> bool:
    normalized = str(message or "").lower()
    transient_markers = (
        "http 408",
        "http 425",
        "http 429",
        "http 500",
        "http 502",
        "http 503",
        "http 504",
        "callback unreachable",
        "timeout",
        "timed out",
        "connection reset",
        "connection refused",
    )
    return any(marker in normalized for marker in transient_markers)


async def _callback_weekly_with_bounded_retry(payload: dict[str, Any]) -> None:
    await _callback_with_bounded_retry(
        payload,
        max_attempts_env="WEEKLY_BACKTEST_CALLBACK_MAX_ATTEMPTS",
        label="weekly",
    )


async def _callback_optuna_with_bounded_retry(payload: dict[str, Any]) -> None:
    await _callback_with_bounded_retry(
        payload,
        max_attempts_env="OPTUNA_CALLBACK_MAX_ATTEMPTS",
        label="optuna",
    )


_TRANSIENT_RESEARCH_SWEEP_MARKERS = (
    "429",
    "too many requests",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
    "internal server error",
    "temporarily unavailable",
    "d1 overload",
    "d1 query failed",
    "timeout",
    "timed out",
    "connection reset",
    "connection refused",
)


def _research_sweep_failures(result: dict[str, Any] | None) -> list[str]:
    failures = result.get("failures") if isinstance(result, dict) else None
    return [str(item) for item in failures] if isinstance(failures, list) else []


def _is_transient_research_sweep_failure(message: str) -> bool:
    normalized = str(message or "").lower()
    return any(marker in normalized for marker in _TRANSIENT_RESEARCH_SWEEP_MARKERS)


async def _execute_research_sweep_with_bounded_retry(
    req: OptunaResearchSweepReq,
) -> tuple[dict[str, Any], int]:
    max_attempts = max(1, min(5, _env_int("OPTUNA_SWEEP_MAX_ATTEMPTS", 3)))
    base_delay_seconds = max(0.0, min(10.0, _env_float("OPTUNA_SWEEP_RETRY_BASE_SECONDS", 2.0)))
    last_result: dict[str, Any] | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            result = await asyncio.to_thread(execute_research_sweep, req)
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            if attempt >= max_attempts or not _is_transient_research_sweep_failure(message):
                raise
            delay_seconds = min(10.0, base_delay_seconds * (2 ** (attempt - 1)))
            logger.warning(
                "[OptunaJob] research sweep transient exception attempt=%s/%s delay_seconds=%.1f error=%s",
                attempt,
                max_attempts,
                delay_seconds,
                message,
            )
            await asyncio.sleep(delay_seconds)
            continue

        last_result = result
        failures = _research_sweep_failures(result)
        if result.get("status") == "completed" and not failures:
            result["attempt_count"] = attempt
            return result, attempt
        if not failures or not any(_is_transient_research_sweep_failure(item) for item in failures):
            result["attempt_count"] = attempt
            return result, attempt
        if attempt >= max_attempts:
            result["attempt_count"] = attempt
            return result, attempt
        delay_seconds = min(10.0, base_delay_seconds * (2 ** (attempt - 1)))
        logger.warning(
            "[OptunaJob] research sweep transient source failure attempt=%s/%s delay_seconds=%.1f failures=%s",
            attempt,
            max_attempts,
            delay_seconds,
            failures,
        )
        await asyncio.sleep(delay_seconds)

    if last_result is None:
        raise RuntimeError("research_sweep_retry_exhausted_without_result")
    return last_result, max_attempts


async def _run() -> int:
    mode = os.environ.get("OPTUNA_JOB_MODE", "research_sweep").strip().lower()
    if mode not in {"research_sweep", "per_regime", "parameter_validation", "weekly_backtest"}:
        raise RuntimeError(f"unsupported OPTUNA_JOB_MODE={mode}")

    run_date = os.environ.get("OPTUNA_RUN_DATE", "") or ""
    queue_entry_id = os.environ.get("OPTUNA_QUEUE_ENTRY_ID", "") or ""
    trigger_source = os.environ.get("OPTUNA_TRIGGER_SOURCE", "") or ""
    if mode == "weekly_backtest":
        req: Any = None
        cadence = "weekly"
        task = os.environ.get("OPTUNA_CALLBACK_TASK", "weekly-backtest") or "weekly-backtest"
        log_parallel = 1
    elif mode == "per_regime":
        req = _build_per_regime_request()
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
    execution_run_id = os.environ.get(
        "CLOUD_RUN_EXECUTION",
        f"optuna-{cadence}-{int(time.time())}-{uuid.uuid4().hex[:8]}",
    )
    run_id = (
        (os.environ.get("OPTUNA_RUN_ID") or execution_run_id)
        if mode == "weekly_backtest"
        else execution_run_id
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
    research_sweep_attempts = 0

    try:
        if mode == "weekly_backtest":
            result = await _run_weekly_backtest_bundle(run_date)
            if isinstance(result, dict) and result.get("status") == "completed":
                status = "success"
            else:
                failures = result.get("failures") if isinstance(result, dict) else None
                error = "; ".join(str(item) for item in (failures or [])) or str(result)
            summary = _summarize_result(result if isinstance(result, dict) else {})
        elif mode == "per_regime":
            result = await asyncio.to_thread(run_per_regime, req)
            result_status = result.get("status") if isinstance(result, dict) else None
            if result_status in {"completed", "ok"}:
                status = "success"
            elif result_status == "skipped":
                status = "skipped"
            else:
                error = str(result)
            push = result.get("push") if isinstance(result, dict) else None
            summary = (
                f"per_regime:{getattr(req, 'target', 'unknown')}:{status} "
                f"reason={result.get('reason') if isinstance(result, dict) else None} "
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
            result, research_sweep_attempts = await _execute_research_sweep_with_bounded_retry(req)
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
    scheduler_ticket_id = os.environ.get("OPTUNA_SCHEDULER_TICKET_ID", "").strip()
    scheduler_run_id = os.environ.get("OPTUNA_SCHEDULER_RUN_ID", "").strip()
    if scheduler_ticket_id:
        payload["scheduler_ticket_id"] = scheduler_ticket_id
    if scheduler_run_id:
        payload["scheduler_run_id"] = scheduler_run_id
    if run_date:
        payload["run_date"] = run_date
    if error:
        payload["error"] = error[:1200]
    if mode == "weekly_backtest":
        pbo = result.get("pbo") if isinstance(result, dict) and isinstance(result.get("pbo"), dict) else {}
        payload["metadata"] = {
            "source": "weekly_backtest_research_bundle",
            "executor": "cloud_run_job",
            "mode": mode,
            "validation_status": result.get("validation_status") if isinstance(result, dict) else None,
            "promotion_gate_eligible": result.get("promotion_gate_eligible") if isinstance(result, dict) else False,
            "blockers": result.get("blockers") if isinstance(result, dict) else [],
            "observed_trades": pbo.get("observed_trades"),
            "required_trades": pbo.get("required_trades"),
        }
        payload["result"] = result
    elif mode == "per_regime":
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
        ga_candidate = staging.get("ga_candidate") if isinstance(staging.get("ga_candidate"), dict) else {}
        ga_push = ga_candidate.get("push") if isinstance(ga_candidate.get("push"), dict) else {}
        ga_closure = result.get("ga_closure") if isinstance(result.get("ga_closure"), dict) else {}
        payload["metadata"] = {
            "source": "optuna_research_sweep",
            "executor": "cloud_run_job",
            "mode": mode,
            "cadence": cadence,
            "candidate_ids": candidate_ids,
            "push_results": [item for item in (composite, ga_push) if item],
            "snapshot": staging,
            "ga_closure": ga_closure,
            "performance": result.get("performance") if isinstance(result, dict) else None,
            "attempt_count": research_sweep_attempts,
        }
        payload.update({
            "sandbox_id": composite.get("sandbox_id"),
            "candidate_id": candidate_record.get("candidate_id"),
            "ga_candidate_id": ga_closure.get("candidate_id"),
            "staging_status": staging.get("status"),
            "ga_closure_status": ga_closure.get("status"),
            "result": {
                "staging": staging,
                "ga_closure": ga_closure,
                "incomplete": result.get("incomplete") if isinstance(result, dict) else None,
            },
        })

    if mode == "weekly_backtest":
        await _callback_weekly_with_bounded_retry(payload)
    else:
        await _callback_optuna_with_bounded_retry(payload)
    logger.info("[OptunaJob] finished task=%s status=%s", task, status)
    return 0 if status in {"success", "skipped"} else 1


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
