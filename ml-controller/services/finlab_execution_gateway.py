"""Persistent single-owner Shioaji execution gateway.

The gateway is inert unless live execution is explicitly enabled and the
Cloud Run single-instance/continuous-CPU runtime has been separately confirmed.
"""

from __future__ import annotations

import logging
import os
import queue
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from services.broker_execution_repository import BrokerExecutionRepository


logger = logging.getLogger(__name__)


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "enabled", "on"}


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _raw_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "dict"):
        try:
            return dict(value.dict())
        except Exception:
            pass
    if hasattr(value, "model_dump"):
        try:
            return dict(value.model_dump())
        except Exception:
            pass
    return {"repr": repr(value)}


class PersistentFinlabExecutionGateway:
    def __init__(
        self,
        repository: BrokerExecutionRepository,
        *,
        env: Mapping[str, str] | None = None,
        account_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.repository = repository
        self.env = env or os.environ
        self.account_factory = account_factory
        self._account: Any | None = None
        self._lock = threading.RLock()
        self._started = False
        self._connected = False
        self._unhealthy_reason: str | None = None
        self._stop = threading.Event()
        self._callback_overflow = 0
        size = max(100, int(self.env.get("LIVE_EXECUTION_CALLBACK_QUEUE_SIZE") or 2000))
        self._events: queue.Queue[tuple[str, dict[str, Any], str]] = queue.Queue(maxsize=size)
        self._event_thread: threading.Thread | None = None
        self._reconcile_thread: threading.Thread | None = None

    def _runtime_guard(self) -> None:
        if str(self.env.get("LIVE_EXECUTION_GATEWAY_MODE") or "") != "persistent_singleton":
            raise RuntimeError("persistent_execution_gateway_mode_required")
        if not _truthy(self.env.get("LIVE_EXECUTION_SINGLE_INSTANCE_CONFIRMED")):
            raise RuntimeError("single_instance_execution_runtime_not_confirmed")
        if not _truthy(self.env.get("LIVE_EXECUTION_CONTINUOUS_CPU_CONFIRMED")):
            raise RuntimeError("continuous_cpu_execution_runtime_not_confirmed")

    def _load_account_factory(self) -> Callable[[], Any]:
        if self.account_factory is not None:
            return self.account_factory
        from finlab.online.brokers.sinopac import SinopacAccount

        return SinopacAccount

    def _enqueue(self, event_type: str, payload: dict[str, Any], source: str) -> None:
        try:
            self._events.put_nowait((event_type, payload, source))
        except queue.Full:
            self._callback_overflow += 1
            self._unhealthy_reason = "broker_callback_queue_overflow"
            logger.critical("[ExecutionGateway] broker callback queue overflow")

    def _on_order_update(self, update: Any) -> None:
        raw = _raw_payload(_field(update, "org_event", update))
        operation = _field(raw, "operation", {})
        operation = operation if isinstance(operation, Mapping) else {}
        order = _field(raw, "order", {})
        order = order if isinstance(order, Mapping) else {}
        status = _field(raw, "status", {})
        status = status if isinstance(status, Mapping) else {}
        broker_order_id = str(
            order.get("id")
            or _field(update, "order_id", "")
            or status.get("id")
            or ""
        )
        payload = {
            "broker_order_id": broker_order_id,
            "client_tag": str(order.get("custom_field") or raw.get("custom_field") or ""),
            "status": str(_field(update, "status", status.get("status") or "acknowledged")),
            "success": str(operation.get("op_code") or "00") in {"0", "00"},
            "event_time": str(status.get("exchange_ts") or _field(update, "time", datetime.now(timezone.utc).isoformat())),
            "exchange_sequence": str(order.get("seqno") or order.get("ordno") or ""),
            "raw": raw,
        }
        self._enqueue("ORDER_CALLBACK", payload, "shioaji_order_callback")

    def _on_fill(self, fill: Any) -> None:
        raw = _raw_payload(_field(fill, "org_event", fill))
        broker_order_id = str(raw.get("trade_id") or raw.get("id") or _field(fill, "order_id", ""))
        order_lot = str(raw.get("order_lot") or "")
        multiplier = 1 if "Odd" in order_lot else 1000
        quantity = int(float(raw.get("quantity") or _field(fill, "quantity", 0) or 0))
        payload = {
            "broker_order_id": broker_order_id,
            "client_tag": str(raw.get("custom_field") or ""),
            "status": "deal",
            "quantity": quantity,
            "filled_shares": quantity * multiplier,
            "price": float(raw.get("price") or _field(fill, "price", 0) or 0),
            "event_time": str(raw.get("ts") or _field(fill, "time", datetime.now(timezone.utc).isoformat())),
            "exchange_sequence": str(raw.get("exchange_seq") or raw.get("ordno") or ""),
            "raw": raw,
        }
        self._enqueue("DEAL_CALLBACK", payload, "shioaji_deal_callback")

    def _on_connection(self, state: Any, message: str = "") -> None:
        state_text = str(getattr(state, "value", state)).lower()
        self._connected = state_text in {"connected", "connectionstate.connected", "0"}
        if not self._connected:
            self._unhealthy_reason = f"broker_connection:{state_text}"
        self._enqueue(
            "CONNECTION_STATE",
            {
                "status": state_text,
                "event_time": datetime.now(timezone.utc).isoformat(),
                "message": str(message),
            },
            "shioaji_connection_callback",
        )

    def _event_loop(self) -> None:
        while not self._stop.is_set():
            try:
                event_type, payload, source = self._events.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self.repository.record_broker_event(event_type, payload, source=source)
            except Exception:
                self._unhealthy_reason = "broker_event_persistence_failed"
                logger.exception("[ExecutionGateway] callback persistence failed")
            finally:
                self._events.task_done()

    def _reconcile_loop(self) -> None:
        interval = max(10.0, float(self.env.get("LIVE_EXECUTION_RECONCILE_SECONDS") or 30))
        while not self._stop.wait(interval):
            try:
                if not self._connected or (self._unhealthy_reason or "").startswith("broker_connection:"):
                    self._recover_connection()
                elif self.repository.recoverable_legs():
                    # Callback-first. Poll only ambiguous SUBMITTING/UNKNOWN outcomes.
                    self.reconcile_once()
            except Exception:
                self._unhealthy_reason = "broker_reconciliation_failed"
                logger.exception("[ExecutionGateway] reconciliation failed")

    def _connect_account(self) -> Any:
        account = self._load_account_factory()()
        account.on_order_update(self._on_order_update)
        account.on_fill(self._on_fill)
        account.on_connection(self._on_connection)
        account.connect_realtime()
        return account

    def _recover_connection(self) -> None:
        with self._lock:
            previous = self._account
            if previous is not None:
                try:
                    previous.disconnect_realtime()
                except Exception:
                    logger.warning("[ExecutionGateway] disconnect during recovery failed", exc_info=True)
                try:
                    previous.api.logout()
                except Exception:
                    logger.warning("[ExecutionGateway] logout during recovery failed", exc_info=True)
            self._account = self._connect_account()
            self._connected = True
            self._unhealthy_reason = None
            self.reconcile_once()

    def ensure_started(self) -> None:
        self._runtime_guard()
        with self._lock:
            if self._started:
                if self._unhealthy_reason:
                    raise RuntimeError(self._unhealthy_reason)
                return
            account = self._connect_account()
            self._account = account
            self._connected = True
            self._stop.clear()
            self._event_thread = threading.Thread(target=self._event_loop, name="broker-event-writer", daemon=True)
            self._event_thread.start()
            self._reconcile_thread = threading.Thread(target=self._reconcile_loop, name="broker-reconciler", daemon=True)
            self._reconcile_thread.start()
            self._started = True
            self.reconcile_once()

    def health(self) -> dict[str, Any]:
        return {
            "started": self._started,
            "connected": self._connected,
            "healthy": self._started and self._connected and self._unhealthy_reason is None,
            "unhealthy_reason": self._unhealthy_reason,
            "callback_queue_depth": self._events.qsize(),
            "callback_queue_overflow": self._callback_overflow,
            "event_writer_alive": bool(self._event_thread and self._event_thread.is_alive()),
            "reconciler_alive": bool(self._reconcile_thread and self._reconcile_thread.is_alive()),
        }

    def _place_direct(self, *, symbol: str, side: str, quantity: int, price: float, odd_lot: bool, exchange: str, client_tag: str) -> str:
        if self._account is None:
            raise RuntimeError("execution_gateway_not_started")
        api = self._account.api
        from shioaji.constant import Action, Exchange, OrderType, StockOrderLot, StockPriceType
        from shioaji.contracts import Stock
        from shioaji.constant import SecurityType

        contract = Stock(
            security_type=SecurityType.Stock,
            code=symbol,
            exchange=Exchange.TSE if exchange == "TSE" else Exchange.OTC,
        )
        order = api.Order(
            price=float(price),
            quantity=int(quantity),
            action=Action.Buy if side == "buy" else Action.Sell,
            price_type=StockPriceType.LMT,
            order_type=OrderType.ROD,
            order_cond="Cash",
            account=api.stock_account,
            order_lot=StockOrderLot.IntradayOdd if odd_lot else StockOrderLot.Common,
            custom_field=client_tag,
        )
        trade = api.place_order(contract, order)
        return str(_field(_field(trade, "status", {}), "id", "") or _field(_field(trade, "order", {}), "id", ""))

    def submit_leg(
        self,
        *,
        symbol: str,
        side: str,
        quantity: int,
        price: float,
        odd_lot: bool,
        exchange: str,
        client_tag: str,
    ) -> str:
        self.ensure_started()
        if not re.fullmatch(r"[A-Za-z0-9]{6}", client_tag):
            raise RuntimeError("broker_client_tag_invalid")
        with self._lock:
            health = self.health()
            if not health["healthy"]:
                raise RuntimeError(str(health["unhealthy_reason"] or "execution_gateway_unhealthy"))
            order_id = self._place_direct(
                symbol=symbol,
                side=side,
                quantity=quantity,
                price=price,
                odd_lot=odd_lot,
                exchange=exchange,
                client_tag=client_tag,
            )
            if not order_id.strip():
                raise RuntimeError("broker_order_id_empty")
            return order_id

    def revalidate_broker_truth(self, *, symbol: str) -> dict[str, Any]:
        """Read cash/position/account directly from the active broker session."""
        self.ensure_started()
        with self._lock:
            if self._account is None:
                raise RuntimeError("execution_gateway_not_started")
            from shioaji.constant import Unit

            api = self._account.api
            cash = float(self._account.get_cash())
            positions = list(api.list_positions(api.stock_account, unit=Unit.Share) or [])
            position_shares = 0
            for position in positions:
                code = str(_field(position, "code", "") or _field(position, "stock_id", ""))
                if code == symbol:
                    position_shares += int(float(_field(position, "quantity", 0) or 0))
            actual_account_id = str(_field(api.stock_account, "account_id", "") or "")
            expected_account_id = str(self.env.get("SHIOAJI_ACCOUNT_ID") or "")
            return {
                "status": "ready",
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "available_cash": cash,
                "position_shares": position_shares,
                "account_match": bool(actual_account_id and expected_account_id and actual_account_id == expected_account_id),
            }

    def reconcile_once(self) -> dict[str, Any]:
        if self._account is None:
            return {"status": "not_started", "trade_count": 0}
        with self._lock:
            api = self._account.api
            api.update_status(api.stock_account, timeout=2000)
            trades = list(api.list_trades() or [])
            for trade in trades:
                status = _field(trade, "status", {})
                order = _field(trade, "order", {})
                order_lot = str(_field(order, "order_lot", ""))
                multiplier = 1 if "Odd" in order_lot else 1000
                deal_quantity = int(_field(status, "deal_quantity", 0) or 0)
                deals = list(_field(status, "deals", []) or [])
                total_value = 0.0
                total_quantity = 0
                for deal in deals:
                    qty = int(_field(deal, "quantity", 0) or 0) * multiplier
                    total_quantity += qty
                    total_value += float(_field(deal, "price", 0) or 0) * qty
                payload = {
                    "broker_order_id": str(_field(status, "id", "") or _field(order, "id", "")),
                    "client_tag": str(_field(order, "custom_field", "") or ""),
                    "status": str(_field(status, "status", "")),
                    "filled_shares": max(deal_quantity * multiplier, total_quantity),
                    "average_fill_price": total_value / total_quantity if total_quantity > 0 else None,
                    "event_time": str(_field(status, "modified_time", "") or datetime.now(timezone.utc).isoformat()),
                    "exchange_sequence": str(_field(order, "ordno", "") or _field(order, "seqno", "")),
                }
                self.repository.record_broker_event("STATUS_RECONCILIATION", payload, source="shioaji_update_status")
            if self._unhealthy_reason and (
                self._unhealthy_reason.startswith("broker_connection:")
                or self._unhealthy_reason == "broker_reconciliation_failed"
            ):
                self._unhealthy_reason = None
            self._connected = True
            return {"status": "ok", "trade_count": len(trades)}

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            if self._account is not None:
                try:
                    self._account.disconnect_realtime()
                except Exception:
                    logger.exception("[ExecutionGateway] disconnect realtime failed")
                try:
                    self._account.api.logout()
                except Exception:
                    logger.exception("[ExecutionGateway] logout failed")
            self._account = None
            self._started = False
            self._connected = False
