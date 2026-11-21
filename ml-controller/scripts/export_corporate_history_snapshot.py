"""Export a ga_research_dataset snapshot carrying a compiled corporate-history artifact.

The exporter reads the artifact from a local path (load_history_artifact), so this
runs on the operator's machine, never through the Cloud Run snapshot job.

  --dry-run   check the artifact against the sha256 compile_report.json recorded,
              check it covers every session of the window in the given calendar,
              and print the request, the env names the real export needs and
              whether every D1 domain routes to its own database. No network,
              no GCS, no D1.
  (default)   requires --confirm-write: calls export_backtest_dataset_snapshot,
              which reads D1 (core, market, learning, ops, paper), writes the
              snapshot to GCS and upserts its manifest into learning-db. Wei go
              per run; learning-db is read and written, so stay outside
              13:00-16:30Z and 17:00-23:00Z. Each run gets a fresh producer run id,
              so it never overwrites a snapshot that may be in use.

The export refuses to run when STOCKVISION_ALLOCATOR_CONTRACT_GUARD is on (D1 writes
would silently become no-ops) or when two domains resolve to the same database.
Env values are never printed: only names, routing states and a bucket-free GCS path.
A failed GCS or D1 call is re-raised with the bucket name removed from its message.
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
    from services.d1_domain_client import _active_domains, database_id_for_domain
    out, resolved_ids = {}, {}
    try:
        active = {d.value for d in _active_domains()}
    except RuntimeError as exc:
        return {domain: 'error:' + str(exc).split(':')[0] for domain in EXPORT_DOMAINS}
    for domain in EXPORT_DOMAINS:
        specific = os.environ.get(f'CF_D1_{domain.upper()}_DB_ID', '').strip()
        try:
            resolved = database_id_for_domain(domain)
        except RuntimeError as exc:
            out[domain] = 'error:' + str(exc).split(':')[0]
            continue
        resolved_ids[domain] = resolved
        if domain not in active:  # not in MULTI_D1_ACTIVE_DOMAINS: the legacy id, even when it matches
            out[domain] = 'legacy_fallback'
        else:
            out[domain] = 'specific' if specific and resolved == specific else 'legacy_fallback'
    shared = {d for d in resolved_ids if list(resolved_ids.values()).count(resolved_ids[d]) > 1}
    for domain in shared:  # two domains on one database: the export would read or write the wrong one
        if out[domain] == 'specific':
            out[domain] = 'shared_database'
    return out


def allocator_guard_on() -> bool:
    from services.allocator_contract_guard import allocator_contract_guard_enabled
    return allocator_contract_guard_enabled()


def redact_bucket(text: str) -> str:
    bucket = os.environ.get('GCS_BUCKET_NAME', '').strip()
    return text.replace(bucket, '$GCS_BUCKET_NAME') if bucket else text


def bucket_free(uri):
    bucket = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if uri and bucket:
        return str(uri).replace(f'gs://{bucket}/', 'gs://$GCS_BUCKET_NAME/')
    return uri


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
            'allocator_contract_guard_on': allocator_guard_on(),
            'writes': 'none (dry run)'}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('artifact', type=Path)
    parser.add_argument('--business-date', required=True)
    parser.add_argument('--start-date', required=True)
    parser.add_argument('--end-date', required=True)
    parser.add_argument('--calendar', type=Path, required=True, help='days.json sealed by the fetch (spec days)')
    parser.add_argument('--expected-sha256', required=True, help='sha256 from compile_report.json')
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
    if report['allocator_contract_guard_on']:
        raise SystemExit('export_refused_allocator_contract_guard_on')
    from datetime import datetime, timezone
    # A fresh run id: a rerun never overwrites a snapshot (GCS prefix and manifest) that may be in use.
    run_id = 'corporate-history-{}-{}'.format(
        args.business_date, datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    from services.dataset_snapshot_exporter import DatasetSnapshotExportRequest, export_backtest_dataset_snapshot
    request = {k: v for k, v in report['request'].items() if k != 'kind'}
    try:
        summary = export_backtest_dataset_snapshot(DatasetSnapshotExportRequest(
            **request, producer_run_id=run_id))
    except Exception as exc:  # client errors carry .../b/<bucket>/o URLs; keep the bucket out of stderr
        raise SystemExit(f'export_failed:{type(exc).__name__}:' + redact_bucket(str(exc))[:500]) from None
    snapshot = summary.get('snapshot') or {}
    print(json.dumps({'status': summary.get('status'), 'snapshot_id': snapshot.get('snapshot_id'),
                      'kind': snapshot.get('kind'), 'business_date': snapshot.get('business_date'),
                      'checksum': snapshot.get('checksum'), 'gcs_uri': bucket_free(snapshot.get('gcs_uri')),
                      'row_count': snapshot.get('row_count'), 'artifact_sha256': report['artifact_sha256']},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
