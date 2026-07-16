from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.broker_execution_repository import D1BrokerExecutionRepository  # noqa: E402


def _packet(key: str = "repository-idempotency-key-001") -> dict:
    now = datetime.now(timezone.utc)
    return {
        "schema_version": "stockvision-live-execution-packet-v1",
        "idempotency_key": key,
        "trade_date": "2026-07-13",
        "generated_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=5)).isoformat(),
        "approval": {"scope": "pilot"},
        "intent": {
            "accountId": 1,
            "tradeDate": "2026-07-13",
            "symbol": "4953",
            "side": "sell",
            "requestedShares": 3209,
            "limitPrice": 142,
            "orderLegs": [
                {"lotType": "board_lot", "shares": 3000, "finlabQuantity": 3},
                {"lotType": "odd_lot", "shares": 209, "finlabQuantity": 209},
            ],
        },
    }


def _reserve(repo: D1BrokerExecutionRepository, packet: dict | None = None) -> dict:
    return repo.reserve_intent(
        packet or _packet(),
        risk_decision={
            "risk_config": {"system": {"killSwitch": False}},
            "broker_truth": {"account_match": True},
            "execution_snapshots": {"board_lot": {"snapshot_id": "test"}},
        },
    )


def _repository() -> tuple[D1BrokerExecutionRepository, sqlite3.Connection]:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    migration = (
        REPO / "worker" / "migrations-execution" / "0001_execution_ledger.sql"
    ).read_text(encoding="utf-8")
    conn.executescript(migration)
    conn.execute(
        """UPDATE execution_control_state
           SET kill_switch_active=0,version=version+1,reason='unit_test',updated_by='pytest'
           WHERE control_key='live_trading'"""
    )
    conn.commit()

    def query(sql, params, timeout):
        return [dict(row) for row in conn.execute(sql, params or []).fetchall()]

    def atomic(statements, timeout):
        results = []
        try:
            conn.execute("BEGIN")
            for sql, params in statements:
                cursor = conn.execute(sql, params or [])
                rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
                results.append({"success": True, "results": rows, "meta": {"changes": cursor.rowcount}})
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return {"success": True, "statement_count": len(results), "results": results, "atomic": True}

    return D1BrokerExecutionRepository(query, atomic), conn


def test_reservation_is_idempotent_and_repairs_legs() -> None:
    repo, conn = _repository()
    packet = _packet()
    first = _reserve(repo, packet)
    second = _reserve(repo, packet)
    assert first["intent_id"] == second["intent_id"]
    assert len(repo.list_legs(first["intent_id"])) == 2
    assert all(len(row["client_tag"]) == 6 and row["client_tag"].isalnum() for row in repo.list_legs(first["intent_id"]))
    assert conn.execute("SELECT COUNT(*) FROM broker_execution_intents").fetchone()[0] == 1


def test_same_idempotency_key_with_different_payload_is_conflict() -> None:
    repo, _ = _repository()
    _reserve(repo)
    changed = _packet()
    changed["intent"]["limitPrice"] = 141.5
    assert _reserve(repo, changed)["status"] == "conflict"


def test_deal_before_submit_ack_is_attached_and_reduced_after_order_id_known() -> None:
    repo, conn = _repository()
    reservation = _reserve(repo)
    intent_id = reservation["intent_id"]
    leg = repo.claim_leg(intent_id, "0:board_lot")
    assert leg is not None
    unmatched = repo.record_broker_event(
        "DEAL_CALLBACK",
        {
            "broker_order_id": "broker-order-1",
            "quantity": 1000,
            "price": 142,
            "exchange_sequence": "deal-001",
            "event_time": "2026-07-13T09:01:00+08:00",
        },
        source="test",
    )
    assert unmatched["matched"] is False
    updated = repo.mark_submit_ack(leg["leg_id"], "broker-order-1", {"intent_id": intent_id})
    assert updated["status"] == "PARTIALLY_FILLED"
    stored = repo.list_legs(intent_id)[0]
    assert stored["filled_shares"] == 1000
    event = conn.execute("SELECT leg_id FROM broker_execution_events WHERE exchange_sequence='deal-001'").fetchone()
    assert event["leg_id"] == leg["leg_id"]


def test_unknown_leg_cannot_be_claimed_for_automatic_retry() -> None:
    repo, _ = _repository()
    reservation = _reserve(repo)
    intent_id = reservation["intent_id"]
    leg = repo.claim_leg(intent_id, "0:board_lot")
    assert leg is not None
    repo.mark_submit_unknown(leg["leg_id"], "timeout", {"intent_id": intent_id})
    assert repo.claim_leg(intent_id, "0:board_lot") is None


def test_multiple_deals_accumulate_once_and_duplicate_event_is_ignored() -> None:
    repo, conn = _repository()
    reservation = _reserve(repo)
    intent_id = reservation["intent_id"]
    leg = repo.claim_leg(intent_id, "0:board_lot")
    assert leg is not None
    repo.mark_submit_ack(leg["leg_id"], "broker-order-2", {"intent_id": intent_id})
    first = {
        "broker_order_id": "broker-order-2",
        "quantity": 1000,
        "exchange_sequence": "deal-a",
        "event_time": "2026-07-13T09:01:01+08:00",
    }
    second = {**first, "exchange_sequence": "deal-b", "event_time": "2026-07-13T09:01:02+08:00"}
    repo.record_broker_event("DEAL_CALLBACK", first, source="test")
    repo.record_broker_event("DEAL_CALLBACK", first, source="test")
    repo.record_broker_event("DEAL_CALLBACK", second, source="test")
    stored = repo.list_legs(intent_id)[0]
    assert stored["filled_shares"] == 2000
    assert stored["status"] == "PARTIALLY_FILLED"
    assert conn.execute("SELECT COUNT(*) FROM broker_execution_events WHERE event_type='DEAL_CALLBACK'").fetchone()[0] == 2


def test_reconciliation_can_close_cancelled_order() -> None:
    repo, _ = _repository()
    reservation = _reserve(repo)
    intent_id = reservation["intent_id"]
    leg = repo.claim_leg(intent_id, "0:board_lot")
    assert leg is not None
    repo.mark_submit_ack(leg["leg_id"], "broker-order-3", {"intent_id": intent_id})
    repo.record_broker_event(
        "STATUS_RECONCILIATION",
        {"broker_order_id": "broker-order-3", "status": "Cancelled", "exchange_sequence": "cancel-a"},
        source="test",
    )
    assert repo.list_legs(intent_id)[0]["status"] == "CANCELLED"


def test_unknown_submit_recovers_by_six_character_client_tag() -> None:
    repo, _ = _repository()
    reservation = _reserve(repo)
    intent_id = reservation["intent_id"]
    leg = repo.claim_leg(intent_id, "0:board_lot")
    assert leg is not None
    repo.mark_submit_unknown(leg["leg_id"], "place_order_timeout", {"intent_id": intent_id})
    result = repo.record_broker_event(
        "STATUS_RECONCILIATION",
        {
            "client_tag": leg["client_tag"],
            "broker_order_id": "late-order-id",
            "status": "Submitted",
            "exchange_sequence": "late-ack-1",
        },
        source="restart_recovery",
    )
    assert result["matched"] is True
    recovered = repo.list_legs(intent_id)[0]
    assert recovered["status"] == "ACKNOWLEDGED"
    assert recovered["broker_order_id"] == "late-order-id"


def test_repository_rejects_non_atomic_dependency_injection() -> None:
    with pytest.raises(RuntimeError, match="query and atomic"):
        D1BrokerExecutionRepository(query_fn=lambda *args: [])


def test_execution_ledger_health_reports_control_and_unresolved_state() -> None:
    repo, _ = _repository()
    assert repo.health() == {
        "ready": True,
        "kill_switch_active": False,
        "unresolved_count": 0,
        "intent_count": 0,
    }


def test_reservation_atomic_failure_leaves_no_partial_intent_or_legs() -> None:
    repo, conn = _repository()

    def fail_after_first_statement(statements, timeout):
        try:
            conn.execute("BEGIN")
            sql, params = statements[0]
            conn.execute(sql, params)
            raise RuntimeError("injected_atomic_failure")
        except Exception:
            conn.rollback()
            raise

    repo._atomic = fail_after_first_statement
    with pytest.raises(RuntimeError, match="injected_atomic_failure"):
        _reserve(repo)
    assert conn.execute("SELECT COUNT(*) FROM broker_execution_intents").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM broker_execution_legs").fetchone()[0] == 0


def test_received_event_is_replayed_exactly_once_after_projection_failure() -> None:
    repo, conn = _repository()
    reservation = _reserve(repo)
    intent_id = reservation["intent_id"]
    leg = repo.claim_leg(intent_id, "0:board_lot")
    assert leg is not None
    repo.mark_submit_ack(leg["leg_id"], "broker-order-replay", {"intent_id": intent_id})
    original_atomic = repo._atomic
    call_count = 0

    def fail_projection_once(statements, timeout):
        nonlocal call_count
        call_count += 1
        if call_count == 2:
            raise RuntimeError("projection_write_unavailable")
        return original_atomic(statements, timeout)

    repo._atomic = fail_projection_once
    event = {
        "broker_order_id": "broker-order-replay",
        "quantity": 1000,
        "exchange_sequence": "deal-replay-1",
        "event_time": "2026-07-13T09:02:00+08:00",
    }
    with pytest.raises(RuntimeError, match="projection_write_unavailable"):
        repo.record_broker_event("DEAL_CALLBACK", event, source="test")
    stored_event = conn.execute(
        "SELECT event_status FROM broker_execution_events WHERE exchange_sequence='deal-replay-1'"
    ).fetchone()
    assert stored_event["event_status"] == "received"
    assert repo.list_legs(intent_id)[0]["filled_shares"] == 0

    repo._atomic = original_atomic
    recovered = repo.record_broker_event("DEAL_CALLBACK", event, source="test")
    duplicate = repo.record_broker_event("DEAL_CALLBACK", event, source="test")
    assert recovered["matched"] is True
    assert duplicate["duplicate"] is True
    assert repo.list_legs(intent_id)[0]["filled_shares"] == 1000
