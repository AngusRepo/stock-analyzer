"""Cloud Run Job entrypoint for screener-v2.

Runs the Worker screener code in a Node process with Cloudflare REST adapters,
then posts the terminal scheduler callback to Worker. The Worker callback owns
post-screener continuation when SCREENER_CHAIN_RUN_ID is present.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
import uuid
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("screener_job")


def _tail(value: str, limit: int = 4000) -> str:
    value = value or ""
    return value[-limit:]


def _node_entrypoint() -> str:
    return os.environ.get(
        "SCREENER_NODE_ENTRYPOINT",
        "/app/worker-dist/node-runner/screenerJobMain.js",
    )


def _extract_result(stdout: str) -> dict:
    for line in reversed((stdout or "").splitlines()):
        raw = line.strip()
        if not raw.startswith("{"):
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed.get("task") == "screener":
            return parsed
    raise RuntimeError("screener node runner did not emit terminal JSON")


def _run_node_screener(run_date: str, run_id: str) -> dict:
    entrypoint = Path(_node_entrypoint())
    if not entrypoint.exists():
        raise RuntimeError(f"screener node entrypoint not found: {entrypoint}")

    env = os.environ.copy()
    env.setdefault("ML_CONTROLLER_URL", env.get("ML_CONTROLLER_PUBLIC_URL", ""))

    timeout_s = int(os.environ.get("SCREENER_JOB_TIMEOUT_SECONDS", "5400") or "5400")
    cmd = [
        os.environ.get("SCREENER_NODE_COMMAND", "node"),
        str(entrypoint),
        "--date",
        run_date,
        "--run-id",
        run_id,
        "--json",
    ]
    logger.info("[ScreenerJob] Starting node runner: %s", " ".join(cmd))
    completed = subprocess.run(
        cmd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    if completed.stdout:
        logger.info("[ScreenerJob] node stdout tail:\n%s", _tail(completed.stdout, 2000))
    if completed.stderr:
        logger.warning("[ScreenerJob] node stderr tail:\n%s", _tail(completed.stderr, 2000))

    if completed.returncode != 0:
        raise RuntimeError(
            f"node screener failed rc={completed.returncode}: "
            f"{_tail(completed.stderr or completed.stdout, 1200)}"
        )
    return _extract_result(completed.stdout)


async def _run() -> int:
    run_date = os.environ.get("SCREENER_RUN_DATE", "") or ""
    run_id = os.environ.get(
        "SCREENER_RUN_ID",
        os.environ.get("CLOUD_RUN_EXECUTION", f"screener-job-{int(time.time())}-{uuid.uuid4().hex[:8]}"),
    )
    chain_run_id = os.environ.get("SCREENER_CHAIN_RUN_ID", "").strip()
    callback_task = os.environ.get("SCREENER_CALLBACK_TASK", "screener") or "screener"

    logger.info(
        "[ScreenerJob] Starting screener-v2 run_id=%s date=%s chain_run_id=%s",
        run_id,
        run_date or "today",
        chain_run_id or "-",
    )

    t0 = time.time()
    status = "error"
    summary = ""
    error: str | None = None

    try:
        result = await asyncio.to_thread(_run_node_screener, run_date, run_id)
        status = str(result.get("status") or "success")
        summary = str(result.get("summary") or "")
        if status != "success":
            error = str(result.get("error") or summary or "screener returned non-success status")
    except Exception as e:  # noqa: BLE001
        logger.exception("[ScreenerJob] Screener failed")
        error = f"{type(e).__name__}: {e}"
        summary = error[:180]

    elapsed_ms = int((time.time() - t0) * 1000)
    payload: dict = {
        "task": callback_task,
        "status": status,
        "summary": summary,
        "duration_ms": elapsed_ms,
        "run_id": run_id,
        "metadata": {
            "chain_run_id": chain_run_id or None,
            "continue_post_screener_pipeline": bool(chain_run_id),
            "runner": "cloud_run_node_worker_screener",
        },
    }
    if run_date:
        payload["run_date"] = run_date
    if chain_run_id:
        payload["chain_run_id"] = chain_run_id
        payload["continue_post_screener_pipeline"] = True
    if error:
        payload["error"] = error

    from routers.pipeline import _callback_worker

    await _callback_worker(payload)
    logger.info("[ScreenerJob] Screener finished: status=%s elapsed=%dms", status, elapsed_ms)
    return 0 if status == "success" else 1


def main() -> None:
    exit_code = asyncio.run(_run())
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
