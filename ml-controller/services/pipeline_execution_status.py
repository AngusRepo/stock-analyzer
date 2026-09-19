"""Exact-run Cloud Run observation. A dispatcher exit is not pipeline success."""
from __future__ import annotations

from datetime import date, datetime, timezone
from itertools import islice
from typing import Any

from google.cloud import run_v2

SCHEMA = "pipeline-cloud-execution-status-v1"


def _environment(execution: Any) -> dict[str, str]:
    # Only identity fields are read; secret references/other values never leave here.
    wanted = {"PIPELINE_RUN_DATE", "PIPELINE_PARENT_RUN_ID"}
    return {item.name: item.value for container in execution.template.containers
            for item in container.env if item.name in wanted}


def _iso(value: Any) -> str | None:
    if not value or value.timestamp() <= 0:
        return None
    return value.astimezone(timezone.utc).isoformat()


def lookup_execution(client: Any, *, parent: str, run_date: str, run_id: str,
                     execution_name: str = "", scan_limit: int = 100) -> dict:
    if date.fromisoformat(run_date).isoformat() != run_date or not run_id or not parent:
        raise ValueError("pipeline_cloud_execution_identity_invalid")
    prefix = parent + "/executions/"
    def matches(execution: Any) -> bool:
        values = _environment(execution)
        return (execution.name.startswith(prefix)
                and values.get("PIPELINE_RUN_DATE") == run_date
                and values.get("PIPELINE_PARENT_RUN_ID") == run_id)
    pinned = None
    if execution_name:
        if not execution_name.startswith(prefix) or "/" in execution_name[len(prefix):]:
            raise ValueError("pipeline_cloud_execution_job_mismatch")
        pinned = client.get_execution(request=run_v2.GetExecutionRequest(name=execution_name), timeout=15)
        if not matches(pinned):
            raise ValueError("pipeline_cloud_execution_run_mismatch")
    base = {"schema_version": SCHEMA, "run_date": run_date, "run_id": run_id,
            "pinned_execution_name": execution_name or None, "state": "unknown"}
    # Include continuation jobs with the SAME parent run. Never select merely the
    # newest job, nor report dispatch success as successful recommendation output.
    page = client.list_executions(request=run_v2.ListExecutionsRequest(parent=parent, page_size=100), timeout=15)
    # The SDK/API guarantees create_time descending. Stop at the first exact
    # run, or at the pinned execution's time; old job history must not make
    # every reconciliation exceed its budget once the job has 100 executions.
    execution = None
    observed_count = 0
    for item in islice(page, scan_limit + 1):
        observed_count += 1
        if observed_count > scan_limit:
            return {**base, "reason": "execution_scan_budget_exceeded"}
        if pinned is not None and item.create_time < pinned.create_time:
            execution = pinned
            break
        if matches(item):
            execution = item
            break
    if execution is None:
        execution = pinned
    if execution is None:
        return {**base, "reason": "exact_run_execution_not_found"}
    condition = next((c for c in execution.conditions if c.type_ == "Completed"), None)
    state = "running"
    failure_code = None
    if condition is not None and condition.state == run_v2.Condition.State.CONDITION_FAILED:
        state = "failed"
        message = condition.message.lower()
        failure_code = "memory_limit" if "memory limit" in message or "out of memory" in message else "task_failed"
    elif condition is not None and condition.state == run_v2.Condition.State.CONDITION_SUCCEEDED:
        state = "succeeded"
    elif execution.completion_time:
        state = "unknown"  # Terminal time alone does not prove the outcome.
    completed_at = _iso(execution.completion_time) or (_iso(condition.last_transition_time) if condition else None)
    if state == "failed" and completed_at is None:
        state = "unknown"
    return {**base, "execution_name": execution.name, "state": state,
            "completed_at": completed_at if state in {"failed", "succeeded"} else None,
            "failure_code": failure_code if state == "failed" else None,
            "reason": "awaiting_pipeline_callback" if state == "succeeded" else "exact_run_observed",
            "observed_executions": observed_count}


def failure_callback(snapshot: dict) -> dict | None:
    if snapshot.get("schema_version") != SCHEMA:
        raise ValueError("pipeline_cloud_execution_schema_invalid")
    if snapshot.get("state") != "failed":
        return None
    when = snapshot["completed_at"]
    datetime.fromisoformat(when)
    code = snapshot["failure_code"]
    if code not in {"memory_limit", "task_failed"}:
        raise ValueError("pipeline_cloud_execution_failure_invalid")
    execution_id = snapshot["execution_name"].rsplit("/", 1)[-1]
    error = f"pipeline_cloud_run_failed:{code};completed_at={when};execution={execution_id}"
    return {"task": "pipeline", "status": "error", "run_id": snapshot["run_id"],
            "run_date": snapshot["run_date"], "duration_ms": 0, "error": error,
            "summary": f"Cloud Run terminal failure verified: {execution_id}; {code}",
            "metadata": {"cloud_execution": snapshot}}
