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
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("dataset_snapshot_job")


def _snapshot_export_start_date(run_date: str) -> str:
    try:
        lookback_days = int(os.environ.get("STOCKVISION_RESEARCH_SNAPSHOT_LOOKBACK_DAYS", "420") or "420")
    except ValueError:
        lookback_days = 420
    lookback_days = max(30, min(lookback_days, 1600))
    return (datetime.strptime(run_date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")


def _truthy_env(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip().lower() not in {"0", "false", "no", "off"}


def _chunk_days() -> int:
    try:
        raw = int(os.environ.get("DATASET_SNAPSHOT_CHUNK_DAYS", "10") or "10")
    except ValueError:
        raw = 10
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


async def _run() -> int:
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

    started = time.time()
    status = "error"
    summary = ""
    error: str | None = None

    try:
        if not run_date:
            raise RuntimeError("DATASET_SNAPSHOT_RUN_DATE not configured")
        request = DatasetSnapshotExportRequest(
            business_date=run_date,
            start_date=_snapshot_export_start_date(run_date),
            end_date=run_date,
            producer_run_id=run_id,
            include_signals=_truthy_env("DATASET_SNAPSHOT_INCLUDE_SIGNALS", "1"),
            chunk_days=_chunk_days(),
        )
        combined = await asyncio.to_thread(export_daily_research_snapshots, request)
        status = "success"
        summary = _format_snapshot_summary(run_id, combined)
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
    await _callback_worker(payload)

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
