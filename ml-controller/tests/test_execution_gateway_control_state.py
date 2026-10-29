"""R19: the gateway exposes its own read of the R17 chain for deploy checks, without a broker login."""

from __future__ import annotations

import pytest


def test_gateway_submission_state_is_authenticated_read_only_and_never_shows_values(monkeypatch):
    import execution_gateway_app as app
    from fastapi import HTTPException

    monkeypatch.setattr(app, "SERVICE_ROLE", "dedicated_execution_gateway")
    monkeypatch.setattr(app, "SERVICE_TOKEN", "unit-test-control-token")
    monkeypatch.setenv("LIVE_TRADING_APPROVAL_SCOPE", "secret-scope-value")
    monkeypatch.delenv("LIVE_GATE_RECEIPT_SHA256", raising=False)
    monkeypatch.setenv("FINLAB_LIVE_SUBMIT_ENABLED", "0")

    class Control:
        def state(self):
            return {"status": "live_submission_paused", "reason": "paused", "durable_pause": True}

    monkeypatch.setattr(app.gateway, "submission_control", Control())
    monkeypatch.setattr(app.gateway, "ensure_started", lambda: pytest.fail("state read must not log in"))
    with pytest.raises(HTTPException) as error:
        app.submission_state(authorization=None)
    assert error.value.status_code == 401
    out = app.submission_state(authorization="Bearer unit-test-control-token")
    assert out["status"] == "live_submission_paused" and out["finlab_live_submit_enabled"] is False
    assert out["approval_values_present"] == {"LIVE_TRADING_APPROVAL_SCOPE": True,
                                              "LIVE_TRADING_APPROVAL_EXPIRES_AT": False,
                                              "LIVE_GATE_RECEIPT_SHA256": False}
    assert "secret-scope-value" not in repr(out)


def test_order_path_chain_read_is_bounded_inside_the_relay_budget():
    from services.execution_submission_control import order_path_read_timeout
    from services.finlab_execution_gateway import PersistentFinlabExecutionGateway
    from test_finlab_execution_gateway import Repository, _env

    assert order_path_read_timeout({}) == 1.0
    assert order_path_read_timeout({"LIVE_EXECUTION_CONTROL_READ_TIMEOUT_SECONDS": "30"}) == 2.0
    assert order_path_read_timeout({"LIVE_EXECUTION_CONTROL_READ_TIMEOUT_SECONDS": "0"}) == 0.25
    assert order_path_read_timeout({"LIVE_EXECUTION_CONTROL_READ_TIMEOUT_SECONDS": "x"}) == 1.0
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())
    assert gateway.submission_control._read_timeout == 1.0


def test_submission_state_never_returns_the_approval_values_from_the_chain(monkeypatch):
    import execution_gateway_app as app
    from test_execution_submission_control import RECEIPT, _control, _resume

    monkeypatch.setattr(app, "SERVICE_ROLE", "dedicated_execution_gateway")
    monkeypatch.setattr(app, "SERVICE_TOKEN", "unit-test-control-token")
    control, _, _ = _control()
    _resume(control)
    monkeypatch.setattr(app.gateway, "submission_control", control)
    out = app.submission_state(authorization="Bearer unit-test-control-token")
    assert out["status"] == "live_submission_open" and out["durable_pause"] is False
    assert set(out["receipt"]) == {"sequence", "action", "sha256"} and out["receipt"]["action"] == "resume"
    text = repr(out)
    assert "wei-live-2026-12" not in text and RECEIPT not in text
