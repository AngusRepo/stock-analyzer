from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.broker_execution_contract import sign_packet  # noqa: E402
from services.finlab_execution_shadow_service import run_finlab_execution_shadow  # noqa: E402


NOW = datetime(2026, 7, 13, 1, 1, tzinfo=timezone.utc)


class ReadOnlyRepo:
    def __init__(self) -> None:
        self.daily_reads = 0

    def daily_side_order_count(self, trade_date: str, side: str) -> int:
        self.daily_reads += 1
        return 0


class BrokerGateway:
    def __init__(self) -> None:
        self.truth_reads = 0
        self.submit_calls = 0

    def revalidate_broker_truth(self, *, symbol: str):
        self.truth_reads += 1
        return {"account_match": True, "available_cash": 2_000_000, "position_shares": 5000}

    def submit_leg(self, **kwargs):
        self.submit_calls += 1
        raise AssertionError("shadow must never submit")


def _env(*, broker_read: bool = False) -> dict[str, str]:
    return {
        "LIVE_EXECUTION_SHADOW_ENABLED": "1",
        "LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED": "1" if broker_read else "0",
        "LIVE_EXECUTION_SHADOW_SCOPE": "paper-parity-v1",
        "LIVE_EXECUTION_HMAC_SECRET": "shadow-secret",
        "EXECUTION_GATEWAY_SERVICE_ROLE": "dedicated_execution_gateway",
        "LIVE_EXECUTION_MAX_PACKET_AGE_SECONDS": "5",
        "LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS": "500",
    }


def _risk() -> dict:
    return {
        "system": {"killSwitch": False},
        "order": {
            "maxSingleOrderValue": 1_000_000,
            "maxDailyBuyOrders": 5,
            "maxDailySellOrders": 10,
            "maxPriceDeviationPct": 0.07,
        },
    }


def _packet() -> dict:
    return {
        "schema_version": "stockvision-execution-shadow-packet-v1",
        "idempotency_key": "shadow-4953-sell-20260713-001",
        "trade_date": "2026-07-13",
        "generated_at": NOW.isoformat(),
        "expires_at": (NOW + timedelta(seconds=3)).isoformat(),
        "shadow_scope": "paper-parity-v1",
        "controls": {
            "risk_checks_passed": True,
            "kill_switch_active": False,
            "market_session_open": True,
            "trading_day_confirmed": True,
            "market_phase": "continuous",
        },
        "intent": {
            "schemaVersion": "stockvision-order-intent-v1",
            "accountId": 1,
            "tradeDate": "2026-07-13",
            "symbol": "4953",
            "side": "sell",
            "liveSubmitRequested": False,
            "requestedShares": 1200,
            "limitPrice": 142,
            "minPrice": 142,
            "maxPrice": 142,
            "orderLegs": [
                {"lotType": "board_lot", "shares": 1000, "finlabQuantity": 1, "oddLot": False},
                {"lotType": "odd_lot", "shares": 200, "finlabQuantity": 200, "oddLot": True},
            ],
        },
        "execution_snapshots": {
            lot: {
                "schema_version": "authoritative_execution_snapshot_v1",
                "status": "ready",
                "lot_type": lot,
                "selected_source": "shioaji_hub",
                "age_ms": 100,
                "bid": 142.5,
                "ask": 143.0,
            }
            for lot in ("board_lot", "odd_lot")
        },
        "market_reference": {"reference_price": 142, "limit_up": 156, "limit_down": 128},
    }


def _run(packet: dict, *, broker_read: bool = False, gateway=None):
    env = _env(broker_read=broker_read)
    return run_finlab_execution_shadow(
        packet=packet,
        signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]),
        env=env,
        repository=ReadOnlyRepo(),  # type: ignore[arg-type]
        gateway=gateway,
        risk_loader=_risk,
        snapshot_revalidator=lambda _: {"errors": [], "observations": {"board_lot": {}, "odd_lot": {}}},
        now=NOW,
    )


def test_market_shadow_is_partial_without_broker_login_or_ledger_mutation() -> None:
    gateway = BrokerGateway()
    result = _run(_packet(), gateway=gateway)
    assert result["status"] == "partial"
    assert result["reason"] == "broker_truth_shadow_disabled"
    assert result["ledger_mutation"] is False
    assert result["can_submit_real_order"] is False
    assert gateway.truth_reads == 0
    assert gateway.submit_calls == 0


def test_read_only_broker_shadow_can_pass_but_never_submit() -> None:
    gateway = BrokerGateway()
    result = _run(_packet(), broker_read=True, gateway=gateway)
    assert result["status"] == "pass"
    assert result["broker_login_used"] is True
    assert result["can_submit_real_order"] is False
    assert gateway.truth_reads == 1
    assert gateway.submit_calls == 0


def test_lot_type_mismatch_fails_closed() -> None:
    packet = _packet()
    packet["execution_snapshots"]["odd_lot"]["lot_type"] = "board_lot"
    result = _run(packet)
    assert result["status"] == "blocked"
    assert "execution_snapshot_lot_type_mismatch:odd_lot" in result["blocked_reasons"]


def test_shadow_disabled_stops_before_control_plane() -> None:
    result = run_finlab_execution_shadow(packet=_packet(), signature="bad", env={"LIVE_EXECUTION_SHADOW_ENABLED": "0"})
    assert result["reason"] == "execution_shadow_disabled"
