"""Cloud Run Job entrypoint for durable Active-8 OOF materialization."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("oof_materialize_job")


async def _callback_worker(payload: dict[str, Any]) -> None:
    from routers.pipeline import _callback_worker as callback

    await callback(payload)


def _truthy(value: str) -> bool:
    return value.strip().lower() not in {"0", "false", "no", "off"}


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"invalid integer {name}={raw}") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} outside [{minimum},{maximum}]: {value}")
    return value


async def _execute_lifecycle(
    *,
    cadence: str,
    end_date: str | None,
    promote: bool,
    dispatch_full_fit: bool,
    expected_cohort_id: str | None,
) -> dict[str, Any]:
    from routers.walk_forward import OofLifecycleRequest, run_walk_forward_oof_lifecycle
    from services.active8_prep_lifecycle import (
        Active8PrepDependencyPending,
        ensure_active8_daily_prep,
    )

    try:
        prep = await ensure_active8_daily_prep(end_date=end_date, dry_run=False)
    except Active8PrepDependencyPending as exc:
        return {
            "status": "pending",
            "reason": exc.reason,
            "dependency_retry_required": True,
            "prep_lifecycle": exc.evidence,
        }
    result = await run_walk_forward_oof_lifecycle(OofLifecycleRequest(
        cadence=cadence,
        end_date=end_date,
        dry_run=False,
        promote=promote,
        dispatch_full_fit=dispatch_full_fit,
        expected_cohort_id=expected_cohort_id,
    ))
    result["prep_lifecycle"] = prep
    return result


async def _execute_allocator_snapshot(
    *,
    start_date: str,
    end_date: str,
    lineage_cohort_id: str,
) -> dict[str, Any]:
    from services.allocator_ev_feature_snapshot_backfill import (
        backfill_allocator_ev_feature_snapshots,
    )

    return await asyncio.to_thread(
        backfill_allocator_ev_feature_snapshots,
        start_date=start_date,
        end_date=end_date,
        next_session_date=os.environ.get("OOF_MATERIALIZE_NEXT_SESSION_DATE", "").strip() or None,
        dry_run=False,
        candidate_limit=_bounded_int("OOF_MATERIALIZE_CANDIDATE_LIMIT", 1000, 1, 5000),
        l4_lookback_days=_bounded_int("OOF_MATERIALIZE_L4_LOOKBACK_DAYS", 90, 30, 365),
        l4_min_samples=_bounded_int("OOF_MATERIALIZE_L4_MIN_SAMPLES", 500, 50, 10000),
        l4_min_dates=_bounded_int("OOF_MATERIALIZE_L4_MIN_DATES", 20, 5, 252),
        l4_training_limit=_bounded_int("OOF_MATERIALIZE_L4_TRAINING_LIMIT", 6000, 500, 20000),
        s12_lookback_days=_bounded_int("OOF_MATERIALIZE_S12_LOOKBACK_DAYS", 120, 30, 365),
        s12_limit=_bounded_int("OOF_MATERIALIZE_S12_LIMIT", 5000, 500, 20000),
        s12_min_samples=_bounded_int("OOF_MATERIALIZE_S12_MIN_SAMPLES", 30, 5, 1000),
        s12_min_sample_dates=_bounded_int("OOF_MATERIALIZE_S12_MIN_SAMPLE_DATES", 8, 2, 252),
        lineage_cohort_id=lineage_cohort_id,
    )


def _summary(run_id: str, result: dict[str, Any], *, mode: str) -> str:
    if mode == "allocator_snapshot":
        return " ".join([
            f"run_id={run_id}",
            f"status={result.get('status', 'unknown')}",
            f"built={result.get('snapshots_built', 0)}",
            f"written={result.get('written', 0)}",
            f"skipped_days={result.get('skipped_days', 0)}",
            f"without_l4={result.get('snapshots_without_l4', 0)}",
            "l4_blockers=" + json.dumps(
                result.get("l4_materialization_blockers") or {}, separators=(",", ":"), sort_keys=True
            ),
        ])
    return " ".join([
        f"run_id={run_id}",
        f"status={result.get('status', 'unknown')}",
        f"cohort={result.get('cohort_id', 'none')}",
        f"promoted={bool(result.get('promoted'))}",
        f"reason={result.get('promotion_reason') or result.get('reason') or 'none'}",
    ])


async def _run() -> int:
    mode = os.environ.get("OOF_MATERIALIZE_MODE", "oof_lifecycle").strip().lower()
    cadence = os.environ.get("OOF_MATERIALIZE_CADENCE", "daily").strip().lower()
    start_date = os.environ.get("OOF_MATERIALIZE_START_DATE", "").strip() or None
    end_date = os.environ.get("OOF_MATERIALIZE_END_DATE", "").strip() or None
    promote = _truthy(os.environ.get("OOF_MATERIALIZE_PROMOTE", "1"))
    dispatch_full_fit = _truthy(os.environ.get("OOF_MATERIALIZE_DISPATCH_FULL_FIT", "0"))
    expected_cohort_id = (
        os.environ.get("OOF_MATERIALIZE_EXPECTED_COHORT_ID", "").strip() or None
    )
    callback_task = os.environ.get(
        "OOF_MATERIALIZE_CALLBACK_TASK",
        f"active8-oof-{cadence}",
    ).strip()
    execution_id = os.environ.get(
        "CLOUD_RUN_EXECUTION",
        f"active8-oof-materialize-{int(time.time())}-{uuid.uuid4().hex[:8]}",
    )
    run_id = os.environ.get("OOF_MATERIALIZE_RUN_ID", "").strip() or execution_id
    started = time.time()
    callback_status = "error"
    error: str | None = None
    result: dict[str, Any] = {}

    try:
        if mode == "allocator_snapshot":
            if not start_date or not end_date:
                raise RuntimeError("allocator snapshot mode requires start and end dates")
            result = await _execute_allocator_snapshot(
                start_date=start_date,
                end_date=end_date,
                lineage_cohort_id=run_id,
            )
            status = str(result.get("status") or "").lower()
            if (
                status == "ok"
                and int(result.get("snapshots_built") or 0) > 0
                and int(result.get("written") or 0) > 0
            ):
                callback_status = "success"
            else:
                raise RuntimeError(
                    "allocator snapshot incomplete "
                    f"status={status or 'unknown'} built={result.get('snapshots_built')} "
                    f"written={result.get('written')} "
                    f"skip_reasons={result.get('skip_reasons') or {}}"
                )
        else:
            if mode != "oof_lifecycle":
                raise RuntimeError(f"invalid OOF materialize mode: {mode}")
            if cadence not in {"daily", "weekly", "monthly"}:
                raise RuntimeError(f"invalid OOF materialize cadence: {cadence}")
            result = await _execute_lifecycle(
                cadence=cadence,
                end_date=end_date,
                promote=promote,
                dispatch_full_fit=dispatch_full_fit,
                expected_cohort_id=expected_cohort_id,
            )
            status = str(result.get("status") or "").lower()
            if result.get("dependency_retry_required"):
                forward_extension = result.get("daily_forward_extension") or {}
                reason = (
                    result.get("reason")
                    or forward_extension.get("reason")
                    or (result.get("full_fit_dispatch") or {}).get("reason")
                    or (result.get("opb_refresh") or {}).get("error")
                    or "dependency_retry_required"
                )
                detail = str(forward_extension.get("reason") or "").strip()
                suffix = f":{detail}" if detail and detail != reason else ""
                raise RuntimeError(f"oof_dependency_retry_required:{reason}{suffix}")
            if status in {"materialized", "idempotent_complete"}:
                callback_status = "success"
            elif status in {"skipped", "pending", "spawned"}:
                callback_status = "skipped"
            else:
                raise RuntimeError(f"unexpected OOF materialization status: {status or 'unknown'}")
    except Exception as exc:  # noqa: BLE001 - callback must close every terminal job state.
        logger.exception("[OofMaterializeJob] Failed")
        error = f"{type(exc).__name__}: {exc}"

    summary = _summary(run_id, result, mode=mode)
    if error:
        summary = f"{summary} error={error[:180]}"
    payload: dict[str, Any] = {
        "task": callback_task,
        "status": callback_status,
        "summary": summary,
        "duration_ms": int((time.time() - started) * 1000),
        "run_id": run_id,
        "attempt_id": execution_id,
    }
    if end_date:
        payload["run_date"] = end_date
    if error:
        payload["error"] = error
    await _callback_worker(payload)
    logger.info("[OofMaterializeJob] Finished %s", summary)
    return 0 if callback_status in {"success", "skipped"} else 1


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
