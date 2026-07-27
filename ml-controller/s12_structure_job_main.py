"""Durable Cloud Run Job owner for S12 date-level structure computation."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
import uuid
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("s12_structure_job")


def _extract_terminal(stdout: str) -> dict:
    for line in reversed((stdout or "").splitlines()):
        raw = line.strip()
        if not raw.startswith("{"):
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("task") == "s12-structure-batch":
            return payload
    raise RuntimeError("s12 structure node runner did not emit terminal JSON")


def _run_node(run_date: str, run_id: str, source: str) -> dict:
    entrypoint = Path(os.environ.get(
        "S12_STRUCTURE_NODE_ENTRYPOINT",
        "/app/worker-dist/node-runner/s12StructureBatchJobMain.js",
    ))
    if not entrypoint.exists():
        raise RuntimeError(f"s12 structure node entrypoint not found: {entrypoint}")
    completed = subprocess.run(
        [
            os.environ.get("S12_STRUCTURE_NODE_COMMAND", "node"),
            str(entrypoint),
            "--date", run_date,
            "--run-id", run_id,
            "--source", source,
        ],
        env=os.environ.copy(),
        check=False,
        capture_output=True,
        text=True,
        timeout=int(os.environ.get("S12_STRUCTURE_JOB_TIMEOUT_SECONDS", "3600")),
    )
    if completed.stdout:
        logger.info("node stdout tail:\n%s", completed.stdout[-3000:])
    if completed.stderr:
        logger.warning("node stderr tail:\n%s", completed.stderr[-3000:])
    if completed.returncode != 0:
        raise RuntimeError(
            f"s12 structure node failed rc={completed.returncode}: "
            f"{(completed.stderr or completed.stdout)[-1500:]}"
        )
    return _extract_terminal(completed.stdout)


async def _run() -> int:
    run_date = os.environ.get("S12_STRUCTURE_RUN_DATE", "").strip()
    run_id = os.environ.get(
        "S12_STRUCTURE_RUN_ID",
        os.environ.get("CLOUD_RUN_EXECUTION", f"s12-structure-{int(time.time())}-{uuid.uuid4().hex[:8]}"),
    ).strip()
    source = os.environ.get("S12_STRUCTURE_RUN_SOURCE", "evening_chain").strip()
    chain_run_id = os.environ.get("S12_STRUCTURE_CHAIN_RUN_ID", "").strip()
    from services.allocator_contract_guard import assert_allocator_contract_run_date
    assert_allocator_contract_run_date(run_date, label="s12-structure-batch")

    started = time.time()
    status = "error"
    summary: dict | str = ""
    error: str | None = None
    try:
        result = await asyncio.to_thread(_run_node, run_date, run_id, source)
        status = str(result.get("status") or "error")
        summary = result.get("summary") or {}
        if status != "success":
            error = str(result.get("summary") or "s12 structure batch failed")
    except Exception as exc:  # noqa: BLE001
        logger.exception("S12 durable structure batch failed")
        error = f"{type(exc).__name__}:{exc}"
        summary = error

    payload = {
        "task": "s12-structure-batch",
        "status": status,
        "summary": json.dumps(summary, ensure_ascii=False)[:4000]
        if isinstance(summary, dict) else str(summary)[:4000],
        "duration_ms": int((time.time() - started) * 1000),
        "run_id": run_id,
        "run_date": run_date,
        "metadata": {
            "chain_run_id": chain_run_id or None,
            "source": source,
            "runner": "cloud_run_node_worker_s12_structure",
            "summary": summary if isinstance(summary, dict) else None,
        },
    }
    if error:
        payload["error"] = error
    from routers.pipeline import _callback_worker
    await _callback_worker(payload)
    return 0 if status == "success" else 1


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()
