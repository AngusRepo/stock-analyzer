"""Durable D1 repository for live broker intents, legs and callback events."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Protocol

from services.broker_execution_contract import canonical_json, packet_hash, reduce_leg_state


QueryFn = Callable[[str, list[Any] | None, float], list[dict[str, Any]]]
AtomicFn = Callable[[list[tuple[str, list[Any]]], float], dict[str, Any]]


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
    def execution_control_state(self) -> dict[str, Any] | None: ...
    def reserve_intent(
        self,
        packet: Mapping[str, Any],
        *,
        risk_decision: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    def list_legs(self, intent_id: str) -> list[dict[str, Any]]: ...
    def claim_leg(self, intent_id: str, leg_key: str) -> dict[str, Any] | None: ...
    def mark_submit_ack(self, leg_id: str, broker_order_id: str, payload: Mapping[str, Any]) -> dict[str, Any]: ...
    def mark_submit_unknown(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None: ...
    def mark_submit_rejected(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None: ...
    def record_broker_event(self, event_type: str, payload: Mapping[str, Any], *, source: str) -> dict[str, Any]: ...
    def recoverable_legs(self) -> list[dict[str, Any]]: ...


class D1BrokerExecutionRepository:
    def __init__(
        self,
        query_fn: QueryFn | None = None,
        atomic_fn: AtomicFn | None = None,
    ) -> None:
        provided = (query_fn is not None, atomic_fn is not None)
        if any(provided) and not all(provided):
            raise RuntimeError("execution repository requires query and atomic functions together")
        if not any(provided):
            from services.execution_d1_client import ExecutionD1Client

            client = ExecutionD1Client.from_env()
            query_fn = client.query
            atomic_fn = client.atomic_batch
        assert query_fn is not None and atomic_fn is not None
        self._query = query_fn
        self._atomic = atomic_fn
        self._mutation_lock = threading.RLock()

    def daily_side_order_count(self, trade_date: str, side: str) -> int:
        rows = self._query(
            """SELECT COUNT(*) AS n FROM broker_execution_intents
               WHERE trade_date=? AND side=? AND status NOT IN ('BLOCKED','REJECTED')""",
            [trade_date, side],
            5.0,
        )
        return int((rows[0] if rows else {}).get("n") or 0)

    def execution_control_state(self) -> dict[str, Any] | None:
        rows = self._query(
            "SELECT * FROM execution_control_state WHERE control_key='live_trading' LIMIT 1",
            None,
            5.0,
        )
        return rows[0] if rows else None

    def health(self) -> dict[str, Any]:
        try:
            rows = self._query(
                """SELECT
                     (SELECT purpose FROM execution_database_identity
                       WHERE identity_key='primary' LIMIT 1) AS database_purpose,
                     (SELECT COUNT(*) FROM broker_execution_intents) AS intent_count,
                     (SELECT COUNT(*) FROM broker_execution_legs WHERE status IN ('SUBMITTING','UNKNOWN')) AS unresolved_count,
                     (SELECT kill_switch_active FROM execution_control_state
                       WHERE control_key='live_trading' LIMIT 1) AS kill_switch_active""",
                None,
                5.0,
            )
        except Exception as exc:
            return {
                "ready": False,
                "reason": f"execution_ledger_unavailable:{exc.__class__.__name__}",
            }
        if (
            not rows
            or rows[0].get("kill_switch_active") is None
            or rows[0].get("database_purpose") != "real_trading_execution_only"
        ):
            return {"ready": False, "reason": "execution_control_state_missing"}
        return {
            "ready": True,
            "kill_switch_active": bool(int(rows[0].get("kill_switch_active") or 0)),
            "unresolved_count": int(rows[0].get("unresolved_count") or 0),
            "intent_count": int(rows[0].get("intent_count") or 0),
        }

    def intent_lifecycle(self, idempotency_key: str) -> dict[str, Any] | None:
        intent = self.find_intent(idempotency_key)
        if intent is None:
            return None
        return {"intent": intent, "legs": self.list_legs(str(intent.get("intent_id") or ""))}

    def reserve_intent(
        self,
        packet: Mapping[str, Any],
        *,
        risk_decision: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        intent = packet.get("intent") if isinstance(packet.get("intent"), Mapping) else {}
        key = str(packet.get("idempotency_key") or "")
        if len(key) < 16 or len(key) > 200:
            raise RuntimeError("broker_intent_idempotency_key_invalid")
        intent_id = _intent_id(key)
        digest = packet_hash(packet)
        side = str(intent.get("side") or "").lower()
        if side not in {"buy", "sell"}:
            raise RuntimeError("broker_intent_side_invalid")
        limit = float(intent.get("limitPrice") or intent.get("limit_price") or intent.get("maxPrice") or intent.get("minPrice") or 0)
        shares = int(intent.get("requestedShares") or intent.get("requested_shares") or 0)
        approval = packet.get("approval") if isinstance(packet.get("approval"), Mapping) else {}
        raw_legs = intent.get("orderLegs") or intent.get("order_legs") or []
        if not isinstance(raw_legs, list) or not raw_legs or not all(isinstance(leg, Mapping) for leg in raw_legs):
            raise RuntimeError("broker_intent_order_legs_required")
        source_legs = list(raw_legs)
        statements: list[tuple[str, list[Any]]] = [
            (
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
            )
        ]
        expected_legs: dict[str, dict[str, Any]] = {}
        for index, leg in enumerate(source_legs):
            current_lot = str(leg.get("lotType") or leg.get("lot_type") or "")
            leg_key = f"{index}:{current_lot}"
            current_leg_id = _leg_id(intent_id, leg_key)
            expected = {
                "leg_id": current_leg_id,
                "leg_key": leg_key,
                "client_tag": _client_tag(current_leg_id),
                "lot_type": current_lot,
                "requested_shares": int(leg.get("shares") or 0),
                "broker_quantity": int(leg.get("finlabQuantity") or leg.get("finlab_quantity") or 0),
            }
            expected_legs[leg_key] = expected
            statements.append(
                (
                    """INSERT INTO broker_execution_legs
                       (leg_id,intent_id,leg_key,client_tag,lot_type,requested_shares,broker_quantity,status)
                       SELECT ?,?,?,?,?,?,?,'RESERVED'
                       WHERE EXISTS (
                         SELECT 1 FROM broker_execution_intents
                         WHERE intent_id=? AND packet_hash=?
                       )
                       ON CONFLICT(intent_id,leg_key) DO NOTHING""",
                    [
                        current_leg_id,
                        intent_id,
                        leg_key,
                        expected["client_tag"],
                        current_lot,
                        expected["requested_shares"],
                        expected["broker_quantity"],
                        intent_id,
                        digest,
                    ],
                )
            )
        if risk_decision is not None:
            decision_json = canonical_json(risk_decision)
            risk_config_json = canonical_json(risk_decision.get("risk_config") or {})
            broker_truth_json = canonical_json(risk_decision.get("broker_truth") or {})
            snapshot_json = canonical_json(risk_decision.get("execution_snapshots") or {})
            statements.append(
                (
                    """INSERT INTO execution_risk_decisions
                       (decision_id,intent_id,decision,risk_config_hash,broker_truth_hash,
                        snapshot_hash,decision_json)
                       SELECT ?,?,'allow',?,?,?,?
                       WHERE EXISTS (
                         SELECT 1 FROM broker_execution_intents
                         WHERE intent_id=? AND packet_hash=?
                       )
                       ON CONFLICT(intent_id) DO UPDATE SET
                         risk_config_hash=excluded.risk_config_hash,
                         broker_truth_hash=excluded.broker_truth_hash,
                         snapshot_hash=excluded.snapshot_hash,
                         decision_json=excluded.decision_json,
                         created_at=CURRENT_TIMESTAMP
                       WHERE NOT EXISTS (
                         SELECT 1 FROM broker_execution_legs
                         WHERE intent_id=excluded.intent_id AND status!='RESERVED'
                       )""",
                    [
                        hashlib.sha256(f"risk:{intent_id}".encode("utf-8")).hexdigest(),
                        intent_id,
                        hashlib.sha256(risk_config_json.encode("utf-8")).hexdigest(),
                        hashlib.sha256(broker_truth_json.encode("utf-8")).hexdigest(),
                        hashlib.sha256(snapshot_json.encode("utf-8")).hexdigest(),
                        decision_json,
                        intent_id,
                        digest,
                    ],
                )
            )
        with self._mutation_lock:
            self._atomic(statements, 5.0)
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
        stored_legs = self.list_legs(intent_id)
        stored_by_key = {str(leg.get("leg_key") or ""): leg for leg in stored_legs}
        if set(stored_by_key) != set(expected_legs):
            raise RuntimeError("broker_intent_leg_set_not_persisted")
        for leg_key, expected in expected_legs.items():
            stored = stored_by_key[leg_key]
            for field in (
                "leg_id",
                "client_tag",
                "lot_type",
                "requested_shares",
                "broker_quantity",
            ):
                if str(stored.get(field)) != str(expected[field]):
                    raise RuntimeError(f"broker_intent_leg_contract_mismatch:{leg_key}:{field}")
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
        with self._mutation_lock:
            result = self._atomic(
                [
                    (
                        """UPDATE broker_execution_legs
                           SET status='SUBMITTING',submit_attempts=submit_attempts+1,
                               claimed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,last_error=NULL
                           WHERE intent_id=? AND leg_key=? AND status='RESERVED' AND broker_order_id IS NULL
                             AND EXISTS (
                               SELECT 1 FROM execution_risk_decisions r
                               WHERE r.intent_id=broker_execution_legs.intent_id AND r.decision='allow'
                             )
                             AND EXISTS (
                               SELECT 1 FROM execution_control_state c
                               WHERE c.control_key='live_trading' AND c.kill_switch_active=0
                             )
                           RETURNING *""",
                        [intent_id, leg_key],
                    ),
                    self._intent_status_statement(intent_id),
                ],
                5.0,
            )
            statement_results = result.get("results") or []
            first = statement_results[0] if statement_results else {}
            rows = first.get("results") if isinstance(first, Mapping) else []
            return dict(rows[0]) if rows else None

    def _event_rows_for_order(self, broker_order_id: str, client_tag: str, *, unmatched_only: bool = False) -> list[dict[str, Any]]:
        unmatched = " AND leg_id IS NULL" if unmatched_only else ""
        return self._query(
            f"""SELECT * FROM broker_execution_events
               WHERE (broker_order_id=? OR client_tag=?){unmatched} ORDER BY event_time,received_at,event_id""",
            [broker_order_id, client_tag],
            5.0,
        )

    @staticmethod
    def _intent_status_statement(intent_id: str) -> tuple[str, list[Any]]:
        return (
            """UPDATE broker_execution_intents
               SET status=(
                 SELECT CASE
                   WHEN COUNT(*) = SUM(CASE WHEN status='FILLED' THEN 1 ELSE 0 END) THEN 'FILLED'
                   WHEN SUM(CASE WHEN status='UNKNOWN' THEN 1 ELSE 0 END) > 0 THEN 'UNKNOWN'
                   WHEN SUM(CASE WHEN status IN ('PARTIALLY_FILLED','FILLED') THEN 1 ELSE 0 END) > 0 THEN 'PARTIALLY_FILLED'
                   WHEN SUM(CASE WHEN status='SUBMITTING' THEN 1 ELSE 0 END) > 0 THEN 'SUBMITTING'
                   WHEN COUNT(*) = SUM(CASE WHEN status='REJECTED' THEN 1 ELSE 0 END) THEN 'REJECTED'
                   WHEN COUNT(*) = SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) THEN 'CANCELLED'
                   WHEN SUM(CASE WHEN status='ACKNOWLEDGED' THEN 1 ELSE 0 END) > 0 THEN 'ACKNOWLEDGED'
                   ELSE 'RESERVED'
                 END
                 FROM broker_execution_legs WHERE intent_id=?
               ),updated_at=CURRENT_TIMESTAMP
               WHERE intent_id=?""",
            [intent_id, intent_id],
        )

    def _apply_event_to_leg(
        self,
        leg: Mapping[str, Any],
        event_id: str,
        event_type: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
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
        intent_id = str(leg.get("intent_id") or "")
        leg_id = str(leg.get("leg_id") or "")
        broker_order_id = str(
            payload.get("broker_order_id")
            or payload.get("trade_id")
            or payload.get("id")
            or leg.get("broker_order_id")
            or ""
        ).strip() or None
        expected_filled = max(prior_filled, filled)
        statements = [
            (
                """UPDATE broker_execution_legs SET status=?,filled_shares=MAX(filled_shares,?),
                   average_fill_price=COALESCE(?,average_fill_price),completed_at=COALESCE(?,completed_at),
                   broker_order_id=COALESCE(broker_order_id,?),
                   updated_at=CURRENT_TIMESTAMP
                   WHERE leg_id=? AND EXISTS (
                     SELECT 1 FROM broker_execution_events
                     WHERE event_id=? AND event_status='received'
                   )""",
                [next_status, filled, average_price, completed, broker_order_id, leg_id, event_id],
            ),
            (
                """UPDATE broker_execution_events
                   SET leg_id=?,intent_id=?,event_status='applied'
                   WHERE event_id=? AND event_status='received'
                     AND EXISTS (
                       SELECT 1 FROM broker_execution_legs
                       WHERE leg_id=? AND status=? AND filled_shares>=?
                     )""",
                [leg_id, intent_id, event_id, leg_id, next_status, expected_filled],
            ),
            self._intent_status_statement(intent_id),
        ]
        self._atomic(statements, 5.0)
        event_rows = self._query(
            "SELECT event_status FROM broker_execution_events WHERE event_id=? LIMIT 1",
            [event_id],
            5.0,
        )
        if not event_rows or str(event_rows[0].get("event_status") or "") != "applied":
            raise RuntimeError("broker_event_projection_not_persisted")
        current_rows = self._query(
            "SELECT * FROM broker_execution_legs WHERE leg_id=? LIMIT 1",
            [leg_id],
            5.0,
        )
        if not current_rows:
            raise RuntimeError("broker_leg_projection_missing")
        return current_rows[0]

    def mark_submit_ack(self, leg_id: str, broker_order_id: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not broker_order_id.strip():
            raise RuntimeError("broker_order_id_empty")
        with self._mutation_lock:
            rows = self._query("SELECT * FROM broker_execution_legs WHERE leg_id=? LIMIT 1", [leg_id], 5.0)
            if not rows:
                raise RuntimeError("broker_leg_not_found")
            leg = rows[0]
            intent_id = str(leg.get("intent_id") or "")
            next_status = reduce_leg_state(str(leg.get("status") or "SUBMITTING"), "SUBMIT_ACK")
            client_tag = str(leg.get("client_tag") or "")
            event_payload = {
                **dict(payload),
                "broker_order_id": broker_order_id,
                "client_tag": client_tag,
                "leg_id": leg_id,
            }
            event_id = _event_id(event_payload, "SUBMIT_ACK")
            event_time = str(event_payload.get("event_time") or _utc_now())
            statements = [
                (
                    """UPDATE broker_execution_legs
                       SET status=?,broker_order_id=?,acknowledged_at=COALESCE(acknowledged_at,CURRENT_TIMESTAMP),
                           updated_at=CURRENT_TIMESTAMP
                       WHERE leg_id=? AND (broker_order_id IS NULL OR broker_order_id=?)""",
                    [next_status, broker_order_id, leg_id, broker_order_id],
                ),
                (
                    """INSERT INTO broker_execution_events
                       (event_id,intent_id,leg_id,broker_order_id,client_tag,event_type,event_status,event_time,
                        exchange_sequence,payload_json,source)
                       SELECT ?,?,?,?,?,?,'applied',?,?,?,?
                       WHERE EXISTS (
                         SELECT 1 FROM broker_execution_legs
                         WHERE leg_id=? AND broker_order_id=?
                       )
                       ON CONFLICT(event_id) DO NOTHING""",
                    [
                        event_id,
                        intent_id,
                        leg_id,
                        broker_order_id,
                        client_tag,
                        "SUBMIT_ACK",
                        event_time,
                        None,
                        canonical_json(event_payload),
                        "execution_gateway",
                        leg_id,
                        broker_order_id,
                    ],
                ),
                self._intent_status_statement(intent_id),
            ]
            self._atomic(statements, 5.0)
            current_rows = self._query(
                "SELECT * FROM broker_execution_legs WHERE leg_id=? LIMIT 1",
                [leg_id],
                5.0,
            )
            event_rows = self._query(
                "SELECT event_status FROM broker_execution_events WHERE event_id=? LIMIT 1",
                [event_id],
                5.0,
            )
            if (
                not current_rows
                or str(current_rows[0].get("broker_order_id") or "") != broker_order_id
                or not event_rows
                or str(event_rows[0].get("event_status") or "") != "applied"
            ):
                raise RuntimeError("broker_submit_ack_not_persisted")
            current = current_rows[0]
            for event in self._event_rows_for_order(broker_order_id, client_tag, unmatched_only=True):
                try:
                    raw = json.loads(str(event.get("payload_json") or "{}"))
                except json.JSONDecodeError:
                    raw = {}
                self.record_broker_event(
                    str(event.get("event_type") or ""),
                    raw,
                    source=str(event.get("source") or "execution_gateway_replay"),
                )
                refreshed = self._query(
                    "SELECT * FROM broker_execution_legs WHERE leg_id=? LIMIT 1",
                    [leg_id],
                    5.0,
                )
                if refreshed:
                    current = refreshed[0]
            return current

    def _persist_submit_outcome(
        self,
        leg_id: str,
        event_type: str,
        error: str,
        payload: Mapping[str, Any],
    ) -> None:
        with self._mutation_lock:
            rows = self._query("SELECT * FROM broker_execution_legs WHERE leg_id=? LIMIT 1", [leg_id], 5.0)
            if not rows:
                raise RuntimeError("broker_leg_not_found")
            leg = rows[0]
            intent_id = str(leg.get("intent_id") or "")
            next_status = reduce_leg_state(str(leg.get("status") or "SUBMITTING"), event_type)
            event_payload = {**dict(payload), "leg_id": leg_id, "error": error[:500]}
            broker_order_id = str(leg.get("broker_order_id") or "").strip() or None
            client_tag = str(leg.get("client_tag") or "").strip() or None
            event_id = _event_id(event_payload, event_type)
            completed = _utc_now() if next_status == "REJECTED" else None
            statements = [
                (
                    """UPDATE broker_execution_legs
                       SET status=?,last_error=?,completed_at=COALESCE(?,completed_at),updated_at=CURRENT_TIMESTAMP
                       WHERE leg_id=?""",
                    [next_status, error[:500], completed, leg_id],
                ),
                (
                    """INSERT INTO broker_execution_events
                       (event_id,intent_id,leg_id,broker_order_id,client_tag,event_type,event_status,event_time,
                        exchange_sequence,payload_json,source)
                       SELECT ?,?,?,?,?,?,'applied',?,?,?,?
                       WHERE EXISTS (
                         SELECT 1 FROM broker_execution_legs WHERE leg_id=? AND status=?
                       )
                       ON CONFLICT(event_id) DO NOTHING""",
                    [
                        event_id,
                        intent_id,
                        leg_id,
                        broker_order_id,
                        client_tag,
                        event_type,
                        str(event_payload.get("event_time") or _utc_now()),
                        None,
                        canonical_json(event_payload),
                        "execution_gateway",
                        leg_id,
                        next_status,
                    ],
                ),
                self._intent_status_statement(intent_id),
            ]
            self._atomic(statements, 5.0)
            current = self._query(
                "SELECT status FROM broker_execution_legs WHERE leg_id=? LIMIT 1",
                [leg_id],
                5.0,
            )
            event = self._query(
                "SELECT event_status FROM broker_execution_events WHERE event_id=? LIMIT 1",
                [event_id],
                5.0,
            )
            if (
                not current
                or str(current[0].get("status") or "") != next_status
                or not event
                or str(event[0].get("event_status") or "") != "applied"
            ):
                raise RuntimeError("broker_submit_outcome_not_persisted")

    def mark_submit_unknown(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None:
        self._persist_submit_outcome(leg_id, "SUBMIT_UNKNOWN", error, payload)

    def mark_submit_rejected(self, leg_id: str, error: str, payload: Mapping[str, Any]) -> None:
        self._persist_submit_outcome(leg_id, "SUBMIT_REJECTED", error, payload)

    def record_broker_event(self, event_type: str, payload: Mapping[str, Any], *, source: str) -> dict[str, Any]:
        with self._mutation_lock:
            broker_order_id = str(
                payload.get("broker_order_id") or payload.get("trade_id") or payload.get("id") or ""
            ).strip() or None
            client_tag = str(payload.get("client_tag") or payload.get("custom_field") or "").strip() or None
            event_time = str(payload.get("event_time") or payload.get("datetime") or payload.get("ts") or _utc_now())
            exchange_sequence = str(payload.get("exchange_sequence") or payload.get("exchange_seq") or "").strip() or None
            normalized_payload = {
                **dict(payload),
                "broker_order_id": broker_order_id,
                "client_tag": client_tag,
                "exchange_sequence": exchange_sequence,
            }
            event_id = _event_id(normalized_payload, event_type)
            existing = self._query(
                "SELECT * FROM broker_execution_events WHERE event_id=? LIMIT 1",
                [event_id],
                5.0,
            )
            if existing and str(existing[0].get("event_status") or "") == "applied":
                return {
                    "event_id": event_id,
                    "matched": bool(existing[0].get("leg_id")),
                    "duplicate": True,
                    "leg": None,
                }

            legs = (
                self._query(
                    """SELECT * FROM broker_execution_legs
                       WHERE (? IS NOT NULL AND broker_order_id=?) OR (? IS NOT NULL AND client_tag=?)
                       LIMIT 1""",
                    [broker_order_id, broker_order_id, client_tag, client_tag],
                    5.0,
                )
                if broker_order_id or client_tag
                else []
            )
            if not legs and existing and existing[0].get("leg_id"):
                legs = self._query(
                    "SELECT * FROM broker_execution_legs WHERE leg_id=? LIMIT 1",
                    [existing[0].get("leg_id")],
                    5.0,
                )
            leg = legs[0] if legs else None
            if not existing:
                initial_event_status = "applied" if event_type == "CONNECTION_STATE" else "received"
                self._atomic(
                    [
                        (
                            """INSERT INTO broker_execution_events
                               (event_id,intent_id,leg_id,broker_order_id,client_tag,event_type,event_status,event_time,
                                exchange_sequence,payload_json,source)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?)
                               ON CONFLICT(event_id) DO NOTHING""",
                            [
                                event_id,
                                leg.get("intent_id") if leg else payload.get("intent_id"),
                                leg.get("leg_id") if leg else payload.get("leg_id"),
                                broker_order_id,
                                client_tag,
                                event_type,
                                initial_event_status,
                                event_time,
                                exchange_sequence,
                                canonical_json(normalized_payload),
                                source,
                            ],
                        )
                    ],
                    5.0,
                )
                persisted = self._query(
                    "SELECT * FROM broker_execution_events WHERE event_id=? LIMIT 1",
                    [event_id],
                    5.0,
                )
                if not persisted:
                    raise RuntimeError("broker_event_not_persisted")
            if leg is None:
                return {"event_id": event_id, "matched": False, "duplicate": bool(existing), "leg": None}
            updated = self._apply_event_to_leg(leg, event_id, event_type, normalized_payload)
            return {"event_id": event_id, "matched": True, "duplicate": bool(existing), "leg": updated}

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
