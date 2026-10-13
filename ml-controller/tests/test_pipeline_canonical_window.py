import asyncio
from datetime import datetime, timezone

import pytest

from services.pipeline_canonical_window import assert_canonical_window_open


class Response:
    status_code = 200

    def __init__(self, *, allowed: bool, reason: str):
        self.allowed = allowed
        self.reason = reason

    def json(self):
        return {
            "schema_version": "historical-learning-lineage-boundary-v1",
            "calendar_owner": "worker.schedulerPolicy.nextTwTradingDate",
            "boundary": {
                "signalDate": "2026-09-22",
                "allowed": self.allowed,
                "reason": self.reason,
            },
        }


def test_historical_pipeline_accepts_only_worker_verified_preopen_window(monkeypatch):
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example")
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "test-token")
    observed = []

    def worker_get(url, **kwargs):
        observed.append((url, kwargs["params"]))
        return Response(allowed=True, reason="pre_next_session_open_historical_write_window")

    assert_canonical_window_open(
        "2026-09-22", http_get=worker_get,
        now=datetime(2026, 9, 23, 0, 59, tzinfo=timezone.utc),
    )
    assert observed == [("https://worker.example/api/admin/historical-lineage-boundary",
                         {"task": "pipeline", "date": "2026-09-22"})]


def test_historical_pipeline_rejects_after_open_and_unverified_boundary(monkeypatch):
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example")
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "test-token")
    now = datetime(2026, 9, 23, 1, 1, tzinfo=timezone.utc)
    with pytest.raises(RuntimeError, match="pipeline_canonical_window_closed:next_executable_session_opened"):
        assert_canonical_window_open(
            "2026-09-22",
            http_get=lambda *args, **kwargs: Response(
                allowed=False, reason="next_executable_session_opened_use_snapshot_only_repair"),
            now=now,
        )
    monkeypatch.delenv("STOCKVISION_AUTH_TOKEN")
    with pytest.raises(RuntimeError, match="pipeline_canonical_window_worker_not_configured"):
        assert_canonical_window_open("2026-09-22", now=now)


@pytest.mark.parametrize('change', [None, 'scope', 'session', 'reason', 'allowed', 'owner', 'day', 'signal'])
def test_oct13_paper_recovery_requires_exact_worker_boundary(monkeypatch, change):
    monkeypatch.setenv('STOCKVISION_WORKER_URL', 'https://worker.example')
    monkeypatch.setenv('STOCKVISION_AUTH_TOKEN', 'test-token')
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'premarket_once_v1')
    day = '2026-10-12'
    now = datetime(2026, 10, 13, 15, 59, tzinfo=timezone.utc)
    boundary = dict(signalDate=day, allowed=True, scope='paper', nextSessionDate='2026-10-13',
                    reason='authorized_paper_recovery_20261013')
    if change == 'scope': boundary['scope'] = 'live'
    if change == 'session': boundary['nextSessionDate'] = '2026-10-14'
    if change == 'reason': boundary['reason'] = 'authorized_paper_recovery_20261012'
    if change == 'allowed': boundary['allowed'] = False
    if change == 'owner': monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER', 'other')
    if change == 'day': now = datetime(2026, 10, 14, 1, 0, tzinfo=timezone.utc)
    if change == 'signal': day = boundary['signalDate'] = '2026-10-09'
    class WorkerResponse:
        status_code = 200
        def json(self):
            return dict(schema_version='historical-learning-lineage-boundary-v1',
                        calendar_owner='worker.schedulerPolicy.nextTwTradingDate', boundary=boundary)
    invoke = lambda: assert_canonical_window_open(day, now=now, http_get=lambda *a, **k: WorkerResponse())
    if change:
        with pytest.raises(RuntimeError, match='pipeline_canonical_window_closed'):
            invoke()
    else:
        invoke()


@pytest.mark.parametrize("node_name", [
    "node_compute_personas", "node_write_d1", "node_paired_nav_setup",
    "node_compute_sector_flow", "node_compute_pit_residual_shadow",
    "node_export_dataset_snapshot",
])
def test_pipeline_write_nodes_stop_before_side_effects(node_name, monkeypatch):
    from graphs import daily_pipeline_v2 as pipeline

    def deny(_run_date):
        raise RuntimeError("pipeline_canonical_window_closed:test")

    monkeypatch.setattr(pipeline, "assert_canonical_window_open", deny)
    with pytest.raises(RuntimeError, match="pipeline_canonical_window_closed:test"):
        asyncio.run(getattr(pipeline, node_name)({"run_date": "2026-09-22"}))
