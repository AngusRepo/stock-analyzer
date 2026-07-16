from __future__ import annotations

from pathlib import Path
import sqlite3

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = REPO_ROOT / "worker" / "migrations-execution" / "0001_execution_ledger.sql"


def test_execution_ledger_migration_is_standalone_and_fail_closed() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(MIGRATION.read_text(encoding="utf-8"))

    tables = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert {
        "execution_database_identity",
        "broker_execution_intents",
        "broker_execution_legs",
        "broker_execution_events",
        "execution_control_state",
        "execution_risk_decisions",
        "execution_reconciliation_runs",
        "execution_reconciliation_discrepancies",
    }.issubset(tables)

    identity = connection.execute(
        "SELECT purpose,schema_version,instance_id FROM execution_database_identity"
    ).fetchone()
    assert identity == (
        "real_trading_execution_only",
        "stockvision-execution-ledger-v1",
        "UNPROVISIONED",
    )
    control = connection.execute(
        "SELECT kill_switch_active,version FROM execution_control_state WHERE control_key='live_trading'"
    ).fetchone()
    assert control == (1, 1)

    with pytest.raises(sqlite3.IntegrityError):
        connection.execute(
            "UPDATE execution_control_state SET kill_switch_active=2 WHERE control_key='live_trading'"
        )
