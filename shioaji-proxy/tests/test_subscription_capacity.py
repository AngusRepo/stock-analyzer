from __future__ import annotations

import importlib.util
import time
from datetime import datetime
from pathlib import Path


def _load_proxy_main():
    path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("shioaji_proxy_subscription_cap", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_orderbook_watch_capacity_is_a_hard_admission_limit(monkeypatch):
    proxy = _load_proxy_main()
    proxy.watched_orderbook_symbols.clear()
    proxy.orderbook_watch_rejections.clear()
    monkeypatch.setenv("SHIOAJI_MAX_ORDERBOOK_WATCH_SYMBOLS", "2")

    accepted = proxy.watch_orderbook_symbols(["2330", "2317", "2454"])

    assert accepted == ["2330", "2317"]
    assert sorted(proxy.watched_orderbook_symbols) == ["2317", "2330"]
    assert proxy.orderbook_watch_rejections["board_lot:2454"]["reason"] == "watch_capacity_exceeded"


def test_rejected_symbol_never_reaches_subscription_recovery(monkeypatch):
    proxy = _load_proxy_main()
    proxy.watched_orderbook_symbols.clear()
    proxy.orderbook_watch_rejections.clear()
    proxy.subscription_recovery.clear()
    proxy._quote_session_up = True
    monkeypatch.setenv("SHIOAJI_MAX_ORDERBOOK_WATCH_SYMBOLS", "1")
    proxy.watch_orderbook_symbols(["2330"])
    monkeypatch.setattr(
        proxy,
        "subscribe_symbol",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("rejected symbol must not subscribe")),
    )

    proxy.recover_orderbook_symbol("2454", "watchdog_waiting_callback")

    assert "board_lot:2454" not in proxy.subscription_recovery


def test_after_close_health_quiesces_waiting_and_recovery(monkeypatch):
    proxy = _load_proxy_main()
    proxy.watched_orderbook_symbols.clear()
    proxy.last_bidasks.clear()
    proxy.subscription_recovery.clear()
    proxy.watched_orderbook_symbols["0050"] = time.time() + 60
    proxy.subscription_recovery["board_lot:0050"] = {
        "consecutive_failures": 4,
        "next_attempt_at": time.time() + 60,
        "inflight": False,
        "last_reason": "watchdog_waiting_callback",
    }
    monkeypatch.setattr(proxy, "is_market_hours", lambda: False)

    watch = proxy.orderbook_health_summary()
    recovery = proxy.orderbook_recovery_health_summary()

    assert watch["waiting_bidasks"] == 0
    assert watch["deferred_bidasks"] == 1
    assert watch["samples"][0]["status"] == "market_closed"
    assert recovery["active_recoveries"] == 0
    assert recovery["backoff_symbols"] == 0
    assert recovery["status"] == "deferred_until_market_open"


def test_after_close_finish_resets_failure_backoff(monkeypatch):
    proxy = _load_proxy_main()
    proxy.subscription_recovery["board_lot:0050"] = {
        "consecutive_failures": 4,
        "next_attempt_at": time.time() + 60,
        "inflight": True,
        "last_reason": "watchdog_waiting_callback",
    }
    monkeypatch.setattr(proxy, "is_market_hours", lambda: False)

    proxy._finish_orderbook_recovery("0050")

    state = proxy.subscription_recovery["board_lot:0050"]
    assert state["inflight"] is False
    assert state["consecutive_failures"] == 0
    assert state["next_attempt_at"] == 0.0
    assert state["last_reason"] == "deferred_until_market_open"
