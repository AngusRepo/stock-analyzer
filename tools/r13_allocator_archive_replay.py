#!/usr/bin/env python3
"""R13: replay archived formal allocator days and measure the solver. No writes.

For each signal date with an activated Paper plan, this reruns the allocator on the frozen
allocation snapshot behind the first pre-09:00 formal plan (the same context and guards as the
OPB arm replay) and records, per date and per solver time budget:

- candidate count (the ~81-name pool vs the 5 slots), positions after, wall time, rounds, gap;
- the outcome: a plan, the exact allocate() refusal, or a refusal raised elsewhere in run();
- AUD-1: locked weight above the exposure cap; exposure cap 0 with locked holdings (and how
  many are outside the pool), or with none (a full-liquidation plan);
- AUD-2: `l4_portfolio_optimality_not_certified` and whether the budget was exhausted;
- AUD-17: unlocked holdings below min_weight, and how many the plan sells to zero;
- whether the replayed weights equal the stored plan (the stored arm is forced when the
  frozen policy is v2 with OPB enabled; v1 days are not comparable without their ledger).

R33 rule: the allocator and its 30 s budget are not changed. `--time-limit` only measures what
another budget would prove; the default replays the production 30 s.

Reads D1 (paper, learning, market) through query-only clients; the snapshot reader may also
read the GCS cold store. `--output` writes a local JSON file only. The learning-db write-avoid
windows (13:00-16:30Z, 17:00-23:00Z) are checked before every date; a run that reaches one
stops with a partial report.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / 'ml-controller'), str(REPO / 'tools' / 'release'), str(REPO / 'tools')]

from services.l4_numeric_contract import WEIGHT_SUPPORT  # noqa: E402

PRODUCTION_TIME_LIMIT = 30.
AVOID_WINDOWS_UTC = (('13:00', '16:30'), ('17:00', '23:00'))
NOT_CERTIFIED = 'l4_portfolio_optimality_not_certified'


def in_avoid_window(now: datetime) -> bool:
    clock = now.astimezone(timezone.utc).strftime('%H:%M')
    return any(start <= clock < end for start, end in AVOID_WINDOWS_UTC)


class QueryOnly:
    """Expose only query(); the replay can never write through a client."""

    def __init__(self, client):
        self._client = client

    def query(self, *args, **kwargs):
        return self._client.query(*args, **kwargs)


def preconditions(kwargs: dict, pool: set | None = None) -> dict:
    """AUD-1 / AUD-17 facts about one allocate() call, before solving."""
    symbols = list(kwargs['symbols'])
    current = [float(v) for v in kwargs['current_weights']]
    locked = set(kwargs.get('locked_symbols') or ())
    cap = float(kwargs['exposure_cap'])
    min_weight = float(kwargs['min_weight'])
    held = {s: w for s, w in zip(symbols, current) if w > WEIGHT_SUPPORT}
    locked_held = [s for s in held if s in locked]
    locked_weight = sum(held[s] for s in locked_held)
    below = sorted(s for s, w in held.items() if s not in locked and w < min_weight)
    return {
        'candidates': len(symbols), 'held': len(held), 'locked_held': len(locked_held),
        'locked_outside_pool': None if pool is None else sum(s not in pool for s in locked_held),
        'max_positions': kwargs.get('max_positions'), 'exposure_cap': cap, 'min_weight': min_weight,
        'locked_weight': locked_weight,
        'aud1_locked_over_cap': locked_weight > cap + 1e-8,
        'aud1_zero_cap_with_locked': cap <= 0 and locked_weight > WEIGHT_SUPPORT,
        'aud1_zero_cap_full_liquidation': cap <= 0 and locked_weight <= WEIGHT_SUPPORT and bool(held),
        'aud17_below_min_weight': below,
    }


def outcome(pre: dict, result: dict) -> dict:
    weights = result['weights']
    sold = [s for s in pre['aud17_below_min_weight'] if weights.get(s, 0.) <= WEIGHT_SUPPORT]
    return {'positions_after': sum(w > WEIGHT_SUPPORT for w in weights.values()),
            'exposure_after': sum(weights.values()),
            'rounds': result['proof']['rounds'], 'gap': result['proof']['absolute_objective_gap'],
            'aud17_sold_to_zero': sold}


def measured(run, allocate_module, runtime_module, time_limit, pool=None):
    """Wrap the runtime's allocate() so one run() call is timed at the given budget."""
    calls = []
    real = allocate_module.allocate

    def timed(**kwargs):
        pre = preconditions(kwargs, pool)
        started = time.perf_counter()
        try:
            result = real(**{**kwargs, 'time_limit': time_limit})
        except Exception as error:
            seconds = time.perf_counter() - started
            calls.append({**pre, 'seconds': seconds, 'status': 'error', 'error': f'{type(error).__name__}: {error}',
                          'aud2_budget_exhausted': NOT_CERTIFIED in str(error) and seconds >= time_limit})
            raise
        calls.append({**pre, **outcome(pre, result), 'seconds': time.perf_counter() - started, 'status': 'plan'})
        return result

    def replay(*args, **kwargs):
        original = runtime_module.allocate
        runtime_module.allocate = timed
        try:
            return run(*args, **kwargs)
        finally:
            runtime_module.allocate = original
    return replay, calls


def _not_applicable(report, reason):
    return {**report, 'status': 'not_applicable', 'reason': reason}


def replay_date(signal_date, *, paper, learning, market, time_limits, run, read_snapshot, first_formal_plan,
                allocate_module, runtime_module, is_v2):
    from services.l4_opb_arm_replay import _entry_deadline, _utc
    rows = market.query("SELECT MIN(date) AS entry FROM canonical_market_daily WHERE stock_id='0050' "
                        "AND source='finlab.price' AND date>?", [signal_date])
    entry = str((rows[0] if rows else {}).get('entry') or '')[:10]
    if not entry:
        return {'signal_date': signal_date, 'status': 'no_next_session'}
    row, stored = first_formal_plan(paper, signal_date, entry)
    if row is None:
        return {'signal_date': signal_date, 'status': 'no_formal_plan'}
    report = {'signal_date': signal_date, 'entry_date': entry, 'plan_id': row['plan_id'],
              'snapshot_id': row['allocation_snapshot_id']}
    saved = read_snapshot(learning.query, row['allocation_snapshot_id'])
    if not _utc(saved['manifest']['frozen_at']) < _entry_deadline(entry):
        return _not_applicable(report, 'context_frozen_after_entry')
    inputs = saved['payload']['content']['inputs']
    frozen = inputs['alpha_policy']['l4Distribution']
    runtime = frozen.get('runtime') or {}
    if runtime.get('signal_date') != signal_date or runtime.get('l3_identity') != stored.get('l3_identity'):
        return _not_applicable(report, 'context_mismatch')
    v2 = bool(is_v2(frozen))
    chosen = (stored.get('opb') or {}).get('arm_id')
    # Production skips the arm gate when OPB is off; forcing an arm there would add a check.
    forced = chosen if v2 and (frozen.get('opb') or {}).get('enabled') else None
    comparable = v2  # a v1 day's arm depends on the reward ledger, which the snapshot lacks
    pool = {r.get('symbol') for r in inputs['recommendations'] if isinstance(r, dict)}
    report.update(policy_v2=v2, arm_id=chosen, forced_arm=forced,
                  consistency='comparable' if comparable else 'not_applicable:v1_context', budgets=[])
    for limit in time_limits:
        replay, calls = measured(run, allocate_module, runtime_module, limit, pool)
        budget = {'time_limit': limit, 'matches_stored': None}
        try:
            output = replay(deepcopy(inputs['recommendations']), deepcopy(frozen),
                            return_history=deepcopy(inputs['return_history']), forced_arm=forced)
            plan = output[0]['_l4_portfolio_plan'] if output else None
            if comparable:
                budget['matches_stored'] = plan is not None and plan.get('weights') == stored.get('weights')
        except Exception as error:  # the replay records any refusal; it never repairs it
            budget['run_error'] = f'{type(error).__name__}: {error}'
        budget['solves'] = calls
        report['budgets'].append(budget)
    report['status'] = 'replayed'
    return report


def summarize(reports):
    days = [r for r in reports if r.get('status') == 'replayed']
    summary = {'dates': len(reports), 'replayed': len(days),
               'not_replayed': {}}
    for r in reports:
        if r.get('status') != 'replayed':
            key = r.get('reason') or r.get('status')
            summary['not_replayed'][key] = summary['not_replayed'].get(key, 0) + 1
    for limit in sorted({b['time_limit'] for r in days for b in r['budgets']}):
        budgets = [b for r in days for b in r['budgets'] if b['time_limit'] == limit]
        solves = [s for b in budgets for s in b['solves']]
        allocate_errors, run_errors = {}, {}
        for solve in solves:
            if solve['status'] == 'error':
                allocate_errors[solve['error']] = allocate_errors.get(solve['error'], 0) + 1
        for budget in budgets:
            if 'run_error' in budget:
                run_errors[budget['run_error']] = run_errors.get(budget['run_error'], 0) + 1
        seconds = sorted(s['seconds'] for s in solves)
        summary[f'budget_{limit:g}s'] = {
            'days': len(budgets), 'days_with_plan': sum('run_error' not in b for b in budgets),
            'days_refused': sum('run_error' in b for b in budgets), 'run_errors': run_errors,
            'solves': len(solves), 'solve_plans': sum(s['status'] == 'plan' for s in solves),
            'allocate_errors': allocate_errors,
            'aud2_budget_exhausted': sum(bool(s.get('aud2_budget_exhausted')) for s in solves),
            'seconds_median': seconds[len(seconds) // 2] if seconds else None,
            'seconds_max': seconds[-1] if seconds else None,
            'candidates_max': max((s['candidates'] for s in solves), default=None),
            'aud1_locked_over_cap_days': sum(s['aud1_locked_over_cap'] for s in solves),
            'aud1_zero_cap_with_locked_days': sum(s['aud1_zero_cap_with_locked'] for s in solves),
            'aud1_zero_cap_full_liquidation_days': sum(s['aud1_zero_cap_full_liquidation'] for s in solves),
            'aud17_days_with_names_below_min': sum(bool(s['aud17_below_min_weight']) for s in solves),
            'aud17_names_sold_to_zero': sum(len(s.get('aud17_sold_to_zero', [])) for s in solves),
            'matches_stored': sum(b['matches_stored'] is True for b in budgets),
            'differs_from_stored': sum(b['matches_stored'] is False for b in budgets),
            'not_comparable': sum(b['matches_stored'] is None for b in budgets),
        }
    return summary


def main(argv=None, *, clock=None, clients=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--since', required=True, help='first signal date (YYYY-MM-DD)')
    parser.add_argument('--until', required=True, help='last signal date (YYYY-MM-DD)')
    parser.add_argument('--time-limit', type=float, action='append',
                        help=f'solver budget in seconds; repeatable (default {PRODUCTION_TIME_LIMIT:g})')
    parser.add_argument('--output', type=Path, help='write the full JSON report to this local file')
    args = parser.parse_args(argv)
    clock = clock or (lambda: datetime.now(timezone.utc))
    if in_avoid_window(clock()):
        raise SystemExit('learning-db write-avoid window (13:00-16:30Z, 17:00-23:00Z); run later')
    from services import l4_distribution_runtime, l4_portfolio
    from services.l4_opb_arm_replay import first_formal_plan
    from services.l4_opb_selection import is_v2
    from services.paired_nav_journal import read_snapshot
    if clients is None:
        from services.d1_domain_client import client_for_domain
        clients = {name: client_for_domain(name) for name in ('paper', 'learning', 'market')}
    paper, learning, market = (QueryOnly(clients[name]) for name in ('paper', 'learning', 'market'))
    dates = [str(r['signal_date'])[:10] for r in paper.query(
        'SELECT DISTINCT signal_date FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 '
        'AND signal_date BETWEEN ? AND ? ORDER BY signal_date', [args.since, args.until])]
    reports, aborted = [], None
    for day in dates:
        if in_avoid_window(clock()):
            aborted = {'reason': 'aborted_avoid_window', 'next_date': day}
            break
        reports.append(replay_date(day, paper=paper, learning=learning, market=market,
                                   time_limits=args.time_limit or [PRODUCTION_TIME_LIMIT],
                                   run=l4_distribution_runtime.run, read_snapshot=read_snapshot,
                                   first_formal_plan=first_formal_plan, allocate_module=l4_portfolio,
                                   runtime_module=l4_distribution_runtime, is_v2=is_v2))
    result = {'schema_version': 'r13-allocator-archive-replay-v1', 'since': args.since, 'until': args.until,
              'aborted': aborted, 'summary': summarize(reports), 'dates': reports}
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')
    print(json.dumps({'aborted': aborted, 'summary': result['summary']}, ensure_ascii=False, indent=2))
    return result


if __name__ == '__main__':
    main()
