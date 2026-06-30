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
from datetime import date, datetime, timedelta, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("verify_job")


def format_verify_summary(result: dict) -> str:
    return (
        f"verified {result.get('verified', 0)}/{result.get('pending', 0)} "
        f"written {result.get('metrics', {}).get('verified_rows_written', 0)} "
        f"correct {result.get('correct', 0)} "
        f"pnl {(float(result.get('total_pnl_pct', 0.0)) * 100):.1f}% "
        f"arf {result.get('arf_updated', 0)}"
    )


def _is_unmatured_replay_window(run_date: str, tw_now: datetime | None = None) -> bool:
    try:
        target = date.fromisoformat((run_date or "").strip())
    except ValueError:
        return False

    now = tw_now or (datetime.now(timezone.utc) + timedelta(hours=8))
    age_days = (now.date() - target).days
    if age_days <= 0:
        return True
    if age_days == 1 and now.hour < 15:
        return True
    return False


def classify_verify_callback_status(
    result: dict,
    run_date: str = "",
    tw_now: datetime | None = None,
) -> tuple[str, str | None]:
    if result.get("status") != "ok":
        errors = result.get("errors") or []
        return "error", "; ".join(str(e) for e in errors[:3]) or str(result)

    pending = int(result.get("pending") or 0)
    verified = int(result.get("verified") or 0)
    written = int((result.get("metrics") or {}).get("verified_rows_written") or 0)

    if pending <= 0:
        return "skipped", "no pending predictions in verifiable window"
    if verified <= 0 or written <= 0:
        if _is_unmatured_replay_window(run_date or str(result.get("run_date") or ""), tw_now):
            return "skipped", (
                "no matured outcome writes yet for replay window: "
                f"pending={pending} verified={verified} verified_rows_written={written}"
            )
        return "error", (
            f"verify produced no durable outcome writes: "
            f"pending={pending} verified={verified} verified_rows_written={written}"
        )
    return "success", None


async def _run() -> int:
    from graphs.verify_pipeline import run_verify_v2

    run_date = os.environ.get("VERIFY_RUN_DATE", "") or ""
    lookback_days = int(os.environ.get("VERIFY_LOOKBACK_DAYS", "5") or 5)
    limit = int(os.environ.get("VERIFY_LIMIT", "200") or 200)
    callback_task = os.environ.get("VERIFY_CALLBACK_TASK", "verify-v2") or "verify-v2"
    update_aggregates = (os.environ.get("VERIFY_UPDATE_AGGREGATES", "0") or "0").strip().lower() in {"1", "true", "yes"}
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
            update_aggregates=update_aggregates,
        )
        status, reason = classify_verify_callback_status(result, run_date=run_date)
        summary = format_verify_summary(result) if status == "success" else (reason or "verify skipped")
        if status == "error":
            error = reason
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
    if run_date:
        payload["run_date"] = run_date
    if error:
        payload["error"] = error

    from routers.pipeline import _callback_worker

    await _callback_worker(payload)
    logger.info("[VerifyJob] Verify finished: status=%s elapsed=%dms", status, elapsed_ms)
    return 0 if status in {"success", "skipped"} else 1


def main() -> None:
    exit_code = asyncio.run(_run())
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
