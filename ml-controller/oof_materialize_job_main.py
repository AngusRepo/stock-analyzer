"""Cloud Run Job entrypoint for durable Active-8 OOF materialization."""
from __future__ import annotations

import asyncio
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


async def _execute_lifecycle(
    *,
    cadence: str,
    end_date: str | None,
    promote: bool,
) -> dict[str, Any]:
    from routers.walk_forward import OofLifecycleRequest, run_walk_forward_oof_lifecycle

    return await run_walk_forward_oof_lifecycle(OofLifecycleRequest(
        cadence=cadence,
        end_date=end_date,
        dry_run=False,
        promote=promote,
    ))


def _summary(run_id: str, result: dict[str, Any]) -> str:
    return " ".join([
        f"run_id={run_id}",
        f"status={result.get('status', 'unknown')}",
        f"cohort={result.get('cohort_id', 'none')}",
        f"promoted={bool(result.get('promoted'))}",
        f"reason={result.get('promotion_reason') or result.get('reason') or 'none'}",
    ])


async def _run() -> int:
    cadence = os.environ.get("OOF_MATERIALIZE_CADENCE", "daily").strip().lower()
    end_date = os.environ.get("OOF_MATERIALIZE_END_DATE", "").strip() or None
    promote = _truthy(os.environ.get("OOF_MATERIALIZE_PROMOTE", "1"))
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
        if cadence not in {"daily", "weekly", "monthly"}:
            raise RuntimeError(f"invalid OOF materialize cadence: {cadence}")
        result = await _execute_lifecycle(
            cadence=cadence,
            end_date=end_date,
            promote=promote,
        )
        status = str(result.get("status") or "").lower()
        if result.get("dependency_retry_required"):
            raise RuntimeError("OOF materialization completed but OPB refresh requires retry")
        if status in {"materialized", "idempotent_complete"}:
            callback_status = "success"
        elif status in {"skipped", "pending"}:
            callback_status = "skipped"
        else:
            raise RuntimeError(f"unexpected OOF materialization status: {status or 'unknown'}")
    except Exception as exc:  # noqa: BLE001 - callback must close every terminal job state.
        logger.exception("[OofMaterializeJob] Failed")
        error = f"{type(exc).__name__}: {exc}"

    summary = _summary(run_id, result)
    if error:
        summary = f"{summary} error={error[:180]}"
    payload: dict[str, Any] = {
        "task": callback_task,
        "status": callback_status,
        "summary": summary,
        "duration_ms": int((time.time() - started) * 1000),
        "run_id": run_id,
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
