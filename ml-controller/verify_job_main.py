"""
verify_job_main.py - Cloud Run Job entrypoint for verify pipeline V2.

Invoked as `python -m verify_job_main` by the Cloud Run Job `verify-v2`.
Reads VERIFY_* env vars, runs the existing verify graph to completion, and
POSTs the result back to Worker via the shared callback helper.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid

from routers.pipeline import _callback_worker
from routers.verify import _format_verify_summary

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("verify_job")


async def _run() -> int:
    from graphs.verify_pipeline import run_verify_v2

    run_date = os.environ.get("VERIFY_RUN_DATE", "") or ""
    lookback_days = int(os.environ.get("VERIFY_LOOKBACK_DAYS", "5") or 5)
    limit = int(os.environ.get("VERIFY_LIMIT", "200") or 200)
    callback_task = os.environ.get("VERIFY_CALLBACK_TASK", "verify-v2") or "verify-v2"
    run_id = os.environ.get(
        "VERIFY_RUN_ID",
        os.environ.get("CLOUD_RUN_EXECUTION", f"verify-job-{int(time.time())}-{uuid.uuid4().hex[:8]}"),
    )

    logger.info(
        "[VerifyJob] Starting verify V2 run_id=%s date=%s lookback=%s limit=%s",
        run_id,
        run_date or "today",
        lookback_days,
        limit,
    )

    t0 = time.time()
    status = "error"
    summary = ""
    error: str | None = None

    try:
        result = await run_verify_v2(
            run_date=run_date,
            lookback_days=lookback_days,
            limit=limit,
        )
        ok = result.get("status") == "ok"
        errors = result.get("errors") or []
        status = "success" if ok else "error"
        summary = _format_verify_summary(result) if ok else ("; ".join(str(e) for e in errors[:3]) or "verify failed")
        if not ok:
            error = "; ".join(str(e) for e in errors[:3]) or str(result)
    except Exception as e:  # noqa: BLE001
        logger.exception("[VerifyJob] Verify failed")
        error = f"{type(e).__name__}: {e}"
        summary = error[:160]

    elapsed_ms = int((time.time() - t0) * 1000)
    payload: dict = {
        "task": callback_task,
        "status": status,
        "summary": summary,
        "duration_ms": elapsed_ms,
        "run_id": run_id,
    }
    if error:
        payload["error"] = error

    await _callback_worker(payload)
    logger.info("[VerifyJob] Verify finished: status=%s elapsed=%dms", status, elapsed_ms)
    return 0 if status == "success" else 1


def main() -> None:
    exit_code = asyncio.run(_run())
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
