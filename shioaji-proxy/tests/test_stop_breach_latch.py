from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_proxy_main():
    path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("shioaji_proxy_stop_latch", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _tick(price: float, timestamp: str) -> dict:
    return {
        "price": price,
        "timestamp": timestamp,
        "updated_at": timestamp,
        "session_epoch": 7,
    }


def test_v_shape_stop_breach_is_latched_once_and_never_reverts(monkeypatch):
    proxy = _load_proxy_main()
    proxy.stop_watches.clear()
    proxy.stop_breaches.clear()
    dispatched: list[dict] = []
    monkeypatch.setattr(proxy._stop_breach_dispatch_executor, "submit", lambda fn, payload: dispatched.append(payload))
    proxy.stop_watches["4541"] = {
        "intent_key": "1:4541:2026-07-13:2000:72.8000:full_sell",
        "account_id": 1,
        "symbol": "4541",
        "entry_date": "2026-07-13",
        "requested_shares": 2000,
        "stop_price": 72.8,
        "stop_version": "72.8000",
        "expires_at_epoch": proxy.time.time() + 60,
    }

    assert proxy._latch_stop_breach("4541", _tick(73.0, "2026-07-16T09:00:01+08:00")) is None
    breached = proxy._latch_stop_breach("4541", _tick(72.7, "2026-07-16T09:00:02+08:00"))
    assert breached is not None
    assert breached["trigger_price"] == 72.7
    assert breached["trigger_time"] == "2026-07-16T09:00:02+08:00"
    assert breached["session_epoch"] == 7

    assert proxy._latch_stop_breach("4541", _tick(73.2, "2026-07-16T09:00:03+08:00")) is None
    persisted = proxy.stop_breaches[breached["intent_key"]]
    assert persisted["trigger_price"] == 72.7
    assert persisted["trigger_time"] == "2026-07-16T09:00:02+08:00"
    assert len(dispatched) == 1
