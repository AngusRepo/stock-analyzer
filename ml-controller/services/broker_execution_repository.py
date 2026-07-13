"""Durable D1 repository for live broker intents, legs and callback events."""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Protocol

from services.broker_execution_contract import canonical_json, packet_hash, reduce_leg_state


QueryFn = Callable[[str, list[Any] | None, float], list[dict[str, Any]]]
ExecuteFn = Callable[[str, list[Any] | None, float], dict[str, Any]]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _intent_id(idempotency_key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"stockvision:broker-intent:{idempotency_key}"))


def _leg_id(intent_id: str, leg_key: str) -> str:
    return str(uuid.uuid5(uuid.UUID(intent_id), leg_key))


def _client_tag(leg_id: str) -> str:
    # Shioaji stock custom_field is alphanumeric and limited to six characters.
    return base64.b32encode(hashlib.sha256(leg_id.encode("utf-8")).digest()).decode("ascii")[:6]


def _event_id(payload: Mapping[str, Any], event_type: str) -> str:
    stable = str(payload.get("exchange_sequence") or payload.get("event_id") or "").strip()
    if stable:
        material = (
            f"{event_type}:{stable}:{payload.get('broker_order_id') or ''}:"
            f"{payload.get('client_tag') or payload.get('custom_field') or ''}:"
            f"{payload.get('status') or ''}:{payload.get('operation') or ''}:{payload.get('event_time') or ''}"
        )
    else:
        material = f"{event_type}:{canonical_json(payload)}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


class BrokerExecutionRepository(Protocol):
    def find_intent(self, idempotency_key: str) -> dict[str, Any] | None: ...
    def intent_lifecycle(self, idempotency_key: str) -> dict[str, Any] | None: ...
    def daily_side_order_count(self, trade_date: str, side: str) -> int: ...
    def reserve_intent(self, packet: Mapping[str, Any]) -> dict[str, Any]: ...
    def list_legs(self, intent_id: str) -> list[dict[str, Any]]: ...
    def claim_leg(self, intent_id: str, leg_key: str) -> dict[str, Any] | None: ...
    def mark_submit_ack(self, leg_id: str, broker_order_id: str, payload: Mapping[str, Any]) -> dict[str, Any]: ...
    def mark_submit_unknown(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None: ...
    def mark_submit_rejected(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None: ...
    def record_broker_event(self, event_type: str, payload: Mapping[str, Any], *, source: str) -> dict[str, Any]: ...
    def recoverable_legs(self) -> list[dict[str, Any]]: ...


class D1BrokerExecutionRepository:
    def __init__(self, query_fn: QueryFn | None = None, execute_fn: ExecuteFn | None = None) -> None:
        if query_fn is None or execute_fn is None:
            from services import d1_client

            query_fn = query_fn or (lambda sql, params, timeout: d1_client.query(sql, params, timeout))
            execute_fn = execute_fn or (lambda sql, params, timeout: d1_client.execute(sql, params, timeout))
        self._query = query_fn
        self._execute = execute_fn

    def daily_side_order_count(self, trade_date: str, side: str) -> int:
        rows = self._query(
            """SELECT COUNT(*) AS n FROM broker_execution_intents
               WHERE trade_date=? AND side=? AND status NOT IN ('BLOCKED','REJECTED')""",
            [trade_date, side],
            5.0,
        )
        return int((rows[0] if rows else {}).get("n") or 0)

    def intent_lifecycle(self, idempotency_key: str) -> dict[str, Any] | None:
        intent = self.find_intent(idempotency_key)
        if intent is None:
            return None
        return {"intent": intent, "legs": self.list_legs(str(intent.get("intent_id") or ""))}

    def reserve_intent(self, packet: Mapping[str, Any]) -> dict[str, Any]:
        intent = packet.get("intent") if isinstance(packet.get("intent"), Mapping) else {}
        key = str(packet.get("idempotency_key") or "")
        intent_id = _intent_id(key)
        digest = packet_hash(packet)
        side = str(intent.get("side") or "").lower()
        limit = float(intent.get("limitPrice") or intent.get("limit_price") or intent.get("maxPrice") or intent.get("minPrice") or 0)
        shares = int(intent.get("requestedShares") or intent.get("requested_shares") or 0)
        approval = packet.get("approval") if isinstance(packet.get("approval"), Mapping) else {}
        self._execute(
            """INSERT INTO broker_execution_intents
               (intent_id,idempotency_key,account_id,trade_date,symbol,side,status,packet_hash,
                approval_scope,requested_shares,limit_price,intent_json,packet_json)
               VALUES (?,?,?,?,?,?,'RESERVED',?,?,?,?,?,?)
               ON CONFLICT(idempotency_key) DO NOTHING""",
            [
                intent_id,
                key,
                int(intent.get("accountId") or intent.get("account_id") or 0),
                str(packet.get("trade_date") or intent.get("tradeDate") or ""),
                str(intent.get("symbol") or ""),
                side,
                digest,
                str(approval.get("scope") or ""),
                shares,
                limit,
                canonical_json(intent),
                canonical_json(packet),
            ],
            5.0,
        )
        rows = self._query(
            "SELECT * FROM broker_execution_intents WHERE idempotency_key=? LIMIT 1",
            [key],
            5.0,
        )
        if not rows:
            raise RuntimeError("broker_intent_reservation_not_persisted")
        row = rows[0]
        if str(row.get("packet_hash") or "") != digest:
            return {"status": "conflict", "intent_id": row.get("intent_id"), "row": row}

        for index, leg in enumerate(intent.get("orderLegs") or intent.get("order_legs") or []):
            if not isinstance(leg, Mapping):
                continue
            current_lot = str(leg.get("lotType") or leg.get("lot_type") or "")
            leg_key = f"{index}:{current_lot}"
            self._execute(
                """INSERT INTO broker_execution_legs
                   (leg_id,intent_id,leg_key,client_tag,lot_type,requested_shares,broker_quantity,status)
                   VALUES (?,?,?,?,?,?,?,'RESERVED')
                   ON CONFLICT(intent_id,leg_key) DO NOTHING""",
                [
                    _leg_id(intent_id, leg_key),
                    intent_id,
                    leg_key,
                    _client_tag(_leg_id(intent_id, leg_key)),
                    current_lot,
                    int(leg.get("shares") or 0),
                    int(leg.get("finlabQuantity") or leg.get("finlab_quantity") or 0),
                ],
                5.0,
            )
        return {
            "status": "reserved" if str(row.get("status")) == "RESERVED" else "replay",
            "intent_id": intent_id,
            "row": row,
        }

    def list_legs(self, intent_id: str) -> list[dict[str, Any]]:
        return self._query(
            "SELECT * FROM broker_execution_legs WHERE intent_id=? ORDER BY leg_key",
            [intent_id],
            5.0,
        )

    def claim_leg(self, intent_id: str, leg_key: str) -> dict[str, Any] | None:
        result = self._execute(
            """UPDATE broker_execution_legs
               SET status='SUBMITTING',submit_attempts=submit_attempts+1,claimed_at=CURRENT_TIMESTAMP,
                   updated_at=CURRENT_TIMESTAMP,last_error=NULL
               WHERE intent_id=? AND leg_key=? AND status='RESERVED' AND broker_order_id IS NULL
               RETURNING *""",
            [intent_id, leg_key],
            5.0,
        )
        rows = result.get("results") or []
        if rows:
            self._execute(
                "UPDATE broker_execution_intents SET status='SUBMITTING',updated_at=CURRENT_TIMESTAMP WHERE intent_id=?",
                [intent_id],
                5.0,
            )
            return rows[0]
        return None

    def _event_rows_for_order(self, broker_order_id: str, client_tag: str, *, unmatched_only: bool = False) -> list[dict[str, Any]]:
        unmatched = " AND leg_id IS NULL" if unmatched_only else ""
        return self._query(
            f"""SELECT * FROM broker_execution_events
               WHERE (broker_order_id=? OR client_tag=?){unmatched} ORDER BY event_time,received_at,event_id""",
            [broker_order_id, client_tag],
            5.0,
        )

    def _apply_event_to_leg(self, leg: Mapping[str, Any], event_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        requested = int(leg.get("requested_shares") or 0)
        prior_filled = int(leg.get("filled_shares") or 0)
        event_quantity = int(payload.get("filled_shares") or payload.get("quantity") or 0)
        filled = prior_filled + event_quantity if event_type == "DEAL_CALLBACK" else max(prior_filled, event_quantity)
        next_status = reduce_leg_state(
            str(leg.get("status") or "RESERVED"),
            event_type,
            filled_shares=filled,
            requested=requested,
            callback_success=payload.get("success") is not False,
            broker_status=str(payload.get("status") or ""),
        )
        average_price = payload.get("average_fill_price") or payload.get("price") or leg.get("average_fill_price")
        completed = _utc_now() if next_status in {"FILLED", "CANCELLED", "REJECTED"} else None
        self._execute(
            """UPDATE broker_execution_legs SET status=?,filled_shares=MAX(filled_shares,?),
               average_fill_price=COALESCE(?,average_fill_price),completed_at=COALESCE(?,completed_at),
               updated_at=CURRENT_TIMESTAMP WHERE leg_id=?""",
            [next_status, filled, average_price, completed, leg.get("leg_id")],
            5.0,
        )
        self._refresh_intent_status(str(leg.get("intent_id") or ""))
        return {**dict(leg), "status": next_status, "filled_shares": max(int(leg.get("filled_shares") or 0), filled)}

    def _refresh_intent_status(self, intent_id: str) -> None:
        if not intent_id:
            return
        legs = self.list_legs(intent_id)
        statuses = {str(leg.get("status") or "RESERVED") for leg in legs}
        if not statuses:
            return
        if statuses == {"FILLED"}:
            status = "FILLED"
        elif "UNKNOWN" in statuses:
            status = "UNKNOWN"
        elif "PARTIALLY_FILLED" in statuses or "FILLED" in statuses:
            status = "PARTIALLY_FILLED"
        elif "SUBMITTING" in statuses:
            status = "SUBMITTING"
        elif statuses <= {"REJECTED"}:
            status = "REJECTED"
        elif statuses <= {"CANCELLED"}:
            status = "CANCELLED"
        elif statuses & {"ACKNOWLEDGED"}:
            status = "ACKNOWLEDGED"
        else:
            status = "RESERVED"
        self._execute(
            "UPDATE broker_execution_intents SET status=?,updated_at=CURRENT_TIMESTAMP WHERE intent_id=?",
            [status, intent_id],
            5.0,
        )

    def mark_submit_ack(self, leg_id: str, broker_order_id: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not broker_order_id.strip():
            raise RuntimeError("broker_order_id_empty")
        rows = self._query("SELECT * FROM broker_execution_legs WHERE leg_id=? LIMIT 1", [leg_id], 5.0)
        if not rows:
            raise RuntimeError("broker_leg_not_found")
        leg = rows[0]
        next_status = reduce_leg_state(str(leg.get("status") or "SUBMITTING"), "SUBMIT_ACK")
        self._execute(
            """UPDATE broker_execution_legs SET status=?,broker_order_id=?,acknowledged_at=CURRENT_TIMESTAMP,
               updated_at=CURRENT_TIMESTAMP WHERE leg_id=? AND (broker_order_id IS NULL OR broker_order_id=?)""",
            [next_status, broker_order_id, leg_id, broker_order_id],
            5.0,
        )
        client_tag = str(leg.get("client_tag") or "")
        event_payload = {**dict(payload), "broker_order_id": broker_order_id, "client_tag": client_tag, "leg_id": leg_id}
        self.record_broker_event("SUBMIT_ACK", event_payload, source="execution_gateway")
        current = {**leg, "status": next_status, "broker_order_id": broker_order_id}
        for event in self._event_rows_for_order(broker_order_id, client_tag, unmatched_only=True):
            try:
                raw = json.loads(str(event.get("payload_json") or "{}"))
            except json.JSONDecodeError:
                raw = {}
            current = self._apply_event_to_leg(current, str(event.get("event_type") or ""), raw)
            self._execute(
                "UPDATE broker_execution_events SET leg_id=?,intent_id=? WHERE event_id=?",
                [leg_id, leg.get("intent_id"), event.get("event_id")],
                5.0,
            )
        return current

    def mark_submit_unknown(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None:
        self._execute(
            "UPDATE broker_execution_legs SET status='UNKNOWN',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE leg_id=?",
            [error[:500], leg_id],
            5.0,
        )
        rows = self._query("SELECT intent_id FROM broker_execution_legs WHERE leg_id=? LIMIT 1", [leg_id], 5.0)
        if rows:
            self._refresh_intent_status(str(rows[0].get("intent_id") or ""))
        self.record_broker_event("SUBMIT_UNKNOWN", {**dict(payload), "leg_id": leg_id, "error": error[:500]}, source="execution_gateway")

    def mark_submit_rejected(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None:
        self._execute(
            """UPDATE broker_execution_legs SET status='REJECTED',last_error=?,completed_at=CURRENT_TIMESTAMP,
               updated_at=CURRENT_TIMESTAMP WHERE leg_id=?""",
            [error[:500], leg_id],
            5.0,
        )
        rows = self._query("SELECT intent_id FROM broker_execution_legs WHERE leg_id=? LIMIT 1", [leg_id], 5.0)
        if rows:
            self._refresh_intent_status(str(rows[0].get("intent_id") or ""))
        self.record_broker_event("SUBMIT_REJECTED", {**dict(payload), "leg_id": leg_id, "error": error[:500]}, source="execution_gateway")

    def record_broker_event(self, event_type: str, payload: Mapping[str, Any], *, source: str) -> dict[str, Any]:
        broker_order_id = str(payload.get("broker_order_id") or payload.get("trade_id") or payload.get("id") or "").strip() or None
        client_tag = str(payload.get("client_tag") or payload.get("custom_field") or "").strip() or None
        event_time = str(payload.get("event_time") or payload.get("datetime") or payload.get("ts") or _utc_now())
        exchange_sequence = str(payload.get("exchange_sequence") or payload.get("exchange_seq") or "").strip() or None
        legs = self._query(
            """SELECT * FROM broker_execution_legs
               WHERE (? IS NOT NULL AND broker_order_id=?) OR (? IS NOT NULL AND client_tag=?) LIMIT 1""",
            [broker_order_id, broker_order_id, client_tag, client_tag],
            5.0,
        ) if broker_order_id or client_tag else []
        leg = legs[0] if legs else None
        if leg and broker_order_id and not str(leg.get("broker_order_id") or ""):
            self._execute(
                """UPDATE broker_execution_legs SET broker_order_id=?,updated_at=CURRENT_TIMESTAMP
                   WHERE leg_id=? AND broker_order_id IS NULL""",
                [broker_order_id, leg.get("leg_id")],
                5.0,
            )
            leg = {**leg, "broker_order_id": broker_order_id}
        event_id = _event_id({**dict(payload), "broker_order_id": broker_order_id, "exchange_sequence": exchange_sequence}, event_type)
        existing = self._query("SELECT event_id,leg_id FROM broker_execution_events WHERE event_id=? LIMIT 1", [event_id], 5.0)
        if existing:
            return {"event_id": event_id, "matched": bool(existing[0].get("leg_id")), "duplicate": True, "leg": leg}
        self._execute(
            """INSERT INTO broker_execution_events
               (event_id,intent_id,leg_id,broker_order_id,client_tag,event_type,event_status,event_time,
                exchange_sequence,payload_json,source)
               VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING""",
            [
                event_id,
                leg.get("intent_id") if leg else payload.get("intent_id"),
                leg.get("leg_id") if leg else payload.get("leg_id"),
                broker_order_id,
                client_tag,
                event_type,
                str(payload.get("status") or "received"),
                event_time,
                exchange_sequence,
                canonical_json(payload),
                source,
            ],
            5.0,
        )
        updated = self._apply_event_to_leg(leg, event_type, payload) if leg else None
        return {"event_id": event_id, "matched": bool(leg), "leg": updated}

    def recoverable_legs(self) -> list[dict[str, Any]]:
        return self._query(
            """SELECT l.*,i.trade_date,i.symbol,i.side FROM broker_execution_legs l
               JOIN broker_execution_intents i ON i.intent_id=l.intent_id
               WHERE l.status IN ('SUBMITTING','UNKNOWN')
               ORDER BY l.updated_at""",
            None,
            5.0,
        )
    def find_intent(self, idempotency_key: str) -> dict[str, Any] | None:
        rows = self._query(
            "SELECT * FROM broker_execution_intents WHERE idempotency_key=? LIMIT 1",
            [idempotency_key],
            5.0,
        )
        return rows[0] if rows else None
