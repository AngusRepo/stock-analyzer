"""Bounded post-release repair through existing owners; no base-model retrain."""
from __future__ import annotations

import argparse
import asyncio
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def repair(args):
    from services.walk_forward_retrain import _get_bucket
    from routers.walk_forward import _oof_lifecycle_calendar, dispatch_oof_full_fit_training

    bucket = _get_bucket()
    if bucket is None:
        raise RuntimeError('GCS unavailable')
    if args.action == 'prep':
        from services.active8_prep_lifecycle import ensure_active8_daily_prep
        result = await ensure_active8_daily_prep(end_date=args.cutoff, dry_run=False)
        dates, calendar = _oof_lifecycle_calendar(args.cutoff, bucket=bucket,
            prep_gcs_prefix=result['output_gcs_prefix'])
        return {'action': 'prep', 'result': result, 'calendar': calendar,
                'new_dates_after_2026_08_18': [d for d in dates if d > '2026-08-18'],
                'base_training_dispatched': False}

    if not args.cohort_id or not args.expected_run_id:
        raise ValueError('evaluation requires exact cohort and existing training run')
    prefix = f'walk_forward/oof_cohorts/{args.cohort_id}'
    manifest = json.loads(bucket.blob(f'{prefix}/manifest.json').download_as_text())
    receipt = json.loads(bucket.blob(f'{prefix}/full_fit/{args.cutoff}.json').download_as_text())
    if (receipt.get('run_id') != args.expected_run_id
            or receipt.get('cohort_id') != args.cohort_id
            or receipt.get('status') not in {'completed', 'blocked'}
            or receipt.get('retry_required') is not False
            or receipt.get('missing_models') or receipt.get('training_failed_models')
            or len(receipt.get('release_models') or []) != 8):
        raise ValueError('repair requires a terminal, complete eight-base-model receipt')
    result = await dispatch_oof_full_fit_training(manifest=manifest,
        knowledge_cutoff_date=args.cutoff, bucket=bucket,
        lifecycle_cadence='weekly', allow_new_dispatch=False)
    if result.get('run_id') != args.expected_run_id:
        raise RuntimeError('repair changed base training owner')
    return {'action': 'evaluation', 'result': result, 'base_training_dispatched': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--action', choices=['prep', 'evaluation'], required=True)
    parser.add_argument('--cutoff', required=True)
    parser.add_argument('--cohort-id')
    parser.add_argument('--expected-run-id')
    parser.add_argument('--apply', action='store_true', required=True)
    args = parser.parse_args()
    if date.fromisoformat(args.cutoff) > (datetime.now(timezone.utc) + timedelta(hours=8)).date():
        parser.error('future knowledge cutoff is forbidden')
    if args.cohort_id and ('/' in args.cohort_id or '..' in args.cohort_id):
        parser.error('cohort ID must be a single object-path component')
    print(json.dumps(asyncio.run(repair(args)), ensure_ascii=False, default=str), flush=True)


if __name__ == '__main__':
    main()
