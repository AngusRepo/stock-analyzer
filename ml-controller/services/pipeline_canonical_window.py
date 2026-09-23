"""Recheck the Worker-owned historical write window at async pipeline boundaries."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx


def assert_canonical_window_open(
    run_date: str,
    *,
    http_get: Callable[..., Any] | None = None,
    now: datetime | None = None,
) -> None:
    """Fail closed before a historical run spawns compute or mutates canonical rows."""
    try:
        parsed_date = datetime.strptime(run_date, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError("pipeline_canonical_window_invalid_date") from exc
    current = (now or datetime.now(timezone.utc)).astimezone(timezone(timedelta(hours=8))).date()
    if parsed_date >= current:
        return

    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip().rstrip("/")
    worker_token = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
    if not worker_url or not worker_token:
        raise RuntimeError("pipeline_canonical_window_worker_not_configured")
    response = (http_get or httpx.get)(
        f"{worker_url}/api/admin/historical-lineage-boundary",
        params={"task": "pipeline", "date": run_date},
        headers={"Authorization": f"Bearer {worker_token}"},
        timeout=30.0,
    )
    if response.status_code != 200:
        raise RuntimeError(f"pipeline_canonical_window_worker_http_{response.status_code}")
    payload = response.json()
    boundary = payload.get("boundary") if isinstance(payload, dict) else None
    if (
        not isinstance(boundary, dict)
        or payload.get("schema_version") != "historical-learning-lineage-boundary-v1"
        or payload.get("calendar_owner") != "worker.schedulerPolicy.nextTwTradingDate"
        or boundary.get("signalDate") != run_date
    ):
        raise RuntimeError("pipeline_canonical_window_worker_contract_invalid")
    if boundary.get("allowed") is not True or boundary.get("reason") != "pre_next_session_open_historical_write_window":
        raise RuntimeError(f"pipeline_canonical_window_closed:{boundary.get('reason') or 'unknown'}")
