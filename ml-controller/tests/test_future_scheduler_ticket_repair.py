import json
import sqlite3
from pathlib import Path

import pytest

from scripts.plan_future_scheduler_ticket_repair import plan


def test_repair_preserves_before_image_and_exact_cas_then_allows_existing_retry():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    root = Path(__file__).resolve().parents[2]
    conn.executescript((root / 'worker/domain-migrations/ops/0011_scheduler_execution_tickets.sql').read_text())
    conn.execute("""INSERT INTO scheduler_execution_tickets_v1(
        ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,scheduled_at,
        run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum,accepted_at,last_summary)
        VALUES('t','d','t','active8-oof-monthly','active8-oof-monthly','2026-09-06',
        '2026-09-05T18:00:00Z','r','r:attempt:1','physical_root','success','scheduler_http','sha256:x',
        '2026-08-26 17:44:28','active8_oof_lifecycle status=spawned cadence=monthly')""")
    row = dict(conn.execute('SELECT * FROM scheduler_execution_tickets_v1').fetchone())
    repair = plan(row, as_of='2026-09-06T02:00:00Z')
    assert conn.execute(repair['sql']).rowcount == 1
    assert conn.execute(repair['sql']).rowcount == 0
    after = dict(conn.execute('SELECT * FROM scheduler_execution_tickets_v1').fetchone())
    assert after['status'] == 'blocked'
    assert json.loads(after['metadata_json'])['future_ticket_repair_v1']['before'] == row
    for key in ('run_id', 'dedupe_key', 'attempt_count', 'accepted_at', 'completed_at'):
        assert after[key] == row[key]
    with pytest.raises(ValueError, match='not a pre-schedule'):
        plan({**row, 'accepted_at': row['scheduled_at']}, as_of='2026-09-06T02:00:00Z')
    with pytest.raises(ValueError, match='not arrived'):
        plan(row, as_of='2026-08-27T00:00:00Z')
    with pytest.raises(ValueError, match='limited to Active-8 monthly'):
        plan({**row, 'task': 'weekly-optuna'}, as_of='2026-09-06T02:00:00Z')
