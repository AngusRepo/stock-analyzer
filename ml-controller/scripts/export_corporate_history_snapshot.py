"""Export a ga_research_dataset snapshot carrying a compiled corporate-history artifact.

The exporter reads the artifact from a local path (load_history_artifact), so this
runs on the operator's machine, never through the Cloud Run snapshot job.

  --dry-run   verify the artifact (sha256, tape), check it covers every session of
              the window in the given calendar, estimate nothing remote, and print
              the request and the env names the real export needs. No network,
              no GCS, no D1.
  (default)   requires --confirm-write: calls export_backtest_dataset_snapshot,
              which reads D1 (core, market, learning) and writes the snapshot to
              GCS plus its D1 manifest. Wei go per run; learning-db is read, so
              stay outside 13:00-16:30Z and 17:00-23:00Z.

Env values are never printed; only the names present or missing are reported.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

REQUIRED_ENV = ('CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_D1_CORE_DB_ID', 'CF_D1_MARKET_DB_ID',
                'CF_D1_LEARNING_DB_ID', 'GCS_BUCKET_NAME')


def plan(artifact: Path, *, business_date: str, start_date: str, end_date: str, calendar: list[str]) -> dict:
    from services.research_corporate_history import load_history_artifact, validate_history_coverage
    checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
    frame = load_history_artifact(artifact, checksum)
    days = sorted(d for d in calendar if start_date <= d <= end_date)
    if not days:
        raise SystemExit('export_window_has_no_sessions_in_calendar')
    if days[-1] != end_date:
        raise SystemExit(f'export_end_date_not_a_calendar_session:{end_date} (calendar ends {calendar[-1]})')
    tape = validate_history_coverage(frame, days=days, symbols=())  # what the exporter checks before writing
    return {'artifact': str(artifact), 'artifact_sha256': checksum,
            'history_start': min(tape), 'history_end': max(tape), 'window_sessions': len(days),
            'request': {'business_date': business_date, 'start_date': start_date, 'end_date': end_date,
                        'kind': 'ga_research_dataset', 'include_signals': True,
                        'corporate_history_path': str(artifact), 'corporate_history_checksum': checksum},
            'env_present': [n for n in REQUIRED_ENV if os.environ.get(n, '').strip()],
            'env_missing': [n for n in REQUIRED_ENV if not os.environ.get(n, '').strip()],
            'writes': 'none (dry run)'}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('artifact', type=Path)
    parser.add_argument('--business-date', required=True)
    parser.add_argument('--start-date', required=True)
    parser.add_argument('--end-date', required=True)
    parser.add_argument('--calendar', type=Path, required=True, help='days.json sealed by the fetch (spec days)')
    parser.add_argument('--producer-run-id', default=None)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--confirm-write', action='store_true')
    args = parser.parse_args(argv)
    calendar = sorted(json.loads(args.calendar.read_text(encoding='utf-8')))
    report = plan(args.artifact.resolve(), business_date=args.business_date, start_date=args.start_date,
                  end_date=args.end_date, calendar=calendar)
    if args.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if not args.confirm_write:
        raise SystemExit('refusing to write GCS/D1 without --confirm-write (Wei go)')
    if report['env_missing']:
        raise SystemExit('export_env_missing:' + ','.join(report['env_missing']))
    from services.dataset_snapshot_exporter import DatasetSnapshotExportRequest, export_backtest_dataset_snapshot
    request = {k: v for k, v in report['request'].items() if k != 'kind'}
    summary = export_backtest_dataset_snapshot(DatasetSnapshotExportRequest(
        **request, producer_run_id=args.producer_run_id or f'corporate-history-{args.business_date}'))
    snapshot = summary.get('snapshot') or {}
    print(json.dumps({'status': summary.get('status'), 'snapshot_id': snapshot.get('snapshot_id'),
                      'kind': snapshot.get('kind'), 'business_date': snapshot.get('business_date'),
                      'checksum': snapshot.get('checksum'), 'gcs_uri': snapshot.get('gcs_uri'),
                      'row_count': snapshot.get('row_count'), 'artifact_sha256': report['artifact_sha256']},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
