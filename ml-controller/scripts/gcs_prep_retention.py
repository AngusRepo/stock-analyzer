"""Daily OOF prep retention in GCS. Dry-run by default; --execute needs a separate Wei go.

Every trading day writes a full prep run (about 0.93 GB) under universal/oof_forward_prep_v2/<run>/.
Readers use the same day's run, or a run something else names. A run is kept when any of these hold:
  - its name date or its newest object's creation date is within --keep-days (default 90), so a
    backfill written today under an old business date stays,
  - a repo pin file names it (active8_feature_sources.json and the other services/*.json pins),
  - a canonical_adjusted*/**/prep/manifest.json names it as its source (TimeXer training and forward
    extension read the source shards through that field),
  - a learning-db path column or a cohort manifest names it,
  - any of its objects carries a hold, or its name does not start with YYYY-MM-DD-.
Only prep/batch_<n>.npz shards of the other runs are deleted; the receipt, feature names and cleaning
reports stay as lineage. The receipt still says ready, so rerunning prep into the same prefix fails its
checksum check; a rebuild needs a new prefix. If any reference source cannot be read, nothing is
deleted. Exit status is 1 when any planned delete failed.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import sys
from typing import Any, Callable, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CONFIRM_PHRASE = 'delete-unreferenced-oof-prep-batches'
PREFIX = 'universal/oof_forward_prep_v2/'
CANONICAL_PREFIX = 'universal/canonical_adjusted'
DEFAULT_KEEP_DAYS = 90
RUN_RE = re.compile(r'universal/oof_forward_prep_v2/([A-Za-z0-9._-]+)')
DATE_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})(?:-|$)')
BATCH_RE = re.compile(r'^prep/batch_\d+\.npz$')
PIN_DIR = Path(__file__).resolve().parents[1] / 'services'
# learning-db columns that hold GCS paths or path-bearing JSON
D1_PATH_COLUMNS = {
    'active8_oof_cohorts': ('artifact_manifest_path',),
    'active8_oof_fold_artifacts': ('artifact_path',),
    'active8_oof_materialized_artifacts': ('artifact_path',),
    'active8_oof_materialized_artifact_history': ('artifact_path',),
    'active8_oof_date_eligibility': ('evidence_artifact_path',),
    'dataset_snapshots': ('gcs_uri', 'metadata_json'),
    'model_artifact_registry': ('artifact_path', 'metadata_path', 'training_manifest_path',
                                'offline_evidence_json', 'live_evidence_json'),
    'expected_return_artifact_payloads': ('source_artifact_path', 'artifact_json'),
    'active8_ensemble_artifacts_v1': ('archive_uri', 'payload_json', 'validation_json'),
    'active8_ensemble_validation_attempts_v1': ('receipt_json',),
    'active8_oof_retention_ledger': ('archive_path',),
    'active8_oof_forward_extension_coverage': ('extension_manifest_path',),
}

Query = Callable[[str, list[Any]], list[dict]]


def runs_named(texts: Iterable[str]) -> set[str]:
    return {m for t in texts if t for m in RUN_RE.findall(t)}


def run_date(run: str) -> date | None:
    match = DATE_RE.match(run)
    try:
        return date.fromisoformat(match.group(1)) if match else None
    except ValueError:
        return None


def created_date(blob) -> date | None:
    created = getattr(blob, 'time_created', None)
    return (created.astimezone(timezone.utc) + timedelta(hours=8)).date() if created else None


def pin_refs(pin_dir: Path = PIN_DIR) -> set[str]:
    return runs_named(p.read_text(encoding='utf-8') for p in sorted(pin_dir.glob('*.json')))


def d1_refs(query: Query) -> tuple[set[str], list[str]]:
    """Runs named in learning-db path columns, plus the cohort manifest paths to read."""
    texts, manifests = [], []
    for table, columns in D1_PATH_COLUMNS.items():
        for column in columns:
            rows = query(f"SELECT {column} v FROM {table} WHERE instr({column}, ?) > 0", ['oof_forward_prep_v2/'])
            texts += [str(r['v']) for r in rows]
    for row in query("SELECT artifact_manifest_path v FROM active8_oof_cohorts WHERE artifact_manifest_path IS NOT NULL", []):
        manifests.append(str(row['v']))
    return runs_named(texts), manifests


def manifest_refs(bucket, paths: Iterable[str]) -> set[str]:
    """Runs named in the given manifests; a missing or unreadable manifest raises."""
    return runs_named(bucket.blob(p.removeprefix(f'gs://{bucket.name}/')).download_as_text() for p in paths)


def canonical_manifests(bucket) -> list[str]:
    return [b.name for b in bucket.list_blobs(prefix=CANONICAL_PREFIX, match_glob='**/prep/manifest.json')]


def plan(blobs: Iterable[Any], referenced: dict[str, set[str]], today: date, keep_days: int) -> dict:
    """Group prep objects by run; return kept runs by reason and the batch shards to delete."""
    if keep_days < 30:
        raise ValueError('prep_keep_days_too_small')
    cutoff = today - timedelta(days=keep_days)
    runs: dict[str, list] = {}
    for blob in blobs:
        run, _, rest = blob.name.removeprefix(PREFIX).partition('/')
        if rest:
            runs.setdefault(run, []).append((rest, blob))
    kept: dict[str, list[str]] = {}
    candidates: dict[str, list] = {}
    for run, items in sorted(runs.items()):
        day = run_date(run)
        reasons = [name for name, refs in referenced.items() if run in refs]
        if day is None:
            reasons.append('undated')
        elif day >= cutoff or max((created_date(b) or day for _, b in items), default=day) >= cutoff:
            reasons.append('recent')
        if any(b.temporary_hold or b.event_based_hold for _, b in items):
            reasons.append('hold')
        if reasons:
            kept[run] = reasons
            continue
        batches = [b for rest, b in items if BATCH_RE.match(rest)]
        if batches:
            candidates[run] = batches
    by_reason: dict[str, int] = {}
    for reasons in kept.values():
        for r in reasons:
            by_reason[r] = by_reason.get(r, 0) + 1
    return {
        'cutoff_date': cutoff.isoformat(),
        'runs_total': len(runs),
        'runs_kept': len(kept),
        'kept_by_reason': dict(sorted(by_reason.items())),
        'referenced_runs_missing': {k: sorted(v - set(runs)) for k, v in referenced.items() if v - set(runs)},
        'candidate_runs': {run: {'objects': len(bs), 'bytes': sum(int(b.size or 0) for b in bs)}
                           for run, bs in candidates.items()},
        'candidate_objects': sum(len(bs) for bs in candidates.values()),
        'candidate_gb': round(sum(int(b.size or 0) for bs in candidates.values() for b in bs) / 1e9, 2),
        '_blobs': [b for bs in candidates.values() for b in bs],
    }


def execute(blobs: Iterable[Any]) -> dict:
    """Delete each shard only if it is still the generation that was planned."""
    deleted, failed = 0, []
    for blob in blobs:
        try:
            blob.delete(if_generation_match=blob.generation)
            deleted += 1
        except Exception as exc:  # keep going; a changed or held object is reported, not retried
            failed.append({'name': blob.name, 'error': type(exc).__name__})
    return {'deleted_objects': deleted, 'failed': failed}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--keep-days', type=int, default=DEFAULT_KEEP_DAYS)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--confirm', default='')
    args = parser.parse_args(argv)
    if args.execute and args.confirm != CONFIRM_PHRASE:
        parser.error(f'--execute requires --confirm {CONFIRM_PHRASE}')
    from services.d1_domain_client import D1DataDomain, DomainD1Client
    from services.walk_forward_retrain import _get_bucket
    bucket = _get_bucket()
    if bucket is None:
        raise SystemExit('gcs_bucket_unavailable')
    # require_specific: never fall back to the legacy DB, which could answer with stale tables
    learning = DomainD1Client(D1DataDomain.LEARNING, require_specific=True)
    d1_runs, cohort_manifests = d1_refs(learning.query)
    canonical = canonical_manifests(bucket)
    referenced = {
        'pin': pin_refs(),
        'canonical_manifest': manifest_refs(bucket, canonical),
        'd1': d1_runs,
        'cohort_manifest': manifest_refs(bucket, cohort_manifests),
    }
    today = (datetime.now(timezone.utc) + timedelta(hours=8)).date()
    report = plan(bucket.list_blobs(prefix=PREFIX), referenced, today, args.keep_days)
    blobs = report.pop('_blobs')
    report['manifests_read'] = {'canonical': len(canonical), 'cohort': len(cohort_manifests)}
    if args.execute:
        report['executed'] = execute(blobs)
    print(json.dumps(report, sort_keys=True))
    return 1 if report.get('executed', {}).get('failed') else 0


if __name__ == '__main__':
    raise SystemExit(main())
