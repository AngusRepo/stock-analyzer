"""R17 controller routes: pause never needs approval; resume conflicts surface as 409; lost writes are unconfirmed."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

import routers.finlab as finlab
from services.execution_submission_control import SubmissionControlConflict


class FakeControl:
    def __init__(self, fail=None):
        self.fail = fail
        self.calls = []

    def pause(self, **kwargs):
        self.calls.append(("pause", kwargs))
        if self.fail:
            raise self.fail
        return {"status": "live_submission_paused", "receipt": {"sha256": "s"}}

    def resume(self, **kwargs):
        self.calls.append(("resume", kwargs))
        if self.fail:
            raise self.fail
        return {"status": "live_submission_open", "resume_receipt": {"sha256": "r"}}

    def state(self):
        return {"status": "live_submission_paused", "reason": "paused", "receipt": None}


def _use(monkeypatch, control):
    monkeypatch.setattr(finlab, "D1SubmissionControl", lambda: control)


def test_pause_route_needs_no_approval_and_lost_write_is_unconfirmed(monkeypatch):
    control = FakeControl()
    _use(monkeypatch, control)
    req = finlab.FinLabPaperReturnRequest(request_id="r1", actor="admin:1", reason="return")
    assert finlab.return_to_paper_route(req)["status"] == "live_submission_paused"
    assert control.calls == [("pause", {"request_id": "r1", "actor": "admin:1", "reason": "return"})]
    _use(monkeypatch, FakeControl(fail=TimeoutError("d1")))
    result = finlab.return_to_paper_route(req)
    assert result["pause_confirmed"] is False and result["status"] == "live_submission_paused"


def test_resume_route_maps_conflicts_to_409_and_forwards_every_approval_field(monkeypatch):
    req = {"request_id": "r2", "actor": "admin:1", "reason": "gate", "approval_scope": "s",
           "approval_expires_at": "2026-12-31T00:00:00+00:00", "gate_receipt_sha256": "a" * 64}
    control = FakeControl()
    _use(monkeypatch, control)
    assert finlab.resume_live(req)["status"] == "live_submission_open"
    assert control.calls[0][1]["gate_receipt_sha256"] == "a" * 64
    _use(monkeypatch, FakeControl(fail=SubmissionControlConflict("live_resume_approval_mismatch")))
    with pytest.raises(HTTPException) as exc:
        finlab.resume_live(req)
    assert exc.value.status_code == 409
    _use(monkeypatch, FakeControl(fail=RuntimeError("d1")))
    assert finlab.resume_live(req)["resume_confirmed"] is False


def test_resume_request_requires_full_sha():
    with pytest.raises(Exception):
        finlab.FinLabLiveResumeRequest(request_id="r", actor="a", reason="x", approval_scope="s",
                                       approval_expires_at="t", gate_receipt_sha256="short")


def test_invalid_resume_request_never_echoes_approval_values(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    control = FakeControl()
    _use(monkeypatch, control)
    app = FastAPI()
    app.include_router(finlab.router)
    client = TestClient(app)
    path = next(route.path for route in finlab.router.routes if route.path.endswith("/execution/resume"))
    secret_scope, secret_expiry, short_sha = "wei-scope-7c1", "2026-12-31T09:00:00+08:00", "f00d" * 8
    for body in ({"request_id": "r", "actor": "a", "reason": "x", "approval_scope": secret_scope,
                  "approval_expires_at": secret_expiry, "gate_receipt_sha256": short_sha},
                 {"approval_scope": secret_scope}, [secret_scope], secret_scope):
        response = client.post(path, json=body)
        assert response.status_code == 422 and response.json() == {"detail": "live_resume_request_invalid"}
    for raw in (b'{"approval_scope": "' + secret_scope.encode() + b'", ', b"approval_scope=" + secret_scope.encode(), b""):
        response = client.post(path, content=raw, headers={"Content-Type": "application/json"})
        assert response.status_code == 422
        text = response.text
        assert secret_scope not in text and secret_expiry not in text and short_sha not in text
        assert response.json() == {"detail": "live_resume_request_invalid"}
    assert control.calls == []
