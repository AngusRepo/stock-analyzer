"""L4 policy v2 activation for Paper; run explicitly by the release owner.

  prepare         read-only: capture raw/merged config and Worker risk defaults, start the
                  release chain with the v1 -> v2 packet (--cost-objective is required)
  prepare-change  local: append a v2 constraints change (--set key=JSON) derived from the chain end;
                  with --continue-from CHAIN --step k, start a new chain from that chain's packet k
                  (the next release after Pk is activated: its S is Pk)
  prepare-risk    risk-only link (G0b): add absent trading:risk_config fields (--risk-set
                  section.key=JSON, add-only, policy unchanged). With no chain in --out and no
                  --continue-from it starts the chain at the live step (read-only KV/Worker reads);
                  otherwise it appends to the chain end / continues like prepare-change
  grant           local: derive P1..Pn from the release's S grant and validate every grant
  activate        dry-run unless --execute: move one adjacent step to --to (source|1..n);
                  forward follows the packet write order, backward its rollback order

Ports audits/risk-review-20261014/activate_policy.py. Optimistic rechecks
before every write and readback after it; KV has no CAS. Never rewrites a
sealed plan, dispatches a job, stages or deletes a grant, or enables Live.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import quote

REPO = Path(__file__).resolve().parents[1]
REGION = 'asia-east1'
SNAPSHOT_HASH_JS = r'''
const crypto=require('node:crypto');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']'
  :'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
for (const value of JSON.parse(require('node:fs').readFileSync(0,'utf8')))
  console.log(crypto.createHash('sha256').update(canonical(value)).digest('hex').slice(0,8));
'''


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(out, name, value):
    (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def sealed_plans(paper):
    # One plan per request: all payloads together (~128 MB on 2026-11-02) exceed a D1 response.
    ids = paper.query('SELECT plan_id FROM l4_portfolio_plans_v1 WHERE account_id=1 ORDER BY plan_id')
    return [paper.query('SELECT plan_id,payload_json FROM l4_portfolio_plans_v1 WHERE account_id=1 AND plan_id=?',
                        [row['plan_id']])[0] for row in ids]


def effective_risk_change_allowed(before, after, declared, *, forward, free=()):
    """Worker effective risk config before/after one step; only `declared` ('section.key') and
    `free` paths may move, and forward the declared paths must show the declared values.
    Backward the declared paths are not compared at all: the raw KV rollback is already checked
    by step_writes and the write readback, and the Worker's view of an absent field is its own."""
    def split(view):
        rest = json.loads(json.dumps(view))
        moved = {}
        for path in (*declared, *free):
            section, _, key = path.partition('.')
            if isinstance(rest.get(section), dict) and key in rest[section]:
                moved[path] = rest[section].pop(key)
        return rest, moved
    rest_before, _ = split(before)
    rest_after, moved_after = split(after)
    if rest_before != rest_after:
        return False
    return not forward or all(moved_after.get(path) == value for path, value in declared.items())


def risk_view_expectation(chain, start, target):
    """(declared, free, forward) for the Worker effective risk view after one step to `target`.

    A resumed step whose writes all landed (start == target) cannot tell its direction from KV,
    and `before` was read after the write (the edge cache may show either side): the fields both
    adjacent packets declare may differ from `before`; those the target raw risk_config carries
    must show their target values (forward: the target packet's declared values)."""
    from services.l4_policy_activation import chain_states, declared_risk_fields
    if start != target:
        return declared_risk_fields(chain[max(start, target) - 1]['activation']), (), target > start
    raw = chain_states(chain)[target]['trading:risk_config']
    touched = {}
    for index in (target - 1, target):
        if 0 <= index < len(chain):
            touched.update(declared_risk_fields(chain[index]['activation']))
    declared, free = {}, []
    for path in touched:
        section, _, key = path.partition('.')
        if isinstance(raw.get(section), dict) and key in raw[section]:
            declared[path] = raw[section][key]
        else:
            free.append(path)
    return declared, tuple(free), True


# The Worker reads trading:risk_config through the KV edge cache (~60 s), so its effective view
# lags a write by up to about a minute. Each read is itself bounded so a hung request cannot
# outlast the poll.
WORKER_RISK_VIEW_TIMEOUT_S = 120.0
WORKER_RISK_VIEW_INTERVAL_S = 5.0
WORKER_RISK_VIEW_REQUEST_TIMEOUT_S = 15.0


def worker_risk_view_reader(call):
    """fetch(timeout) for the Worker effective risk view; `call(timeout)` returns the reply of
    GET /api/admin/risk-config. Only an HTTP 200 view the Worker built from KV (source 'kv') counts:
    a non-200, a missing key or a KV read error (the Worker answers 200 with its FAIL_CLOSED view,
    source 'missing' / 'error') is None, i.e. not available."""
    def fetch(timeout):
        reply = call(timeout)
        body = reply.get('body')
        if (reply.get('http_status') != 200 or not isinstance(body, dict) or body.get('source') != 'kv'
                or not isinstance(body.get('effective'), dict)):
            return None
        return body['effective']
    return fetch


def _transport_errors():
    try:
        import httpx
    except ImportError:
        return ()
    return (httpx.TransportError,)   # timeouts, connect errors, a dropped connection


def _poll_worker_risk_view(fetch, accept, *, timeout=None, interval=None, transient=None):
    """Call fetch(request_timeout) until accept(view); bounded by `timeout` (fail closed).

    A transport error or an unavailable view (None) is retried within the same bound."""
    timeout = WORKER_RISK_VIEW_TIMEOUT_S if timeout is None else timeout
    interval = WORKER_RISK_VIEW_INTERVAL_S if interval is None else interval
    transient = _transport_errors() if transient is None else transient
    deadline = time.monotonic() + timeout
    while True:
        try:
            view = fetch(max(1.0, min(WORKER_RISK_VIEW_REQUEST_TIMEOUT_S, deadline - time.monotonic())))
        except transient:
            view = None
        if view is not None and accept(view):
            return view
        if time.monotonic() >= deadline:
            raise RuntimeError('worker_effective_risk_config_changed' if view is not None
                               else 'worker_risk_config_unavailable')
        time.sleep(interval)


def read_worker_risk_view(fetch, **poll):
    """The Worker effective risk view before a step; fails closed if no KV-backed view arrives."""
    return _poll_worker_risk_view(fetch, lambda view: True, **poll)


def wait_for_worker_risk_view(fetch, before, declared, *, forward, free=(), **poll):
    """Poll the Worker effective risk view until the step's change is visible; bounded.

    A view that moved outside the declared fields keeps polling (a stale edge copy) until the
    deadline, then fails."""
    return _poll_worker_risk_view(
        fetch, lambda view: effective_risk_change_allowed(before, view, declared, forward=forward, free=free), **poll)


def verify_worker_risk_step(fetch, before, chain, start, target, **poll):
    """After the writes of one step start -> target: the Worker view shows exactly that step."""
    declared, free, forward = risk_view_expectation(chain, start, target)
    return wait_for_worker_risk_view(fetch, before, declared, forward=forward, free=free, **poll)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('prepare', 'prepare-change', 'prepare-risk', 'grant', 'activate'))
    parser.add_argument('--workspace-root', type=Path, required=True, help='holds audits/pipeline-nightly-20261013')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--controller', type=Path, default=REPO / 'ml-controller')
    parser.add_argument('--engineering-receipt', type=Path)
    parser.add_argument('--source-reference')
    parser.add_argument('--source-grant', type=Path)
    parser.add_argument('--cost-objective', choices=('single_side_v1', 'entry_round_trip_v1'))
    parser.add_argument('--set', action='append', default=[], metavar='KEY=JSON')
    parser.add_argument('--risk-set', action='append', default=[], metavar='SECTION.KEY=JSON',
                        help='prepare-risk: an absent trading:risk_config field and its value')
    parser.add_argument('--to', help='source, or the 1-based grant index to step to')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--continue-from', type=Path, metavar='POLICY_CHAIN_JSON',
                        help='prepare-change: start a new chain from packet --step of a live release chain')
    parser.add_argument('--step', type=int, help='with --continue-from: the activated step k (1..n)')
    args = parser.parse_args()
    if ((args.continue_from is None) != (args.step is None)
            or args.continue_from and args.command not in ('prepare-change', 'prepare-risk')):
        raise SystemExit('--continue-from and --step go together, with prepare-change / prepare-risk only')
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    sys.path[:0] = [str(args.workspace_root / 'audits/pipeline-nightly-20261013'), str(args.controller)]
    os.environ['CLOUDSDK_PYTHON'] = sys.executable
    from runtime_context import load_environment, kv_get, request, gc
    release = load_environment()
    from services.paired_nav_journal import digest

    def read(key):
        reply = kv_get(key)
        if reply['http_status'] != 200:
            raise RuntimeError('kv_read_failed:' + key)
        return reply['body']

    # GET /api/admin/risk-config with a per-request timeout (worker() has none below 120 s); only a
    # KV-backed 200 view counts, never the Worker's FAIL_CLOSED one.
    risk_view = worker_risk_view_reader(lambda timeout: request(
        os.environ['STOCKVISION_WORKER_URL'].rstrip('/') + '/api/admin/risk-config',
        headers={'Authorization': 'Bearer ' + os.environ['STOCKVISION_AUTH_TOKEN']}, timeout=timeout))

    if args.command in ('prepare', 'prepare-change', 'prepare-risk') and (not args.engineering_receipt or not args.source_reference):
        raise SystemExit(args.command + ' needs --engineering-receipt and --source-reference')
    if args.command == 'prepare':
        if not args.cost_objective:
            raise SystemExit('prepare needs --cost-objective (no default: it is a policy decision)')
        if (out / 'policy-chain.json').exists():
            raise SystemExit('policy-chain.json exists; start a new --out for a new chain')
        service = json.loads(gc('run', 'services', 'describe', 'ml-controller', '--region=' + REGION, '--format=json'))
        env = {r['name']: r for r in service['spec']['template']['spec']['containers'][0]['env']}
        # The packet pins the controller's own allocator window, not this host's.
        name = 'STOCKVISION_GNN_RETURN_HISTORY_LOOKBACK'
        if name in env and 'value' not in env[name]:
            raise RuntimeError('lookback_env_not_literal')
        os.environ.pop(name, None)
        if name in env:
            os.environ[name] = env[name]['value']
        from services.active_model_policy import gnn_return_history_lookback
        from services.l4_release_packet import prepare_policy_v2_packet
        from services.worker_config_client import load_active_trading_config
        raw, risk = read('trading:config'), read('trading:risk_config')
        merged = load_active_trading_config()
        # Worker `effective` = DEFAULT_RISK_CONFIG merged under raw; absent raw keys carry the defaults.
        effective = read_worker_risk_view(risk_view)
        packet = prepare_policy_v2_packet(raw_config=raw, merged_config=merged, risk_config=risk,
            risk_defaults=effective, lookback=gnn_return_history_lookback(),
            cost_objective=args.cost_objective,
            engineering_receipt=load(args.engineering_receipt), source_reference=args.source_reference)
        if read('trading:config') != raw or read('trading:risk_config') != risk:
            raise RuntimeError('configuration_changed_during_prepare')
        packet['worker_effective_risk_config'] = effective
        packet['controller_source_sha'] = release['source_sha']
        save(out, 'policy-chain.json', [packet])
        print(json.dumps({'status': 'prepared_locally', 'cloud_writes': 0, 'chain_length': 1,
                          'next_policy_identity': packet['approved_policy_identity'],
                          'cost_objective': packet['activation']['cost_objective'],
                          'risk_config_filled_fields': packet['activation']['risk_config_filled_fields']}))
        return

    if args.continue_from:
        # A release made while the live chain sits at Pk starts a new chain from Pk: old packet k is
        # the previous link but not part of the new chain, so new chain[0].rollback_config = Pk raw.
        if (out / 'policy-chain.json').exists():
            raise SystemExit('policy-chain.json exists; start a new --out for a continued chain')
        from services.l4_policy_activation import chain_states
        previous_raw = args.continue_from.read_bytes()
        previous_chain = json.loads(previous_raw)
        if not isinstance(previous_chain, list) or not 1 <= args.step <= len(previous_chain):
            raise SystemExit('--step must name a packet of the --continue-from chain (1..n)')
        chain_states(previous_chain)
        chain, previous = [], previous_chain[args.step - 1]
    elif args.command == 'prepare-risk' and not (out / 'policy-chain.json').exists():
        chain, previous = [], None   # first link: starts at the live step (S)
    else:
        chain = load(out / 'policy-chain.json')
        previous = chain[-1] if args.command in ('prepare-change', 'prepare-risk') else None
    if args.command == 'prepare-risk':
        from services.l4_release_packet import prepare_policy_risk_packet
        fields = {}
        for item in args.risk_set:
            key, sep, value = item.partition('=')
            if not sep or key in fields:
                raise SystemExit('--risk-set needs distinct SECTION.KEY=JSON items')
            fields[key] = json.loads(value)
        if previous is None:
            from services.worker_config_client import load_active_trading_config
            raw, risk = read('trading:config'), read('trading:risk_config')
            merged = load_active_trading_config()
            packet = prepare_policy_risk_packet(raw_config=raw, merged_config=merged, risk_config=risk,
                risk_fields=fields, engineering_receipt=load(args.engineering_receipt), source_reference=args.source_reference)
            if read('trading:config') != raw or read('trading:risk_config') != risk:
                raise RuntimeError('configuration_changed_during_prepare')
        else:
            packet = prepare_policy_risk_packet(raw_config=previous['next_config'],
                merged_config=previous['next_merged_config'], risk_config=previous['next_risk_config'],
                risk_fields=fields, engineering_receipt=load(args.engineering_receipt), source_reference=args.source_reference)
        packet['controller_source_sha'] = release['source_sha']
        if args.continue_from:
            packet['continued_from'] = {'step': args.step, 'activation_checksum': digest(previous['activation']),
                'policy_chain_sha256': hashlib.sha256(previous_raw).hexdigest()}
        save(out, 'policy-chain.json', [*chain, packet])
        print(json.dumps({'status': 'prepared_locally', 'cloud_writes': 0, 'chain_length': len(chain) + 1,
                          'risk_config_added_fields': fields, 'next_policy_identity': packet['approved_policy_identity']}))
        return
    if args.command == 'prepare-change':
        from services.l4_release_packet import prepare_policy_change_packet
        changes = {}
        for item in args.set:
            key, sep, value = item.partition('=')
            if not sep or key in changes:
                raise SystemExit('--set needs distinct KEY=JSON items')
            changes[key] = json.loads(value)
        packet = prepare_policy_change_packet(previous, changes=changes,
            engineering_receipt=load(args.engineering_receipt), source_reference=args.source_reference)
        packet['controller_source_sha'] = release['source_sha']
        if args.continue_from:
            packet['continued_from'] = {'step': args.step, 'activation_checksum': digest(previous['activation']),
                'policy_chain_sha256': hashlib.sha256(previous_raw).hexdigest()}
        save(out, 'policy-chain.json', [*chain, packet])
        print(json.dumps({'status': 'prepared_locally', 'cloud_writes': 0, 'chain_length': len(chain) + 1,
                          'changes': changes, 'next_policy_identity': packet['approved_policy_identity']}))
        return

    from services.active8_paper_admission import validate_runtime_approval
    from services.l4_policy_activation import policy_keys, step_writes
    if args.command == 'grant':
        from services.l4_policy_activation import policy_grants
        source = load(args.source_grant)
        grants = policy_grants(source, chain)
        validate_runtime_approval(source, source['admission'])
        for grant in grants:
            validate_runtime_approval(grant, grant['admission'])
        save(out, 'policy-grants.json', grants)
        print(json.dumps({'status': 'grants_validated_locally', 'cloud_writes': 0,
                          'approval_checksums': [g['approval_checksum'] for g in grants]}))
        return

    grants = load(out / 'policy-grants.json')
    behavior = json.loads((args.controller / 'services/native_execution_behavior_release.json').read_text())
    keys = policy_keys(behavior)
    if len(grants) != len(chain) or len(keys) != len(grants):
        raise RuntimeError('grants_not_bound_to_release_chain')
    for count, (grant, packet) in enumerate(zip(grants, chain), 1):
        if (grant['configuration']['trading_config'] != packet['next_merged_config']
                or grant['configuration']['risk_config'] != packet['next_risk_config']
                or grant.get('approved_l4_execution_policy_change')
                != {'activation_checksums': [digest(p['activation']) for p in chain[:count]]}):
            raise RuntimeError('grant_not_bound_to_packet:' + str(count))
    if kv_get(behavior['runtime_admission'])['http_status'] != 200:
        raise RuntimeError('grant_not_staged:runtime_admission')
    for key, grant in zip(keys, grants):
        if kv_get(key)['http_status'] != 200 or read(key) != grant:
            raise RuntimeError('staged_policy_grant_differs:' + key)
        validate_runtime_approval(grant, grant['admission'])
    source_grant = read(behavior['runtime_admission'])
    source_config = source_grant['configuration']
    if source_config['risk_config'] != chain[0]['rollback_risk_config']:
        raise RuntimeError('source_grant_not_bound_to_rollback_risk_config')
    if args.to is None:
        raise SystemExit('activate needs --to source|1..' + str(len(grants)))
    target = 0 if args.to == 'source' else int(args.to)

    running = []
    for job in json.loads(gc('run', 'jobs', 'list', '--region=' + REGION, '--format=json')):
        name = job['metadata']['name']
        for row in json.loads(gc('run', 'jobs', 'executions', 'list', '--job=' + name, '--region=' + REGION,
                                 '--limit=5', '--format=json')):
            status = row.get('status', {})
            if status.get('runningCount') or status.get('startTime') and not status.get('completionTime'):
                running.append(row['metadata']['name'])
    if running:
        raise RuntimeError('wait_for_inflight_jobs:' + ','.join(running))

    current = {key: read(key) for key in ('trading:config', 'trading:risk_config')}
    # One adjacent step; a run resumes only after its own first write landed. Anything else is drift.
    start, pending = step_writes(chain, current, target)
    label = lambda i: 'source' if i == 0 else 'P' + str(i)
    from services.d1_domain_client import client_for_domain
    paper = client_for_domain('paper')
    sealed_before = sealed_plans(paper)
    risk_before = read_worker_risk_view(risk_view)
    plan = {'mode': 'execute' if args.execute else 'dry_run', 'from': label(start), 'to': label(target),
            'writes': [{'key': key, 'from_checksum': digest(frm), 'to_checksum': digest(to)} for key, frm, to in pending],
            'controller_source': release['source_sha'],
            'grant_checksum': (grants[target - 1] if target else source_grant)['approval_checksum']}
    stem = 'activation-' + plan['from'] + '-' + plan['to']
    if not args.execute:
        save(out, stem + '-dry-run.json', plan)
        print(json.dumps(plan))
        return

    endpoint = ('https://api.cloudflare.com/client/v4/accounts/' + os.environ['CF_ACCOUNT_ID']
                + '/storage/kv/namespaces/' + os.environ['CF_KV_NAMESPACE_ID'] + '/values/')

    def put(name, value, ttl=None):
        result = request(endpoint + quote(name, safe='') + ('?expiration_ttl=' + str(ttl) if ttl else ''),
            method='PUT', body=value, headers={'Authorization': 'Bearer ' + os.environ['CF_API_TOKEN']})
        if result['http_status'] != 200 or not result['body'].get('success'):
            raise RuntimeError('kv_write_failed:' + name)
        if read(name) != value:
            raise RuntimeError('kv_readback_failed:' + name)

    at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    receipt = {'status': 'writing', 'started_at': at, **plan, 'raw_values_before': current, 'snapshot_id': None}
    save(out, stem + '-receipt.json', receipt)
    for key, frm, to in pending:
        if key == 'trading:config':
            # Keep the Worker snapshot index format with its JS canonical hashes.
            old_hash, new_hash = subprocess.run(['node', '-e', SNAPSHOT_HASH_JS], input=json.dumps([frm, to]),
                capture_output=True, text=True, check=True).stdout.split()
            snapshot_id = 'trading:config:snapshot:' + at + ':' + new_hash
            meta = {'source': 'operator_verified_l4_policy_' + plan['from'] + '_to_' + plan['to'],
                    'push_id': plan['grant_checksum'], 'prev_hash': old_hash, 'new_hash': new_hash}
            snapshot = {'config': to, 'meta': meta, 'pushed_at': at}
            index = kv_get('trading:config:snapshot_index')
            if index['http_status'] not in (200, 404):
                raise RuntimeError('snapshot_index_unreadable')
            entries = index['body'] if index['http_status'] == 200 else []
            put(snapshot_id, snapshot, 90 * 86400)
            put('trading:config:snapshot_index', [{'id': snapshot_id, 'pushed_at': at, 'source': meta['source'],
                'push_id': meta['push_id'], 'hash': new_hash, 'prev_hash': old_hash,
                'bytes': len(json.dumps(snapshot, ensure_ascii=False).encode('utf8'))}, *entries][:100])
            receipt['snapshot_id'] = snapshot_id
        if read(key) != frm:
            raise RuntimeError('production_config_changed_before_write:' + key)
        put(key, to)
        receipt.setdefault('written', []).append(key)
        save(out, stem + '-receipt.json', receipt)

    from services.active8_nav_adoption import current_execution_configuration
    from services.active8_paper_admission import runtime_configuration_identity, verify_active_approval
    sealed_after = sealed_plans(paper)
    if digest(sealed_before) != digest(sealed_after):
        raise RuntimeError('sealed_plans_changed_during_activation')
    # The Worker effective risk view may change only at the risk fields this step declares
    # (G0b): forward they show exactly the declared values; backward they are not compared (the
    # raw KV rollback is verified above); every other field is unchanged either way. The Worker
    # reads KV through its edge cache, so poll (about a minute, bounded) instead of reading once.
    verify_worker_risk_step(risk_view, risk_before, chain, start, target)
    expected = grants[target - 1]['configuration'] if target else source_config
    actual = current_execution_configuration()
    if digest(runtime_configuration_identity(actual)) != digest(runtime_configuration_identity(expected)):
        raise RuntimeError('runtime_configuration_not_expected_grant')
    selected = verify_active_approval(grants[0]['admission'])
    if selected['approval_checksum'] != plan['grant_checksum']:
        raise RuntimeError('production_bundle_grant_not_switched')
    receipt.update(status='config_written_readback_verified', completed_at=datetime.now(timezone.utc).isoformat(),
        selected_grant_checksum=selected['approval_checksum'], raw_values_after={k: read(k) for k in current},
        sealed_plans_written=0, sealed_plans_checksum_before_after=digest(sealed_before),
        worker_effective_risk_config_unchanged=True, real_order_writes=0, scope='paper')
    save(out, stem + '-receipt.json', receipt)
    print(json.dumps({k: receipt[k] for k in ('status', 'from', 'to', 'snapshot_id', 'selected_grant_checksum')}))


if __name__ == '__main__':
    main()
