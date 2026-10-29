"""D7g: ops-db retention ledger retention. Dry-run by default; --execute needs a separate Wei go.

Only no-op ledger rows are eligible: a run item that deleted, archived or scrubbed nothing and
names no artifact, and a run with the same zero counts whose items are all eligible. Release
receipts (deleted_rows>0 or an evidence artifact_id) stay, because the cold readers
(retention_history.py, retention_market_history.py, retentionReleaseReconciliation.ts) prove a
release from them. run_artifacts, artifact_hard_references and artifact_deletion_claims_v1 are
reported but never deleted here (claims are immutable by trigger and FK-pin their artifacts).
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

CONFIRM_PHRASE = 'delete-ops-ledger-noop-rows'
DEFAULT_RETENTION_DAYS = 400


def _noop_item(a: str = '') -> str:
    """An item older than the cutoff that moved no rows and names no artifact."""
    return (f"{a}completed_at < ? AND {a}deleted_rows=0 AND {a}archived_rows=0 AND {a}scrubbed_rows=0 "
            f"AND CASE WHEN json_valid({a}evidence_json) THEN json_extract({a}evidence_json,'$.artifact_id') END IS NULL")


ITEM_WHERE = _noop_item()
RUN_WHERE = ("COALESCE(completed_at, created_at) < ? AND status<>'running' "
             "AND deleted_rows=0 AND archived_rows=0 AND scrubbed_rows=0 "
             "AND NOT EXISTS (SELECT 1 FROM data_retention_run_items i "
             f"WHERE i.run_id=data_retention_runs.run_id AND NOT ({_noop_item('i.')}))")
REPORT_ONLY = {
    'run_artifacts': "SELECT COUNT(*) n FROM run_artifacts WHERE created_at < ?",
    'artifact_hard_references': "SELECT COUNT(*) n FROM artifact_hard_references WHERE active=0 AND released_at < ?",
    'artifact_deletion_claims_v1': "SELECT COUNT(*) n FROM artifact_deletion_claims_v1 WHERE claimed_at < ?",
}

Query = Callable[[str, list[Any]], list[dict]]
Execute = Callable[[str, list[Any]], dict]


def cutoff_for(now: datetime, retention_days: int) -> str:
    if retention_days < 90:
        raise ValueError('ops_ledger_retention_days_too_small')
    return (now.astimezone(timezone.utc) - timedelta(days=retention_days)).strftime('%Y-%m-%d %H:%M:%S')


def _count(query: Query, sql: str, params: list[Any]) -> int:
    rows = query(sql, params)
    return int(rows[0]['n']) if rows else 0


def plan(query: Query, cutoff: str) -> dict:
    """Read-only counts of what --execute would delete, plus the report-only tables."""
    return {
        'cutoff': cutoff,
        'eligible': {
            'data_retention_run_items': _count(query, f"SELECT COUNT(*) n FROM data_retention_run_items WHERE {ITEM_WHERE}", [cutoff]),
            'data_retention_runs': _count(query, f"SELECT COUNT(*) n FROM data_retention_runs WHERE {RUN_WHERE}", [cutoff, cutoff]),
        },
        'total': {t: _count(query, f"SELECT COUNT(*) n FROM {t}", []) for t in ('data_retention_run_items', 'data_retention_runs')},
        'report_only_older_than_cutoff': {t: _count(query, sql, [cutoff]) for t, sql in REPORT_ONLY.items()},
    }


def execute(run: Execute, cutoff: str, *, batch_size: int = 500, max_batches: int = 200) -> dict:
    """Delete eligible rows in bounded batches: items first (FK), then runs left without items."""
    deleted = {'data_retention_run_items': 0, 'data_retention_runs': 0}
    statements = (
        ('data_retention_run_items', f"DELETE FROM data_retention_run_items WHERE rowid IN "
                                     f"(SELECT rowid FROM data_retention_run_items WHERE {ITEM_WHERE} LIMIT ?)", [cutoff]),
        ('data_retention_runs', f"DELETE FROM data_retention_runs WHERE rowid IN "
                                f"(SELECT rowid FROM data_retention_runs WHERE {RUN_WHERE} LIMIT ?)", [cutoff, cutoff]),
    )
    for table, sql, params in statements:
        for _ in range(max_batches):
            changes = int((run(sql, [*params, batch_size]).get('meta') or {}).get('changes') or 0)
            deleted[table] += changes
            if changes < batch_size:
                break
    return {'cutoff': cutoff, 'deleted': deleted}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--retention-days', type=int, default=DEFAULT_RETENTION_DAYS)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--confirm', default='')
    args = parser.parse_args(argv)
    if args.execute and args.confirm != CONFIRM_PHRASE:
        parser.error(f'--execute requires --confirm {CONFIRM_PHRASE}')
    from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
    ops = client_proxy_for_domain(D1DataDomain.OPS)
    cutoff = cutoff_for(datetime.now(timezone.utc), args.retention_days)
    report = plan(ops.query, cutoff)
    if args.execute:
        report['executed'] = execute(ops.execute, cutoff)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
