#!/usr/bin/env python3
"""One-time backfill of `screener_momentum_snapshots.pool_definition` (Wei 10/29 Q3).

The momentum-zone percentile only compares snapshots of one candidate pool. Rows written
before market migration 0011 carry NULL and are excluded from history until this tool
labels them. It only labels the most recent run of rows whose pool size matches the current
pool; older rows (a different screener pool) stay NULL and never enter the percentile.

Dry-run is the default: it reads the table and prints the proposed `--since` date.
`--execute --since YYYY-MM-DD` writes (D1 market, needs Wei go) and reads the result back.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / 'ml-controller'), str(REPO / 'tools' / 'release'), str(REPO / 'tools')]

# Must equal MOMENTUM_POOL_DEFINITION in worker/src/lib/momentumZone.ts (pinned by a test).
POOL_DEFINITION = 'screener-v2.final-candidates.v1'
# A pool that changed by more than this factor in either direction is a different pool.
SIZE_FACTOR = 2.0
REFERENCE_ROWS = 20
SELECT = 'SELECT date, candidate_count, pool_definition FROM screener_momentum_snapshots ORDER BY date'
UPDATE = ('UPDATE screener_momentum_snapshots SET pool_definition = ? '
          'WHERE pool_definition IS NULL AND date >= ?')


def propose(rows):
    """Return the summary and the earliest date of the newest same-size run of rows."""
    sized = [r for r in rows if isinstance(r.get('candidate_count'), int) and r['candidate_count'] > 0]
    summary = {'rows': len(rows), 'null_rows': sum(r.get('pool_definition') is None for r in rows),
               'labelled_rows': sum(r.get('pool_definition') == POOL_DEFINITION for r in rows),
               'other_pool_rows': sum(r.get('pool_definition') not in (None, POOL_DEFINITION) for r in rows)}
    if not sized:
        return {**summary, 'proposed_since': None, 'reason': 'no rows with a candidate_count'}
    reference = statistics.median(r['candidate_count'] for r in sized[-REFERENCE_ROWS:])
    run = []
    for row in reversed(sized):
        if not reference / SIZE_FACTOR <= row['candidate_count'] <= reference * SIZE_FACTOR:
            break
        run.append(row)
    if not run:
        return {**summary, 'reference_candidate_count': reference, 'proposed_since': None,
                'reason': 'newest row is already outside the reference pool size; wait for more rows'}
    since = run[-1]['date']
    return {**summary, 'reference_candidate_count': reference, 'proposed_since': since,
            'run_rows': len(run), 'first_excluded': next((r['date'] for r in reversed(sized)
                                                          if r['date'] < since), None)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help='write (needs Wei go)')
    parser.add_argument('--since', help='first date to label; required with --execute')
    args = parser.parse_args(argv)
    if args.execute and not (args.since and re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.since)):
        raise SystemExit('--execute needs an explicit --since YYYY-MM-DD (take it from the dry run)')
    from services.d1_domain_client import client_for_domain
    market = client_for_domain('market')
    result = propose(market.query(SELECT))
    if args.execute:
        market.execute(UPDATE, [POOL_DEFINITION, args.since])
        after = market.query(SELECT)
        unlabelled = [r['date'] for r in after if r['date'] >= args.since and r.get('pool_definition') is None]
        if unlabelled:
            raise SystemExit(f'readback: {len(unlabelled)} rows since {args.since} are still NULL')
        result = {**result, 'executed_since': args.since, 'after': propose(after)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__ == '__main__':
    main()
