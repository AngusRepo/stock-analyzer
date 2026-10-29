"""R17: durable pause/resume chain, gateway leg boundary, fail-closed reads (fake broker only)."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from services.execution_submission_control import (
    D1SubmissionControl,
    OPEN,
    PAUSED,
    SubmissionControlConflict,
    row_sha256,
)
from services.finlab_execution_gateway import LiveSubmissionBlocked, PersistentFinlabExecutionGateway
from test_finlab_execution_gateway import Repository, _env

MIGRATION = Path(__file__).resolve().parents[2] / "worker/domain-migrations/execution/0005_live_submission_control.sql"
NOW = datetime(2026, 12, 9, 1, 0, tzinfo=timezone.utc)
RECEIPT = "a" * 64


def _approval_env(**overrides):
    values = {
        "LIVE_TRADING_APPROVAL_SCOPE": "wei-live-2026-12",
        "LIVE_TRADING_APPROVAL_EXPIRES_AT": (NOW + timedelta(days=7)).isoformat(),
        "LIVE_GATE_RECEIPT_SHA256": RECEIPT,
    }
    values.update(overrides)
    return values


def _control(env=None, now=NOW):
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(MIGRATION.read_text())

    def query(sql, params, timeout):
        return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def execute(sql, params, timeout):
        conn.execute(sql, params)
        conn.commit()
        return {"success": True}

    clock = {"now": now}
    control = D1SubmissionControl(query=query, execute=execute,
                                  env=_approval_env() if env is None else env, now=lambda: clock["now"])
    return control, conn, clock


def _resume(control, **overrides):
    args = {"request_id": "resume-1", "actor": "admin:wei", "reason": "R4 gate passed",
            "approval_scope": "wei-live-2026-12",
            "approval_expires_at": (NOW + timedelta(days=7)).isoformat(),
            "gate_receipt_sha256": RECEIPT}
    args.update(overrides)
    return control.resume(**args)


def test_live_starts_paused_from_the_migration_seed():
    control, _, _ = _control()
    state = control.state()
    assert state["status"] == PAUSED and state["reason"] == "paused" and state["durable_pause"] is True
    assert state["receipt"]["request_id"] == "initial_seed"
    assert state["receipt"]["sha256"] == row_sha256(control._chain()[-1])


def test_no_receipt_carries_the_approval_values():
    control, _, _ = _control()
    opened = _resume(control)
    paused = control.pause(request_id="p-1", actor="wei", reason="stop")
    for receipt in (opened["receipt"], opened["resume_receipt"], paused["receipt"], control.state()["receipt"]):
        assert set(receipt) == {"sequence", "action", "request_id", "actor", "created_at", "previous_sha256", "sha256"}
    text = repr((opened, paused, control.state()))
    assert "approval_scope" not in text and "gate_receipt_sha256" not in text and "approval_expires_at" not in text
    assert control.closed_reason() == "live_submission_paused:paused"


def test_resume_needs_matching_scope_expiry_and_gate_receipt_then_pause_closes_again():
    control, conn, _ = _control()
    for bad in ({"approval_scope": "other"}, {"gate_receipt_sha256": "b" * 64},
                {"gate_receipt_sha256": "not-a-sha"},
                {"approval_expires_at": (NOW + timedelta(days=8)).isoformat()}):
        with pytest.raises(SubmissionControlConflict):
            _resume(control, **bad)
    assert control.state()["status"] == PAUSED
    opened = _resume(control)
    assert opened["status"] == OPEN and opened["resume_receipt"]["action"] == "resume"
    assert control.closed_reason() is None
    # Replaying the same resume adds nothing; a second resume while open is refused.
    assert _resume(control)["resume_receipt"] == opened["resume_receipt"]
    with pytest.raises(SubmissionControlConflict, match="not_paused"):
        _resume(control, request_id="resume-2")
    paused = control.pause(request_id="pause-1", actor="admin:wei", reason="return to paper")
    assert paused["status"] == PAUSED and paused["existing_orders_and_positions"] == "preserved"
    # One-click pause is idempotent: no new row while already paused.
    again = control.pause(request_id="pause-2", actor="admin:wei", reason="second click")
    assert again["receipt"] == paused["receipt"]
    assert conn.execute("SELECT COUNT(*) FROM live_submission_control_v1").fetchone()[0] == 3
    with pytest.raises(SubmissionControlConflict, match="reused"):
        _resume(control, request_id="pause-1")


@pytest.mark.parametrize("env", [
    _approval_env(LIVE_TRADING_APPROVAL_SCOPE=""),
    _approval_env(LIVE_GATE_RECEIPT_SHA256=""),
    _approval_env(LIVE_TRADING_APPROVAL_EXPIRES_AT=""),
])
def test_resume_refused_when_any_deployed_approval_value_is_missing(env):
    control, _, _ = _control(env=env)
    with pytest.raises(SubmissionControlConflict):
        _resume(control, approval_scope=env["LIVE_TRADING_APPROVAL_SCOPE"] or "x",
                approval_expires_at=env["LIVE_TRADING_APPROVAL_EXPIRES_AT"] or (NOW + timedelta(days=7)).isoformat(),
                gate_receipt_sha256=env["LIVE_GATE_RECEIPT_SHA256"] or RECEIPT)
    assert control.state()["status"] == PAUSED


def test_expired_approval_cannot_resume_and_an_open_state_closes_at_expiry():
    expired = _approval_env(LIVE_TRADING_APPROVAL_EXPIRES_AT=(NOW - timedelta(seconds=1)).isoformat())
    control, _, _ = _control(env=expired)
    with pytest.raises(SubmissionControlConflict, match="expired"):
        _resume(control, approval_expires_at=expired["LIVE_TRADING_APPROVAL_EXPIRES_AT"])
    control, _, clock = _control()
    _resume(control)
    clock["now"] = NOW + timedelta(days=7)
    assert control.state()["reason"] == "live_approval_expired"
    assert control.closed_reason() is not None


@pytest.mark.parametrize("key,value", [
    ("LIVE_GATE_RECEIPT_SHA256", "c" * 64),
    ("LIVE_TRADING_APPROVAL_SCOPE", "wei-live-other"),
    # A shortened expiry must take effect even though the stored row allows longer.
    ("LIVE_TRADING_APPROVAL_EXPIRES_AT", (NOW + timedelta(days=1)).isoformat()),
])
def test_env_drift_after_resume_reads_as_lapsed_not_durably_paused(key, value):
    env = _approval_env()
    control, _, _ = _control(env=env)
    _resume(control)
    assert control.state()["status"] == OPEN
    env[key] = value
    genesis_pause = control.state()["last_pause_at"]
    assert control.state() | {"receipt": None} == {
        "status": PAUSED, "reason": "live_approval_changed_since_resume", "receipt": None,
        "durable_pause": False, "policy": "stop_new_live_orders_preserve_broker_lifecycle_v1",
        "last_pause_at": genesis_pause}
    assert control.closed_reason() is not None
    # The lapsed resume is not a stop: a pause still writes a durable row.
    paused = control.pause(request_id="pause-after-lapse", actor="admin", reason="stop")
    assert paused["receipt"]["action"] == "pause" and control.state()["durable_pause"] is True


def test_non_hex_gate_receipt_in_env_never_opens():
    bad = "z" * 64
    env = _approval_env(LIVE_GATE_RECEIPT_SHA256=bad)
    control, conn, _ = _control(env=env)
    with pytest.raises(SubmissionControlConflict, match="gate_receipt_invalid"):
        _resume(control, gate_receipt_sha256=bad)
    # Even a row written out of band with that receipt reads closed.
    seed = dict(conn.execute("SELECT * FROM live_submission_control_v1").fetchone())
    row = {"sequence": 2, "action": "resume", "request_id": "oob", "actor": "x", "reason": "x",
           "approval_scope": env["LIVE_TRADING_APPROVAL_SCOPE"],
           "approval_expires_at": env["LIVE_TRADING_APPROVAL_EXPIRES_AT"], "gate_receipt_sha256": bad,
           "created_at": NOW.isoformat(), "previous_sha256": seed["row_sha256"]}
    row["row_sha256"] = row_sha256(row)
    conn.execute(f"INSERT INTO live_submission_control_v1 ({','.join(row)}) VALUES ({','.join('?' * len(row))})",
                 list(row.values()))
    assert control.state()["reason"] == "live_approval_env_invalid"


def test_chain_that_does_not_start_with_a_pause_never_opens():
    control, conn, _ = _control()
    conn.execute("DROP TRIGGER live_submission_control_v1_no_delete")
    conn.execute("DROP TRIGGER live_submission_control_v1_append_only")
    conn.execute("DELETE FROM live_submission_control_v1")
    env = _approval_env()
    row = {"sequence": 1, "action": "resume", "request_id": "forged", "actor": "x", "reason": "x",
           "approval_scope": env["LIVE_TRADING_APPROVAL_SCOPE"],
           "approval_expires_at": env["LIVE_TRADING_APPROVAL_EXPIRES_AT"], "gate_receipt_sha256": RECEIPT,
           "created_at": NOW.isoformat(), "previous_sha256": "0" * 64}
    row["row_sha256"] = row_sha256(row)
    conn.execute(f"INSERT INTO live_submission_control_v1 ({','.join(row)}) VALUES ({','.join('?' * len(row))})",
                 list(row.values()))
    assert control.state()["reason"] == "live_submission_control_seed_invalid"
    assert control.closed_reason() is not None


def test_replaying_a_superseded_command_is_a_conflict_not_a_receipt():
    control, _, _ = _control()
    _resume(control)
    control.pause(request_id="pause-1", actor="admin", reason="stop")
    _resume(control, request_id="resume-2")
    assert control.state()["status"] == OPEN
    # A retried old pause must not report "paused" while Live is open.
    with pytest.raises(SubmissionControlConflict, match="superseded"):
        control.pause(request_id="pause-1", actor="admin", reason="stop")
    control.pause(request_id="pause-3", actor="admin", reason="stop")
    # Nor may a retried old resume report a resume while Live is paused.
    with pytest.raises(SubmissionControlConflict, match="superseded"):
        _resume(control, request_id="resume-2")
    assert control.state()["status"] == PAUSED


def test_tampered_empty_or_unreadable_chain_fails_closed():
    control, conn, _ = _control()
    _resume(control)
    # Simulate an out-of-band edit (triggers dropped) that rewrites history.
    conn.execute("DROP TRIGGER live_submission_control_v1_no_update")
    conn.execute("UPDATE live_submission_control_v1 SET reason='edited' WHERE sequence=2")
    assert control.state()["reason"] == "live_submission_control_chain_invalid"
    assert control.closed_reason() is not None
    empty, conn2, _ = _control()
    conn2.execute("DROP TRIGGER live_submission_control_v1_no_delete")
    conn2.execute("DELETE FROM live_submission_control_v1")
    assert empty.state()["reason"] == "live_submission_control_empty"
    broken, conn3, _ = _control()
    conn3.close()
    assert broken.state()["reason"] == "live_submission_control_unavailable"
    with pytest.raises(Exception):
        broken.pause(request_id="p", actor="a", reason="r")


def _submit(gateway, side="buy"):
    return gateway.submit_leg(symbol="4953", side=side, quantity=209, price=142,
                              odd_lot=True, exchange="TSE", client_tag="ABC123")


def test_gateway_blocks_every_side_while_paused_without_broker_login():
    control, _, _ = _control()
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    for side in ("buy", "sell"):
        with pytest.raises(LiveSubmissionBlocked, match="live_submission_paused:paused"):
            _submit(gateway, side)
    assert not gateway._started  # No broker login just to reject an order.


def test_pause_between_legs_blocks_later_legs_and_keeps_reconciling():
    control, _, _ = _control()
    _resume(control)
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    gateway._started, gateway._connected = True, True
    placed = []
    gateway._place_direct = lambda **kwargs: placed.append(kwargs) or "existing-order"
    gateway.health = lambda: {"healthy": True, "unhealthy_reason": None}
    gateway._trade_cache_degraded = lambda: False
    assert _submit(gateway) == "existing-order"
    control.pause(request_id="pause-1", actor="admin", reason="return to paper")
    for side in ("buy", "sell"):
        with pytest.raises(LiveSubmissionBlocked, match="paused"):
            _submit(gateway, side)
    assert len(placed) == 1
    # The pause never closes the broker session; fills for the earlier order still arrive.
    assert gateway._started and gateway._connected and not gateway._stop.is_set()
    gateway._on_fill(type("Fill", (), {"org_event": {
        "trade_id": "existing-order", "order_lot": "IntradayOdd", "quantity": 209,
    }})())
    assert gateway._events.get_nowait()[0] == "DEAL_CALLBACK"


def test_pause_landing_during_reconciliation_blocks_the_leg():
    control, _, _ = _control()
    _resume(control)
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    gateway._started, gateway._connected = True, True
    placed = []
    gateway._place_direct = lambda **kwargs: placed.append(kwargs) or "order"
    gateway.health = lambda: {"healthy": True, "unhealthy_reason": None}
    gateway._trade_cache_degraded = lambda: True
    gateway.reconcile_once = lambda: control.pause(request_id="p-mid", actor="admin", reason="stop")
    with pytest.raises(LiveSubmissionBlocked, match="paused"):
        _submit(gateway)
    assert placed == []


def test_pause_landing_during_broker_login_blocks_the_leg():
    control, _, _ = _control()
    _resume(control)
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=control)
    placed = []

    def login():
        control.pause(request_id="p-login", actor="admin", reason="stop")
        gateway._started, gateway._connected = True, True

    gateway.ensure_started = login
    gateway._place_direct = lambda **kwargs: placed.append(kwargs) or "order"
    gateway.health = lambda: {"healthy": True, "unhealthy_reason": None}
    gateway._trade_cache_degraded = lambda: False
    with pytest.raises(LiveSubmissionBlocked, match="paused"):
        _submit(gateway)
    assert placed == []


def test_durable_pause_is_false_when_open_or_unreadable():
    control, _, _ = _control()
    _resume(control)
    assert control.state()["status"] == OPEN and control.state()["durable_pause"] is False
    broken, conn, _ = _control()
    conn.close()
    assert broken.state()["durable_pause"] is False


def test_unreadable_control_blocks_gateway():
    class Broken:
        def closed_reason(self):
            raise RuntimeError("d1 down")

    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), submission_control=Broken())
    with pytest.raises(LiveSubmissionBlocked, match="control_unavailable"):
        _submit(gateway)


def test_default_control_requires_execution_domain_without_legacy_fallback():
    control = D1SubmissionControl(env={})
    assert control._query.__self__.domain.value == "execution"
    assert control._query.__self__.require_specific is True


def test_state_reports_when_the_latest_pause_was_written():
    """D-7: the intake blocks orders that became sendable before this pause, even after a resume."""
    control, _, clock = _control()
    first = control.state()["last_pause_at"]
    assert first is not None
    clock["now"] = NOW + timedelta(minutes=1)
    _resume(control)
    assert control.state()["last_pause_at"] == first
    clock["now"] = NOW + timedelta(minutes=2)
    control.pause(request_id="p-2", actor="admin", reason="stop")
    clock["now"] = NOW + timedelta(minutes=3)
    _resume(control, request_id="resume-2")
    state = control.state()
    assert state["status"] == OPEN and state["last_pause_at"] == (NOW + timedelta(minutes=2)).isoformat()
