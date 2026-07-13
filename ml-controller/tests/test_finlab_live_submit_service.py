from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.broker_execution_contract import packet_hash, sign_packet  # noqa: E402
from services.finlab_live_submit_service import run_finlab_live_submit  # noqa: E402


TEST_NOW = datetime(2026, 7, 13, 1, 1, tzinfo=timezone.utc)


def _intent(**overrides: object) -> dict:
    intent = {
        "schemaVersion": "stockvision-order-intent-v1",
        "accountId": 1,
        "tradeDate": "2026-07-13",
        "symbol": "4953",
        "side": "sell",
        "liveSubmitRequested": False,
        "requestedShares": 3209,
        "limitPrice": 142,
        "minPrice": 142,
        "maxPrice": 142,
        "orderLegs": [
            {"lotType": "board_lot", "shares": 3000, "finlabQuantity": 3, "oddLot": False},
            {"lotType": "odd_lot", "shares": 209, "finlabQuantity": 209, "oddLot": True},
        ],
    }
    intent.update(overrides)
    return intent


def _ready_env(cert_path: Path) -> dict[str, str]:
    cert_path.write_text("dummy", encoding="utf-8")
    return {
        "FINLAB_LIVE_SUBMIT_ENABLED": "1",
        "SHIOAJI_API_KEY": "api-key",
        "SHIOAJI_SECRET_KEY": "secret-key",
        "SHIOAJI_CERT_PASSWORD": "cert-password",
        "SHIOAJI_CERT_PATH": str(cert_path),
        "SHIOAJI_CERT_PERSON_ID": "A123456789",
        "SHIOAJI_ACCOUNT_ID": "unit-test-account",
        "LIVE_EXECUTION_HMAC_SECRET": "unit-test-signing-secret",
        "LIVE_TRADING_APPROVAL_SCOPE": "pilot-2026-07-13",
        "LIVE_TRADING_APPROVAL_EXPIRES_AT": "2099-01-01T00:00:00Z",
        "LIVE_EXECUTION_GATEWAY_MODE": "persistent_singleton",
        "LIVE_EXECUTION_SINGLE_INSTANCE_CONFIRMED": "1",
        "LIVE_EXECUTION_CONTINUOUS_CPU_CONFIRMED": "1",
        "EXECUTION_GATEWAY_SERVICE_ROLE": "dedicated_execution_gateway",
    }


def _risk(kill_switch: bool = False) -> dict:
    return {
        "system": {"killSwitch": kill_switch},
        "order": {
            "maxSingleOrderValue": 1_000_000,
            "maxDailyBuyOrders": 5,
            "maxDailySellOrders": 10,
            "maxPriceDeviationPct": 0.07,
        },
    }


def _packet(intent: dict | None = None, **overrides: object) -> dict:
    now = TEST_NOW
    value = {
        "schema_version": "stockvision-live-execution-packet-v1",
        "idempotency_key": "paper-to-live-test-4953-sell-001",
        "trade_date": "2026-07-13",
        "generated_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=5)).isoformat(),
        "approval": {"approved_by": "Wei", "scope": "pilot-2026-07-13"},
        "controls": {
            "risk_checks_passed": True,
            "kill_switch_active": False,
            "market_session_open": True,
            "trading_day_confirmed": True,
            "market_phase": "continuous",
            "broker_truth_ready": True,
        },
        "intent": intent or _intent(),
        "execution_snapshots": {
            "board_lot": {
                "schema_version": "authoritative_execution_snapshot_v1",
                "status": "ready",
                "selected_source": "shioaji_hub",
                "age_ms": 100,
                "bid": 142.5,
                "ask": 143.0,
            },
            "odd_lot": {
                "schema_version": "authoritative_execution_snapshot_v1",
                "status": "ready",
                "selected_source": "shioaji_hub",
                "age_ms": 120,
                "bid": 142.5,
                "ask": 143.0,
            },
        },
        "broker_truth": {
            "status": "ready",
            "observed_at": now.isoformat(),
            "exchange": "TSE",
            "reference_price": 142,
            "limit_up": 156,
            "limit_down": 128,
            "available_cash": 2_000_000,
            "position_shares": 5000,
        },
    }
    value.update(overrides)
    return value


class MemoryRepository:
    def __init__(self) -> None:
        self.intents: dict[str, dict[str, Any]] = {}
        self.legs: dict[str, list[dict[str, Any]]] = {}
        self.events: list[tuple[str, dict[str, Any], str]] = []

    def find_intent(self, key: str):
        return self.intents.get(key)

    def daily_side_order_count(self, trade_date: str, side: str) -> int:
        return len([row for row in self.intents.values() if row["trade_date"] == trade_date and row["side"] == side])

    def reserve_intent(self, packet: Mapping[str, Any]) -> dict[str, Any]:
        key = str(packet["idempotency_key"])
        digest = packet_hash(packet)
        existing = self.intents.get(key)
        if existing and existing["packet_hash"] != digest:
            return {"status": "conflict", "intent_id": existing["intent_id"], "row": existing}
        if existing:
            return {"status": "replay", "intent_id": existing["intent_id"], "row": existing}
        intent_id = f"intent-{len(self.intents) + 1}"
        intent = packet["intent"]
        row = {
            "intent_id": intent_id,
            "packet_hash": digest,
            "trade_date": packet["trade_date"],
            "side": intent["side"],
            "status": "RESERVED",
        }
        self.intents[key] = row
        self.legs[intent_id] = [
            {
                "leg_id": f"{intent_id}-leg-{index}",
                "intent_id": intent_id,
                "leg_key": f"{index}:{leg['lotType']}",
                "client_tag": f"TST{index:03d}",
                "lot_type": leg["lotType"],
                "requested_shares": leg["shares"],
                "broker_quantity": leg["finlabQuantity"],
                "status": "RESERVED",
                "broker_order_id": None,
            }
            for index, leg in enumerate(intent["orderLegs"])
        ]
        return {"status": "reserved", "intent_id": intent_id, "row": row}

    def list_legs(self, intent_id: str):
        return [dict(row) for row in self.legs[intent_id]]

    def claim_leg(self, intent_id: str, leg_key: str):
        row = next(row for row in self.legs[intent_id] if row["leg_key"] == leg_key)
        if row["status"] != "RESERVED":
            return None
        row["status"] = "SUBMITTING"
        return dict(row)

    def mark_submit_ack(self, leg_id: str, broker_order_id: str, payload: Mapping[str, Any]):
        row = next(row for rows in self.legs.values() for row in rows if row["leg_id"] == leg_id)
        row["status"] = "ACKNOWLEDGED"
        row["broker_order_id"] = broker_order_id
        return dict(row)

    def mark_submit_unknown(self, leg_id: str, error: str, payload: Mapping[str, Any]):
        row = next(row for rows in self.legs.values() for row in rows if row["leg_id"] == leg_id)
        row["status"] = "UNKNOWN"
        row["last_error"] = error

    def mark_submit_rejected(self, leg_id: str, error: str, payload: Mapping[str, Any]):
        row = next(row for rows in self.legs.values() for row in rows if row["leg_id"] == leg_id)
        row["status"] = "REJECTED"

    def record_broker_event(self, event_type: str, payload: Mapping[str, Any], *, source: str):
        self.events.append((event_type, dict(payload), source))
        return {"matched": False}

    def recoverable_legs(self):
        return [row for rows in self.legs.values() for row in rows if row["status"] in {"UNKNOWN", "ACKNOWLEDGED"}]


class FakeGateway:
    def __init__(self, fail_call: int | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_call = fail_call

    def submit_leg(self, **kwargs: Any) -> str:
        self.calls.append(kwargs)
        if self.fail_call == len(self.calls):
            raise TimeoutError("broker outcome unavailable")
        return f"order-{len(self.calls)}"

    def health(self):
        return {"healthy": True, "connected": True}

    def revalidate_broker_truth(self, *, symbol: str):
        return {
            "status": "ready",
            "available_cash": 2_000_000,
            "position_shares": 5000,
            "account_match": True,
        }


def _run(tmp_path: Path, repo: MemoryRepository, gateway: FakeGateway, packet: dict, **kwargs: Any) -> dict:
    env = _ready_env(tmp_path / "cert.pfx")
    return run_finlab_live_submit(
        packet=packet,
        signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]),
        allow_live_submit=True,
        env=env,
        repository=repo,
        gateway=gateway,  # type: ignore[arg-type]
        risk_loader=lambda: _risk(),
        snapshot_revalidator=lambda _: {"errors": [], "observations": {}},
        now=TEST_NOW,
        **kwargs,
    )


def test_live_submit_disabled_blocks_before_repository(tmp_path: Path) -> None:
    packet = _packet()
    result = run_finlab_live_submit(
        packet=packet,
        allow_live_submit=True,
        env={"FINLAB_LIVE_SUBMIT_ENABLED": "0"},
    )
    assert result["status"] == "blocked"
    assert result["reason"] == "finlab_live_submit_disabled"


def test_legacy_intent_without_signed_packet_is_blocked() -> None:
    result = run_finlab_live_submit(intent=_intent(), allow_live_submit=True)
    assert result["reason"] == "signed_execution_packet_required"


def test_invalid_signature_blocks_before_reservation(tmp_path: Path) -> None:
    env = _ready_env(tmp_path / "cert.pfx")
    repo = MemoryRepository()
    result = run_finlab_live_submit(
        packet=_packet(),
        signature="bad",
        allow_live_submit=True,
        env=env,
        repository=repo,
        gateway=FakeGateway(),  # type: ignore[arg-type]
        risk_loader=lambda: _risk(),
        now=TEST_NOW,
    )
    assert result["status"] == "blocked"
    assert "execution_packet_signature_invalid" in result["blocked_reasons"]
    assert repo.intents == {}


def test_valid_packet_splits_board_and_odd_lot_once(tmp_path: Path) -> None:
    repo = MemoryRepository()
    gateway = FakeGateway()
    result = _run(tmp_path, repo, gateway, _packet())
    assert result["status"] == "submitted"
    assert [call["quantity"] for call in gateway.calls] == [3, 209]
    assert [call["odd_lot"] for call in gateway.calls] == [False, True]
    assert all(call["exchange"] == "TSE" for call in gateway.calls)
    assert [call["client_tag"] for call in gateway.calls] == ["TST000", "TST001"]
    assert [row["broker_order_id"] for row in result["legs"]] == ["order-1", "order-2"]


def test_second_leg_timeout_preserves_first_ack_and_blocks_resubmit(tmp_path: Path) -> None:
    repo = MemoryRepository()
    gateway = FakeGateway(fail_call=2)
    packet = _packet()
    first = _run(tmp_path, repo, gateway, packet)
    assert first["status"] == "unknown"
    assert [row["status"] for row in first["legs"]] == ["ACKNOWLEDGED", "UNKNOWN"]
    second = _run(tmp_path, repo, gateway, packet)
    assert second["status"] == "idempotent_replay"
    assert len(gateway.calls) == 2, "replay must never resubmit ACKNOWLEDGED or UNKNOWN legs"


def test_runtime_kill_switch_blocks_even_when_signed_packet_says_false(tmp_path: Path) -> None:
    env = _ready_env(tmp_path / "cert.pfx")
    packet = _packet()
    result = run_finlab_live_submit(
        packet=packet,
        signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]),
        allow_live_submit=True,
        env=env,
        repository=MemoryRepository(),
        gateway=FakeGateway(),  # type: ignore[arg-type]
        risk_loader=lambda: _risk(kill_switch=True),
        now=TEST_NOW,
    )
    assert result["status"] == "blocked"
    assert "runtime_kill_switch_active_or_unknown" in result["blocked_reasons"]


def test_general_ml_controller_role_cannot_submit(tmp_path: Path) -> None:
    env = _ready_env(tmp_path / "cert.pfx")
    env.pop("EXECUTION_GATEWAY_SERVICE_ROLE")
    packet = _packet()
    gateway = FakeGateway()
    result = run_finlab_live_submit(
        packet=packet,
        signature=sign_packet(packet, env["LIVE_EXECUTION_HMAC_SECRET"]),
        allow_live_submit=True,
        env=env,
        repository=MemoryRepository(),
        gateway=gateway,  # type: ignore[arg-type]
        risk_loader=lambda: _risk(),
        snapshot_revalidator=lambda _: {"errors": [], "observations": {}},
        now=TEST_NOW,
    )
    assert result["reason"] == "dedicated_execution_gateway_service_required"
    assert gateway.calls == []
