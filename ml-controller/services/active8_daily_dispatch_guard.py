"""Date-wide daily dispatch fence. Provider terminal state, never elapsed time, owns retry.

GCS generations serialize all watchdog tickets. An ambiguous dispatch remains
closed until its exact provider execution is found or an evidence-bound repair
receipt is supplied. This is not a NAV/accounting success receipt.
"""
from __future__ import annotations

from datetime import date, datetime, time as day_time, timedelta, timezone
import hashlib
from itertools import islice
import json
import re
import time
import uuid

from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import run_v2

from services.cloud_run_jobs_client import JobAlreadyRunningError, MIN_PAGE_SECONDS
from services.cloud_run_jobs_client import executions_newest_first as _executions_newest_first

SCHEMA = "active8-daily-dispatch-guard-v1"
MAX_DISPATCHES = 64  # Across the whole business date, not renewed by a new ticket.
SCAN_LIMIT = 100
# Executions of the same job in mode opb_arm_replay (l4_opb_replay_dispatch.JOB_CADENCE)
# are never daily dispatches; they are skipped without spending SCAN_LIMIT. The controller
# starts at most 4 a business date (l4_opb_replay_dispatch.MAX_EXECUTIONS_PER_BUSINESS_DATE,
# claimed here by dispatch_replay_guarded), so a scan back over 31 business dates meets at most 124; past
# this allowance the history is not as expected.
REPLAY_CADENCE = "opb_arm_replay"
REPLAY_DATE_ENV = "OOF_MATERIALIZE_OPB_REPLAY_DATE"
REPLAY_CLAIM_ENV = "OOF_MATERIALIZE_OPB_REPLAY_CLAIM_ID"
REPLAY_SCAN_LIMIT = 200
REPLAY_SCHEMA = "active8-opb-arm-replay-dispatch-v1"
# A claim older than this without its execution in the provider list never started one:
# far beyond the controller's whole dispatch budget (l4_opb_replay_dispatch, 40 s).
REPLAY_CLAIM_STALE_SECONDS = 120
REPLAY_MIN_RUN_JOB_SECONDS = 5


class DailyDispatchBlocked(RuntimeError):
    pass


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("active8_daily_dispatch_guard_deadline")
    return min(8.0, remaining)


def executions_newest_first(client, deadline: float, page_size: int):
    """Executions of the job, newest first, page by page within the deadline
    (cloud_run_jobs_client.executions_newest_first: each page min(8 s, remaining), none
    under MIN_PAGE_SECONDS)."""
    return _executions_newest_first(client, deadline, page_size, error="active8_daily_dispatch_guard_deadline")


def _load(bucket, path: str, deadline: float):
    blob = bucket.blob(path)
    try:
        blob.reload(timeout=_remaining(deadline), retry=None)
    except NotFound:
        return None, 0
    generation = int(blob.generation)
    raw = blob.download_as_bytes(if_generation_match=generation, timeout=_remaining(deadline), retry=None)
    return json.loads(raw), generation


def _save(bucket, path: str, state: dict, generation: int, deadline: float):
    bucket.blob(path).upload_from_string(
        json.dumps(state, sort_keys=True, separators=(",", ":")),
        content_type="application/json", if_generation_match=generation,
        timeout=_remaining(deadline), retry=None,
    )


def _env(execution) -> dict:
    wanted = {"OOF_MATERIALIZE_CADENCE", "OOF_MATERIALIZE_END_DATE", "OOF_MATERIALIZE_DISPATCH_CLAIM_ID",
              REPLAY_DATE_ENV, REPLAY_CLAIM_ENV}
    return {v.name: v.value for c in execution.template.containers for v in c.env if v.name in wanted}


def _state(execution) -> str:
    for condition in execution.conditions:
        if condition.type_ != "Completed":
            continue
        if condition.state == run_v2.Condition.State.CONDITION_FAILED:
            return "failed"
        if condition.state == run_v2.Condition.State.CONDITION_SUCCEEDED:
            return "succeeded"
    return "unknown" if execution.completion_time else "running"


def _since(client, day: str, deadline: float):
    """(execution, env) of this job created on or after the Taipei calendar day `day`."""
    earliest = datetime.combine(date.fromisoformat(day), day_time(), tzinfo=timezone(timedelta(hours=8)))
    for item in islice(executions_newest_first(client, deadline, SCAN_LIMIT), SCAN_LIMIT + REPLAY_SCAN_LIMIT + 1):
        _remaining(deadline)
        # Provider list is creation-time descending. A business-date execution
        # cannot predate that Taipei calendar day; historical backfills are
        # created later and remain included. Avoid scanning years of old jobs.
        if item.create_time and item.create_time < earliest:
            return
        if not item.name.startswith(client._parent + "/executions/"):
            raise DailyDispatchBlocked("provider_execution_job_mismatch")
        yield item, _env(item)


def replay_executions(client, day: str, deadline: float) -> list:
    """Replay-mode executions ever started for business date `day`, in any state.

    A history longer than the scan allowance raises (the caller does not start one)."""
    seen, matches = 0, []
    for item, values in _since(client, day, deadline):
        seen += 1
        if seen > SCAN_LIMIT + REPLAY_SCAN_LIMIT:
            raise DailyDispatchBlocked("provider_history_scan_budget_requires_repair")
        if values.get("OOF_MATERIALIZE_CADENCE") == REPLAY_CADENCE and values.get(REPLAY_DATE_ENV) == day:
            matches.append(item)
    return matches


def _replay_path(day: str) -> str:
    # Next to the daily fence of the same date (same bucket and prefix), its own object.
    return f"operations/active8-daily-dispatch/v1/{day}/opb-arm-replay.json"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _observe_replay(client, name: str, day: str, deadline: float):
    if not name.startswith(client._parent + "/executions/") or "/" in name.rsplit("/executions/", 1)[-1]:
        raise DailyDispatchBlocked("provider_execution_job_mismatch")
    execution = client._get_executions_client().get_execution(
        request=run_v2.GetExecutionRequest(name=name), timeout=_remaining(deadline), retry=None,
    )
    values = _env(execution)
    if (execution.name != name or values.get("OOF_MATERIALIZE_CADENCE") != REPLAY_CADENCE
            or values.get(REPLAY_DATE_ENV) != day):
        raise DailyDispatchBlocked("provider_execution_date_mismatch")
    return execution


def _job_execution(execution):
    from services.cloud_run_jobs_client import JobExecution
    return JobExecution(execution.name, execution.name.rsplit("/", 1)[-1])


def dispatch_replay_guarded(client, bucket, *, day: str, env_overrides: dict, max_executions: int,
                            deadline: float):
    """Start one replay execution for business date `day` under a GCS generation claim.

    Returns ("spawned", JobExecution), ("busy", JobExecution | None) or ("capped", count).
    The claim (sequence number + claim id, saved with if_generation_match) is taken
    before RunJob, so concurrent entries cannot both start one: the loser answers busy
    and never calls RunJob. At most `max_executions` claims a date, and none while the
    last claimed execution runs (busy), so the last one's receipt is readable before
    `capped`. Research dispatch only: a claim that never reached the provider expires
    after REPLAY_CLAIM_STALE_SECONDS and stays counted (conservative).
    """
    if date.fromisoformat(day).isoformat() != day:
        raise ValueError("active8_opb_replay_dispatch_identity_invalid")
    if bucket is None:
        raise DailyDispatchBlocked("durable_dispatch_guard_unavailable")
    path = _replay_path(day)
    try:
        state, generation = _load(bucket, path, deadline)
    except PreconditionFailed:
        return "busy", None                  # another entry is writing the fence right now
    if state is None:
        # First claim of the date: what the provider already ran counts (executions
        # started before this fence existed, or by a lost state object).
        started = replay_executions(client, day, deadline)
        running = next((e for e in started if _state(e) == "running"), None)
        state = {"schema_version": REPLAY_SCHEMA, "business_date": day, "job": client._parent,
                 "started": len(started), "status": "dispatched" if running else "ready",
                 "execution_name": running.name if running else "", "claim_id": "", "claimed_at": ""}
        try:
            _save(bucket, path, state, 0, deadline)
            state, generation = _load(bucket, path, deadline)
        except PreconditionFailed:
            return "busy", None
    if (state.get("schema_version") != REPLAY_SCHEMA or state.get("business_date") != day
            or state.get("job") != client._parent or type(state.get("started")) is not int
            or state["started"] < 0 or state.get("status") not in {"ready", "dispatching", "dispatched"}):
        raise DailyDispatchBlocked("replay_dispatch_guard_invalid")
    if state["status"] == "dispatched":
        execution = _observe_replay(client, str(state.get("execution_name") or ""), day, deadline)
        if _state(execution) == "running":
            return "busy", _job_execution(execution)
    elif state["status"] == "dispatching":
        claim_id = str(state.get("claim_id") or "")
        execution = next((item for item, values in _since(client, day, deadline)
                          if claim_id and values.get(REPLAY_CLAIM_ENV) == claim_id), None)
        if execution is not None and _state(execution) == "running":
            return "busy", _job_execution(execution)
        if execution is None:
            try:
                age = (_utcnow() - datetime.fromisoformat(str(state.get("claimed_at")))).total_seconds()
            except ValueError:
                age = REPLAY_CLAIM_STALE_SECONDS
            if age < REPLAY_CLAIM_STALE_SECONDS:
                return "busy", None          # another caller may still be inside RunJob
    # The last claimed execution (if any) has ended.
    if state["started"] >= max_executions:
        return "capped", state["started"]
    if deadline - time.monotonic() < REPLAY_MIN_RUN_JOB_SECONDS:
        raise TimeoutError("active8_opb_replay_dispatch_deadline")   # before the claim: nothing spent
    claim_id = str(uuid.uuid4())
    state.update(status="dispatching", claim_id=claim_id, claimed_at=_utcnow().isoformat(),
                 execution_name="", started=state["started"] + 1)
    try:
        _save(bucket, path, state, generation, deadline)
    except PreconditionFailed:
        return "busy", None                  # another entry holds this sequence number
    _, claimed_generation = _load(bucket, path, deadline)
    try:
        execution = client.run_job(env_overrides={**env_overrides, REPLAY_CLAIM_ENV: claim_id},
                                   reject_if_running=True, deadline_seconds=deadline - time.monotonic())
    except JobAlreadyRunningError as exc:
        # Refused (the OOF job runs): nothing started, the sequence number is returned.
        state.update(status="ready", claim_id="", claimed_at="", started=state["started"] - 1)
        try:
            _save(bucket, path, state, claimed_generation, deadline)
        except Exception:
            pass                             # the claim expires; counted conservatively
        return "busy", exc.execution
    # Any other RunJob error leaves the claim: found by claim id, or expired.
    state.update(status="dispatched", execution_name=execution.execution_name)
    try:
        _save(bucket, path, state, claimed_generation, deadline)
    except Exception:
        pass                                 # the next entry finds it by claim id
    return "spawned", execution


def _scan(client, day: str, deadline: float, claim_id: str = ""):
    matches = []
    scanned = replays = 0
    for item, values in _since(client, day, deadline):
        if values.get("OOF_MATERIALIZE_CADENCE") == REPLAY_CADENCE:
            replays += 1
            if replays > REPLAY_SCAN_LIMIT:
                raise DailyDispatchBlocked("provider_history_scan_budget_requires_repair")
            continue
        if scanned == SCAN_LIMIT:
            raise DailyDispatchBlocked("provider_history_scan_budget_requires_repair")
        scanned += 1
        if values.get("OOF_MATERIALIZE_CADENCE") != "daily" or values.get("OOF_MATERIALIZE_END_DATE") != day:
            continue
        if claim_id and values.get("OOF_MATERIALIZE_DISPATCH_CLAIM_ID") != claim_id:
            continue
        matches.append(item)
        if claim_id:  # A unique dispatch claim has at most one accepted execution.
            break
    return matches


def _observe(client, name: str, day: str, deadline: float):
    if not name.startswith(client._parent + "/executions/") or "/" in name.rsplit("/executions/", 1)[-1]:
        raise DailyDispatchBlocked("provider_execution_job_mismatch")
    execution = client._get_executions_client().get_execution(
        request=run_v2.GetExecutionRequest(name=name), timeout=_remaining(deadline), retry=None,
    )
    values = _env(execution)
    if (execution.name != name or values.get("OOF_MATERIALIZE_CADENCE") != "daily"
            or values.get("OOF_MATERIALIZE_END_DATE") != day):
        raise DailyDispatchBlocked("provider_execution_date_mismatch")
    return execution


def dispatch_daily_guarded(client, bucket, *, env_overrides: dict,
                           expected_source_sha: str | None = None, deadline_seconds: float = 25):
    """Return the actual new JobExecution or raise an active/blocked result.

    Repair interface (GCS only): repair.json must bind the exact state generation
    and digest, evidence digest, current 40-hex source SHA, authorized_by=Wei,
    action=resume_once. A receipt is single-use and never resets the daily budget.
    Existing Worker operator-owned failure fences are separate and remain intact.
    """
    day = str(env_overrides.get("OOF_MATERIALIZE_END_DATE", ""))
    if date.fromisoformat(day).isoformat() != day or env_overrides.get("OOF_MATERIALIZE_CADENCE") != "daily":
        raise ValueError("active8_daily_dispatch_identity_invalid")
    if bucket is None:
        raise DailyDispatchBlocked("durable_dispatch_guard_unavailable")
    deadline = time.monotonic() + deadline_seconds
    path = f"operations/active8-daily-dispatch/v1/{day}/state.json"
    state, generation = _load(bucket, path, deadline)
    if state is None:
        executions = _scan(client, day, deadline)
        failed = next((e for e in executions if _state(e) in {"failed", "unknown"}), None)
        active = next((e for e in executions if _state(e) == "running"), None)
        state = {"schema_version": SCHEMA, "business_date": day, "job": client._parent,
                 "dispatch_count": len(executions), "status": "ready", "execution_name": "", "claim_id": ""}
        if failed:
            state.update(status="blocked", execution_name=failed.name, reason="verified_provider_terminal_failure_requires_repair")
        elif active:
            state.update(status="dispatched", execution_name=active.name)
        try:
            _save(bucket, path, state, 0, deadline)
        except PreconditionFailed:
            raise DailyDispatchBlocked("dispatch_guard_contended_retry_without_compute")
        state, generation = _load(bucket, path, deadline)
    if (state.get("schema_version") != SCHEMA or state.get("business_date") != day
            or state.get("job") != client._parent or type(state.get("dispatch_count")) is not int
            or not 0 <= state["dispatch_count"] <= MAX_DISPATCHES
            or state.get("status") not in {"ready", "dispatching", "dispatched", "blocked"}):
        raise DailyDispatchBlocked("dispatch_guard_invalid")
    state_digest = hashlib.sha256(json.dumps(state, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    ambiguous_unresolved = False
    if state["status"] in {"dispatching", "dispatched"}:
        name = state.get("execution_name")
        if name:
            execution = _observe(client, name, day, deadline)
        else:
            matches = _scan(client, day, deadline, str(state.get("claim_id") or ""))
            execution = matches[0] if len(matches) == 1 else None
            if execution is None:
                # Another caller may still be inside run_job. Do not mutate its
                # CAS generation, expire its claim, or launch a replacement.
                ambiguous_unresolved = True
        observed = _state(execution) if execution is not None else "unknown"
        if observed == "running":
            from services.cloud_run_jobs_client import JobExecution
            raise JobAlreadyRunningError(JobExecution(execution.name, execution.name.rsplit("/", 1)[-1]))
        if observed == "succeeded":
            state.update(status="ready", execution_name="")
        else:
            state.update(status="blocked", reason="verified_provider_terminal_failure_requires_repair" if observed == "failed"
                         else "ambiguous_dispatch_requires_repair")
    if state["status"] == "blocked":
        repair, _ = _load(bucket, path.replace("state.json", "repair.json"), deadline)
        allowed = (isinstance(repair, dict) and repair.get("action") == "resume_once"
                   and repair.get("authorized_by") == "Wei" and repair.get("state_generation") == generation
                   and repair.get("state_sha256") == state_digest and repair.get("source_sha") == expected_source_sha
                   and re.fullmatch(r"[a-f0-9]{40}", expected_source_sha or "")
                   and re.fullmatch(r"[a-f0-9]{64}", str(repair.get("evidence_sha256") or "")))
        if not allowed:
            # Persist the terminal/ambiguous result; a new ticket cannot reopen it.
            if not ambiguous_unresolved:
                _save(bucket, path, state, generation, deadline)
            raise DailyDispatchBlocked(state.get("reason", "dispatch_guard_requires_repair"))
        state.update(status="ready", execution_name="", repair_generation_consumed=generation)
    if state["dispatch_count"] >= MAX_DISPATCHES:
        raise DailyDispatchBlocked("date_dispatch_budget_exhausted_requires_repair")
    claim_id = str(uuid.uuid4())
    state.update(status="dispatching", claim_id=claim_id, execution_name="",
                 dispatch_count=state["dispatch_count"] + 1,
                 scheduler_ticket_id=env_overrides.get("OOF_MATERIALIZE_SCHEDULER_TICKET_ID", ""),
                 scheduler_run_id=env_overrides.get("OOF_MATERIALIZE_SCHEDULER_RUN_ID", ""),
                 continuation_attempt=env_overrides.get("OOF_MATERIALIZE_CONTINUATION_ATTEMPT", "0"))
    try:
        _save(bucket, path, state, generation, deadline)
    except PreconditionFailed:
        raise DailyDispatchBlocked("dispatch_guard_contended_retry_without_compute")
    _, claimed_generation = _load(bucket, path, deadline)
    try:
        execution = client.run_job(
            env_overrides={**env_overrides, "OOF_MATERIALIZE_DISPATCH_CLAIM_ID": claim_id},
            expected_source_sha=expected_source_sha, deadline_seconds=deadline - time.monotonic(),
        )
    except JobAlreadyRunningError:
        state.update(status="ready", dispatch_count=state["dispatch_count"] - 1)
        _save(bucket, path, state, claimed_generation, deadline)
        raise
    # Any other exception is ambiguous. Keep the durable claim; never dispatch
    # a replacement merely because a response or ledger write was interrupted.
    state.update(status="dispatched", execution_name=execution.execution_name)
    _save(bucket, path, state, claimed_generation, deadline)
    return execution
