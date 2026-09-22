"""NAV cold migration. Default is inventory; mutations require exact approved scope.
Run with PYTHONPATH=ml-controller and existing runtime environment. No secret discovery.
"""
import argparse
import json
from services.d1_domain_client import client_for_domain
from services.paired_nav_cold import migrate_snapshot, release_hot_copy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--action', choices=['inventory', 'archive', 'release'], default='inventory')
    parser.add_argument('--snapshot-id')
    parser.add_argument('--expected-checksum')
    parser.add_argument('--approval-id')
    args = parser.parse_args()
    db = client_for_domain('learning')
    if args.action == 'inventory':
        result = db.query("""SELECT p.snapshot_id,COUNT(*) part_count,m.payload_checksum,m.snapshot_kind,
            CASE WHEN m.snapshot_id IS NULL THEN 'orphan_recovery_required' ELSE 'archive_before_release' END status
            FROM paired_nav_frozen_parts_v1 p LEFT JOIN paired_nav_frozen_manifests_v1 m ON m.snapshot_id=p.snapshot_id
            GROUP BY p.snapshot_id ORDER BY part_count DESC""", [])
    else:
        if not args.snapshot_id or not args.expected_checksum or not args.approval_id:
            parser.error('mutation requires exact snapshot ID, checksum and recorded user approval ID')
        rows = db.query('SELECT payload_checksum FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [args.snapshot_id])
        if len(rows) != 1 or rows[0]['payload_checksum'] != args.expected_checksum:
            parser.error('snapshot missing or checksum changed; no mutation performed')
        if args.action == 'archive':
            result = migrate_snapshot(query=db.query, writer=db.batch_execute, snapshot_id=args.snapshot_id)
        else:
            result = release_hot_copy(query=db.query, writer=db.batch_execute, snapshot_id=args.snapshot_id,
                expected_checksum=args.expected_checksum, approval_id=args.approval_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
