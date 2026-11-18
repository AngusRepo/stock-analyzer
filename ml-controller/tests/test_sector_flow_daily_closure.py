import asyncio

import pytest
from fastapi import HTTPException

from routers import sector_flow as sector_flow_router
from services import sector_flow_service


def _closure_state(monkeypatch, *, runs, generations, claim_changes=1, writes=None):
    ops_calls, market_calls = [], []
    writes = [] if writes is None else writes

    def ops_query(sql, params=None):
        ops_calls.append((sql, params))
        return runs

    def market_query(sql, params=None):
        market_calls.append((sql, params))
        return generations

    def ops_execute(sql, params=None):
        writes.append((" ".join(sql.split()), params))
        return {"success": True, "meta": {"changes": claim_changes if "INSERT" in sql else 1}}

    monkeypatch.setattr(sector_flow_service.OPS_D1_CLIENT, "query", ops_query)
    monkeypatch.setattr(sector_flow_service.OPS_D1_CLIENT, "execute", ops_execute)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", market_query)
    return ops_calls, market_calls


def _forbid_pipeline(monkeypatch):
    def fail(*_args, **_kwargs):
        raise AssertionError("closed date must not be recomputed")

    monkeypatch.setattr(sector_flow_service, "run_sector_flow_pipeline", fail)


def test_closed_date_is_not_recomputed(monkeypatch):
    run_id = "sector-flow:2026-11-17:native:20261117T141000Z"
    ops_calls, market_calls = _closure_state(
        monkeypatch,
        runs=[{"run_id": run_id, "status": "pass", "reconstruction_mode": "native",
               "rows_written": 457, "completed_at": "2026-11-17 14:11:10"}],
        generations=[{"generation_id": run_id, "available_at": "2026-11-17T14:11:09+00:00", "row_count": 457}],
    )
    _forbid_pipeline(monkeypatch)

    summary = sector_flow_service.ensure_sector_flow_daily_closure("2026-11-17")

    assert summary["status"] == "already_complete"
    assert summary["closure"]["status"] == "complete"
    assert summary["rebuild_run_id"] == run_id
    assert ops_calls[0][1] == ["2026-11-17"]
    assert "status <> 'running'" in ops_calls[0][0]
    assert market_calls[0][1] == [run_id, "2026-11-17"]


@pytest.mark.parametrize("runs,generations", [
    ([], []),
    ([{"run_id": "r-failed", "status": "failed"}], [{"generation_id": "r-failed"}]),
    ([{"run_id": "r-pass", "status": "pass"}], []),
])
def test_unclosed_date_is_computed_once(monkeypatch, runs, generations):
    writes = []
    _closure_state(monkeypatch, runs=runs, generations=generations, writes=writes)
    calls = []

    def fake_pipeline(as_of_date, *, producer_position):
        calls.append((as_of_date, producer_position))
        return {"as_of_date": as_of_date, "closure": {"status": "complete", "failures": []}}

    monkeypatch.setattr(sector_flow_service, "run_sector_flow_pipeline", fake_pipeline)

    summary = sector_flow_service.ensure_sector_flow_daily_closure(
        "2026-11-17", producer_position="pre_screener_same_session",
    )

    assert summary["status"] == "computed"
    assert calls == [("2026-11-17", "pre_screener_same_session")]
    claim_id = writes[0][1][0]
    assert writes[0][0].startswith("INSERT INTO sector_flow_pit_rebuild_runs_v1") and "WHERE NOT EXISTS" in writes[0][0]
    assert writes[-1] == ("DELETE FROM sector_flow_pit_rebuild_runs_v1 WHERE run_id = ? AND status = 'running'", [claim_id])


def test_running_claim_refuses_a_concurrent_compute(monkeypatch):
    writes = []
    _closure_state(monkeypatch, runs=[], generations=[], claim_changes=0, writes=writes)
    _forbid_pipeline(monkeypatch)

    with pytest.raises(sector_flow_service.SectorFlowClosureInProgress):
        sector_flow_service.ensure_sector_flow_daily_closure("2026-11-17")

    assert len(writes) == 1, "a refused claim deletes nothing"


def test_claim_is_released_when_the_compute_fails(monkeypatch):
    writes = []
    _closure_state(monkeypatch, runs=[], generations=[], writes=writes)

    def failing_pipeline(as_of_date, *, producer_position):
        raise RuntimeError("sector_flow_pit_incomplete")

    monkeypatch.setattr(sector_flow_service, "run_sector_flow_pipeline", failing_pipeline)

    with pytest.raises(RuntimeError, match="sector_flow_pit_incomplete"):
        sector_flow_service.ensure_sector_flow_daily_closure("2026-11-17")

    assert writes[-1][0].startswith("DELETE FROM sector_flow_pit_rebuild_runs_v1")


def test_pipeline_tail_skips_a_date_closed_before_the_screener(monkeypatch):
    from graphs import daily_pipeline_v2

    run_id = "sector-flow:2026-11-17:native:20261117T141000Z"
    _closure_state(
        monkeypatch,
        runs=[{"run_id": run_id, "status": "pass"}],
        generations=[{"generation_id": run_id}],
    )
    _forbid_pipeline(monkeypatch)
    monkeypatch.setattr(daily_pipeline_v2, "_assert_pipeline_canonical_window", lambda state: None)

    result = asyncio.run(daily_pipeline_v2.node_compute_sector_flow({"run_date": "2026-11-17"}))

    assert result["sector_flow_summary"]["status"] == "already_complete"


def test_daily_closure_endpoint_marks_pre_screener_producer(monkeypatch):
    calls = []

    def fake_ensure(date, *, producer_position):
        calls.append((date, producer_position))
        return {"as_of_date": date, "status": "computed", "closure": {"status": "complete"}}

    monkeypatch.setattr(sector_flow_router, "_today_tw", lambda: "2026-11-18")
    monkeypatch.setattr(sector_flow_service, "ensure_sector_flow_daily_closure", fake_ensure)

    for date in ("2026-11-18", "2026-11-17"):
        result = asyncio.run(sector_flow_router.sector_flow_daily_closure(
            sector_flow_router.SectorFlowDailyClosureRequest(date=date),
        ))
        assert result["status"] == "computed"

    assert calls == [("2026-11-18", "pre_screener_same_session"), ("2026-11-17", "pre_screener_same_session")]


def test_daily_closure_endpoint_reports_a_running_claim_as_conflict(monkeypatch):
    def fake_ensure(date, *, producer_position):
        raise sector_flow_service.SectorFlowClosureInProgress("sector_flow_closure_in_progress:2026-11-18")

    monkeypatch.setattr(sector_flow_router, "_today_tw", lambda: "2026-11-18")
    monkeypatch.setattr(sector_flow_service, "ensure_sector_flow_daily_closure", fake_ensure)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(sector_flow_router.sector_flow_daily_closure(
            sector_flow_router.SectorFlowDailyClosureRequest(date="2026-11-18"),
        ))

    assert exc.value.status_code == 409


@pytest.mark.parametrize("date", ["2026-11-19", "2026-11-16", "2026-02-30", "20261118", "2026-11-18T00:00"])
def test_daily_closure_endpoint_rejects_invalid_or_future_dates(monkeypatch, date):
    monkeypatch.setattr(sector_flow_router, "_today_tw", lambda: "2026-11-18")
    _forbid_pipeline(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(sector_flow_router.sector_flow_daily_closure(
            sector_flow_router.SectorFlowDailyClosureRequest(date=date),
        ))

    assert exc.value.status_code == 422


def test_daily_closure_endpoint_fails_closed(monkeypatch):
    def fake_ensure(date, *, producer_position):
        raise RuntimeError("sector_flow_pit_incomplete")

    monkeypatch.setattr(sector_flow_router, "_today_tw", lambda: "2026-11-18")
    monkeypatch.setattr(sector_flow_service, "ensure_sector_flow_daily_closure", fake_ensure)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(sector_flow_router.sector_flow_daily_closure(
            sector_flow_router.SectorFlowDailyClosureRequest(date="2026-11-18"),
        ))

    assert exc.value.status_code == 500
    assert "sector_flow_pit_incomplete" in exc.value.detail
