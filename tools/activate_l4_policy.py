"""L4 policy v2 activation for Paper; run explicitly by the release owner.

  prepare         read-only: capture raw/merged config and Worker risk defaults, start the
                  release chain with the v1 -> v2 packet (--cost-objective is required)
  prepare-change  local: append a v2 constraints change (--set key=JSON) derived from the chain end
  grant           local: derive P1..Pn from the release's S grant and validate every grant
  activate        dry-run unless --execute: move one adjacent step to --to (source|1..n);
                  forward follows the packet write order, backward its rollback order

grant and activate validate grants against the release's native Paper bundle: --admission-dir
(the new-grant admission output of tools/release/release.py) sets NATIVE_PAPER_RUNNER to its
native-paper.cjs after checking it against the admission receipt (CD-NEW-07).

Ports audits/risk-review-20261014/activate_policy.py. Optimistic rechecks
before every write and readback after it; KV has no CAS. Never rewrites a
sealed plan, dispatches a job, stages or deletes a grant, or enables Live.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
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


def use_admission_bundle(admission: Path) -> Path:
    """Point NATIVE_PAPER_RUNNER at the admission's native bundle, proven by its receipt checksum."""
    import hashlib
    receipt = load(admission / 'admission-receipt.json')
    bundle = (admission / 'native-paper.cjs').resolve()
    if receipt.get('mode') != 'new-grant' or not receipt.get('native_bundle_sha256'):
        raise SystemExit('--admission-dir must be a new-grant admission with a native bundle')
    if not bundle.is_file() or hashlib.sha256(bundle.read_bytes()).hexdigest() != receipt['native_bundle_sha256']:
        raise RuntimeError('admission_native_bundle_checksum_mismatch')
    os.environ['NATIVE_PAPER_RUNNER'] = str(bundle)
    return bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('prepare', 'prepare-change', 'grant', 'activate'))
    parser.add_argument('--workspace-root', type=Path, required=True, help='holds audits/pipeline-nightly-20261013')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--controller', type=Path, default=REPO / 'ml-controller')
    parser.add_argument('--engineering-receipt', type=Path)
    parser.add_argument('--source-reference')
    parser.add_argument('--source-grant', type=Path)
    parser.add_argument('--admission-dir', type=Path,
                        help='grant/activate: new-grant admission dir; its native-paper.cjs becomes NATIVE_PAPER_RUNNER')
    parser.add_argument('--cost-objective', choices=('single_side_v1', 'entry_round_trip_v1'))
    parser.add_argument('--set', action='append', default=[], metavar='KEY=JSON')
    parser.add_argument('--to', help='source, or the 1-based grant index to step to')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if args.command in ('grant', 'activate'):
        if not args.admission_dir:
            raise SystemExit(args.command + ' needs --admission-dir (sets NATIVE_PAPER_RUNNER to the release bundle)')
        use_admission_bundle(args.admission_dir)
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    sys.path[:0] = [str(args.workspace_root / 'audits/pipeline-nightly-20261013'), str(args.controller)]
    os.environ['CLOUDSDK_PYTHON'] = sys.executable
    from runtime_context import load_environment, kv_get, request, worker, gc
    release = load_environment()
    from services.paired_nav_journal import digest

    def read(key):
        reply = kv_get(key)
        if reply['http_status'] != 200:
            raise RuntimeError('kv_read_failed:' + key)
        return reply['body']

    if args.command in ('prepare', 'prepare-change') and (not args.engineering_receipt or not args.source_reference):
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
        effective = worker('/api/admin/risk-config')
        if effective['http_status'] != 200:
            raise RuntimeError('worker_risk_config_unavailable')
        # Worker `effective` = DEFAULT_RISK_CONFIG merged under raw; absent raw keys carry the defaults.
        packet = prepare_policy_v2_packet(raw_config=raw, merged_config=merged, risk_config=risk,
            risk_defaults=effective['body']['effective'], lookback=gnn_return_history_lookback(),
            cost_objective=args.cost_objective,
            engineering_receipt=load(args.engineering_receipt), source_reference=args.source_reference)
        if read('trading:config') != raw or read('trading:risk_config') != risk:
            raise RuntimeError('configuration_changed_during_prepare')
        packet['worker_effective_risk_config'] = effective['body']['effective']
        packet['controller_source_sha'] = release['source_sha']
        save(out, 'policy-chain.json', [packet])
        print(json.dumps({'status': 'prepared_locally', 'cloud_writes': 0, 'chain_length': 1,
                          'next_policy_identity': packet['approved_policy_identity'],
                          'cost_objective': packet['activation']['cost_objective'],
                          'risk_config_filled_fields': packet['activation']['risk_config_filled_fields']}))
        return

    chain = load(out / 'policy-chain.json')
    if args.command == 'prepare-change':
        from services.l4_release_packet import prepare_policy_change_packet
        changes = {}
        for item in args.set:
            key, sep, value = item.partition('=')
            if not sep or key in changes:
                raise SystemExit('--set needs distinct KEY=JSON items')
            changes[key] = json.loads(value)
        packet = prepare_policy_change_packet(chain[-1], changes=changes,
            engineering_receipt=load(args.engineering_receipt), source_reference=args.source_reference)
        packet['controller_source_sha'] = release['source_sha']
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
    sealed_before = paper.query('SELECT plan_id,payload_json FROM l4_portfolio_plans_v1 WHERE account_id=1 ORDER BY plan_id')
    risk_before = worker('/api/admin/risk-config')['body']['effective']
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
    sealed_after = paper.query('SELECT plan_id,payload_json FROM l4_portfolio_plans_v1 WHERE account_id=1 ORDER BY plan_id')
    if digest(sealed_before) != digest(sealed_after):
        raise RuntimeError('sealed_plans_changed_during_activation')
    if worker('/api/admin/risk-config')['body']['effective'] != risk_before:
        raise RuntimeError('worker_effective_risk_config_changed')
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
