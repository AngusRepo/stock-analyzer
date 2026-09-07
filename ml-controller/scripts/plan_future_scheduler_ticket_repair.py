"""Offline-only repair planner. Never connects to production or launches jobs.

Input is a fresh Ops SELECT snapshot. Quarantine only explicitly selected
physical tickets whose terminal success predates their schedule. Preserve the
entire before image in metadata and require an exact-row CAS. An operator must
check remote executions, approve SQL, execute it, and verify changes()==1.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def literal(value: Any) -> str:
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


def plan(row: dict[str, Any], *, as_of: str) -> dict[str, Any]:
    if row.get('ticket_kind') != 'physical_root' or row.get('status') != 'success':
        raise ValueError('only false-success physical roots may be quarantined')
    if row.get('task') != 'active8-oof-monthly' or row.get('scheduler_job_id') != 'active8-oof-monthly':
        raise ValueError('this incident repair is limited to Active-8 monthly')
    if (utc(row['scheduled_at']) - utc(row['accepted_at'])).total_seconds() <= 300:
        raise ValueError('not a pre-schedule ticket; never invalidate legitimate completion')
    if utc(as_of) < utc(row['scheduled_at']):
        raise ValueError('scheduled time has not arrived')
    if 'status=spawned' not in (row.get('last_summary') or ''):
        raise ValueError('requires the diagnosed dispatch-only false-success receipt')
    metadata = json.loads(row['metadata_json'])
    metadata['future_ticket_repair_v1'] = {
        'reason': 'scheduler_ticket_accepted_before_schedule',
        'before': row,
        'planned_at': as_of,
        'effect': 'quarantine_only_no_dispatch_no_promotion',
    }
    # Do not change identity, attempts or timestamps that identify the old run.
    # Subsequent legitimate admission owns a new attempt and its acceptance time.
    compare = ('ticket_id', 'run_id', 'status', 'payload_checksum', 'accepted_at',
               'updated_at', 'last_summary', 'metadata_json', 'attempt_count', 'scheduled_at')
    where = ' AND '.join(f'{key} IS {literal(row[key])}' for key in compare)
    sql = (
        "UPDATE scheduler_execution_tickets_v1 SET status='blocked', "
        "last_error='scheduler_ticket_accepted_before_schedule; audited quarantine', "
        "last_summary='invalid historical dispatch quarantined; current monthly execution still required', "
        f"metadata_json={literal(json.dumps(metadata, ensure_ascii=False, separators=(',', ':')))}, "
        f"updated_at=CURRENT_TIMESTAMP WHERE {where};"
    )
    return {'ticket_id': row['ticket_id'], 'expected_changes': 1, 'before': row, 'sql': sql,
            'dispatch': False, 'production_effect': False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('--ticket-id', action='append', required=True)
    parser.add_argument('--as-of', required=True, help='Explicit UTC review clock; never auto-apply')
    args = parser.parse_args()
    rows = json.loads(args.snapshot.read_text(encoding='utf-8-sig'))
    if not isinstance(rows, list) or len(set(args.ticket_id)) != len(args.ticket_id):
        raise ValueError('requires row array and distinct explicit ticket ids')
    selected = []
    for ticket_id in args.ticket_id:
        matches = [row for row in rows if row.get('ticket_id') == ticket_id]
        if len(matches) != 1:
            raise ValueError(f'exact ticket not uniquely present: {ticket_id}')
        selected.append(plan(matches[0], as_of=args.as_of))
    print(json.dumps({'mode': 'offline_plan_only', 'plans': selected}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
