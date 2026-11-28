#!/usr/bin/env python3
"""OPB v3 offline evidence: replay archived formal days under candidate arms. No writes.

Two steps, both read-only:

fetch   For every signal date with an activated Paper plan, read the frozen allocation snapshot
        behind the first pre-09:00 formal plan (the same choice as the OPB arm replay) and the
        adjusted open/close of every candidate and holding over the forward window, and keep a
        local compressed copy. D1 is read through `wrangler d1 execute --remote` (the operator's
        own login, no API token in this process); the cold store through `gcloud storage cat`.
replay  Rerun the allocator offline on each cached day for every arm of one or more arm sets,
        and report per arm: target weights, gross exposure, five-session net return, the v2
        reward (arm minus base) and the v3 exposure-normalized reward.

`--output` writes local JSON only. Learning-db reads honour the write-avoid windows
(13:00-16:30Z, 17:00-23:00Z) like the R13 replay.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import gzip
import json
import math
import os
import subprocess
import sys
from pathlib import Path

# One BLAS thread per process: the replay runs one solve per process, and
# oversubscribed BLAS threads make each 564-name eigendecomposition ~1000x slower.
for _name in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
    os.environ.setdefault(_name, '1')
os.environ.setdefault('GCS_BUCKET_NAME', COLD_BUCKET := 'stockvision-models')

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / 'ml-controller')]

WORKER = REPO / 'worker'
# A worktree may lack node_modules; WRANGLER points at any checkout's binary.
WRANGLER = os.environ.get('WRANGLER') or str(WORKER / 'node_modules/.bin/wrangler')
DATABASES = {'paper': 'stockvision-paper-db', 'learning': 'stockvision-learning-db',
             'market': 'stockvision-market-db'}
AVOID_WINDOWS_UTC = (('13:00', '16:30'), ('17:00', '23:00'))


def in_avoid_window(now: datetime) -> bool:
    clock = now.astimezone(timezone.utc).strftime('%H:%M')
    return any(start <= clock < end for start, end in AVOID_WINDOWS_UTC)


def _literal(value):
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError('non-finite literal')
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def inline(sql: str, params) -> str:
    parts = sql.split('?')
    if len(parts) != len(params or []) + 1:
        raise ValueError('placeholder count mismatch')
    out = [parts[0]]
    for value, tail in zip(params or [], parts[1:]):
        out += [_literal(value), tail]
    return ''.join(out)


class WranglerQuery:
    """query() only, through the operator's wrangler login; never writes."""

    def __init__(self, domain: str):
        self.domain = domain
        self.database = DATABASES[domain]

    def query(self, sql, params=()):
        statement = inline(sql, list(params or ()))
        head = statement.lstrip().split(None, 1)[0].upper()
        if head not in ('SELECT', 'WITH', 'EXPLAIN'):
            raise ValueError('read-only client: ' + head)
        if self.domain == 'learning' and in_avoid_window(datetime.now(timezone.utc)):
            raise RuntimeError('learning_db_avoid_window')
        result = subprocess.run([WRANGLER, 'd1', 'execute', self.database, '--remote', '--json',
                                 '--command', statement], cwd=WORKER, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise RuntimeError(f'wrangler failed: {result.stderr[-800:]}{result.stdout[-800:]}')
        payload = json.loads(result.stdout)
        return payload[0]['results']

    __call__ = query


class GcloudCold:
    """Cold store download through one `gcloud storage cat` stream (no sliced cp)."""

    def download(self, key, path):
        with open(path, 'wb') as sink:
            subprocess.run(['gcloud', 'storage', 'cat', f'gs://{COLD_BUCKET}/{key}'], stdout=sink, check=True,
                           timeout=1800)


def first_formal_plan(paper, signal_date, entry_date):
    from services.l4_opb_arm_replay import _entry_deadline, _utc
    rows = paper.query(
        "SELECT plan_id,allocation_snapshot_id,created_at,json_extract(payload_json,'$.execution_scope') scope,"
        "json_extract(payload_json,'$.weights') weights,json_extract(payload_json,'$.opb') opb,"
        "json_extract(payload_json,'$.l3_identity') l3,json_extract(payload_json,'$.policy_identity') pid "
        "FROM l4_portfolio_plans_v1 WHERE account_id=1 AND signal_date=? AND activated=1 ORDER BY created_at,plan_id",
        [signal_date])
    for row in rows:
        if row['scope'] == 'paper' and _utc(row['created_at']) < _entry_deadline(entry_date):
            return row
    return None


def _proxy(args):
    """The market proxy: --market-proxy, else the KV schema default (l4_opb_selection)."""
    from services.l4_opb_selection import market_proxy
    value = getattr(args, 'market_proxy', None)
    return market_proxy({} if value is None else {'market_proxy': value})


def fetch(args):
    from services import paired_nav_cold
    from services.paired_nav_journal import read_snapshot
    from services.forward_net_return import forward_sessions
    paper, learning, market = (WranglerQuery(d) for d in ('paper', 'learning', 'market'))
    store = GcloudCold()
    original = paired_nav_cold.production_store
    paired_nav_cold.production_store = lambda: paired_nav_cold.ColdObjects.__new__(paired_nav_cold.ColdObjects)
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    dates = [r['signal_date'] for r in paper.query(
        'SELECT DISTINCT signal_date FROM l4_portfolio_plans_v1 WHERE account_id=1 AND activated=1 '
        'AND signal_date>=? AND signal_date<=? ORDER BY signal_date', [args.start, args.end])]
    report = {}
    try:
        for day in dates:
            target = cache / f'{day}.json.gz'
            if target.exists() and not args.refresh:
                report[day] = 'cached'
                continue
            sessions = forward_sessions(day, query=market.query)
            entry = sessions[0] if sessions else None
            if entry is None:
                # Immature: entry is the next session; use the snapshot cut-off rule on the next weekday.
                nxt = market.query("SELECT date FROM canonical_market_daily WHERE stock_id=? AND "
                                   "source='finlab.price' AND date>? ORDER BY date LIMIT 1", [_proxy(args), day])
                entry = str(nxt[0]['date'])[:10] if nxt else None
            if entry is None:
                report[day] = 'no_entry_session'
                continue
            row = first_formal_plan(paper, day, entry)
            if row is None:
                report[day] = 'no_formal_plan'
                continue
            cold = paired_nav_cold.ColdObjects.__new__(paired_nav_cold.ColdObjects)
            cold.download = store.download
            paired_nav_cold.production_store = lambda cold=cold: cold
            saved = read_snapshot(learning.query, row['allocation_snapshot_id'])
            content = saved['payload']['content']
            inputs = content['inputs']
            from services.l4_opb_arm_replay import _entry_deadline, _utc
            record = {'signal_date': day, 'entry_date': entry, 'sessions': sessions,
                      'frozen_before_entry': _utc(saved['manifest']['frozen_at']) < _entry_deadline(entry),
                      'plan': {k: (json.loads(v) if k in ('weights', 'opb', 'l3') and v else v) for k, v in row.items()},
                      'allocator_source_identity': content.get('allocator_source_identity'),
                      'inputs': {'recommendations': inputs['recommendations'],
                                 'return_history': inputs['return_history'],
                                 'l4Distribution': inputs['alpha_policy']['l4Distribution']}}
            with gzip.open(target, 'wt', encoding='utf-8') as sink:
                json.dump(record, sink, separators=(',', ':'), allow_nan=False)
            report[day] = 'fetched'
            print(day, 'fetched', flush=True)
    finally:
        paired_nav_cold.production_store = original
    prices(args, market, cache)
    print(json.dumps(report, indent=1))


def prices(args, market, cache):
    """Adjusted open/close for every candidate and holding, signal start .. end+10 sessions."""
    symbols = set()
    for path in sorted(cache.glob('20*.json.gz')):
        with gzip.open(path, 'rt', encoding='utf-8') as source:
            record = json.load(source)
        symbols |= {r['symbol'] for r in record['inputs']['recommendations']}
        symbols |= {h['symbol'] for h in record['inputs']['l4Distribution']['runtime']['account']['holdings']}
    proxy = _proxy(args)
    symbols = sorted(symbols | {proxy})
    end = market.query("SELECT date FROM canonical_market_daily WHERE stock_id=? AND source='finlab.price' "
                       "AND date>? ORDER BY date LIMIT 10", [proxy, args.end])
    last = str(end[-1]['date'])[:10] if end else args.end
    rows = []
    for offset in range(0, len(symbols), 40):
        chunk = symbols[offset:offset + 40]
        marks = ','.join('?' for _ in chunk)
        rows += market.query(f"SELECT stock_id,date,source,adj_open,adj_close FROM canonical_market_daily "
                             f"WHERE stock_id IN ({marks}) AND date>=? AND date<=? "
                             f"AND source IN ('finlab.price','finlab.rotc_price')", [*chunk, args.start, last])
    calendar = [str(r['date'])[:10] for r in market.query(
        "SELECT date FROM canonical_market_daily WHERE stock_id=? AND source='finlab.price' "
        "AND date>=? AND date<=? ORDER BY date", [proxy, args.start, last])]
    with gzip.open(cache / 'prices.json.gz', 'wt', encoding='utf-8') as sink:
        json.dump({'market_proxy': proxy, 'calendar': calendar, 'rows': rows}, sink, separators=(',', ':'))
    print('prices', len(symbols), 'symbols', len(rows), 'rows', flush=True)


def load_records(cache):
    records = []
    for path in sorted(Path(cache).glob('20*.json.gz')):
        with gzip.open(path, 'rt', encoding='utf-8') as source:
            records.append(json.load(source))
    return records


def load_prices(cache, *, proxy):
    """The calendar and market piece must come from the proxy this replay prices against."""
    with gzip.open(Path(cache) / 'prices.json.gz', 'rt', encoding='utf-8') as source:
        raw = json.load(source)
    if raw.get('market_proxy') != proxy:
        raise RuntimeError('opb_v3_offline_replay_market_proxy_mismatch')
    from services.forward_net_return import PRICE_SOURCES
    best = {}
    for row in raw['rows']:
        key = (str(row['stock_id']), str(row['date'])[:10])
        priority = PRICE_SOURCES.index(row['source'])
        if key not in best or priority < best[key][0]:
            best[key] = (priority, row['adj_open'], row['adj_close'])
    return raw['calendar'], {k: (v[1], v[2]) for k, v in best.items()}


def reference_policies(records):
    """The latest v2 frozen policy per L3 identity: the 'live' policy a replay uses."""
    from services.l4_opb_selection import is_v2
    refs = {}
    for record in records:
        policy = record['inputs']['l4Distribution']
        if is_v2(policy):
            key = json.dumps(policy['runtime']['l3_identity'], sort_keys=True)
            refs[key] = {k: v for k, v in policy.items() if k != 'runtime'}
    return refs


def emulated_policy(reference, runtime, arm, inert_reference_exposure=None, inert_reference_name=None):
    """Arm = allocator overrides + envelope fractions, applied as the base policy with OPB off."""
    policy = deepcopy(reference)
    policy['opb'] = {**policy['opb'], 'enabled': False}
    policy['constraints'] = {**policy['constraints'], **(arm.get('constraints') or {})}
    runtime = deepcopy(runtime)
    limits = runtime['account']['risk_limits']
    inert = limits['exposure_cap'] == 0 or bool(limits.get('buys_halted'))
    counterfactual = False
    if inert and inert_reference_exposure is not None:
        limits.update(exposure_cap=inert_reference_exposure, name_cap=inert_reference_name, buys_halted=False)
        counterfactual = True
    limits['exposure_cap'] = limits['exposure_cap'] * arm.get('exposure_fraction', 1.)
    limits['name_cap'] = limits['name_cap'] * arm.get('name_fraction', 1.)
    policy['runtime'] = runtime
    return policy, inert, counterfactual


def _solve(job):
    record, reference, arm, inert_reference_exposure, inert_reference_name = job
    from services.l4_distribution_runtime import run
    from services.l4_numeric_contract import WEIGHT_SUPPORT
    inputs = record['inputs']
    policy, inert, counterfactual = emulated_policy(reference, inputs['l4Distribution']['runtime'], arm,
                                                    inert_reference_exposure, inert_reference_name)
    try:
        output = run(deepcopy(inputs['recommendations']), policy, return_history=inputs['return_history'])
    except Exception as exc:  # report, never guess
        return {'signal_date': record['signal_date'], 'arm': arm['id'], 'status': 'failed',
                'error': f'{type(exc).__name__}:{str(exc)[:160]}'}
    plan = output[0]['_l4_portfolio_plan']
    weights = {s: w for s, w in plan['weights'].items() if w > WEIGHT_SUPPORT}
    current = {s: t['current_weight'] for s, t in plan['targets'].items() if t['current_weight'] > WEIGHT_SUPPORT}
    return {'signal_date': record['signal_date'], 'arm': arm['id'], 'status': 'ok', 'inert': inert,
            'counterfactual_inert': counterfactual, 'weights': weights, 'current': current,
            'exposure': sum(weights.values())}


def replay(args):
    from concurrent.futures import ProcessPoolExecutor
    proxy = _proxy(args)
    calendar, prices = load_prices(args.cache, proxy=proxy)
    records = [r for r in load_records(args.cache) if r['frozen_before_entry']]
    refs = reference_policies(records)
    arm_sets = json.loads(Path(args.arms).read_text())
    jobs = []
    for record in records:
        key = json.dumps(record['inputs']['l4Distribution']['runtime']['l3_identity'], sort_keys=True)
        reference = refs.get(key)
        if reference is None:
            continue
        for arm in arm_sets:
            jobs.append((record, reference, arm, args.inert_reference_exposure, args.inert_reference_name))
    results = []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for result in pool.map(_solve, jobs):
            results.append(result)
            print(result['signal_date'], result['arm'], result['status'], round(result.get('exposure', 0), 4),
                  len(result.get('weights') or {}), result.get('error', ''), flush=True)
    fees = {r['signal_date']: r['inputs']['l4Distribution']['runtime']['account']['fees'] for r in records}
    for result in results:
        if result['status'] == 'ok':
            result.update(outcome(result, calendar, prices, fees[result['signal_date']], proxy=proxy))
    Path(args.output).write_text(json.dumps(results, separators=(',', ':')))


def outcome(result, calendar, prices, fees, *, proxy):
    """Session pieces of the five-session net label (same function the v3 ledger uses)."""
    from services.l4_opb_arm_replay import session_pieces
    day = result['signal_date']
    after = [d for d in calendar if d > day][:5]
    if not after:
        return {'pieces': None, 'reason': 'immature'}
    pieces = session_pieces(result['weights'], result['current'], sessions=after, prices=prices,
                            buy_cost=fees['buy_cost'], sell_cost=fees['sell_cost'])
    market = session_pieces({proxy: 1.}, {proxy: 1.}, sessions=after, prices=prices,
                            buy_cost=0., sell_cost=0.)
    if pieces is None or market is None:
        return {'pieces': None, 'reason': 'missing_price'}
    return {'pieces': pieces, 'market_pieces': market, 'sessions': after,
            'net_return': sum(pieces) if len(after) == 5 else None}

def ledger_rows(results, *, kinds=None):
    """v2-ledger-shaped rows (context fixed per run) from replay results."""
    from services.l4_opb_selection import LEDGER_SCHEMA_V2, REWARD_EXPOSURE_NORMALIZED, ROW_LIVE, ROW_COUNTERFACTUAL_INERT
    from services.l4_numeric_contract import WEIGHT_SUPPORT
    by_day = {}
    for r in results:
        if r['status'] == 'ok' and r.get('pieces') is not None:
            by_day.setdefault(r['signal_date'], {})[r['arm']] = r
    rows = []
    for day, arms in sorted(by_day.items()):
        base = arms.get('base')
        if base is None:
            continue
        kind = ROW_COUNTERFACTUAL_INERT if base.get('counterfactual_inert') else ROW_LIVE
        for arm_id, r in arms.items():
            for i, session in enumerate(r['sessions']):
                inert = base['inert'] and not base.get('counterfactual_inert')
                if inert:
                    status, delta = 'inert', 0.
                elif r['exposure'] <= WEIGHT_SUPPORT or base['exposure'] <= WEIGHT_SUPPORT:
                    status, delta = 'no_exposure', 0.
                else:
                    status = 'complete'
                    delta = r['pieces'][i] * base['exposure'] / r['exposure'] - base['pieces'][i]
                rows.append({'context_identity': 'offline', 'signal_date': day, 'arm_digest': arm_id,
                             'session_offset': i + 1, 'schema_version': LEDGER_SCHEMA_V2,
                             'reward_semantic': REWARD_EXPOSURE_NORMALIZED, 'row_kind': kind, 'status': status,
                             'known_date': session, 'delta': delta, 'market_piece': r['market_pieces'][i],
                             'arm_exposure': r['exposure'], 'base_exposure': base['exposure'],
                             'raw_delta': r['pieces'][i] - base['pieces'][i]})
    return rows


def evaluate(args):
    from services.l4_opb_selection import (_v3_series, critical_value, market_neutral_edge, decayed_paired_edge,
                                           ROW_KINDS)
    results = json.loads(Path(args.results).read_text())
    arm_ids = []
    for r in results:
        if r['arm'] not in arm_ids:
            arm_ids.append(r['arm'])
    rows = ledger_rows(results)
    config = {'inert_counterfactual': {'enabled': args.count_inert, 'reference_exposure_cap': None},
              'min_exposure_ratio': args.min_exposure_ratio,
              'cutover_warm_start': {'enabled': False, 'max_observations': 0}}
    arms = [{'id': a, 'definition_digest': a} for a in arm_ids]
    window, half_life = args.window, args.half_life
    days = sorted({r['signal_date'] for r in results})
    by = {(r['signal_date'], r['arm']): r for r in results if r['status'] == 'ok'}
    report = {'arms': {}, 'timeline': [], 'parameters': vars(args)}
    # Per-arm descriptive statistics over the whole sample.
    series, _, counted = _v3_series(config, arms, rows, context='offline', signal_date='9999-12-31')
    k = len(arm_ids) - 1
    for a in arm_ids:
        d, m, sess = series[a]
        stats = market_neutral_edge(d, m, window=10 ** 6, half_life=10 ** 9, lag=args.lag)
        distinct = [day for day in days if (day, a) in by and (day, 'base') in by
                    and by[(day, a)]['weights'] != by[(day, 'base')]['weights']]
        ratios = [by[(day, a)]['exposure'] / by[(day, 'base')]['exposure'] for day in days
                  if (day, a) in by and (day, 'base') in by and by[(day, 'base')]['exposure'] > 1e-9]
        five = [sum(by[(day, a)]['pieces']) - sum(by[(day, 'base')]['pieces']) for day in days
                if (day, a) in by and (day, 'base') in by and by[(day, a)].get('net_return') is not None
                and by[(day, 'base')].get('net_return') is not None]
        v2 = decayed_paired_edge(five, window=60, half_life=20., lag=4)
        report['arms'][a] = {
            'sessions': stats['samples'], 'alpha_per_session': stats['mean'], 'beta': stats['beta'],
            'se': stats['standard_error'],
            't': (stats['mean'] / stats['standard_error']) if stats['mean'] is not None and stats['standard_error'] else None,
            'critical_value_full_sample': critical_value(stats['samples'], max(k, 1), args.alpha, 10 ** 6, 10 ** 9,
                                                         args.lag, 20000) if a != 'base' else None,
            'distinct_days': len(distinct), 'days': sum(1 for day in days if (day, a) in by),
            'mean_exposure_ratio': sum(ratios) / len(ratios) if ratios else None,
            'raw_five_session_delta_mean': (sum(five) / len(five)) if five else None,
            'v2_rule_t': (v2['mean'] / v2['standard_error']) if v2['standard_error'] else None}
    # Walk-forward selection: on each decision day use only rows known by then.
    decisions = {}
    for day in days:
        known = [r for r in rows if r['known_date'] <= day]
        ser, any_rows, _ = _v3_series(config, arms, known, context='offline', signal_date=day)
        best, status, detail = 'base', 'cold_start_base' if not any_rows else 'no_calibrated_edge', {}
        bounds = []
        for a in arm_ids:
            d, m, _ = ser[a]
            st = market_neutral_edge(d, m, window=window, half_life=half_life, lag=args.lag)
            c = critical_value(st['samples'], k, args.alpha, window, half_life, args.lag, 20000) \
                if a != 'base' and st['mean'] is not None else None
            lb = st['mean'] - c * st['standard_error'] if c is not None else None
            detail[a] = {'n': st['samples'], 'alpha': st['mean'], 'se': st['standard_error'], 'c': c, 'lb': lb}
            if a != 'base' and lb is not None and lb > 0:
                bounds.append((lb, a))
        if bounds:
            top = max(bounds)
            best, status = top[1], 'learned_policy'
        # v2 rule on the same data: raw five-session deltas, 1 x SE, matured by the decision day.
        v2_best, v2_bounds = 'base', []
        for a in arm_ids:
            if a == 'base':
                continue
            five = [sum(by[(d0, a)]['pieces']) - sum(by[(d0, 'base')]['pieces']) for d0 in days
                    if d0 < day and (d0, a) in by and by[(d0, a)].get('net_return') is not None
                    and by[(d0, a)]['sessions'][-1] <= day and not by[(d0, 'base')]['inert']]
            st = decayed_paired_edge(five, window=60, half_life=20., lag=4)
            if st['lower_bound'] is not None and st['lower_bound'] > 0:
                v2_bounds.append((st['lower_bound'], a))
        if v2_bounds:
            v2_best = max(v2_bounds)[1]
        decisions[day] = {'v3': best, 'v2': v2_best}
        report['timeline'].append({'signal_date': day, 'v3_arm': best, 'v3_status': status, 'v2_arm': v2_best,
                                   'detail': detail})
    # NAV: each day's plan is a 1/5 tranche held for its five sessions (label semantics).
    def nav(choose):
        daily = {}
        for day in days:
            arm = choose(day)
            r = by.get((day, arm))
            if r is None or r.get('pieces') is None:
                continue
            for session, piece in zip(r['sessions'], r['pieces']):
                daily[session] = daily.get(session, 0.) + piece / 5.
        value, peak, drawdown, path = 1., 1., 0., []
        for session in sorted(daily):
            value *= 1. + daily[session]
            peak = max(peak, value)
            drawdown = min(drawdown, value / peak - 1.)
            path.append((session, value))
        return {'final_nav': value, 'max_drawdown': drawdown, 'sessions': len(path)}
    report['nav'] = {'base': nav(lambda d: 'base'), 'v2_rule': nav(lambda d: decisions[d]['v2']),
                     'v3_rule': nav(lambda d: decisions[d]['v3'])}
    for a in arm_ids:
        report['nav']['always_' + a] = nav(lambda d, a=a: a)
    report['rows_counted'] = counted
    Path(args.output).write_text(json.dumps(report, indent=1, default=str))
    print(json.dumps({'arms': report['arms'], 'nav': report['nav']}, indent=1, default=str))
    print('timeline', [(t['signal_date'], t['v3_arm'], t['v2_arm']) for t in report['timeline']])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    f = sub.add_parser('fetch')
    f.add_argument('--start', required=True)
    f.add_argument('--end', required=True)
    f.add_argument('--cache', required=True)
    f.add_argument('--refresh', action='store_true')
    proxy_help = 'market proxy (default: the KV schema default, l4_opb_selection.MARKET_PROXY_DEFAULT)'
    f.add_argument('--market-proxy', default=None, help=proxy_help)
    q = sub.add_parser('prices')
    q.add_argument('--start', required=True)
    q.add_argument('--end', required=True)
    q.add_argument('--cache', required=True)
    q.add_argument('--market-proxy', default=None, help=proxy_help)
    r = sub.add_parser('replay')
    r.add_argument('--cache', required=True)
    r.add_argument('--arms', required=True, help='JSON list of {id, constraints?, exposure_fraction?, name_fraction?}')
    r.add_argument('--output', required=True)
    r.add_argument('--workers', type=int, default=6)
    r.add_argument('--inert-reference-exposure', type=float, default=None)
    r.add_argument('--inert-reference-name', type=float, default=0.0625)
    r.add_argument('--market-proxy', default=None, help=proxy_help)
    e = sub.add_parser('evaluate')
    e.add_argument('--results', required=True)
    e.add_argument('--output', required=True)
    e.add_argument('--alpha', type=float, default=0.10)
    e.add_argument('--lag', type=int, default=2)
    e.add_argument('--window', type=int, default=60)
    e.add_argument('--half-life', type=float, default=20.)
    e.add_argument('--count-inert', action='store_true')
    e.add_argument('--min-exposure-ratio', type=float, default=0.5)
    args = parser.parse_args(argv)
    if args.command == 'fetch':
        fetch(args)
    elif args.command == 'prices':
        prices(args, WranglerQuery('market'), Path(args.cache))
    elif args.command == 'replay':
        replay(args)
    elif args.command == 'evaluate':
        evaluate(args)


if __name__ == '__main__':
    main()
