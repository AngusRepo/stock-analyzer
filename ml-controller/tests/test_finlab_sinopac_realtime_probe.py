from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_sinopac_realtime_probe import (
    ProbeRecorder,
    run_probe,
    sinopac_env_status,
    summarize_events,
)


class _Tick:
    stock_id = "2330"
    price = 581.0
    volume = 2
    total_volume = 100
    time = datetime(2026, 5, 25, 1, 0, 0, tzinfo=timezone.utc)


class _BidAsk:
    stock_id = "2330"
    bid_prices_top5 = [580.0, 579.0, 0.0, 0.0, 0.0]
    bid_volumes_top5 = [100, 90, 0, 0, 0]
    ask_prices_top5 = [581.0, 582.0, 0.0, 0.0, 0.0]
    ask_volumes_top5 = [120, 130, 0, 0, 0]
    time = datetime(2026, 5, 25, 1, 0, 0, tzinfo=timezone.utc)


def _test_output_dir(name: str) -> Path:
    path = Path("ml-controller") / ".tmp" / "finlab_sinopac_probe_tests" / f"{name}-{time.time_ns()}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_sinopac_env_status_requires_broker_credentials(monkeypatch) -> None:
    monkeypatch.delenv("SHIOAJI_API_KEY", raising=False)
    monkeypatch.delenv("SHIOAJI_SECRET_KEY", raising=False)
    monkeypatch.delenv("SHIOAJI_API_SECRET", raising=False)
    monkeypatch.delenv("SHIOAJI_CERT_PASSWORD", raising=False)
    monkeypatch.delenv("SHIOAJI_CERT_PATH", raising=False)
    monkeypatch.delenv("SHIOAJI_CERT_PERSON_ID", raising=False)

    status = sinopac_env_status()

    assert status["ready"] is False
    assert "SHIOAJI_API_KEY" in status["missing"]
    assert "SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET" in status["missing"]


def test_probe_recorder_captures_tick_and_bidask_latency() -> None:
    output_dir = _test_output_dir("recorder")
    recorder = ProbeRecorder(run_id="test-run", output_dir=output_dir)

    recorder.record_tick(_Tick())
    recorder.record_bidask(_BidAsk())
    recorder.close()

    assert (output_dir / "events.jsonl").exists()
    assert len(recorder.events) == 2
    assert recorder.events[0].source_type == "tick"
    assert recorder.events[1].source_type == "bidask"
    assert recorder.events[1].best_bid == 580.0
    assert recorder.events[1].best_ask == 581.0
    summary = summarize_events(recorder.events)
    assert summary["event_count"] == 2
    assert "finlab_sinopac_realtime:tick:2330" in summary["counts"]


def test_run_probe_does_not_login_without_explicit_flag() -> None:
    called = {"factory": False}

    def factory():
        called["factory"] = True
        raise AssertionError("account factory should not be called")

    result = run_probe(
        symbols=["2330"],
        duration_seconds=0,
        output_dir=_test_output_dir("run-probe"),
        allow_broker_login=False,
        account_factory=factory,
    )

    assert result["status"] == "completed"
    assert result["finlab_realtime"] == "skipped"
    assert result["live_submit_enabled"] is False
    assert called["factory"] is False
