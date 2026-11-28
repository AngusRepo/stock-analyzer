"""
dataset_snapshot_job_main.py - Cloud Run Job entrypoint for dataset snapshots.

Invoked by a detached Cloud Run Job when pipeline-v2 reports
dataset_snapshot_export=deferred. This job owns the heavy D1 reads, GCS writes,
manifest upserts, and terminal Worker scheduler callback.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from datetime import datetime, timedelta

from routers.pipeline import _callback_worker
from services.dataset_snapshot_exporter import (
    DatasetSnapshotExportRequest,
    export_daily_research_snapshots,
    export_backtest_dataset_snapshot,
)

# One JSON object per line (Cloud Logging jsonPayload, with root_ticket_id when set).
from services.json_logging import configure_json_logging  # noqa: E402

configure_json_logging(logging.INFO)
logger = logging.getLogger("dataset_snapshot_job")
CANONICAL_COMPUTE_SNAPSHOT_LOOKBACK_DAYS = 1280


def _snapshot_export_start_date(run_date: str) -> str:
    try:
        lookback_days = int(os.environ.get("STOCKVISION_RESEARCH_SNAPSHOT_LOOKBACK_DAYS", "1280") or "1280")
    except ValueError:
        lookback_days = 1280
    # This job publishes the canonical compute snapshot consumed by Active-8
    # purged OOF. A shorter validation window must use a different artifact
    # kind and must never supersede the production compute snapshot.
    lookback_days = max(CANONICAL_COMPUTE_SNAPSHOT_LOOKBACK_DAYS, min(lookback_days, 1600))
    return (datetime.strptime(run_date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")


def _truthy_env(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip().lower() not in {"0", "false", "no", "off"}


def _chunk_days() -> int:
    # One trading day per D1 query: CHUNK=3 already exceeded D1's 50 MB response
    # limit (error 7500) on the 1280-day export, so the default must not rely on
    # the job's env override.
    try:
        raw = int(os.environ.get("DATASET_SNAPSHOT_CHUNK_DAYS", "1") or "1")
    except ValueError:
        raw = 1
    return max(1, min(raw, 30))


def _format_snapshot_summary(run_id: str, combined: dict) -> str:
    snapshots = combined.get("snapshots") or {}
    backtest = ((snapshots.get("backtest_dataset") or {}).get("snapshot") or {})
    price = ((snapshots.get("price_history") or {}).get("snapshot") or {})
    return (
        f"run_id={run_id} "
        f"backtest={backtest.get('snapshot_id')} rows={backtest.get('row_count')} "
        f"price={price.get('snapshot_id')} rows={price.get('row_count')}"
    )


CORPORATE_HISTORY_WEEKLY_MODE = "corporate_history_weekly"
CORPORATE_HISTORY_WEEKLY_TASK = "corporate-history-weekly"


async def _run_corporate_history_weekly() -> int:
    """Saturday research corporate-history export; its own scheduler task and callback.

    Exit codes drive Cloud Run's task retries (maxRetries=2). Deterministic stops exit 0 after
    their error callback: a named fail-closed stop (CorporateHistoryWeeklyError: gate, calendar,
    baseline, refused export), a compile/validation ValueError, and the fetch script's SystemExit
    (FinLab auth, role, empty window), which all need an operator fix. Anything else (D1, GCS,
    FinLab transport) exits 1 and is retried. A retry exports under `<run_id>-a<attempt>`,
    never over an earlier attempt.
    """
    import tempfile
    from pathlib import Path
    from scripts.export_corporate_history_snapshot import redact_bucket
    from services.corporate_history_weekly import (
        CorporateHistoryWeeklyError, format_summary, run_corporate_history_weekly)
    run_date = os.environ.get("DATASET_SNAPSHOT_RUN_DATE", "").strip()
    run_id = os.environ.get("DATASET_SNAPSHOT_PRODUCER_RUN_ID", "").strip()
    attempt = os.environ.get("CLOUD_RUN_TASK_ATTEMPT", "0").strip() or "0"
    producer_run_id = run_id if attempt == "0" else f"{run_id}-a{attempt}"
    started = time.time()
    status, summary, error, retry = "error", "", None, False
    logger.info("[CorporateHistoryWeekly] Starting run_id=%s date=%s attempt=%s",
                run_id or "missing", run_date or "missing", attempt)
    try:
        if not run_date or not run_id.startswith(f"{CORPORATE_HISTORY_WEEKLY_TASK}-{run_date}-") \
                or not attempt.isdigit():
            raise CorporateHistoryWeeklyError("corporate_history_weekly_run_identity_invalid")
        with tempfile.TemporaryDirectory(prefix="corp-history-") as tmp:
            result = await asyncio.to_thread(
                run_corporate_history_weekly, run_date, run_id=producer_run_id, workdir=Path(tmp) / "run")
        summary = format_summary(result)
        status = "success"
    except (Exception, SystemExit) as e:  # noqa: BLE001 - the fetch script stops on FinLab auth with SystemExit
        logger.exception("[CorporateHistoryWeekly] Export failed")
        retry = not isinstance(e, (CorporateHistoryWeeklyError, ValueError, SystemExit))
        error = redact_bucket(f"{type(e).__name__}: {e}")
        summary = f"run_id={producer_run_id} {error[:300]}"
    payload: dict = {"task": CORPORATE_HISTORY_WEEKLY_TASK, "status": status, "summary": summary,
                     "duration_ms": int((time.time() - started) * 1000), "run_id": run_id}
    if run_date:
        payload["run_date"] = run_date
    if error:
        payload["error"] = error
    try:
        await _callback_worker(payload)
    except Exception:  # noqa: BLE001 - a lost callback must not re-run a finished export
        logger.exception("[CorporateHistoryWeekly] Callback failed; run log stays triggered")
    logger.info("[CorporateHistoryWeekly] Finished status=%s retry=%s elapsed_ms=%d", status, retry, payload["duration_ms"])
    return 1 if retry else 0


async def _run() -> int:
    if os.environ.get("DATASET_SNAPSHOT_MODE", "").strip() == CORPORATE_HISTORY_WEEKLY_MODE:
        return await _run_corporate_history_weekly()
    run_date = os.environ.get("DATASET_SNAPSHOT_RUN_DATE", "") or os.environ.get("PIPELINE_RUN_DATE", "") or ""
    parent_run_id = os.environ.get("DATASET_SNAPSHOT_PARENT_RUN_ID", "").strip()
    execution_id = os.environ.get(
        "CLOUD_RUN_EXECUTION",
        f"dataset-snapshot-{int(time.time())}-{uuid.uuid4().hex[:8]}",
    )
    run_id = os.environ.get("DATASET_SNAPSHOT_PRODUCER_RUN_ID", "").strip()
    if not run_id:
        run_id = f"{parent_run_id}:snapshot" if parent_run_id else execution_id

    logger.info(
        "[DatasetSnapshotJob] Starting run_id=%s parent=%s date=%s",
        run_id,
        parent_run_id or "n/a",
        run_date or "missing",
    )

    input_only = _truthy_env("DATASET_SNAPSHOT_INPUT_ONLY", "0")
    started = time.time()
    status = "error"
    summary = ""
    error: str | None = None

    try:
        if not run_date:
            raise RuntimeError("DATASET_SNAPSHOT_RUN_DATE not configured")
        premarket_input_uri = os.environ.get("PIPELINE_PREMARKET_POSTWRITE_INPUT_GCS_URI", "").strip()
        if input_only and premarket_input_uri:
            raise RuntimeError("input-only snapshot cannot run premarket postwrite")
        postclose_uri = os.environ.get("PIPELINE_PREMARKET_POSTCLOSE_WORK_URI", "").strip()
        postclose_result = None
        if postclose_uri:
            # After-close research on the sealed morning state, then the normal export.
            if input_only or premarket_input_uri:
                raise ValueError("postclose_job_mode_conflict")
            from services.premarket_postclose import read_work
            from graphs.daily_pipeline_v2 import run_pipeline_v2_postclose
            work = await asyncio.to_thread(read_work, postclose_uri)
            if work["signal_date"] != run_date or work["run_id"] != parent_run_id:
                raise ValueError("postclose_job_identity_mismatch")
            postclose_result = await run_pipeline_v2_postclose(work["input_gcs_uri"])
            deadline = os.environ.get("DATASET_SNAPSHOT_EXPORT_QUIET_DEADLINE", "").strip()
            if deadline and not _truthy_env("DATASET_SNAPSHOT_SKIP_EXPORT", "0"):
                from services.premarket_postclose import wait_for_export_window
                waited = time.time()
                export_window = await asyncio.to_thread(
                    wait_for_export_window, work["signal_date"], work["run_id"], deadline)
                logger.info("[DatasetSnapshotJob] export_window=%s waited_s=%d", export_window,
                            int(time.time() - waited))
        elif premarket_input_uri:
            from services.premarket_postwrite import run_premarket_postwrite
            await run_premarket_postwrite(premarket_input_uri)
        if _truthy_env("DATASET_SNAPSHOT_SKIP_EXPORT", "0"):
            if not (premarket_input_uri or postclose_uri):
                raise RuntimeError("snapshot export skipped without premarket postwrite")
            summary = f"run_id={run_id} postwrite=complete snapshot=disabled"
        else:
            request = DatasetSnapshotExportRequest(
                business_date=run_date,
                start_date=_snapshot_export_start_date(run_date),
                end_date=run_date,
                producer_run_id=run_id,
                include_signals=False if input_only else _truthy_env("DATASET_SNAPSHOT_INCLUDE_SIGNALS", "1"),
                chunk_days=_chunk_days(),
            )
            if input_only:
                exported = await asyncio.to_thread(export_backtest_dataset_snapshot, request)
                combined = {"snapshots": {"backtest_dataset": exported}}
            else:
                combined = await asyncio.to_thread(export_daily_research_snapshots, request)
            summary = _format_snapshot_summary(run_id, combined)
        if postclose_result is not None and postclose_result.get("status") != "completed":
            # The export still happened; the research failure must stay visible on this job.
            raise RuntimeError("postclose_research_incomplete:" + str(postclose_result.get("error") or postclose_result.get("status")))
        status = "success"
    except Exception as e:  # noqa: BLE001
        logger.exception("[DatasetSnapshotJob] Export failed")
        error = f"{type(e).__name__}: {e}"
        summary = f"run_id={run_id} {error[:180]}"

    payload: dict = {
        "task": "dataset-snapshot-export",
        "status": status,
        "summary": summary,
        "duration_ms": int((time.time() - started) * 1000),
        "run_id": run_id,
    }
    if run_date:
        payload["run_date"] = run_date
    if error:
        payload["error"] = error
    if not input_only:
        await _callback_worker(payload)
    else:
        logger.info("[DatasetSnapshotJob] Input-only completion: %s", summary)
        stage_path = os.environ.get('DATASET_SNAPSHOT_INPUT_STAGE', '').strip()
        if stage_path:
            from services.pipeline_input_events import record_snapshot_result
            stage = await asyncio.to_thread(record_snapshot_result, stage_path, status=status,
                snapshot=(exported.get('snapshot') if status == 'success' else None), error=error)
            # The result is durable before HTTP. Reconciliation retries a lost notification.
            import httpx
            token = os.environ.get('ML_CONTROLLER_TOKEN') or os.environ.get('STOCKVISION_AUTH_TOKEN', '')
            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    response = await client.post(stage['callback_url'], json={'stage_path': stage_path},
                        headers={'X-Service-Token': token})
                    response.raise_for_status()
            except Exception:
                logger.exception('Input snapshot callback pending reconciliation')

    logger.info(
        "[DatasetSnapshotJob] Finished status=%s elapsed_ms=%d",
        status,
        payload["duration_ms"],
    )
    return 0 if status == "success" else 1


def main() -> None:
    exit_code = asyncio.run(_run())
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
