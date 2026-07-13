from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.finlab_execution_gateway import PersistentFinlabExecutionGateway  # noqa: E402


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
