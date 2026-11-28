#!/usr/bin/env python3
"""OPB v3 cutover warm start (F-B) runner. Dry-run by default: reads prod, writes nothing.

Run once per cutover, after the R33 switch packet is sealed and before the first
post-cutover premarket plan. It replays the newest pre-cutover formal-plan days
under the NEW context with the new bundle's walk-forward OOF scores and a
past-only hinge (services/l4_opb_cutover_warm_start.py), as
`cutover_warm_start` rows. Selection reads them only when KV
`l4Distribution.opb.cutover_warm_start.enabled` is true.

--write inserts the rows into LEARNING_DB l4_opb_arm_replay_v2 (insert-or-verify).
That is a prod write: it needs Wei's go and runs under the single executor (M1-c).

Order (fixed): the rows are keyed by the OPB context, which hashes the allocator
sources (paired_nav_collection.allocator_runtime_source_identity) through the
allocator_source_equivalence.json certificate (both are guarded below). A source
change deployed after the warm start moves every later plan to a new context
and the warm rows are never read again (the nightly replay re-solves live days
under a new context, but it cannot rebuild warm days: they need the bundle's
fold-OOF scores). So, in the cutover release:
  1. merge and deploy every allocator-source change of the release (e.g. the
     dead-code deletions that touch recommendation_service.py), then re-pin;
  2. seal the R33 switch packet;
  3. dry-run this tool on the deployed commit; note `context_identity`;
  4. --write --deployed-sha <live sha> --expect-context <that context>
     [--ack-open-source-prs N,...], before the first post-cutover plan.
--write refuses while origin/main carries allocator-source changes the deployed
commit lacks, or while an open PR touches those sources and is not listed in
--ack-open-source-prs (listing one says it will not merge before the evidence
has rebuilt). A source deploy after step 4 needs steps 3-4 again (new go).

Usage:
  python tools/opb_cutover_warm_start.py --switch-packet packet.json --bundle bundle.json \
      --cutover-signal-date 2026-12-05 [--days 20] [--write --deployed-sha SHA --expect-context HEX]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ml-controller'))


class DryRunLearning:
    """Reads go to prod; l4_opb_arm_replay_v2 writes land in memory and are read back from there."""

    def __init__(self, inner):
        self.inner, self.rows = inner, {}

    def query(self, sql, params):
        real = self.inner.query(sql, params)
        if 'FROM l4_opb_arm_replay_v2' not in sql:
            return real
        context, day = params[:2]
        extra = [r for k, r in self.rows.items() if k[:2] == (context, day)]
        return real + extra

    def batch_execute(self, statements):
        from services.l4_opb_arm_replay import COLUMNS_V2
        for _, values in statements:
            record = dict(zip(COLUMNS_V2, values))
            key = (record['context_identity'], record['signal_date'], record['arm_digest'], record['session_offset'])
            self.rows.setdefault(key, record)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--switch-packet', required=True, help='sealed r33_switch packet (JSON)')
    parser.add_argument('--bundle', required=True, help='the new sealed monthly bundle (JSON)')
    parser.add_argument('--cutover-signal-date', required=True, help='last signal date before the first new plan')
    parser.add_argument('--days', type=int, default=None, help='default: KV cutover_warm_start.max_observations')
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--deployed-sha', help='required with --write: the live controller commit')
    parser.add_argument('--expect-context', help='required with --write: context_identity printed by the dry run')
    parser.add_argument('--ack-open-source-prs', default='',
                        help='comma-separated open PR numbers touching allocator sources that will not merge first')
    args = parser.parse_args(argv)
    if args.write:
        # The context hashes the allocator sources; rows written from any other
        # checkout land in a context the deployed controller never reads.
        import subprocess
        head = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=no'],
                               capture_output=True, text=True).stdout.strip()
        if not args.deployed_sha or head != args.deployed_sha or dirty:
            raise SystemExit('--write needs a clean checkout at --deployed-sha (the live controller commit)')
        if not args.expect_context:
            raise SystemExit('--write needs --expect-context (the context_identity of the dry run)')
        source_batch_guard(ack_prs=args.ack_open_source_prs)
    from google.cloud import storage
    from services.d1_domain_client import client_proxy_for_domain
    from services.l4_opb_arm_replay import first_formal_plan
    from services.l4_opb_cutover_warm_start import replay_warm_day
    from services.l4_opb_selection import context_identity, is_v3, market_proxy, validate_arms
    from services.r33_crossfit_serving import load_bundle_inputs
    from services.r33_calibration_job import pool_score_table
    from services.r33_rank_pool import load_serving_pool
    from services.active8_oof_cohort_materializer import load_verified_oof_manifest

    packet = json.loads(Path(args.switch_packet).read_text())
    bundle = json.loads(Path(args.bundle).read_text())
    live = json.loads(packet['writes']['kv-config']['after'])['l4Distribution']
    ensemble = packet['ensemble']
    if not is_v3(live):
        raise SystemExit('policy after the switch is not OPB v3')
    validate_arms(live)
    context = context_identity(live, live['artifact']['l3_identity'])
    if args.write and context != args.expect_context:
        raise SystemExit(f'context_identity {context} != --expect-context: sources or policy moved since the dry run')
    days_wanted = args.days if args.days is not None else live['opb']['cutover_warm_start']['max_observations']
    clients = {name: client_proxy_for_domain(name) for name in ('paper', 'learning', 'market', 'ops')}
    if not args.write:
        clients['learning'] = DryRunLearning(clients['learning'])
    bucket = storage.Client().bucket(os.environ.get('GCS_BUCKET_NAME', 'stockvision-models'))
    source, oof, pool_by_date = load_bundle_inputs(bundle, bucket=bucket, ops_query=clients['ops'].query)
    table = pool_score_table(oof, pool_by_date, variant=source['variant'])
    manifest, _ = load_verified_oof_manifest(bundle['manifest_path'], bucket=bucket, require_formal_lineage=True)
    windows = {f"w{w['window_id']}": {'train_end': str(w['train_range'][1]), 'test_start': str(w['test_range'][0]),
                                      'test_end': str(w['test_range'][1])} for w in manifest['windows']}
    oof_rows = oof.select('prediction_date', 'symbol', 'model_name', 'raw_score', 'fold_id').to_dicts()
    oof_days = sorted({r['prediction_date'] for r in oof_rows})
    plans = [str(r['signal_date']) for r in clients['paper'].query(
        'SELECT DISTINCT signal_date FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 '
        'AND signal_date<=? AND signal_date>=? ORDER BY signal_date DESC LIMIT ?',
        [args.cutover_signal_date, oof_days[0], 4 * days_wanted])]
    business_date = (date.fromisoformat(args.cutover_signal_date) + timedelta(days=1)).isoformat()
    report, booked = {}, 0
    for day in plans:
        if booked >= days_wanted:
            break
        if day not in set(oof_days):
            report[day] = {'status': 'skipped', 'reason': 'outside_new_bundle_oof'}
            continue
        try:
            entry = clients['market'].query("SELECT date FROM canonical_market_daily WHERE stock_id=? "
                                            "AND source='finlab.price' AND date>? ORDER BY date LIMIT 1",
                                            [market_proxy(live), day])
            plan_row, _ = first_formal_plan(clients['paper'], day, str(entry[0]['date'])[:10])
            pool = load_serving_pool(clients['ops'].query, signal_date=day,
                                     screener_run_id=_frozen_screener_run(clients, plan_row))
            report[day] = replay_warm_day(live=live, day=day, cutover_business_date=business_date, oof_rows=oof_rows,
                                          windows=windows, table=table, pool=pool, ensemble=ensemble, clients=clients)
        except Exception as exc:  # report every day; never guess
            report[day] = {'status': 'failed', 'error': f'{type(exc).__name__}:{str(exc)[:200]}'}
        if report[day].get('status') == 'materialized':
            booked += 1
    print(json.dumps({'write': args.write, 'context_identity': context, 'days_booked': booked, 'days': report,
                      'dry_run_rows': len(getattr(clients['learning'], 'rows', {}))}, indent=1, default=str))


# Release certificates that allocator_source_identity() reads besides the hashed sources:
# changing one moves the OPB context exactly like a source change does.
ALLOCATOR_IDENTITY_CERTIFICATES = ('allocator_source_equivalence.json',)


def allocator_source_paths():
    from services.paired_nav_collection import allocator_runtime_source_identity
    names = set(allocator_runtime_source_identity()) | set(ALLOCATOR_IDENTITY_CERTIFICATES)
    return sorted('ml-controller/services/' + name for name in names)


def source_batch_guard(*, ack_prs, run=None):
    """Refuse a warm start that a pending allocator-source change would orphan (see module doc)."""
    import subprocess
    run = run or (lambda cmd: subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)
    paths = allocator_source_paths()
    run(['git', '-C', str(ROOT), 'fetch', '--quiet', 'origin', 'main'])
    pending = run(['git', '-C', str(ROOT), 'diff', '--name-only', 'HEAD', 'origin/main', '--', *paths]).split()
    if pending:
        raise SystemExit('allocator sources on origin/main differ from the deployed commit; deploy them, '
                         'then warm start: ' + ','.join(pending))
    prs = json.loads(run(['gh', 'pr', 'list', '--repo', 'AngusRepo/stock-analyzer', '--state', 'open',
                          '--limit', '500', '--json', 'number,files']))
    touching = sorted(pr['number'] for pr in prs if any(f['path'] in set(paths) for f in pr.get('files') or ()))
    acked = sorted(int(n) for n in str(ack_prs).split(',') if n.strip())
    if touching != acked:
        raise SystemExit(f'open PRs touching allocator sources {touching} != --ack-open-source-prs {acked}')
    return {'pending_on_main': [], 'open_source_prs': touching}


def _frozen_screener_run(clients, plan_row):
    """The L2 run the frozen plan's rank pool came from (L0-L2 are not re-run)."""
    from services.paired_nav_journal import read_snapshot
    if plan_row is None:
        raise ValueError('no_formal_plan')
    saved = read_snapshot(clients['learning'].query, plan_row['allocation_snapshot_id'])
    runtime = saved['payload']['content']['inputs']['alpha_policy']['l4Distribution']['runtime']
    return (runtime.get('r33_rank_pool') or {})['screener_run_id']


if __name__ == '__main__':
    main()
