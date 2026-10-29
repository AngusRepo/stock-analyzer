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


def _live_config(mode: str = "paper") -> dict:
    return {
        "schema_version": "live-config-v1",
        "mode": mode,
        "capital_source": "broker_nav_authoritative_marks",
        "session": {"timezone": "Asia/Taipei", "continuous_open": "09:00", "continuous_close": "13:30",
                    "deferred_sell_release": "09:00"},
        "freshness": {"max_packet_age_seconds": 5, "max_snapshot_age_ms": 500, "max_broker_truth_age_seconds": 5},
        "pause": {"enabled": False, "daily_loss_pct": None, "cumulative_drawdown_pct": None},
    }


def _fees() -> dict:
    return {"commission": 0.001425, "tax": 0.003, "dayTradeTax": 0.0015, "minCommission": 20}


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


def _run(packet: dict, *, broker_read: bool = False, gateway=None, live_config=_live_config, fees=_fees,
         env_overrides: dict | None = None, snapshot_revalidator=None):
    env = {**_env(broker_read=broker_read), **(env_overrides or {})}
    return run_finlab_execution_shadow(
        packet=packet,
        signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]),
        env=env,
        repository=ReadOnlyRepo(),  # type: ignore[arg-type]
        gateway=gateway,
        risk_loader=_risk,
        live_config_loader=live_config,
        fees_loader=fees,
        snapshot_revalidator=snapshot_revalidator
        or (lambda _: {"errors": [], "observations": {"board_lot": {}, "odd_lot": {}}}),
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


# --- trading:live_config / trading:config.fees (plan §4.5, D-5) ---

def test_shadow_runs_in_paper_mode_but_needs_a_valid_live_config() -> None:
    assert _run(_packet())["status"] == "partial"  # mode 'paper' is fine for a non-mutating shadow
    result = _run(_packet(), live_config=lambda: None)
    assert result["status"] == "blocked" and "live_config_unavailable" in result["blocked_reasons"]


def test_shadow_session_and_freshness_come_from_live_config() -> None:
    config = _live_config()
    config["session"] = {**config["session"], "continuous_close": "09:00", "deferred_sell_release": "09:00"}
    result = _run(_packet(), live_config=lambda: config)  # NOW is 09:01 Taiwan time
    assert "runtime_market_session_closed" in result["blocked_reasons"]
    config = _live_config()
    config["freshness"] = {**config["freshness"], "max_snapshot_age_ms": 50}
    result = _run(_packet(), live_config=lambda: config)
    assert any(r.startswith("execution_snapshot_stale:") for r in result["blocked_reasons"])


def test_shadow_hub_revalidation_gets_the_effective_snapshot_age(monkeypatch) -> None:
    import services.finlab_execution_shadow_service as service

    seen: list[int] = []

    def fake(packet, *, env=None, post_fn=None, max_snapshot_age_ms=None):
        seen.append(max_snapshot_age_ms)
        return {"errors": [], "observations": {}}

    monkeypatch.setattr(service, "revalidate_authoritative_snapshots", fake)
    packet = _packet()
    env = {**_env(), "LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS": "450"}
    result = run_finlab_execution_shadow(
        packet=packet, signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]), env=env,
        repository=ReadOnlyRepo(), risk_loader=_risk, live_config_loader=_live_config,  # type: ignore[arg-type]
        fees_loader=_fees, now=NOW,
    )
    assert result["status"] == "partial" and seen == [450]


def _buy_packet() -> dict:
    packet = _packet()
    packet["intent"].update(side="buy", limitPrice=143, minPrice=143, maxPrice=143)
    return packet


def test_shadow_broker_cash_check_fails_closed_without_fees() -> None:
    assert _run(_buy_packet(), broker_read=True, gateway=BrokerGateway())["status"] == "pass"
    result = _run(_buy_packet(), broker_read=True, gateway=BrokerGateway(), fees=lambda: None)
    assert result["blocked_reasons"] == ["trading_fees_unavailable"]


def test_shadow_sell_does_not_read_fees() -> None:
    def fees():
        raise AssertionError("a sell needs no fee owner")

    assert _run(_packet(), broker_read=True, gateway=BrokerGateway(), fees=fees)["status"] == "pass"


def test_shadow_broker_cash_check_includes_the_minimum_commission() -> None:
    class Cash(BrokerGateway):
        def __init__(self, cash: float) -> None:
            super().__init__()
            self.cash = cash

        def revalidate_broker_truth(self, *, symbol: str):
            return {**super().revalidate_broker_truth(symbol=symbol), "available_cash": self.cash}

    packet = _buy_packet()
    packet["intent"].update(requestedShares=10, orderLegs=[
        {"lotType": "odd_lot", "shares": 10, "finlabQuantity": 10, "oddLot": True}])
    # 1430 notional + max(2.04, 20) commission = 1450; the old 1.005 buffer accepted 1440.
    assert _run(packet, broker_read=True, gateway=Cash(1440))["blocked_reasons"] == [
        "broker_cash_insufficient_at_shadow"]
    assert _run(packet, broker_read=True, gateway=Cash(1449.99))["blocked_reasons"] == [
        "broker_cash_insufficient_at_shadow"]
    assert _run(packet, broker_read=True, gateway=Cash(1450))["status"] == "pass"


def test_shadow_sell_needs_the_whole_position() -> None:
    class Held(BrokerGateway):
        def __init__(self, shares: int) -> None:
            super().__init__()
            self.shares = shares

        def revalidate_broker_truth(self, *, symbol: str):
            return {**super().revalidate_broker_truth(symbol=symbol), "position_shares": self.shares}

    assert _run(_packet(), broker_read=True, gateway=Held(1200))["status"] == "pass"
    assert _run(_packet(), broker_read=True, gateway=Held(1199))["blocked_reasons"] == [
        "broker_position_insufficient_at_shadow"]
