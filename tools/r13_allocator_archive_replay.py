#!/usr/bin/env python3
"""R13: replay archived formal allocator days and measure the solver. Read-only.

For each signal date with an activated Paper plan, this reruns the allocator on the frozen
allocation snapshot behind the first pre-09:00 formal plan (the same context the OPB arm
replay uses) and records, per date and per solver time budget:

- candidate count (the ~81-name pool vs the 5 slots), positions after, wall time, rounds, gap;
- the outcome: plan, or the exact error (AUD-2 `l4_portfolio_optimality_not_certified`,
  AUD-1 infeasible / invalid limits, ...);
- AUD-1 preconditions: locked weight above the exposure cap; exposure cap 0 with locked
  (out-of-pool) holdings, or with none (a full-liquidation plan);
- AUD-17: unlocked holdings below min_weight, and how many the plan sells to zero;
- whether the replayed weights equal the stored plan (same arm forced for v2 policies).

R33 rule: the allocator and its 30 s budget are not changed. `--time-limit` only measures what
another budget would prove; the default replays the production 30 s.

D1 reads only (paper, learning, market). Learning-db reads are refused during its write-avoid
windows (13:00-16:30Z, 17:00-23:00Z).
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

PRODUCTION_TIME_LIMIT = 30.
AVOID_WINDOWS_UTC = (('13:00', '16:30'), ('17:00', '23:00'))
SUPPORT = 1e-9


def in_avoid_window(now: datetime) -> bool:
    clock = now.astimezone(timezone.utc).strftime('%H:%M')
    return any(start <= clock < end for start, end in AVOID_WINDOWS_UTC)


def preconditions(kwargs: dict) -> dict:
    """AUD-1 / AUD-17 facts about one allocate() call, before solving."""
    symbols = list(kwargs['symbols'])
    current = [float(v) for v in kwargs['current_weights']]
    locked = set(kwargs.get('locked_symbols') or ())
    cap = float(kwargs['exposure_cap'])
    min_weight = float(kwargs['min_weight'])
    held = {s: w for s, w in zip(symbols, current) if w > SUPPORT}
    locked_weight = sum(w for s, w in held.items() if s in locked)
    below = sorted(s for s, w in held.items() if s not in locked and w < min_weight)
    return {
        'candidates': len(symbols), 'held': len(held), 'locked_held': sum(s in locked for s in held),
        'max_positions': kwargs.get('max_positions'), 'exposure_cap': cap, 'min_weight': min_weight,
        'locked_weight': locked_weight,
        'aud1_locked_over_cap': locked_weight > cap + 1e-8,
        'aud1_zero_cap_with_locked': cap <= 0 and locked_weight > SUPPORT,
        'aud1_zero_cap_full_liquidation': cap <= 0 and locked_weight <= SUPPORT and bool(held),
        'aud17_below_min_weight': below,
    }


def outcome(pre: dict, kwargs: dict, result: dict | None) -> dict:
    if result is None:
        return {}
    weights = result['weights']
    sold = [s for s in pre['aud17_below_min_weight'] if weights.get(s, 0.) <= SUPPORT]
    return {'positions_after': sum(w > SUPPORT for w in weights.values()),
            'exposure_after': sum(weights.values()),
            'rounds': result['proof']['rounds'], 'gap': result['proof']['absolute_objective_gap'],
            'aud17_sold_to_zero': sold}


def measured(run, allocate_module, runtime_module, time_limit):
    """Wrap the runtime's allocate() so one run() call is timed at the given budget."""
    calls = []
    real = allocate_module.allocate

    def timed(**kwargs):
        pre = preconditions(kwargs)
        started = time.perf_counter()
        try:
            result = real(**{**kwargs, 'time_limit': time_limit})
        except ValueError as error:
            calls.append({**pre, 'seconds': time.perf_counter() - started, 'status': 'error', 'error': str(error)})
            raise
        calls.append({**pre, **outcome(pre, kwargs, result), 'seconds': time.perf_counter() - started, 'status': 'plan'})
        return result

    def replay(*args, **kwargs):
        original = runtime_module.allocate
        runtime_module.allocate = timed
        try:
            return run(*args, **kwargs)
        finally:
            runtime_module.allocate = original
    return replay, calls


def replay_date(signal_date, *, paper, learning, market, time_limits, run, read_snapshot, first_formal_plan,
                allocate_module, runtime_module, is_v2):
    rows = market.query("SELECT MIN(date) AS entry FROM canonical_market_daily WHERE stock_id='0050' "
                        "AND source='finlab.price' AND date>?", [signal_date])
    entry = str((rows[0] if rows else {}).get('entry') or '')[:10]
    if not entry:
        return {'signal_date': signal_date, 'status': 'no_next_session'}
    row, stored = first_formal_plan(paper, signal_date, entry)
    if row is None:
        return {'signal_date': signal_date, 'status': 'no_formal_plan'}
    saved = read_snapshot(learning.query, row['allocation_snapshot_id'])
    inputs = saved['payload']['content']['inputs']
    frozen = inputs['alpha_policy']['l4Distribution']
    chosen = (stored.get('opb') or {}).get('arm_id')
    forced = chosen if is_v2(frozen) else None
    report = {'signal_date': signal_date, 'entry_date': entry, 'plan_id': row['plan_id'],
              'snapshot_id': row['allocation_snapshot_id'], 'policy_v2': is_v2(frozen), 'arm_id': chosen, 'budgets': []}
    for limit in time_limits:
        replay, calls = measured(run, allocate_module, runtime_module, limit)
        entry_report = {'time_limit': limit}
        try:
            output = replay(deepcopy(inputs['recommendations']), deepcopy(frozen),
                            return_history=deepcopy(inputs['return_history']), forced_arm=forced)
            plan = output[0]['_l4_portfolio_plan'] if output else None
            entry_report['matches_stored'] = plan is not None and plan.get('weights') == stored.get('weights')
        except Exception as error:  # the replay records any refusal; it never repairs it
            entry_report['error'] = f'{type(error).__name__}: {error}'
        entry_report['solves'] = calls
        report['budgets'].append(entry_report)
    report['status'] = 'replayed'
    return report


def summarize(reports):
    days = [r for r in reports if r.get('status') == 'replayed']
    summary = {'dates': len(reports), 'replayed': len(days)}
    for index, limit in enumerate(sorted({b['time_limit'] for r in days for b in r['budgets']})):
        solves = [s for r in days for b in r['budgets'] if b['time_limit'] == limit for s in b['solves']]
        errors = {}
        for solve in solves:
            if solve['status'] == 'error':
                errors[solve['error']] = errors.get(solve['error'], 0) + 1
        seconds = sorted(s['seconds'] for s in solves)
        summary[f'budget_{limit:g}s'] = {
            'solves': len(solves), 'plans': sum(s['status'] == 'plan' for s in solves), 'errors': errors,
            'seconds_median': seconds[len(seconds) // 2] if seconds else None,
            'seconds_max': seconds[-1] if seconds else None,
            'candidates_max': max((s['candidates'] for s in solves), default=None),
            'aud1_locked_over_cap_days': sum(s['aud1_locked_over_cap'] for s in solves),
            'aud1_zero_cap_with_locked_days': sum(s['aud1_zero_cap_with_locked'] for s in solves),
            'aud1_zero_cap_full_liquidation_days': sum(s['aud1_zero_cap_full_liquidation'] for s in solves),
            'aud17_days_with_names_below_min': sum(bool(s['aud17_below_min_weight']) for s in solves),
            'aud17_names_sold_to_zero': sum(len(s.get('aud17_sold_to_zero', [])) for s in solves),
            'matches_stored': sum(bool(b.get('matches_stored')) for r in days for b in r['budgets']
                                  if b['time_limit'] == limit),
        }
    return summary


def main(argv=None, *, now=None, clients=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--since', required=True, help='first signal date (YYYY-MM-DD)')
    parser.add_argument('--until', required=True, help='last signal date (YYYY-MM-DD)')
    parser.add_argument('--time-limit', type=float, action='append',
                        help=f'solver budget in seconds; repeatable (default {PRODUCTION_TIME_LIMIT:g})')
    parser.add_argument('--output', type=Path, help='write the full JSON report here')
    args = parser.parse_args(argv)
    if in_avoid_window(now or datetime.now(timezone.utc)):
        raise SystemExit('learning-db write-avoid window (13:00-16:30Z, 17:00-23:00Z); run later')
    from services import l4_distribution_runtime, l4_portfolio
    from services.l4_opb_arm_replay import first_formal_plan
    from services.l4_opb_selection import is_v2
    from services.paired_nav_journal import read_snapshot
    if clients is None:
        from services.d1_domain_client import client_for_domain
        clients = {name: client_for_domain(name) for name in ('paper', 'learning', 'market')}
    dates = [str(r['signal_date'])[:10] for r in clients['paper'].query(
        'SELECT DISTINCT signal_date FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 '
        'AND signal_date BETWEEN ? AND ? ORDER BY signal_date', [args.since, args.until])]
    reports = [replay_date(day, paper=clients['paper'], learning=clients['learning'], market=clients['market'],
                           time_limits=args.time_limit or [PRODUCTION_TIME_LIMIT], run=l4_distribution_runtime.run,
                           read_snapshot=read_snapshot, first_formal_plan=first_formal_plan,
                           allocate_module=l4_portfolio, runtime_module=l4_distribution_runtime, is_v2=is_v2)
               for day in dates]
    result = {'schema_version': 'r13-allocator-archive-replay-v1', 'since': args.since, 'until': args.until,
              'summary': summarize(reports), 'dates': reports}
    if args.output:
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')
    print(json.dumps(result['summary'], ensure_ascii=False, indent=2))
    return result


if __name__ == '__main__':
    main()
