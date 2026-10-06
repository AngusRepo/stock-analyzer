from pathlib import Path
from enum import Enum
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.finlab_execution_gateway import BrokerOrderRejected, PersistentFinlabExecutionGateway  # noqa: E402


class Repository:
    def __init__(self) -> None:
        self.events = []

    def record_broker_event(self, event_type, payload, *, source):
        self.events.append((event_type, payload, source))
        return {"matched": False}

    def recoverable_legs(self):
        return []


def _env(**overrides: str) -> dict[str, str]:
    values = {
        "LIVE_EXECUTION_GATEWAY_MODE": "persistent_singleton",
        "LIVE_EXECUTION_SINGLE_INSTANCE_CONFIRMED": "1",
        "LIVE_EXECUTION_CONTINUOUS_CPU_CONFIRMED": "1",
    }
    values.update(overrides)
    return values


def test_runtime_guard_blocks_request_scoped_or_scaled_gateway() -> None:
    gateway = PersistentFinlabExecutionGateway(Repository(), env={})  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="persistent_execution_gateway_mode_required"):
        gateway.ensure_started()


def test_fill_callback_uses_official_trade_id_and_common_lot_share_units() -> None:
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())  # type: ignore[arg-type]
    gateway._on_fill(
        type(
            "Fill",
            (),
            {
                "org_event": {
                    "trade_id": "trade-id-001",
                    "exchange_seq": "deal-seq-1",
                    "order_lot": "Common",
                    "quantity": 1,
                    "price": 142,
                    "ts": 123.0,
                }
            },
        )()
    )
    event_type, payload, source = gateway._events.get_nowait()
    assert event_type == "DEAL_CALLBACK"
    assert payload["broker_order_id"] == "trade-id-001"
    assert payload["filled_shares"] == 1000
    assert source == "shioaji_deal_callback"


def test_odd_lot_fill_keeps_share_units_and_official_event_id() -> None:
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())  # type: ignore[arg-type]
    gateway._on_fill(type("Fill", (), {"org_event": {
        "event_id": "v1:SD:session:7", "trade_id": "odd-order-1", "order_lot": "IntradayOdd",
        "quantity": 209, "price": 142, "ts": 123.0,
    }})())
    event_type, payload, _ = gateway._events.get_nowait()
    assert event_type == "DEAL_CALLBACK"
    assert payload["event_id"] == "v1:SD:session:7"
    assert payload["filled_shares"] == 209


def test_fill_without_lot_type_never_assumes_board_lot() -> None:
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())  # type: ignore[arg-type]
    gateway._on_fill(type("Fill", (), {"org_event": {
        "event_id": "v1:SD:session:8", "trade_id": "unknown-order", "quantity": 209,
    }})())
    event_type, payload, _ = gateway._events.get_nowait()
    assert event_type == "RECOVERY"
    assert "filled_shares" not in payload
    assert gateway.health()["unhealthy_reason"] == "broker_fill_lot_type_unrecognized"


def test_reconciliation_uses_enum_lot_values_for_share_units() -> None:
    class Lot(Enum):
        Common = "Common"
        IntradayOdd = "IntradayOdd"

    class Api:
        stock_account = object()

        def update_status(self, account, timeout):
            return None

        def list_trades(self):
            return [
                {"order": {"order_lot": Lot.Common, "id": "board-1"},
                 "status": {"id": "board-1", "deal_quantity": 1}},
                {"order": {"order_lot": Lot.IntradayOdd, "id": "odd-1"},
                 "status": {"id": "odd-1", "deal_quantity": 209}},
            ]

    repository = Repository()
    gateway = PersistentFinlabExecutionGateway(repository, env=_env())  # type: ignore[arg-type]
    gateway._account = type("Account", (), {"api": Api()})()
    result = gateway.reconcile_once()
    assert result["trade_count"] == 2
    assert [event[1]["filled_shares"] for event in repository.events] == [1000, 209]
    assert gateway.health()["unhealthy_reason"] is None


def test_unverified_fill_stays_unhealthy_until_its_order_is_reconciled() -> None:
    class Api:
        stock_account = object()
        trades = []

        def update_status(self, account, timeout):
            return None

        def list_trades(self):
            return self.trades

    api = Api()
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())  # type: ignore[arg-type]
    gateway._account = type("Account", (), {"api": api})()
    gateway._on_fill(type("Fill", (), {"org_event": {
        "trade_id": "odd-1", "quantity": 209,
    }})())
    gateway.reconcile_once()
    assert gateway.health()["unhealthy_reason"] == "broker_fill_lot_type_unrecognized"
    api.trades = [{"order": {"order_lot": "IntradayOdd", "id": "odd-1"},
                   "status": {"id": "odd-1", "deal_quantity": 209}}]
    gateway.reconcile_once()
    assert gateway.health()["unhealthy_reason"] is None


def test_submit_reconciles_degraded_trade_cache_before_placing_order() -> None:
    class Api:
        stock_account = object()
        degraded = True
        refresh_count = 0

        def trade_cache_health(self, account):
            return type("Health", (), {"state": "Degraded" if self.degraded else "Healthy"})()

        def update_status(self, account, timeout):
            self.refresh_count += 1
            self.degraded = False

        def list_trades(self):
            return []

    api = Api()
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())  # type: ignore[arg-type]
    gateway._account = type("Account", (), {"api": api})()
    gateway._started = True
    gateway._connected = True
    placements = []
    gateway._place_direct = lambda **kwargs: placements.append(kwargs) or "order-1"  # type: ignore[method-assign]
    assert gateway.submit_leg(symbol="4953", side="buy", quantity=209, price=142,
                              odd_lot=True, exchange="TSE", client_tag="ABC123") == "order-1"
    assert api.refresh_count == 1
    assert len(placements) == 1


def test_submit_does_not_place_order_while_trade_cache_remains_degraded() -> None:
    class Api:
        stock_account = object()

        def trade_cache_health(self, account):
            return type("Health", (), {"state": "Degraded"})()

        def update_status(self, account, timeout):
            return None

        def list_trades(self):
            return []

    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())  # type: ignore[arg-type]
    gateway._account = type("Account", (), {"api": Api()})()
    gateway._started = True
    gateway._connected = True
    with pytest.raises(RuntimeError, match="broker_trade_cache_degraded"):
        gateway.submit_leg(symbol="4953", side="buy", quantity=209, price=142,
                           odd_lot=True, exchange="TSE", client_tag="ABC123")


def test_broker_explicit_rejection_is_distinct_from_unknown_outcome() -> None:
    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env())  # type: ignore[arg-type]

    class Api:
        stock_account = object()

        def Order(self, **kwargs):
            return kwargs

        def place_order(self, contract, order):
            return {"status": {"id": "order-1", "status": "Failed", "status_code": "88"}}

    gateway._account = type("Account", (), {"api": Api()})()
    with pytest.raises(BrokerOrderRejected):
        gateway._place_direct(symbol="4953", side="buy", quantity=209, price=142,
                              odd_lot=True, exchange="TSE", client_tag="ABC123")


def test_disconnected_session_is_replaced_by_one_controlled_recovery() -> None:
    created = []

    class Api:
        def __init__(self):
            self.stock_account = type("Account", (), {"account_id": "A1"})()
            self.logged_out = False

        def update_status(self, account, timeout):
            return None

        def list_trades(self):
            return []

        def logout(self):
            self.logged_out = True

    class Account:
        def __init__(self):
            self.api = Api()
            self.disconnected = False

        def on_order_update(self, callback): self.order_callback = callback
        def on_fill(self, callback): self.fill_callback = callback
        def on_connection(self, callback): self.connection_callback = callback
        def connect_realtime(self): return None
        def disconnect_realtime(self): self.disconnected = True

    def factory():
        account = Account()
        created.append(account)
        return account

    gateway = PersistentFinlabExecutionGateway(Repository(), env=_env(), account_factory=factory)  # type: ignore[arg-type]
    gateway.ensure_started()
    assert len(created) == 1
    gateway._on_connection("disconnected", "test")
    gateway._recover_connection()
    assert len(created) == 2
    assert created[0].disconnected is True
    assert created[0].api.logged_out is True
    assert gateway.health()["connected"] is True
    gateway.close()
