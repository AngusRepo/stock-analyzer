"""Full-information OPB arm replay ledger (learning DB); never on the formal path.

For each matured signal date, replay every arm of the live v2 policy on the
frozen allocation context behind that day's first pre-09:00 formal plan and
record each arm's five-session net return paired with base. Selection reads
these rows; the account receipt ledger stays audit-only.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import logging

from services.l4_distribution import digest
from services.l4_opb_selection import (HORIZON_SESSIONS, LEDGER_SCHEMA, arm_definition, context_identity,
    is_v2, validate_constraints)

logger = logging.getLogger(__name__)

# Engineering budget per nightly run (snapshot reads + solves), not a trading decision.
BACKFILL_DATES_PER_RUN = 10
COLUMNS = ('context_identity', 'signal_date', 'arm_digest', 'arm_id', 'schema_version', 'known_date',
           'arm_return', 'base_return', 'delta', 'effective_digest', 'arm_inert', 'status', 'snapshot_id',
           'plan_id', 'replay_plan_id', 'consistency', 'payload_checksum', 'materialized_at')


def _utc(value):
    parsed = datetime.fromisoformat(str(value).replace(' ', 'T').replace('Z', '+00:00'))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _entry_deadline(entry_date):
    # 09:00 Asia/Taipei (UTC+8, no DST) on the entry session.
    return datetime.fromisoformat(entry_date + 'T01:00:00+00:00')


def first_formal_plan(paper, signal_date, entry_date):
    """The day's first activated Paper plan published before entry 09:00."""
    rows = paper.query('SELECT plan_id,allocation_snapshot_id,created_at,payload_json FROM l4_portfolio_plans_v1 '
                       'WHERE account_id=1 AND signal_date=? AND activated=1 ORDER BY created_at,plan_id',
                       [signal_date])
    for row in rows:
        plan = json.loads(row['payload_json'])
        if plan.get('execution_scope') == 'paper' and _utc(row['created_at']) < _entry_deadline(entry_date):
            return row, plan
    return None, None


def _arms(live):
    return [(arm['id'], digest(arm_definition(arm))) for arm in live['opb']['arms']]


def replay_day(*, live, signal_date, business_date, paper, learning, market, run=None, now=None):
    """Materialize one date. Returns a status receipt; rows only when every arm priced."""
    from services.forward_net_return import forward_sessions, load_prices, net_return
    from services.paired_nav_collection import allocator_source_identity
    from services.paired_nav_journal import read_snapshot
    if run is None:
        from services.l4_distribution_runtime import run
    sessions = forward_sessions(signal_date, query=market.query)
    if sessions is None or not sessions[-1] < business_date:
        return {'status': 'immature'}
    entry, known = sessions[0], sessions[-1]
    row, stored = first_formal_plan(paper, signal_date, entry)
    if row is None:
        return {'status': 'no_formal_plan'}
    l3 = stored['l3_identity']
    if live['artifact']['l3_identity'] != l3:
        return {'status': 'not_applicable', 'reason': 'l3_identity_changed'}
    context = context_identity(live, l3)
    arms = _arms(live)
    existing = {r['arm_digest'] for r in learning.query(
        'SELECT arm_digest FROM l4_opb_arm_replay_v1 WHERE context_identity=? AND signal_date=?', [context, signal_date])}
    if {d for _, d in arms} <= existing:
        return {'status': 'already_materialized'}
    saved = read_snapshot(learning.query, row['allocation_snapshot_id'])
    if not _utc(saved['manifest']['frozen_at']) < _entry_deadline(entry):
        return {'status': 'not_applicable', 'reason': 'context_frozen_after_entry'}
    content = saved['payload']['content']
    inputs = content['inputs']
    frozen = inputs['alpha_policy']['l4Distribution']
    runtime = frozen['runtime']
    if runtime['signal_date'] != signal_date or runtime['l3_identity'] != l3:
        raise ValueError('l4_opb_arm_replay_context_mismatch')
    history = inputs['return_history']
    if not isinstance(history, dict) or history.get('lookback') != live['constraints']['return_history_lookback_sessions']:
        return {'status': 'not_applicable', 'reason': 'risk_lookback_changed'}
    if not inputs['recommendations']:
        return {'status': 'not_applicable', 'reason': 'empty_pool'}
    policy = {**deepcopy(live), 'runtime': deepcopy(runtime)}
    plans = {}
    for arm_id, _ in arms:
        output = run(deepcopy(inputs['recommendations']), deepcopy(policy), return_history=history, forced_arm=arm_id)
        plans[arm_id] = output[0]['_l4_portfolio_plan']
    base = plans['base']
    current = {s: t['current_weight'] for s, t in base['targets'].items()}
    held = {s for plan in plans.values() for s, w in plan['weights'].items() if w > 0}
    prices = load_prices(held, entry_date=entry, exit_date=known, query=market.query)
    fees = runtime['account']['fees']
    values = {arm_id: net_return(plan['weights'], current, prices=prices,
                                 buy_cost=fees['buy_cost'], sell_cost=fees['sell_cost'])
              for arm_id, plan in plans.items()}
    if any(value is None for value in values.values()):
        return {'status': 'missing_price', 'symbols': sorted(held - set(prices))}
    # The live arm actually chosen that day must replay to the stored targets.
    same_policy = digest({k: v for k, v in frozen.items() if k != 'runtime'}) == digest(live)
    same_source = content.get('allocator_source_identity') == allocator_source_identity()
    chosen = (stored.get('opb') or {}).get('arm_id')
    if not (same_policy and same_source and is_v2(frozen)):
        consistency = 'not_applicable:' + ('policy_changed' if not same_policy else 'source_changed' if not same_source else 'v1_context')
    elif chosen not in plans:
        raise ValueError('l4_opb_arm_replay_chosen_arm_missing')
    elif plans[chosen]['weights'] != stored['weights']:
        raise ValueError('l4_opb_arm_replay_mismatch')
    else:
        consistency = 'verified'
    materialized_at = (now or datetime.now(timezone.utc)).isoformat()
    records = []
    for arm_id, arm_digest in arms:
        opb = plans[arm_id]['opb']
        body = {'context_identity': context, 'signal_date': signal_date, 'arm_digest': arm_digest, 'arm_id': arm_id,
            'schema_version': LEDGER_SCHEMA, 'known_date': known, 'arm_return': values[arm_id],
            'base_return': values['base'], 'delta': values[arm_id] - values['base'],
            'effective_digest': opb['effective_digest'], 'arm_inert': int(bool(opb['arm_inert'])),
            'status': 'arm_inert' if opb['arm_inert'] else 'complete', 'snapshot_id': row['allocation_snapshot_id'],
            'plan_id': row['plan_id'], 'replay_plan_id': plans[arm_id]['plan_id'], 'consistency': consistency}
        records.append({**body, 'payload_checksum': digest(body), 'materialized_at': materialized_at})
    _insert(learning, records)
    return {'status': 'materialized', 'arms': len(records), 'consistency': consistency, 'known_date': known}


def _insert(learning, records):
    """Insert-or-verify: a rerun must reproduce the stored rows byte-for-byte."""
    marks = ','.join('?' for _ in COLUMNS)
    learning.batch_execute([(f'INSERT INTO l4_opb_arm_replay_v1({",".join(COLUMNS)}) VALUES({marks}) '
                             'ON CONFLICT(context_identity,signal_date,arm_digest) DO NOTHING',
                             [record[c] for c in COLUMNS]) for record in records])
    for record in records:
        stored = learning.query('SELECT payload_checksum FROM l4_opb_arm_replay_v1 '
                                'WHERE context_identity=? AND signal_date=? AND arm_digest=?',
                                [record['context_identity'], record['signal_date'], record['arm_digest']])
        if [r['payload_checksum'] for r in stored] != [record['payload_checksum']]:
            raise ValueError('l4_opb_arm_replay_conflict')


def attach_daily_replay(config, business_date, *, clients=None):
    """Independent nightly task; it never changes OOF/account closure status."""
    try:
        live = config.get('l4Distribution')
        if not is_v2(live):
            return {'status': 'skipped', 'reason': 'policy_not_v2'}
        validate_constraints(live['constraints'])
        if clients is None:
            from services.d1_domain_client import client_proxy_for_domain
            clients = {name: client_proxy_for_domain(name) for name in ('paper', 'learning', 'market')}
        paper, learning, market = clients['paper'], clients['learning'], clients['market']
        limit = live['opb']['reward_window_observations'] + HORIZON_SESSIONS
        dates = [str(r['signal_date']) for r in paper.query(
            'SELECT DISTINCT signal_date FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 '
            'AND signal_date<? ORDER BY signal_date DESC LIMIT ?', [business_date, limit])]
        results, computed = {}, 0
        for day in dates:
            if computed >= BACKFILL_DATES_PER_RUN:
                results[day] = {'status': 'deferred_budget'}
                continue
            try:
                results[day] = replay_day(live=live, signal_date=day, business_date=business_date,
                                          paper=paper, learning=learning, market=market)
            except Exception as exc:
                logger.exception('[L4 OPB replay] %s failed', day)
                results[day] = {'status': 'failed', 'error_type': type(exc).__name__, 'reason': str(exc)[:200]}
            if results[day]['status'] not in ('immature', 'already_materialized', 'no_formal_plan'):
                computed += 1
        failed = sorted(day for day, r in results.items() if r['status'] == 'failed')
        return {'status': 'failed' if failed else 'ok', 'failed_dates': failed, 'dates': results}
    except Exception as exc:
        logger.exception('[L4 OPB replay] setup failed')
        return {'status': 'failed', 'error_type': type(exc).__name__, 'reason': str(exc)[:200]}
