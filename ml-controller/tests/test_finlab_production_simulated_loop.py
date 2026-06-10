from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.finlab_production_simulated_loop import (  # noqa: E402
    build_execution_loop_plan,
    run_production_simulated_execution_loop,
    run_production_simulated_loop_once,
)


def test_loop_plan_preserves_10s_polling_and_30s_technical_floor() -> None:
    plan = build_execution_loop_plan(
        duration_seconds=35,
        poll_seconds=10,
        rolling_bar_seconds=10,
        max_symbols=5,
    )

    assert plan["poll_seconds"] == 10
    assert plan["rolling_bar_seconds"] == 30
    assert plan["max_cycles"] == 4
    assert plan["paper_order_mode"] == "worker_intraday_check"
    assert plan["live_submit_enabled"] is False


def test_production_simulated_route_is_preferred_controller_contract() -> None:
    source = (ROOT / "routers" / "finlab.py").read_text(encoding="utf-8")

    assert '@router.post("/execution/production-simulated-loop")' in source
    assert "run_finlab_execution_production_simulated_loop_route" in source
    assert "broker submit stays disabled" in source


def test_production_simulated_loop_uses_internal_worker_endpoint_not_admin_trigger() -> None:
    source = (ROOT / "services" / "finlab_production_simulated_loop.py").read_text(encoding="utf-8")

    assert "/api/internal/execution/intraday-check" in source
    assert "/api/admin/trigger/intraday-check" not in source


def test_production_simulated_loop_once_records_l5_preview_and_reconciliation_events() -> None:
    events: list[dict] = []

    def pending_provider() -> list[dict]:
        return [
            {
                "symbol": "2330",
                "intent": {
                    "schemaVersion": "stockvision-order-intent-v1",
                    "symbol": "2330",
                    "side": "buy",
                    "liveSubmitRequested": False,
                    "requestedShares": 1000,
                    "maxPrice": 100.5,
                    "priceTick": 0.5,
                    "priceSnapMode": "floor_to_buy_limit",
                    "orderLegs": [
                        {
                            "lotType": "board_lot",
                            "shares": 1000,
                            "finlabQuantity": 1,
                            "finlabQuantityUnit": "lots",
                            "oddLot": False,
                            "orderLot": "common",
                        }
                    ],
                },
            }
        ]

    def l5_provider(symbols: list[str]) -> dict:
        return {"2330": {"status": "pass", "best_ask": 100.5, "best_bid": 100.3}}

    def preview_provider(intent: dict) -> dict:
        return {"status": "pass", "visible_reason": "broker preview passed", "can_submit_real_order": False}

    result = run_production_simulated_loop_once(
        pending_provider=pending_provider,
        l5_provider=l5_provider,
        preview_provider=preview_provider,
        event_sink=events.append,
    )

    assert result["status"] == "completed"
    assert result["symbols"] == ["2330"]
    assert [event["event_type"] for event in events] == [
        "finlab_l5_market_data",
        "finlab_execution_preview",
        "paper_broker_reconciliation",
    ]
    assert all(event["live_submit_enabled"] is False for event in events)


def test_production_simulated_loop_triggers_worker_intraday_check_every_10_seconds() -> None:
    calls: list[int] = []
    sleeps: list[float] = []

    async def worker_trigger(cycle_idx: int) -> dict:
        calls.append(cycle_idx)
        return {"ok": True, "status_code": 200, "body": {"success": True, "result": "paper simulated"}}

    async def sleep_fn(seconds: float) -> None:
        sleeps.append(seconds)

    import asyncio

    result = asyncio.run(run_production_simulated_execution_loop(
        duration_seconds=21,
        poll_seconds=10,
        rolling_bar_seconds=30,
        worker_trigger=worker_trigger,
        sleep_fn=sleep_fn,
    ))

    assert result["status"] == "completed"
    assert result["mode"] == "real_loop_simulated_order"
    assert result["paper_order_mode"] == "worker_intraday_check"
    assert result["live_submit_enabled"] is False
    assert result["can_submit_real_order"] is False
    assert calls == [0, 1, 2]
    assert len(sleeps) == 2


def test_production_simulated_loop_blocks_without_worker_config() -> None:
    import asyncio

    result = asyncio.run(run_production_simulated_execution_loop(
        duration_seconds=10,
        poll_seconds=10,
        worker_url="",
        worker_auth_token="",
    ))

    assert result["status"] == "blocked"
    assert result["reason"] == "stockvision_worker_url_missing"
    assert result["live_submit_enabled"] is False
    assert result["can_submit_real_order"] is False


def test_production_simulated_loop_treats_worker_application_failure_as_failed_cycle() -> None:
    async def worker_trigger(cycle_idx: int) -> dict:
        return {"ok": True, "status_code": 200, "body": {"success": False, "error": "paper gate failed"}}

    async def sleep_fn(seconds: float) -> None:
        return None

    import asyncio

    result = asyncio.run(run_production_simulated_execution_loop(
        duration_seconds=10,
        poll_seconds=10,
        worker_trigger=worker_trigger,
        sleep_fn=sleep_fn,
    ))

    assert result["status"] == "completed_with_errors"
    assert result["cycles_failed"] == 1
    assert result["cycles"][0]["status"] == "error"
