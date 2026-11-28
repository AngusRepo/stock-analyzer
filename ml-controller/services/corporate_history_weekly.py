"""Weekly research corporate-history snapshot (ga_research_dataset), Wei 2026-11-28 P3a option A.

Runs in the dataset-snapshot-export Cloud Run Job (DATASET_SNAPSHOT_MODE=corporate_history_weekly),
Saturday TW 10:00, so Sunday's weekly-backtest freshness gate (history may trail the newest
backtest_dataset by at most 5 sessions) never depends on a hand export.

Each run, in a fresh work directory:
  1. scope   days = the baseline's sealed calendar + market_trading_sessions after it (through
             run_date); universe = the core stocks active in the window (same query as the exporter).
  2. fetch   the seven FinLab sources + TWSE ETF registry (fetch_corporate_history_sources.fetch).
  3. rules   the reviewed MOPS rules and issuer bundle stay frozen in a GCS baseline whose object and
             sha256 are pinned in git (corporate_history_baseline.json; the bucket is the job's
             GCS_BUCKET_NAME). A later event without a reviewed issuer document stays blocked, so its
             issuer is excluded (fail-closed); MOPS review stays manual, and a new reviewed baseline
             ships by PR.
  4. compile compile_history + gap_report; the history must reach the last session.
  5. gate    the production 1/5 exclusion gate on the 90 / 365 day and full windows; any STOPS
             publishes nothing.
  6. archive the sealed inputs (fetched sources, spec, calendar, universe, frozen baseline objects,
             artifact, gate) to gs://$GCS_BUCKET_NAME/research/corporate_history/weekly/<run_id>/,
             because the job's work directory is temporary; the manual flow kept them under audits/.
  7. export  export_backtest_dataset_snapshot under this attempt's producer run id (the job suffixes a
             Cloud Run retry, so a retry never rewrites an earlier attempt's objects).

Nothing here changes Paper, serving pointers, KV or trading config.
"""
from __future__ import annotations

from datetime import date
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable

BASELINE_SCHEMA = 'corporate-history-weekly-baseline-v1'
PIN_SCHEMA = 'corporate-history-baseline-pin-v1'
PIN_PATH = Path(__file__).with_name('corporate_history_baseline.json')
# Same scope as the reviewed manual runs (runbook_corporate_history_1107 stocks_raw query).
UNIVERSE_MARKETS = ('TWSE', 'OTC')
GATE_WINDOWS = (90, 365)
ARCHIVE_PREFIX = 'research/corporate_history/weekly'
SESSIONS_SQL = ('SELECT session_date FROM market_trading_sessions'
                ' WHERE session_date > ? AND session_date <= ? ORDER BY session_date')


class CorporateHistoryWeeklyError(RuntimeError):
    """A named fail-closed stop: nothing was published."""


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read_gcs_uri(uri: str) -> bytes:
    if not uri.startswith('gs://') or '/' not in uri[5:]:
        raise CorporateHistoryWeeklyError('corporate_history_baseline_uri_invalid')
    bucket, _, path = uri[5:].partition('/')
    from google.cloud import storage
    return storage.Client().bucket(bucket).blob(path).download_as_bytes()


def _sibling(uri: str, name: str) -> str:
    if '/' in name or name in ('', '.', '..'):
        raise CorporateHistoryWeeklyError('corporate_history_baseline_object_name_invalid')
    return uri.rsplit('/', 1)[0] + '/' + name


def pinned_baseline(pin_path: Path = PIN_PATH) -> tuple[str, str]:
    """(gs:// uri, sha256) of the reviewed baseline pinned in git; the bucket is the job's GCS_BUCKET_NAME."""
    pin = json.loads(pin_path.read_text(encoding='utf-8'))
    obj, digest = str(pin.get('object') or ''), str(pin.get('sha256') or '')
    if pin.get('schema_version') != PIN_SCHEMA or not obj or obj.startswith('/') or '..' in obj.split('/') \
            or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise CorporateHistoryWeeklyError('corporate_history_baseline_pin_invalid')
    bucket = os.environ.get('GCS_BUCKET_NAME', '').strip()
    if not bucket:
        raise CorporateHistoryWeeklyError('corporate_history_export_env_missing:GCS_BUCKET_NAME')
    return f'gs://{bucket}/{obj}', digest


def load_baseline(uri: str, workdir: Path, *, expected_sha256: str,
                  read: Callable[[str], bytes] = read_gcs_uri) -> dict[str, Any]:
    """Frozen reviewed inputs: baseline.json must match the git pin, and every extra source its own sha256."""
    raw = read(uri)
    if _sha256(raw) != expected_sha256:
        raise CorporateHistoryWeeklyError('corporate_history_baseline_checksum_mismatch')
    baseline = json.loads(raw)
    if baseline.get('schema_version') != BASELINE_SCHEMA:
        raise CorporateHistoryWeeklyError('corporate_history_baseline_schema_invalid')
    days = baseline.get('days')
    if not isinstance(days, list) or not days or any(not isinstance(d, str) or date.fromisoformat(d).isoformat() != d
                                                     for d in days):
        raise CorporateHistoryWeeklyError('corporate_history_baseline_days_invalid')
    if _sha256(json.dumps(sorted(days)).encode()) != baseline.get('days_sha256'):
        raise CorporateHistoryWeeklyError('corporate_history_baseline_days_checksum_mismatch')
    start = baseline.get('history_start')
    if start != min(days):
        raise CorporateHistoryWeeklyError('corporate_history_baseline_start_not_first_session')
    for name in ('reviewed_stock_rules', 'reviewed_subscription_rules', 'cash_rounding_rules'):
        if not isinstance(baseline.get(name, []), list):
            raise CorporateHistoryWeeklyError(f'corporate_history_baseline_{name}_invalid')
    extras = []
    for entry in baseline.get('extra_sources') or []:
        raw = read(_sibling(uri, entry['object']))
        if _sha256(raw) != entry['sha256']:
            raise CorporateHistoryWeeklyError('corporate_history_baseline_object_checksum_mismatch:' + entry['object'])
        local = workdir / ('baseline-' + entry['object'])
        local.write_bytes(raw)
        extras.append({'dataset': entry['dataset'], 'path': str(local), 'fetched_at': entry['fetched_at'],
                       'sha256': entry['sha256']})
    return {**baseline, 'days': sorted(days), 'extra_sources': extras}


def session_days(baseline_days: list[str], run_date: str, query: Callable[[str, list], list[dict]]) -> list[str]:
    """Sealed baseline calendar plus the observed exchange sessions after it, through run_date."""
    last = max(baseline_days)
    if run_date <= last:
        raise CorporateHistoryWeeklyError(f'corporate_history_run_date_not_after_baseline:{run_date}<={last}')
    added = [str(row['session_date'])[:10] for row in query(SESSIONS_SQL, [last, run_date])]
    if not added:
        raise CorporateHistoryWeeklyError(f'corporate_history_no_new_sessions_after:{last}')
    return sorted(set(baseline_days) | set(added))


def _market_query(sql: str, params: list) -> list[dict]:
    from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
    return client_proxy_for_domain(D1DataDomain.MARKET).query(sql, params)


def active_stocks(start_date: str, end_date: str) -> list[dict]:
    from services.dataset_snapshot_exporter import _query_active_stocks
    frame = _query_active_stocks(start_date, end_date)
    return [{'symbol': str(row['symbol']), 'market': row.get('market'), 'listed_date': row.get('listed_date'),
             'delisted_date': row.get('delisted_date')} for row in frame.iter_rows(named=True)
            if row.get('market') in UNIVERSE_MARKETS]


def exclusion_gate(tape: dict, stocks: list[dict], *, start: str, end: str) -> list[dict]:
    from scripts.estimate_corporate_exclusion_share import estimate
    full = (date.fromisoformat(end) - date.fromisoformat(start)).days
    return estimate(tape, stocks, end=end, windows=sorted({*GATE_WINDOWS, full}))


def _export_ready() -> None:
    """The same refusals the operator export script applies before a write."""
    from scripts.export_corporate_history_snapshot import REQUIRED_ENV, allocator_guard_on, domain_routing
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name, '').strip()]
    if missing:
        raise CorporateHistoryWeeklyError('corporate_history_export_env_missing:' + ','.join(missing))
    unrouted = [d for d, state in domain_routing().items() if state != 'specific']
    if unrouted:
        raise CorporateHistoryWeeklyError('corporate_history_export_d1_domain_not_routed:' + ','.join(unrouted))
    if allocator_guard_on():
        raise CorporateHistoryWeeklyError('corporate_history_export_refused_allocator_contract_guard_on')


def archive_inputs(workdir: Path, run_id: str) -> str:
    """Upload every sealed input of this run; returns the archive prefix."""
    from services.dataset_snapshot_exporter import _gcs_client_bucket
    bucket, name = _gcs_client_bucket()
    prefix = f'{ARCHIVE_PREFIX}/{run_id}'
    for path in sorted(p for p in workdir.rglob('*') if p.is_file()):
        bucket.blob(f'{prefix}/{path.relative_to(workdir).as_posix()}').upload_from_filename(str(path))
    return f'gs://{name}/{prefix}/'


def _export(artifact: Path, checksum: str, *, start: str, end: str, run_id: str) -> dict:
    from services.dataset_snapshot_exporter import DatasetSnapshotExportRequest, export_backtest_dataset_snapshot
    return export_backtest_dataset_snapshot(DatasetSnapshotExportRequest(
        business_date=end, start_date=start, end_date=end, include_signals=True,
        corporate_history_path=str(artifact), corporate_history_checksum=checksum, producer_run_id=run_id))


def run_corporate_history_weekly(run_date: str, *, run_id: str, workdir: Path, baseline_uri: str | None = None,
                                 baseline_sha256: str | None = None,
                                 deps: dict[str, Callable] | None = None) -> dict[str, Any]:
    """Scope, fetch, compile, gate and export one weekly snapshot. Raises before any write on a stop."""
    from scripts.compile_corporate_history import compile_history, gap_report
    from scripts.fetch_corporate_history_sources import fetch
    from services.research_corporate_history import load_history_tape
    d = {'read': read_gcs_uri, 'market_query': _market_query, 'active_stocks': active_stocks, 'fetch': fetch,
         'export_ready': _export_ready, 'archive': archive_inputs, 'export': _export, **(deps or {})}
    if date.fromisoformat(run_date).isoformat() != run_date:
        raise CorporateHistoryWeeklyError('corporate_history_run_date_invalid')
    uri, digest = (baseline_uri, baseline_sha256) if baseline_uri else pinned_baseline()
    workdir.mkdir(parents=True, exist_ok=False)
    out = workdir / 'fetch'
    out.mkdir()
    baseline = load_baseline(uri, workdir, expected_sha256=digest, read=d['read'])
    start = baseline['history_start']
    calendar = session_days(baseline['days'], run_date, d['market_query'])
    stocks = d['active_stocks'](start, calendar[-1])
    if not stocks:
        raise CorporateHistoryWeeklyError('corporate_history_universe_empty')
    days_path, universe_path = workdir / 'days.json', workdir / 'universe.json'
    days_path.write_text(json.dumps(calendar), encoding='utf-8')
    universe_path.write_text(json.dumps(sorted({s['symbol'] for s in stocks})), encoding='utf-8')
    fetch_report = d['fetch'](out, days_path=days_path, universe_path=universe_path)

    spec = json.loads((out / 'spec.json').read_text(encoding='utf-8'))
    spec.update(cash_rounding_rules=baseline.get('cash_rounding_rules') or [],
                reviewed_stock_rules=baseline.get('reviewed_stock_rules') or [],
                reviewed_subscription_rules=baseline.get('reviewed_subscription_rules') or [],
                extra_sources=baseline['extra_sources'])
    (workdir / 'spec_weekly.json').write_text(json.dumps(spec, ensure_ascii=False), encoding='utf-8')
    frame, compiled_days, scoped, unscoped = compile_history(spec, base=out)
    gap = gap_report(frame, days=compiled_days, calendar=calendar, target_end=calendar[-1])
    if not gap['target_end_reached']:
        raise CorporateHistoryWeeklyError(
            f"corporate_history_target_end_not_reached:history_end={gap['history_end']}:target={calendar[-1]}")
    artifact = workdir / 'corporate_history.parquet'
    frame.write_parquet(artifact)
    checksum = _sha256(artifact.read_bytes())
    end = gap['history_end']
    gate = exclusion_gate(load_history_tape(frame), stocks, start=start, end=end)
    stopped = [g for g in gate if g['status'] != 'runs']
    if stopped:
        raise CorporateHistoryWeeklyError('corporate_history_exclusion_share_above_limit:' + ','.join(
            f"{g['window_days']}d={g['excluded_count']}/{g['holdable_symbols']}" for g in stopped))
    (workdir / 'gate.json').write_text(json.dumps(gate, ensure_ascii=False), encoding='utf-8')
    d['export_ready']()
    archive = d['archive'](workdir, run_id)
    summary = d['export'](artifact, checksum, start=start, end=end, run_id=run_id)
    snapshot = summary.get('snapshot') or {}
    if summary.get('status') != 'ready' or not snapshot.get('snapshot_id'):
        raise CorporateHistoryWeeklyError('corporate_history_export_not_ready:' + str(summary.get('status')))
    return {'status': 'exported', 'run_id': run_id, 'baseline_id': baseline.get('baseline_id'),
            'history_start': start, 'history_end': end, 'sessions': gap['sessions'],
            'artifact_sha256': checksum, 'archive_uri': archive, 'blocked_issuers': gap['blocked_issuers'],
            'scoped_symbols': len(scoped), 'unscoped_symbols': len(unscoped),
            'finlab_calls': fetch_report.get('finlab_calls'),
            'exclusion': [{k: g[k] for k in ('window_days', 'excluded_count', 'holdable_symbols', 'excluded_share')}
                          for g in gate],
            'snapshot_id': snapshot.get('snapshot_id'), 'kind': snapshot.get('kind'),
            'business_date': snapshot.get('business_date'), 'row_count': snapshot.get('row_count')}


def format_summary(result: dict[str, Any]) -> str:
    worst = max(result['exclusion'], key=lambda g: g['excluded_share'])
    return (f"run_id={result['run_id']} snapshot={result['snapshot_id']} history={result['history_start']}~"
            f"{result['history_end']} sessions={result['sessions']} blocked_issuers={result['blocked_issuers']} "
            f"max_exclusion={worst['window_days']}d:{worst['excluded_count']}/{worst['holdable_symbols']}")
