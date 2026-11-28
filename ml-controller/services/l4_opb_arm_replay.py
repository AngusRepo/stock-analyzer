"""Full-information OPB arm replay ledger (learning DB); never on the formal path.

For each matured signal date, replay every arm of the live v2 policy on the
frozen allocation context behind that day's first pre-09:00 formal plan and
record each arm's five-session net return paired with base. Selection reads
these rows; the account receipt ledger stays audit-only.

OPB v3 (`l4-opb-selection-arms-v3`) writes `l4_opb_arm_replay_v2` instead: one
row per (signal day, arm, session of the hold) as soon as that session has
closed, with the arm's and base's piece of the five-session label, both
exposures, the exposure-normalized delta and the market-proxy piece (opb.market_proxy). The first night
solves every arm once; later sessions reuse the stored targets.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import json
import logging
import math

from services.l4_distribution import digest
from services.l4_opb_selection import (HORIZON_SESSIONS, LEDGER_SCHEMA, LEDGER_SCHEMA_V2, canonical_policy, market_proxy,
    REWARD_EXPOSURE_NORMALIZED, ROW_COUNTERFACTUAL_INERT, ROW_CUTOVER_WARM_START, ROW_LIVE, arm_definition,
    context_identity, decision_inputs_digest, is_v2, is_v3, policy_arm_definition, validate_constraints)

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
    return [(arm['id'], digest(policy_arm_definition(live, arm))) for arm in live['opb']['arms']]


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
    same_policy = (digest(canonical_policy({k: v for k, v in frozen.items() if k != 'runtime'}))
                   == digest(canonical_policy(live)))
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


COLUMNS_V2 = ('context_identity', 'signal_date', 'arm_digest', 'session_offset', 'arm_id', 'schema_version',
              'reward_semantic', 'row_kind', 'status', 'known_date', 'arm_piece', 'base_piece', 'market_piece',
              'arm_exposure', 'base_exposure', 'delta', 'effective_digest', 'weights_json', 'current_json',
              'score_source', 'snapshot_id', 'plan_id', 'replay_plan_id', 'consistency', 'payload_checksum',
              'materialized_at')


def session_pieces(weights, current, *, sessions, prices, buy_cost, sell_cost):
    """Per-session pieces of the five-session net label; None when a held price is missing.

    Piece 1 = sum w*(close1/open1 - 1) - rebalance cost; piece k>1 =
    sum w*(close_k - close_{k-1})/open1. The five pieces sum to net_return().
    The entry session needs open and close; a later session without a row
    carries the previous close only when the name has a row on a later session
    (a suspension that resumed), otherwise the pieces are not yet bookable.
    """
    from services.l4_numeric_contract import WEIGHT_SUPPORT
    pieces = [0.] * len(sessions)
    for symbol, weight in weights.items():
        if weight <= WEIGHT_SUPPORT:
            continue
        path = [prices.get((symbol, day)) for day in sessions]
        first = path[0]
        if first is None or first[0] is None or first[1] is None:
            return None
        entry = previous = first[0]
        last_row = max(i for i, price in enumerate(path) if price is not None)
        for i, price in enumerate(path):
            if price is not None and price[1] is None:
                return None          # a row with a bad close is a data error, not a suspension
            if price is None and i > last_row:
                return None          # not loaded yet (or still suspended): retry, never book a 0
            # No row on a calendar session but a later row exists: the name did not trade
            # (suspended); its value carries at the last close, piece 0.
            close = previous if price is None else price[1]
            pieces[i] += weight * (close - previous) / entry
            previous = close
    symbols = set(weights) | set(current)
    cost = sum(buy_cost * max(weights.get(s, 0.) - current.get(s, 0.), 0.)
               + sell_cost * max(current.get(s, 0.) - weights.get(s, 0.), 0.) for s in symbols)
    if pieces:
        pieces[0] -= cost
    return pieces


def load_session_prices(symbols, sessions, *, query):
    """{(symbol, day): (adj_open, adj_close)} over the given sessions (finlab.price first)."""
    from services.forward_net_return import PRICE_SOURCES
    symbols = sorted(set(symbols))
    best = {}
    for offset in range(0, len(symbols), 60):
        chunk = symbols[offset:offset + 60]
        marks = ','.join('?' for _ in chunk)
        rows = query(f"SELECT stock_id,date,source,adj_open,adj_close FROM canonical_market_daily "
                     f"WHERE stock_id IN ({marks}) AND date>=? AND date<=? AND source IN ('finlab.price','finlab.rotc_price')",
                     [*chunk, sessions[0], sessions[-1]])
        for row in rows:
            key = (str(row['stock_id']), str(row['date'])[:10])
            if key[1] not in sessions:
                continue
            priority = PRICE_SOURCES.index(row['source'])
            values = tuple(float(row[f]) if row.get(f) is not None and math.isfinite(float(row[f])) and float(row[f]) > 0
                           else None for f in ('adj_open', 'adj_close'))
            current = best.get(key)
            if current is None or priority < current[0]:
                best[key] = (priority, values)
            elif priority == current[0] and current[1] != values:
                raise ValueError('forward_net_return_conflicting_price')
    return {key: value for key, (_, value) in best.items()}


def _counterfactual_runtime(runtime, counterfactual):
    """A risk-halted day replayed at the policy's reference envelope (KV); nothing else changes.

    A halt zeroes both caps, so both come from KV; locks, forbidden buys, fees and
    holdings stay as frozen."""
    out = deepcopy(runtime)
    limits = out['account']['risk_limits']
    limits.update(exposure_cap=float(counterfactual['reference_exposure_cap']),
                  name_cap=float(counterfactual['reference_name_cap']), buys_halted=False)
    return out


def _solve_arms(*, live, signal_date, entry, arms, paper, learning, run, now, context, terminal, row_kind,
               frozen_override, artifact):
    """Read the day's formal plan and frozen snapshot once and solve every arm.

    Returns {'receipt': ...} when the day yields no rows. A live day's terminal
    outcome (never bookable, or rejected for an integrity mismatch) is recorded once
    per context in l4_opb_arm_replay_verdicts_v1 and answered from there afterwards,
    so neither a nightly retry nor a watchdog tick re-reads the snapshot. A code or
    policy change moves the context and re-judges the day. Warm start
    (frozen_override) replays under other inputs, so it neither reads nor writes them.
    """
    from services.paired_nav_collection import allocator_source_identity
    from services.paired_nav_journal import read_snapshot
    from services.l4_numeric_contract import WEIGHT_SUPPORT
    if run is None:
        from services.l4_distribution_runtime import run
    if terminal:
        cached = _cached_verdict(learning, context, signal_date)
        if cached is not None:
            return {'receipt': cached}

    def verdict(status, reason, row=None, detail=None):
        if not terminal:
            return {'receipt': {'status': status, 'reason': reason}}
        return {'receipt': _record_verdict(learning, context=context, signal_date=signal_date, status=status,
                                           reason=reason, row=row, detail=detail, now=now)}

    def reject(reason, row, detail):
        # Plan, snapshot and (within one context) code are fixed, so every retry
        # gives the same answer: book a terminal, reported rejection, never a retry loop.
        if not terminal:
            raise ValueError('l4_opb_arm_replay_' + reason)
        logger.error('[L4 OPB replay] %s rejected: %s %s', signal_date, reason, detail)
        return verdict('rejected', reason, row, detail)

    row, stored = first_formal_plan(paper, signal_date, entry)
    if row is None:
        # The entry session has closed (sessions is non-empty), so no plan can still
        # be created before its 09:00 deadline.
        return verdict('no_formal_plan', 'no_formal_plan')
    l3 = stored['l3_identity']
    if frozen_override is None and live['artifact']['l3_identity'] != l3:
        return verdict('not_applicable', 'l3_identity_changed', row)
    saved = read_snapshot(learning.query, row['allocation_snapshot_id'])
    if not _utc(saved['manifest']['frozen_at']) < _entry_deadline(entry):
        return verdict('not_applicable', 'context_frozen_after_entry', row)
    content = saved['payload']['content']
    inputs = content['inputs']
    frozen = inputs['alpha_policy']['l4Distribution']
    runtime = frozen['runtime']
    if runtime['signal_date'] != signal_date or runtime['l3_identity'] != l3:
        return reject('context_mismatch', row, {'snapshot_signal_date': runtime['signal_date'],
                                                'l3_identity_matches': runtime['l3_identity'] == l3})
    history = inputs['return_history']
    if not isinstance(history, dict) or history.get('lookback') != live['constraints']['return_history_lookback_sessions']:
        return verdict('not_applicable', 'risk_lookback_changed', row)
    if not inputs['recommendations']:
        return verdict('not_applicable', 'empty_pool', row)
    recommendations = inputs['recommendations']
    # Integrity of the frozen day, independent of code or policy deployed since the plan:
    # the snapshot must hold exactly the inputs the plan decided on.
    recorded = (stored.get('opb') or {}).get('decision_inputs_digest')
    inputs_verified = recorded is not None
    if inputs_verified:
        recomputed = decision_inputs_digest(recommendations, frozen, history, inputs.get('opb_reward_ledger'))
        if recorded != recomputed:
            return reject('input_digest_mismatch', row, {'recorded': recorded, 'recomputed': recomputed})
    if frozen_override is not None:
        runtime, recommendations = frozen_override(deepcopy(runtime), deepcopy(recommendations))
    limits = runtime['account']['risk_limits']
    halted = limits['exposure_cap'] == 0 or bool(limits.get('buys_halted'))
    counterfactual = live['opb']['inert_counterfactual']
    kind = row_kind
    if halted and counterfactual['enabled'] and row_kind == ROW_LIVE:
        runtime, kind = _counterfactual_runtime(runtime, counterfactual), ROW_COUNTERFACTUAL_INERT
    policy = {**deepcopy(live), 'runtime': deepcopy(runtime)}
    if artifact is not None:
        if frozen_override is None or artifact.get('model_checksum') != live['artifact'].get('model_checksum'):
            raise ValueError('l4_opb_arm_replay_artifact_override_invalid')
        policy['artifact'] = deepcopy(artifact)
    # Every arm is solved: the chosen arm's solve is what verifies tonight's verdict.
    solved = {}
    for arm_id, arm_digest in arms:
        output = run(deepcopy(recommendations), deepcopy(policy), return_history=history, forced_arm=arm_id)
        plan = output[0]['_l4_portfolio_plan']
        solved[arm_digest] = {'weights': {s: w for s, w in plan['weights'].items() if w > WEIGHT_SUPPORT},
            'current': {s: t['current_weight'] for s, t in plan['targets'].items() if t['current_weight'] > WEIGHT_SUPPORT},
            'replay_plan_id': plan['plan_id'], 'effective_digest': plan['opb']['effective_digest'],
            'inert': bool(plan['opb']['arm_inert'])}
    # Outputs are comparable only when nothing that shapes them changed since the plan;
    # the input digest above is checked regardless, so `verified_inputs` runs in prod
    # across deploys (v1 only ever reached not_applicable: replay is >=1 session late).
    same_policy = (digest(canonical_policy({k: v for k, v in frozen.items() if k != 'runtime'}))
                   == digest(canonical_policy(live)))
    same_source = content.get('allocator_source_identity') == allocator_source_identity()
    chosen = (stored.get('opb') or {}).get('arm_id')
    by_id = dict(arms)
    if not inputs_verified:
        consistency = 'not_applicable:no_input_digest'
    elif frozen_override is not None or kind != ROW_LIVE or not (same_policy and same_source and is_v3(frozen)):
        consistency = 'verified_inputs'
    elif chosen not in by_id:
        # The plan chose an arm this policy does not define: terminal for the context.
        return reject('chosen_arm_missing', row, {'arm_id': chosen})
    elif {s: w for s, w in stored['weights'].items() if w > WEIGHT_SUPPORT} != solved[by_id[chosen]]['weights']:
        return reject('weights_mismatch', row, {'arm_id': chosen})
    else:
        consistency = 'verified'
    return {'snapshot_id': row['allocation_snapshot_id'], 'plan_id': row['plan_id'],
            'fees': runtime['account']['fees'], 'row_kind': kind, 'consistency': consistency, 'targets': solved}


def replay_day_v3(*, live, signal_date, business_date, paper, learning, market, run=None, now=None,
                  row_kind=ROW_LIVE, frozen_override=None, score_source='serving', artifact=None, solve=True):
    """Materialize the closed sessions of one date into l4_opb_arm_replay_v2.

    The plan and its frozen snapshot are read only to solve arms that have no rows
    yet; a day whose arms are all booked prices its new sessions from the stored
    targets. `solve=False` (premarket) never reads them and returns `needs_solve`.
    frozen_override/artifact (cutover warm start only) rewrite the frozen day's
    L3 inputs and the bundle's declared label horizon; see l4_opb_cutover_warm_start."""
    from services.l4_numeric_contract import WEIGHT_SUPPORT
    proxy = market_proxy(live)
    sessions_all = market.query("SELECT date FROM canonical_market_daily WHERE stock_id=? AND source='finlab.price' "
                                "AND date>? ORDER BY date LIMIT ?", [proxy, signal_date, HORIZON_SESSIONS])
    calendar = [str(r['date'])[:10] for r in sessions_all]
    if not calendar:
        return {'status': 'immature'}
    if calendar != sorted(set(calendar)) or calendar[0] <= signal_date:
        raise ValueError('forward_net_return_calendar_invalid')
    sessions = [day for day in calendar if day < business_date]
    if not sessions:
        return {'status': 'immature'}
    entry = calendar[0]
    context = context_identity(live, live['artifact']['l3_identity'])
    arms = _arms(live)
    # Booked rows first: a fully booked day costs one indexed read, not the plan payload.
    existing = learning.query(
        'SELECT arm_digest,session_offset,weights_json,current_json,replay_plan_id,effective_digest,arm_exposure,'
        'row_kind,status,known_date,arm_piece,market_piece,consistency,snapshot_id,plan_id FROM l4_opb_arm_replay_v2 '
        'WHERE context_identity=? AND signal_date=?', [context, signal_date])
    have = {(r['arm_digest'], int(r['session_offset'])) for r in existing}
    wanted = {(d, i + 1) for _, d in arms for i in range(len(sessions))}
    if wanted <= have:
        return {'status': 'already_materialized'}
    terminal = frozen_override is None and row_kind == ROW_LIVE
    stored_by_arm = {}
    for r in existing:
        stored_by_arm.setdefault(r['arm_digest'], r)
    # Per arm: an arm with booked sessions keeps the targets, row kind and verdict of
    # the night it was solved; only arms without rows take tonight's solve.
    targets, consistency_by_arm, kind_by_arm = {}, {}, {}
    for _, arm_digest in arms:
        r = stored_by_arm.get(arm_digest)
        if r is not None:
            targets[arm_digest] = {'weights': json.loads(r['weights_json']), 'current': json.loads(r['current_json']),
                                   'replay_plan_id': r['replay_plan_id'], 'effective_digest': r['effective_digest'],
                                   'inert': r['status'] == 'inert'}
            consistency_by_arm[arm_digest], kind_by_arm[arm_digest] = r['consistency'], r['row_kind']
    if len(targets) == len(arms) and all((d, 1) in have for _, d in arms):
        # Every arm is booked from session 1: later sessions need only prices. No plan
        # payload, no snapshot (0.8-2.4 GB), no solve. Session 1 carries the only
        # rebalance cost and is already booked, so the fees are not needed either.
        base_row = stored_by_arm[dict(arms)['base']]
        snapshot_id, plan_id = base_row['snapshot_id'], base_row['plan_id']
        fees = {'buy_cost': 0., 'sell_cost': 0.}
    elif not solve:
        # Premarket refresh: a solve needs the snapshot and minutes of CPU; the nightly
        # owner does it. Only booked targets are priced here.
        return {'status': 'needs_solve'}
    else:
        solved = _solve_arms(live=live, signal_date=signal_date, entry=entry, arms=arms, paper=paper,
                             learning=learning, run=run, now=now, context=context, terminal=terminal,
                             row_kind=row_kind, frozen_override=frozen_override, artifact=artifact)
        if 'receipt' in solved:
            return solved['receipt']    # terminal verdict or not applicable: no rows
        snapshot_id, plan_id, fees = solved['snapshot_id'], solved['plan_id'], solved['fees']
        for _, arm_digest in arms:
            if arm_digest not in targets:
                targets[arm_digest] = solved['targets'][arm_digest]
                consistency_by_arm[arm_digest] = solved['consistency']
                kind_by_arm[arm_digest] = solved['row_kind']
    base_digest = dict(arms)['base']
    held = {s for t in targets.values() for s in t['weights']} | {proxy}
    prices = load_session_prices(held, sessions, query=market.query)

    def priced(through):
        window = sessions[:through]
        out = {d: session_pieces(t['weights'], t['current'], sessions=window, prices=prices,
                                 buy_cost=fees['buy_cost'], sell_cost=fees['sell_cost']) for d, t in targets.items()}
        market_piece = session_pieces({proxy: 1.}, {proxy: 1.}, sessions=window, prices=prices,
                                      buy_cost=0., sell_cost=0.)
        return None if market_piece is None or any(value is None for value in out.values()) else (out, market_piece)
    missing = None
    pricing = priced(len(sessions))
    if pricing is None:
        missing = sorted(s for s in held if not all((s, d) in prices and None not in prices[(s, d)] for d in sessions))
        # A held name not priced yet (suspended, not loaded): book the sessions that are
        # final now, exactly what a night with business_date = sessions[k] books (pieces
        # use prices up to their own session only); the rest waits for the prices.
        for through in range(len(sessions) - 1, 0, -1):
            pricing = priced(through)
            if pricing is not None:
                sessions = sessions[:through]
                break
        if pricing is None:
            return {'status': 'missing_price', 'symbols': missing}
    pieces, proxy_pieces = pricing
    base_exposure = sum(targets[base_digest]['weights'].values())
    # A session already booked keeps its booked base and market-proxy pieces: an arm added
    # later (or a re-adjusted price) must not give one session two market pieces.
    booked = {}
    for r in existing:
        offset = int(r['session_offset'])
        if offset > len(sessions):
            continue                 # booked by a later business-date run; not rewritten here
        if str(r['known_date']) != sessions[offset - 1]:
            raise ValueError('l4_opb_arm_replay_calendar_changed')
        booked.setdefault(offset, {})['market'] = float(r['market_piece'])
        if r['arm_digest'] == base_digest:
            booked[offset]['base'] = float(r['arm_piece'])
    materialized_at = (now or datetime.now(timezone.utc)).isoformat()
    records = []
    for arm_id, arm_digest in arms:
        target = targets[arm_digest]
        exposure = sum(target['weights'].values())
        for i, day in enumerate(sessions):
            if (arm_digest, i + 1) in have:
                continue
            arm_piece = pieces[arm_digest][i]
            base_piece = booked.get(i + 1, {}).get('base', pieces[base_digest][i])
            if arm_digest == base_digest:
                arm_piece = base_piece
            market_piece = booked.get(i + 1, {}).get('market', proxy_pieces[i])
            if target['inert'] or targets[base_digest]['inert']:
                status, delta = 'inert', 0.
            elif exposure <= WEIGHT_SUPPORT or base_exposure <= WEIGHT_SUPPORT:
                status, delta = 'no_exposure', 0.
            else:
                status, delta = 'complete', arm_piece * base_exposure / exposure - base_piece
            body = {'context_identity': context, 'signal_date': signal_date, 'arm_digest': arm_digest,
                    'session_offset': i + 1, 'arm_id': arm_id, 'schema_version': LEDGER_SCHEMA_V2,
                    'reward_semantic': REWARD_EXPOSURE_NORMALIZED, 'row_kind': kind_by_arm[arm_digest], 'status': status,
                    'known_date': day, 'arm_piece': arm_piece, 'base_piece': base_piece, 'market_piece': market_piece,
                    'arm_exposure': exposure, 'base_exposure': base_exposure, 'delta': delta,
                    'effective_digest': target['effective_digest'],
                    'weights_json': json.dumps(target['weights'], sort_keys=True, separators=(',', ':')),
                    'current_json': json.dumps(target['current'], sort_keys=True, separators=(',', ':')),
                    'score_source': score_source, 'snapshot_id': snapshot_id,
                    'plan_id': plan_id, 'replay_plan_id': target['replay_plan_id'],
                    'consistency': consistency_by_arm[arm_digest]}
            records.append({**body, 'payload_checksum': digest(body), 'materialized_at': materialized_at})
    _insert_v2(learning, records)
    kinds = {kind_by_arm[d] for _, d in arms}
    verdicts = {consistency_by_arm[d] for _, d in arms}
    receipt = {'status': 'materialized', 'rows': len(records), 'sessions': len(sessions),
               **({'missing_price': missing} if missing is not None else {}),
               'row_kind': kinds.pop() if len(kinds) == 1 else 'mixed',
               'consistency': verdicts.pop() if len(verdicts) == 1 else 'mixed'}
    if receipt['consistency'] == 'mixed' or receipt['row_kind'] == 'mixed':
        receipt['by_arm'] = {arm_id: {'row_kind': kind_by_arm[d], 'consistency': consistency_by_arm[d]}
                             for arm_id, d in arms}
    return receipt


VERDICT_SCHEMA = 'l4-opb-arm-replay-verdict-v1'
VERDICT_COLUMNS = ('context_identity', 'signal_date', 'schema_version', 'status', 'reason', 'snapshot_id', 'plan_id',
                   'detail_json', 'payload_checksum', 'materialized_at')


def _cached_verdict(learning, context, signal_date):
    rows = learning.query('SELECT status,reason FROM l4_opb_arm_replay_verdicts_v1 '
                          'WHERE context_identity=? AND signal_date=?', [context, signal_date])
    return {'status': rows[0]['status'], 'reason': rows[0]['reason'], 'verdict': 'cached'} if rows else None


def _record_verdict(learning, *, context, signal_date, status, reason, row=None, detail=None, now=None):
    """Terminal verdict of a live day in one context (insert-or-verify); the nightly
    replay then skips the day with one indexed read instead of re-reading it."""
    body = {'context_identity': context, 'signal_date': signal_date, 'schema_version': VERDICT_SCHEMA,
            'status': status, 'reason': reason, 'snapshot_id': row['allocation_snapshot_id'] if row else None,
            'plan_id': row['plan_id'] if row else None,
            'detail_json': json.dumps(detail or {}, sort_keys=True, separators=(',', ':'))}
    record = {**body, 'payload_checksum': digest(body),
              'materialized_at': (now or datetime.now(timezone.utc)).isoformat()}
    marks = ','.join('?' for _ in VERDICT_COLUMNS)
    learning.batch_execute([(f'INSERT INTO l4_opb_arm_replay_verdicts_v1({",".join(VERDICT_COLUMNS)}) '
                             f'VALUES({marks}) ON CONFLICT(context_identity,signal_date) DO NOTHING',
                             [record[c] for c in VERDICT_COLUMNS])])
    stored = learning.query('SELECT payload_checksum FROM l4_opb_arm_replay_verdicts_v1 '
                            'WHERE context_identity=? AND signal_date=?', [context, signal_date])
    if [r['payload_checksum'] for r in stored] != [record['payload_checksum']]:
        raise ValueError('l4_opb_arm_replay_verdict_conflict')
    return {'status': status, 'reason': reason, 'verdict': 'recorded'}


def _insert_v2(learning, records):
    """Insert-or-verify: a rerun must reproduce the stored rows byte-for-byte."""
    if not records:
        return
    marks = ','.join('?' for _ in COLUMNS_V2)
    learning.batch_execute([(f'INSERT INTO l4_opb_arm_replay_v2({",".join(COLUMNS_V2)}) VALUES({marks}) '
                             'ON CONFLICT(context_identity,signal_date,arm_digest,session_offset) DO NOTHING',
                             [record[c] for c in COLUMNS_V2]) for record in records])
    keys = {(r['context_identity'], r['signal_date']) for r in records}
    stored = {}
    for context, day in keys:
        for r in learning.query('SELECT arm_digest,session_offset,payload_checksum FROM l4_opb_arm_replay_v2 '
                                'WHERE context_identity=? AND signal_date=?', [context, day]):
            stored[(context, day, r['arm_digest'], int(r['session_offset']))] = r['payload_checksum']
    for record in records:
        key = (record['context_identity'], record['signal_date'], record['arm_digest'], record['session_offset'])
        if stored.get(key) != record['payload_checksum']:
            raise ValueError('l4_opb_arm_replay_conflict')


# Receipts that cost at most an indexed read or one small plan lookup; everything else
# (a solve, pricing, a snapshot read, a failure) spends the per-run budget. This is the
# main-branch rule, so v1 (no verdict table) stays bounded exactly as before.
CHEAP_STATUSES = frozenset({'immature', 'already_materialized', 'no_formal_plan', 'needs_solve'})


def run_progress(results):
    """What a run added: ledger rows written plus terminal verdicts recorded.

    A run with zero progress would repeat itself exactly (same days, same failures),
    so the independent replay treats it as the end of the night."""
    return sum(int(r.get('rows') or 0) for r in results.values() if r.get('status') == 'materialized') + \
        sum(1 for r in results.values() if r.get('verdict') == 'recorded')


def attach_daily_replay(config, business_date, *, clients=None, budget=None, dates_limit=None, deadline_seconds=None,
                        solve=True):
    """Independent nightly task; it never changes OOF/account closure status.

    Catch-up is built in: every run scans the newest `dates_limit` formal-plan days
    and books every session of theirs that has closed before `business_date`, so a
    night nobody ran is filled by the next run. Each write is insert-or-verify, so
    concurrent or repeated runs agree. Bounds per run: `budget` days that did work,
    then `deadline_seconds` of wall time; the rest is `deferred_*` and carries over.
    `solve=False` (v3 premarket) only prices days whose arms are all booked.
    """
    import time
    started = time.monotonic()
    try:
        live = config.get('l4Distribution')
        if not is_v2(live):
            return {'status': 'skipped', 'reason': 'policy_not_v2'}
        validate_constraints(live['constraints'])
        if clients is None:
            from services.d1_domain_client import client_proxy_for_domain
            clients = {name: client_proxy_for_domain(name) for name in ('paper', 'learning', 'market')}
        paper, learning, market = clients['paper'], clients['learning'], clients['market']
        limit = live['opb']['reward_window_observations'] + HORIZON_SESSIONS if dates_limit is None else dates_limit
        if is_v3(live):
            def replay(**kwargs):
                return replay_day_v3(**kwargs, solve=solve)
        else:
            replay = replay_day
        budget = BACKFILL_DATES_PER_RUN if budget is None else budget
        dates = [str(r['signal_date']) for r in paper.query(
            'SELECT DISTINCT signal_date FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 '
            'AND signal_date<? ORDER BY signal_date DESC LIMIT ?', [business_date, limit])]
        # v3 nightly owner: days that could not be booked (missing price, failure) go behind
        # every other day, least recently tried first, so they never take the whole budget
        # night after night and starve older days; they still get any budget left over.
        queue = None
        if is_v3(live) and solve:
            try:
                queue = _read_retry_queue(learning, live)
            except Exception:
                logger.exception('[L4 OPB replay] retry queue read failed; newest-first order tonight')
                queue = {}
        if queue:
            dates = [d for d in dates if d not in queue] + sorted((d for d in dates if d in queue),
                                                                  key=lambda d: (queue[d], d))
        results, computed = {}, 0
        for day in dates:
            if computed >= budget:
                results[day] = {'status': 'deferred_budget'}
                continue
            if deadline_seconds is not None and time.monotonic() - started >= deadline_seconds:
                results[day] = {'status': 'deferred_deadline'}
                continue
            try:
                results[day] = replay(live=live, signal_date=day, business_date=business_date,
                                          paper=paper, learning=learning, market=market)
            except Exception as exc:
                logger.exception('[L4 OPB replay] %s failed', day)
                results[day] = {'status': 'failed', 'error_type': type(exc).__name__, 'reason': str(exc)[:200],
                                'transient': _transient_error(exc)}
            # A cached v3 verdict is one primary-key read (v1 never has one).
            if results[day]['status'] not in CHEAP_STATUSES and results[day].get('verdict') != 'cached':
                computed += 1
        failed = sorted(day for day, r in results.items() if r['status'] == 'failed')
        deferred = sorted(day for day, r in results.items() if r['status'].startswith('deferred_'))
        # Terminal, never retried, but reported on every run that scans the day.
        rejected = sorted(day for day, r in results.items() if r['status'] == 'rejected')
        missing = sorted(day for day, r in results.items() if r['status'] == 'missing_price' or 'missing_price' in r)
        if queue is not None:
            try:
                _write_retry_queue(learning, live, results, queue)
            except Exception:
                # Ordering only: tonight's rows and verdicts are already written.
                logger.exception('[L4 OPB replay] retry queue write failed')
        return {'status': 'failed' if failed else 'ok', 'failed_dates': failed, 'deferred_dates': deferred,
                'rejected_dates': rejected, 'missing_price_dates': missing, 'progress': run_progress(results),
                'transient_failures': sum(1 for r in results.values() if _transient(r)), 'dates': results}
    except Exception as exc:
        logger.exception('[L4 OPB replay] setup failed')
        return {'status': 'failed', 'error_type': type(exc).__name__, 'reason': str(exc)[:200],
                'transient_failures': int(_transient_error(exc))}


def _transient_error(exc):
    """True only for the D1 client's exhausted transient errors (HTTP 429/5xx, network,
    overload; directly or as an explicit __cause__).

    A D1DurableBatchRetryRequired counts by its cause (raised `from` the transport
    error): around an HTTP 400 it repeats on a retry. Everything else repeats too:
    snapshot integrity (paired_nav_journal/cold RuntimeErrors), Worker batch validation,
    HTTP 400 SQL errors, JSON decoding and l4_opb_* / forward_net_return_* ValueErrors.

    Limit: the chain is followed through explicit causes, so any `raise X from <transient>`
    is judged transient even when X itself would repeat (e.g. a conflict raised from a
    D1 503); an implicit __context__ is not followed. The cost is at most one more
    execution on the night's first zero-progress run (run_complete).
    Classification only; never changes what is booked."""
    from services.d1_client import is_transient_d1_error
    return bool(is_transient_d1_error(exc))


def _transient(result):
    return result.get('status') == 'failed' and result.get('transient') is True


RETRY_COLUMNS = ('context_identity', 'signal_date', 'reason', 'detail_json', 'attempts', 'last_attempt_at')
# Age of the last attempt, not of signal_date, decides the prune: a row of the live
# context is rewritten (last_attempt_at) each night it is tried, and queued days are
# tried oldest-attempt first, so only rows nobody reads any more (an older context: a
# deploy or KV change moves it) stop being refreshed. 200 days without an attempt is
# far past any live row's gap; a row dropped early only loses its place in the order
# (work queue, never evidence). Engineering bound, not a trading parameter.
RETRY_STALE_DAYS = 200


def _read_retry_queue(learning, live):
    """{signal_date: last_attempt_at} of this context's unbookable days (one PK-prefix read)."""
    context = context_identity(live, live['artifact']['l3_identity'])
    return {str(r['signal_date']): str(r['last_attempt_at']) for r in learning.query(
        'SELECT signal_date,last_attempt_at FROM l4_opb_arm_replay_retry_v1 WHERE context_identity=?', [context])}


def _write_retry_queue(learning, live, results, queue, now=None):
    """Queue days tried tonight that stay unbookable; drop queued days that resolved.

    Work queue only (ordering), never evidence: the ledger and verdicts decide what is booked."""
    context = context_identity(live, live['artifact']['l3_identity'])
    at = (now or datetime.now(timezone.utc)).isoformat()
    statements = []
    for day, r in results.items():
        if r['status'] == 'failed' or r['status'] == 'missing_price' or 'missing_price' in r:
            reason = 'failed' if r['status'] == 'failed' else 'missing_price'
            # Bounded before encoding, so the column is always valid JSON.
            detail = {k: str(r[k])[:200] for k in ('error_type', 'reason') if k in r}
            for key in ('symbols', 'missing_price'):
                if key in r:
                    names = [str(name) for name in r[key]]
                    detail[key], detail[key + '_count'] = names[:50], len(names)
            statements.append((f'INSERT INTO l4_opb_arm_replay_retry_v1({",".join(RETRY_COLUMNS)}) '
                               'VALUES(?,?,?,?,1,?) ON CONFLICT(context_identity,signal_date) DO UPDATE SET '
                               'reason=excluded.reason,detail_json=excluded.detail_json,attempts=attempts+1,'
                               'last_attempt_at=excluded.last_attempt_at',
                               [context, day, reason, json.dumps(detail, sort_keys=True, separators=(',', ':')), at]))
        elif day in queue and not r['status'].startswith('deferred_'):
            statements.append(('DELETE FROM l4_opb_arm_replay_retry_v1 WHERE context_identity=? AND signal_date=?',
                               [context, day]))
    for day in sorted(set(queue) - set(results)):      # slid out of the replay window
        statements.append(('DELETE FROM l4_opb_arm_replay_retry_v1 WHERE context_identity=? AND signal_date=?',
                           [context, day]))
    # Rows of older contexts are never read again (reads are by context): drop them by age
    # (index idx_l4_opb_arm_replay_retry_v1_attempt, no scan).
    stale = ((now or datetime.now(timezone.utc)) - timedelta(days=RETRY_STALE_DAYS)).isoformat()
    statements.append(('DELETE FROM l4_opb_arm_replay_retry_v1 WHERE last_attempt_at<?', [stale]))
    if statements:
        learning.batch_execute(statements)


# Wall-time bound for starting another day in the premarket refresh; each day is
# one indexed read plus prices (no snapshot, no solve). Not a trading parameter.
PRE_PLAN_DEADLINE_SECONDS = 60


def refresh_before_plan(config, signal_date, *, clients=None, deadline_seconds=PRE_PLAN_DEADLINE_SECONDS):
    """Price the session that closed on `signal_date` for days already solved.

    Runs inside the premarket pipeline, so it never reads a frozen snapshot or
    solves an arm (0.8-2.4 GB and ~2 min a day): a day without booked targets is
    `needs_solve` and left to the nightly owner (independent replay job), which
    books through `signal_date`. The HORIZON_SESSIONS days whose hold covers
    `signal_date` and were solved gain their piece; insert-or-verify, so the
    nightly job finds the same rows. v3 only; a failure leaves the plan on the
    evidence it already has.
    """
    live = config.get('l4Distribution')
    if not is_v3(live) or not (live.get('opb') or {}).get('enabled'):
        return {'status': 'skipped', 'reason': 'policy_not_v3_enabled'}
    business_date = (date.fromisoformat(signal_date) + timedelta(days=1)).isoformat()
    # S itself (immature) plus the HORIZON_SESSIONS plan days whose hold covers S.
    return attach_daily_replay(config, business_date, clients=clients, budget=HORIZON_SESSIONS,
                               dates_limit=HORIZON_SESSIONS + 1, deadline_seconds=deadline_seconds, solve=False)
