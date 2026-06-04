from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import finlab  # noqa: E402


def test_finlab_execution_smoke_route_defaults_to_no_broker_login(monkeypatch):
    captured: dict = {}

    def fake_smoke(**kwargs):
        captured.update(kwargs)
        return {"status": "blocked", "blocked_reasons": ["broker_login_not_allowed"]}

    monkeypatch.setattr(finlab, "run_finlab_execution_smoke", fake_smoke)

    result = asyncio.run(finlab.run_finlab_execution_smoke_route(finlab.FinLabExecutionSmokeRequest()))

    assert result["status"] == "blocked"
    assert captured["allow_broker_login"] is False
    assert captured["preview_noop"] is True


def test_finlab_execution_smoke_route_can_explicitly_allow_broker_login(monkeypatch):
    captured: dict = {}

    def fake_smoke(**kwargs):
        captured.update(kwargs)
        return {"status": "pass", "can_submit_real_order": False}

    monkeypatch.setattr(finlab, "run_finlab_execution_smoke", fake_smoke)

    req = finlab.FinLabExecutionSmokeRequest(allow_broker_login=True, preview_noop=False)
    result = asyncio.run(finlab.run_finlab_execution_smoke_route(req))

    assert result["status"] == "pass"
    assert captured["allow_broker_login"] is True
    assert captured["preview_noop"] is False
