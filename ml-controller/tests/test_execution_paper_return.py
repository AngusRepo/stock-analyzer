"""Exercise the durable stop, leg boundary and authenticated private endpoint locally."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from services.execution_submission_control import D1SubmissionControl
from services.finlab_execution_gateway import LiveSubmissionBlocked, PersistentFinlabExecutionGateway
from test_finlab_execution_gateway import Repository, _env


def _control():
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript((Path(__file__).resolve().parents[2] / "worker/domain-migrations/execution/0005_live_submission_pause.sql").read_text())

    def query(sql, params, timeout):
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def execute(sql, params, timeout):
        conn.execute(sql, params)
        conn.commit()
        return {"success": True}

    return D1SubmissionControl(query=query, execute=execute), conn


def _submit(gateway):
    return gateway.submit_leg(symbol="4953", side="buy", quantity=209, price=142,
                              odd_lot=True, exchange="TSE", client_tag="ABC123")


def test_pause_survives_new_gateway_and_replay_preserves_first_receipt():
    control, conn = _control()
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    gateway.assert_live_submission_allowed()
    first = gateway.return_to_paper(request_id="r1", reason="operator return")
    assert first == gateway.return_to_paper(request_id="r2", reason="second click")
    restarted = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    with pytest.raises(LiveSubmissionBlocked, match="paused_by_paper_return"):
        _submit(restarted)
    assert not restarted._started  # No broker login just to reject an order.
    assert conn.execute("SELECT COUNT(*) FROM live_submission_pause").fetchone()[0] == 1


def test_unreadable_control_fails_before_broker_start_and_never_claims_return():
    control, conn = _control()
    conn.close()
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    with pytest.raises(LiveSubmissionBlocked, match="control_unavailable"):
        _submit(gateway)
    with pytest.raises(sqlite3.ProgrammingError):
        gateway.return_to_paper(request_id="r1", reason="operator return")
    assert not gateway._started


def test_return_serializes_with_current_leg_and_blocks_every_later_leg():
    control, _ = _control()
    repo = Repository()
    gateway = PersistentFinlabExecutionGateway(repo, env=_env(), submission_control=control)
    gateway._started, gateway._connected = True, True
    entered, release, pause_attempted, paused = (threading.Event() for _ in range(4))
    outcomes, failures = [], []

    def place(**kwargs):
        entered.set()
        assert release.wait(5)
        outcomes.append("first_order_ack")
        return "existing-order"

    def call(action):
        try:
            action()
        except BaseException as exc:
            failures.append(exc)

    def pause():
        pause_attempted.set()
        gateway.return_to_paper(request_id="r1", reason="operator return")
        outcomes.append("pause_receipt")
        paused.set()

    gateway._place_direct = place
    current = threading.Thread(target=lambda: call(lambda: _submit(gateway)))
    returning = threading.Thread(target=lambda: call(pause))
    current.start()
    assert entered.wait(5)
    returning.start()
    assert pause_attempted.wait(5)
    assert not paused.is_set()
    release.set()
    current.join(5)
    returning.join(5)
    assert not current.is_alive() and not returning.is_alive() and not failures
    assert outcomes == ["first_order_ack", "pause_receipt"]
    for side in ("buy", "sell"):
        with pytest.raises(LiveSubmissionBlocked, match="paused_by_paper_return"):
            gateway.submit_leg(symbol="4953", side=side, quantity=1, price=142,
                               odd_lot=False, exchange="TSE", client_tag="ABC123")
    assert gateway._started and gateway._connected and not gateway._stop.is_set()
    # The control never closes the broker session or changes pending orders.
    gateway._on_fill(type("Fill", (), {"org_event": {
        "trade_id": "existing-order", "order_lot": "IntradayOdd", "quantity": 209,
    }})())
    assert gateway._events.get_nowait()[0] == "DEAL_CALLBACK"


def test_private_endpoint_requires_auth_and_never_exposes_resume(monkeypatch):
    from fastapi.testclient import TestClient
    import execution_gateway_app as api

    control, _ = _control()
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    monkeypatch.setattr(api, "gateway", gateway)
    monkeypatch.setattr(api, "SERVICE_ROLE", "dedicated_execution_gateway")
    monkeypatch.setattr(api, "SERVICE_TOKEN", "unit-test-token")
    client = TestClient(api.app)
    body = {"request_id": "r1", "reason": "operator return"}
    assert client.post("/v1/control/return-to-paper", json=body).status_code == 401
    assert control.paused_receipt() is None
    response = client.post("/v1/control/return-to-paper", json=body,
                           headers={"Authorization": "Bearer unit-test-token"})
    assert response.status_code == 200
    assert response.json()["existing_orders_and_positions"] == "preserved"
    readback = client.get("/v1/control/submission-state", headers={"Authorization": "Bearer unit-test-token"})
    assert readback.status_code == 200
    assert readback.json()["receipt"] == response.json()["receipt"]
    assert readback.json()["live_admission_granted"] is False
    assert client.post("/v1/control/resume-live").status_code == 404


def test_submission_control_requires_execution_domain_without_legacy_fallback():
    control = D1SubmissionControl()
    assert control._query.__self__.domain.value == "execution"
    assert control._query.__self__.require_specific is True
