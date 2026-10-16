from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from types import SimpleNamespace as NS

from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import run_v2
import pytest

from services import active8_daily_dispatch_guard as guard
from services.cloud_run_jobs_client import CloudRunJobsClient, JobAlreadyRunningError, JobExecution

DAY = "2026-10-16"
PARENT = "projects/p/locations/r/jobs/active8-oof-materialize"
SOURCE = "a" * 40
PATH = f"operations/active8-daily-dispatch/v1/{DAY}/state.json"


class Bucket:
    def __init__(self):
        self.values = {}
        self.serial = 0
        self.before_write = None

    def blob(self, path):
        bucket = self

        class Blob:
            generation = None

            def reload(self, **kwargs):
                if path not in bucket.values:
                    raise NotFound("fixture missing")
                self.generation = bucket.values[path][0]

            def download_as_bytes(self, *, if_generation_match, **kwargs):
                current, value = bucket.values[path]
                assert current == if_generation_match
                return value

            def upload_from_string(self, raw, *, if_generation_match, **kwargs):
                if bucket.before_write:
                    callback, bucket.before_write = bucket.before_write, None
                    callback(path, raw)
                current = bucket.values.get(path, (0, None))[0]
                if current != if_generation_match:
                    raise PreconditionFailed("fixture CAS collision")
                bucket.serial += 1
                bucket.values[path] = (bucket.serial, raw.encode())

        return Blob()

    def state(self):
        return json.loads(self.values[PATH][1])


def execution(name="one", state="running", day=DAY, claim="", cadence="daily"):
    condition = {"running": run_v2.Condition.State.CONDITION_PENDING,
                 "failed": run_v2.Condition.State.CONDITION_FAILED,
                 "succeeded": run_v2.Condition.State.CONDITION_SUCCEEDED,
                 "unknown": run_v2.Condition.State.CONDITION_PENDING}[state]
    env = {"OOF_MATERIALIZE_CADENCE": cadence, "OOF_MATERIALIZE_END_DATE": day,
           "OOF_MATERIALIZE_DISPATCH_CLAIM_ID": claim}
    return NS(name=f"{PARENT}/executions/{name}",
              template=NS(containers=[NS(env=[NS(name=k, value=v) for k, v in env.items()])]),
              create_time=datetime(2026, 10, 16, tzinfo=timezone.utc),
              completion_time=None if state == "running" else datetime(2026, 10, 16, 1, tzinfo=timezone.utc),
              conditions=[NS(type_="Completed", state=condition)])


class Client:
    _parent = PARENT

    def __init__(self, executions=()):
        self.executions = list(executions)
        self.dispatches = []
        self.lookups = []
        self.after_accept = None

    def _get_executions_client(self):
        return self

    def list_executions(self, request, **kwargs):
        assert kwargs["retry"] is None and 0 < kwargs["timeout"] <= 8
        self.lookups.append("list")
        return iter(self.executions)

    def get_execution(self, request, **kwargs):
        assert kwargs["retry"] is None and 0 < kwargs["timeout"] <= 8
        self.lookups.append("get")
        return next(e for e in self.executions if e.name == request.name)

    def run_job(self, **kwargs):
        assert 0 < kwargs["deadline_seconds"] <= 25
        self.dispatches.append(kwargs)
        env = kwargs["env_overrides"]
        value = execution(name=f"job-{len(self.dispatches)}", claim=env["OOF_MATERIALIZE_DISPATCH_CLAIM_ID"])
        self.executions.insert(0, value)
        if self.after_accept:
            self.after_accept()
        return JobExecution(value.name, value.name.rsplit("/", 1)[-1])


def dispatch(client, bucket, *, ticket="ticket-1", attempt=0):
    return guard.dispatch_daily_guarded(client, bucket, env_overrides={
        "OOF_MATERIALIZE_END_DATE": DAY, "OOF_MATERIALIZE_CADENCE": "daily",
        "OOF_MATERIALIZE_SCHEDULER_TICKET_ID": ticket,
        "OOF_MATERIALIZE_SCHEDULER_RUN_ID": ticket + ":run",
        "OOF_MATERIALIZE_CONTINUATION_ATTEMPT": str(attempt),
    }, expected_source_sha=SOURCE)


def test_provider_hard_failure_blocks_new_watchdog_tickets_without_dispatch():
    bucket, client = Bucket(), Client([execution(state="failed")])
    for ticket in ("watchdog-a", "watchdog-b", "snapshot-child"):
        with pytest.raises(guard.DailyDispatchBlocked, match="terminal_failure"):
            dispatch(client, bucket, ticket=ticket)
    assert client.dispatches == []
    assert bucket.state()["dispatch_count"] == 1


def test_running_is_observed_and_never_killed_or_redispatched():
    bucket, client = Bucket(), Client()
    first = dispatch(client, bucket)
    for ticket in ("same", "another"):
        with pytest.raises(JobAlreadyRunningError) as caught:
            dispatch(client, bucket, ticket=ticket)
        assert caught.value.execution == first
    assert len(client.dispatches) == 1
    assert client.lookups == ["list", "get", "get"]


def test_successful_original_owner_can_continue_with_exact_lineage():
    bucket, client = Bucket(), Client()
    dispatch(client, bucket)
    client.executions[0] = execution(name="job-1", state="succeeded")
    dispatch(client, bucket, ticket="original-child", attempt=4)
    saved = bucket.state()
    assert saved["dispatch_count"] == 2
    assert saved["scheduler_ticket_id"] == "original-child"
    assert saved["scheduler_run_id"] == "original-child:run"
    assert saved["continuation_attempt"] == "4"
    assert len(client.dispatches) == 2


def test_partial_dispatch_response_preserves_claim_and_finds_exact_provider_execution():
    bucket, client = Bucket(), Client()
    def lost_response():
        raise TimeoutError("fixture response lost after provider acceptance")
    client.after_accept = lost_response
    with pytest.raises(TimeoutError):
        dispatch(client, bucket)
    assert bucket.state()["status"] == "dispatching"
    with pytest.raises(JobAlreadyRunningError):
        dispatch(client, bucket, ticket="new-watchdog")
    assert len(client.dispatches) == 1


def test_unresolved_claim_does_not_expire_or_modify_inflight_owner():
    bucket, client = Bucket(), Client()
    def no_response():
        client.executions.clear()
        raise TimeoutError("fixture unknown dispatch outcome")
    client.after_accept = no_response
    with pytest.raises(TimeoutError):
        dispatch(client, bucket)
    before = bucket.values[PATH]
    with pytest.raises(guard.DailyDispatchBlocked, match="ambiguous"):
        dispatch(client, bucket, ticket="other")
    assert bucket.values[PATH] == before
    assert len(client.dispatches) == 1


def test_cas_contention_never_allocates_compute():
    bucket, client = Bucket(), Client()
    def race(path, raw):
        bucket.values[path] = (99, raw.encode())
    bucket.before_write = race
    with pytest.raises(guard.DailyDispatchBlocked, match="contended"):
        dispatch(client, bucket)
    assert client.dispatches == []


def test_cas_contention_after_bootstrap_has_one_dispatch_winner():
    bucket, client = Bucket(), Client()
    saved = {"schema_version": guard.SCHEMA, "business_date": DAY, "job": PARENT,
             "dispatch_count": 0, "status": "ready", "execution_name": "", "claim_id": ""}
    bucket.values[PATH] = (1, json.dumps(saved).encode())
    def race(path, raw):
        bucket.values[path] = (99, raw.encode())
    bucket.before_write = race
    with pytest.raises(guard.DailyDispatchBlocked, match="contended"):
        dispatch(client, bucket)
    assert client.dispatches == []


def test_partial_ledger_write_after_acceptance_does_not_duplicate_job():
    bucket, client = Bucket(), Client()
    def fail_next_write():
        def interrupted(path, raw):
            raise ConnectionError("fixture ledger write lost after provider acceptance")
        bucket.before_write = interrupted
    client.after_accept = fail_next_write
    with pytest.raises(ConnectionError):
        dispatch(client, bucket)
    assert bucket.state()["status"] == "dispatching"
    with pytest.raises(JobAlreadyRunningError):
        dispatch(client, bucket, ticket="replacement")
    assert len(client.dispatches) == 1


def test_expired_request_budget_cannot_allocate_compute():
    bucket, client = Bucket(), Client()
    with pytest.raises(TimeoutError, match="deadline"):
        guard.dispatch_daily_guarded(client, bucket, env_overrides={
            "OOF_MATERIALIZE_END_DATE": DAY, "OOF_MATERIALIZE_CADENCE": "daily"}, deadline_seconds=0)
    assert client.dispatches == []


def test_cross_date_and_other_cadence_failures_do_not_consume_this_day():
    bucket, client = Bucket(), Client([execution(state="failed", day="2026-10-15"),
                                      execution(state="failed", cadence="monthly")])
    dispatch(client, bucket)
    assert bucket.state()["dispatch_count"] == 1


def test_scan_budget_is_bounded_and_fails_closed():
    bucket, client = Bucket(), Client([execution(name=str(i), day="2026-10-15") for i in range(101)])
    with pytest.raises(guard.DailyDispatchBlocked, match="scan_budget"):
        dispatch(client, bucket)
    assert client.dispatches == []


def test_old_history_stops_at_taipei_day_boundary_without_false_budget_failure():
    old = execution(state="failed", day="2026-10-15")
    old.create_time = datetime(2026, 10, 15, 15, 59, tzinfo=timezone.utc)
    bucket, client = Bucket(), Client([old] * 200)
    dispatch(client, bucket)
    assert len(client.dispatches) == 1


def test_single_use_evidence_bound_repair_preserves_global_budget():
    bucket, client = Bucket(), Client([execution(state="failed")])
    with pytest.raises(guard.DailyDispatchBlocked):
        dispatch(client, bucket)
    generation, raw = bucket.values[PATH]
    repair = {"action": "resume_once", "authorized_by": "Wei", "state_generation": generation,
              "state_sha256": hashlib.sha256(raw).hexdigest(), "source_sha": SOURCE,
              "evidence_sha256": "b" * 64}
    bucket.serial += 1
    bucket.values[PATH.replace("state.json", "repair.json")] = (bucket.serial, json.dumps(repair).encode())
    dispatch(client, bucket)
    assert bucket.state()["dispatch_count"] == 2
    client.executions[0] = execution(name="job-1", state="failed")
    with pytest.raises(guard.DailyDispatchBlocked, match="terminal_failure"):
        dispatch(client, bucket, ticket="third-watchdog")
    assert len(client.dispatches) == 1


def test_ambiguous_dispatch_has_an_explicit_single_use_repair_path():
    bucket, client = Bucket(), Client()
    def no_response():
        client.executions.clear()
        raise TimeoutError("fixture provider outcome unknown")
    client.after_accept = no_response
    with pytest.raises(TimeoutError):
        dispatch(client, bucket)
    generation, raw = bucket.values[PATH]
    repair = {"action": "resume_once", "authorized_by": "Wei", "state_generation": generation,
              "state_sha256": hashlib.sha256(raw).hexdigest(), "source_sha": SOURCE,
              "evidence_sha256": "b" * 64}
    bucket.serial += 1
    bucket.values[PATH.replace("state.json", "repair.json")] = (bucket.serial, json.dumps(repair).encode())
    client.after_accept = None
    dispatch(client, bucket, ticket="reviewed-repair")
    assert bucket.state()["dispatch_count"] == 2
    assert len(client.dispatches) == 2


def test_daily_dispatch_budget_is_not_reset_by_new_ticket_or_repair():
    bucket, client = Bucket(), Client()
    saved = {"schema_version": guard.SCHEMA, "business_date": DAY, "job": PARENT,
             "dispatch_count": guard.MAX_DISPATCHES, "status": "ready", "execution_name": "", "claim_id": ""}
    bucket.values[PATH] = (1, json.dumps(saved).encode())
    with pytest.raises(guard.DailyDispatchBlocked, match="budget_exhausted"):
        dispatch(client, bucket, ticket="fresh-ticket")
    assert client.dispatches == []


def test_provider_date_mismatch_and_guard_unavailable_fail_closed():
    bucket, client = Bucket(), Client()
    dispatch(client, bucket)
    client.executions[0] = execution(name="job-1", day="2026-10-15")
    with pytest.raises(guard.DailyDispatchBlocked, match="date_mismatch"):
        dispatch(client, bucket)
    with pytest.raises(guard.DailyDispatchBlocked, match="unavailable"):
        dispatch(Client(), None)


def test_source_lookup_uses_same_deadline_and_no_sdk_retries(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr("time.monotonic", lambda: clock[0])
    observed = []
    class Jobs:
        def get_job(self, request, **kwargs):
            observed.append(("source", kwargs))
            clock[0] += 7
            return NS(template=NS(template=NS(containers=[NS(env=[NS(name="STOCKVISION_SOURCE_SHA", value=SOURCE)])])))
        def run_job(self, request, **kwargs):
            observed.append(("dispatch", kwargs))
            return NS(metadata=NS(name=PARENT + "/executions/new"))
    class Executions:
        def list_executions(self, request, **kwargs):
            observed.append(("active", kwargs))
            clock[0] += 7
            return []
    client = CloudRunJobsClient(project_id="p", region="r", job_name="active8-oof-materialize")
    client._client, client._executions_client = Jobs(), Executions()
    client.run_job(expected_source_sha=SOURCE, deadline_seconds=20)
    assert observed == [("source", {"timeout": 8.0, "retry": None}),
                        ("active", {"timeout": 8.0, "retry": None}),
                        ("dispatch", {"timeout": 6.0, "retry": None})]


def test_source_lookup_cannot_dispatch_after_deadline_exhausted(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr("time.monotonic", lambda: clock[0])
    class Jobs:
        def get_job(self, request, **kwargs):
            assert kwargs == {"timeout": 5.0, "retry": None}
            clock[0] = 6
            return NS(template=NS(template=NS(containers=[NS(env=[NS(name="STOCKVISION_SOURCE_SHA", value=SOURCE)])])))
        def run_job(self, **kwargs):
            pytest.fail("expired source lookup must never allocate compute")
    client = CloudRunJobsClient(project_id="p", region="r", job_name="active8-oof-materialize")
    client._client = Jobs()
    with pytest.raises(TimeoutError, match="active_lookup_deadline"):
        client.run_job(expected_source_sha=SOURCE, deadline_seconds=5)
