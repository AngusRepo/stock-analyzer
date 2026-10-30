"""Export a ga_research_dataset snapshot carrying a compiled corporate-history artifact.

The exporter reads the artifact from a local path (load_history_artifact), so this
runs on the operator's machine, never through the Cloud Run snapshot job.

  --dry-run   check the artifact against the sha256 compile_report.json recorded,
              check it covers every session of the window in the given calendar,
              and print the request, the env names the real export needs and
              whether every D1 domain routes to its own database. No network,
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

# D1 domains the exporter reads or writes: core/market/learning (components and the
# learning-db manifest), ops (cold-archive manifests), paper (corporate session index).
EXPORT_DOMAINS = ('core', 'market', 'learning', 'ops', 'paper')
REQUIRED_ENV = ('CF_API_TOKEN', 'CF_ACCOUNT_ID', 'GCS_BUCKET_NAME', 'STOCKVISION_WORKER_URL',
                'STOCKVISION_AUTH_TOKEN', 'MULTI_D1_ACTIVE_DOMAINS',
                *(f'CF_D1_{d.upper()}_DB_ID' for d in EXPORT_DOMAINS))


def domain_routing() -> dict:
    """Per domain: 'specific' when it resolves to its own database id, as the controller does.

    Without MULTI_D1_ACTIVE_DOMAINS a domain falls back to the legacy CF_D1_DB_ID:
    the export would read the wrong database and write a manifest the resolver
    never sees. Values are never reported.
    """
    from services.d1_domain_client import database_id_for_domain
    out = {}
    for domain in EXPORT_DOMAINS:
        specific = os.environ.get(f'CF_D1_{domain.upper()}_DB_ID', '').strip()
        try:
            resolved = database_id_for_domain(domain)
        except RuntimeError as exc:
            out[domain] = 'error:' + str(exc).split(':')[0]
            continue
        out[domain] = 'specific' if specific and resolved == specific else 'legacy_fallback'
    return out


def plan(artifact: Path, *, business_date: str, start_date: str, end_date: str, calendar: list[str],
         expected_sha256: str) -> dict:
    from services.research_corporate_history import load_history_artifact, validate_history_coverage
    checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
    if checksum != expected_sha256:  # the sha256 compile_report.json recorded for this artifact
        raise SystemExit('export_artifact_sha256_mismatch')
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
            'd1_routing': domain_routing(),
            'writes': 'none (dry run)'}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('artifact', type=Path)
    parser.add_argument('--business-date', required=True)
    parser.add_argument('--start-date', required=True)
    parser.add_argument('--end-date', required=True)
    parser.add_argument('--calendar', type=Path, required=True, help='days.json sealed by the fetch (spec days)')
    parser.add_argument('--expected-sha256', required=True, help='sha256 from compile_report.json')
    parser.add_argument('--producer-run-id', default=None)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--confirm-write', action='store_true')
    args = parser.parse_args(argv)
    calendar = sorted(json.loads(args.calendar.read_text(encoding='utf-8')))
    report = plan(args.artifact.resolve(), business_date=args.business_date, start_date=args.start_date,
                  end_date=args.end_date, calendar=calendar, expected_sha256=args.expected_sha256)
    if args.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if not args.confirm_write:
        raise SystemExit('refusing to write GCS/D1 without --confirm-write (Wei go)')
    if report['env_missing']:
        raise SystemExit('export_env_missing:' + ','.join(report['env_missing']))
    unrouted = [d for d, state in report['d1_routing'].items() if state != 'specific']
    if unrouted:
        raise SystemExit('export_d1_domain_not_routed:' + ','.join(unrouted))
    from datetime import datetime, timezone
    # A fresh run id: a rerun never overwrites a snapshot (GCS prefix and manifest) that may be in use.
    run_id = args.producer_run_id or 'corporate-history-{}-{}'.format(
        args.business_date, datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    from services.dataset_snapshot_exporter import DatasetSnapshotExportRequest, export_backtest_dataset_snapshot
    request = {k: v for k, v in report['request'].items() if k != 'kind'}
    summary = export_backtest_dataset_snapshot(DatasetSnapshotExportRequest(
        **request, producer_run_id=run_id))
    snapshot = summary.get('snapshot') or {}
    print(json.dumps({'status': summary.get('status'), 'snapshot_id': snapshot.get('snapshot_id'),
                      'kind': snapshot.get('kind'), 'business_date': snapshot.get('business_date'),
                      'checksum': snapshot.get('checksum'), 'gcs_uri': snapshot.get('gcs_uri'),
                      'row_count': snapshot.get('row_count'), 'artifact_sha256': report['artifact_sha256']},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
