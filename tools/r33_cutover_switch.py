"""R33-NEW-15: switch Paper to the R33 seven-model strategy, one go-gated step at a time.

  prepare   read-only: KV, Worker-merged config, D1 pointers, GCS bundle; writes a local packet
  activate  dry-run unless --execute: run the next step (kv-config -> admission -> grant ->
            r33-row -> promotion); --step must name it, so a step never runs out of order
  rollback  dry-run unless --execute: undo the last done step (promotion is manual, see below)

Every write re-reads the live value first and must find exactly what the previous step left;
every write is read back. Each --execute needs Wei's go for that step. The promotion step is
the original atomic publisher (7 champion pointers, 7 registry rows, 1 ensemble pointer).
Never dispatches a job, never touches Live, never writes a plan.
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
from urllib.parse import quote

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / 'ml-controller'), str(REPO / 'tools' / 'release'), str(REPO / 'tools')]
KV_ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{namespace}/values/'


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _save(path: Path, value, *, exclusive=False):
    with path.open('x' if exclusive else 'w', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def _kv_read(key):
    from services import kv_client
    return kv_client.get_json(key, default=None, strict=True)


def _kv_write(key, value):
    """PUT (or DELETE for None) then read back; KV has no CAS, so callers re-read just before."""
    from runtime_context import request
    url = KV_ENDPOINT.format(account=os.environ['CF_ACCOUNT_ID'], namespace=os.environ['CF_KV_NAMESPACE_ID'])
    result = request(url + quote(key, safe=''), method='DELETE' if value is None else 'PUT', body=value,
                     headers={'Authorization': 'Bearer ' + os.environ['CF_API_TOKEN']})
    if result['http_status'] != 200 or not result['body'].get('success'):
        raise RuntimeError('kv_write_failed:' + key)
    if _kv_read(key) != value:
        raise RuntimeError('kv_readback_failed:' + key)


def _snapshot_config(before, after, source):
    """Same Worker snapshot index format as tools/activate_l4_policy.py, so the Worker can restore it."""
    from activate_l4_policy import SNAPSHOT_HASH_JS
    at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    old_hash, new_hash = subprocess.run(['node', '-e', SNAPSHOT_HASH_JS], input=json.dumps([before, after]),
                                        capture_output=True, text=True, check=True).stdout.split()
    snapshot_id = 'trading:config:snapshot:' + at + ':' + new_hash
    meta = {'source': source, 'push_id': source, 'prev_hash': old_hash, 'new_hash': new_hash}
    snapshot = {'config': after, 'meta': meta, 'pushed_at': at}
    entries = _kv_read('trading:config:snapshot_index') or []
    _kv_write(snapshot_id, snapshot)
    _kv_write('trading:config:snapshot_index', [{'id': snapshot_id, 'pushed_at': at, 'source': source,
        'push_id': source, 'hash': new_hash, 'prev_hash': old_hash,
        'bytes': len(json.dumps(snapshot, ensure_ascii=False).encode('utf8'))}, *entries][:100])
    return snapshot_id


def _learning():
    from services.d1_domain_client import client_for_domain
    return client_for_domain('learning')


def _bucket():
    from google.cloud import storage
    return storage.Client().bucket(os.environ.get('GCS_BUCKET_NAME') or 'stockvision-models')


def _observe(packet):
    observed = {w['key']: _kv_read(w['key']) for w in packet['writes'].values()}
    learning = _learning()
    rows = learning.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?',
                          [packet['ensemble_row']['artifact_id']])
    observed['r33_row'] = rows[0] if rows else None
    pointers = learning.query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', [])
    if len(pointers) != 1:
        raise RuntimeError('ensemble_pointer_cardinality')
    observed['pointer'] = pointers[0]
    return observed


def prepare(args):
    from runtime_context import load_environment
    release = load_environment()
    from services import r33_switch
    from services.active8_paper_admission import KEY, verify_active_approval
    from services.d1_domain_client import client_for_domain
    from services.r33_crossfit_serving import TABLE_NAME, table_bytes
    from services.r33_monthly_lifecycle import BUNDLE_PREFIX, _artifact_train_label_known_max
    from services.worker_config_client import load_active_trading_config
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'packet.json').exists():
        raise SystemExit('packet.json exists; start a new --out')
    raw, old_admission = _kv_read('trading:config'), _kv_read(KEY)
    merged = load_active_trading_config()
    prior = verify_active_approval(old_admission)
    behavior = json.loads((REPO / 'ml-controller/services/native_execution_behavior_release.json').read_text())
    runtime_key = behavior['runtime_admission']
    pointers = _learning().query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', [])
    heads = client_for_domain('paper').query('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id=1', [])
    if len(pointers) != 1 or len(heads) != 1:
        raise RuntimeError('pointer_or_plan_head_cardinality')
    bucket = _bucket()
    bundle_raw = bucket.blob(args.bundle_path).download_as_bytes()
    bundle = json.loads(bundle_raw)
    labels = {}
    for name, item in sorted(bundle['artifacts'].items()):
        labels[name] = _artifact_train_label_known_max(json.loads(bucket.blob(item['metadata_path']).download_as_text()))
    if not all(labels.values()) or max(labels.values()) > bundle['knowledge_cutoff_date']:
        raise RuntimeError('r33_artifact_label_attestation_invalid:' + json.dumps(labels))
    serving_table = json.loads(args.serving_table.read_bytes())
    stored = bucket.blob(f"{BUNDLE_PREFIX}/{bundle['cohort_id']}/{TABLE_NAME}")
    if stored.exists() and stored.download_as_bytes() != table_bytes(serving_table):
        raise RuntimeError('stored_serving_table_differs')
    adaptive = _kv_read('ml:adaptive_params') or {}
    packet = r33_switch.prepare(
        raw_config=raw, merged_config=merged, prior=prior, old_admission=old_admission, pointer=pointers[0],
        current_plan_id=heads[0]['plan_id'], bundle=bundle, bundle_path=args.bundle_path,
        bundle_sha256=hashlib.sha256(bundle_raw).hexdigest(), serving_table=serving_table,
        training_label_known_max=max(labels.values()), source_evidence=json.loads(args.source_evidence.read_text()),
        exit_rules={'swingHardStopPct': args.swing_hard_stop_pct, 'swingMaxHoldSessions': args.swing_max_hold_sessions},
        business_date=args.business_date, effective_signal_date=args.effective_signal_date,
        wei_approval=json.loads(args.wei_approval.read_text()), source_reference=args.source_reference,
        approved_at=_now(), runtime_key=runtime_key, runtime_before=_kv_read(runtime_key),
        archive_uri=f'gs://{bucket.name}/{args.bundle_path}', meta_layer=adaptive.get('meta_layer'),
        now=datetime.now(timezone.utc))
    if _kv_read('trading:config') != raw or _kv_read(KEY) != old_admission:
        raise RuntimeError('configuration_changed_during_prepare')
    packet['controller_source_sha'] = release['source_sha']
    packet['serving_table_stored'] = stored.exists()
    _save(out / 'packet.json', packet, exclusive=True)
    print(json.dumps({'status': 'prepared_locally', 'cloud_writes': 0, 'packet_checksum': packet['packet_checksum'],
                      'ensemble_artifact_id': packet['ensemble']['artifact_id'],
                      'economics_change_scope': packet['approval']['approved_r33_cutover']['economics_change_scope'],
                      'roster': packet['roster'], 'steps': list(r33_switch.STEPS)}))


def _execute(step, packet, observed):
    """One step's write and readback. Returns the receipt fields."""
    from services import r33_switch
    from services.active8_paper_admission import verify_active_approval
    if step in packet['writes']:
        write = packet['writes'][step]
        receipt = {}
        if _kv_read(write['key']) != write['before']:
            raise RuntimeError('live_value_changed_before_write:' + write['key'])
        if step == 'kv-config':
            receipt['snapshot_id'] = _snapshot_config(write['before'], write['after'],
                                                      'r33_cutover_' + packet['packet_checksum'][:16])
        _kv_write(write['key'], write['after'])
        if step == 'kv-config':
            from services.paired_nav_journal import digest
            from services.worker_config_client import load_active_trading_config
            if digest(load_active_trading_config()) != digest(packet['approval']['configuration']['trading_config']):
                raise RuntimeError('worker_merged_config_not_the_granted_config')
            receipt['e7_followup'] = packet['e7_followup']
        if step == 'grant':
            from services.paired_nav_journal import digest
            if digest(verify_active_approval(packet['admission'])) != digest(packet['approval']):
                raise RuntimeError('active_grant_not_the_cutover_grant')
        return receipt
    if step == 'r33-row':
        from services.r33_crossfit_serving import table_bytes
        path = packet['approval']['approved_r33_cutover']['calibration']['serving_table_path']
        blob, body = _bucket().blob(path), table_bytes(packet['serving_table'])
        from google.api_core.exceptions import PreconditionFailed
        try:
            blob.upload_from_string(body, content_type='application/json', if_generation_match=0)
        except PreconditionFailed:
            pass
        if blob.download_as_bytes() != body:
            raise RuntimeError('stored_serving_table_differs')
        row = packet['ensemble_row']
        columns = list(row)
        _learning().execute(
            f"INSERT INTO active8_ensemble_artifacts_v1 ({','.join(columns)},state,production_effect) "
            f"VALUES ({','.join('?' for _ in columns)},'candidate',0) ON CONFLICT(artifact_id) DO NOTHING",
            [row[c] for c in columns])
        if r33_switch.step_states(packet, _observe(packet))['r33-row'] != 'done':
            raise RuntimeError('r33_row_readback_mismatch')
        return {'serving_table_path': path}
    if step == 'promotion':
        return _promote(packet, confirm=True)
    raise RuntimeError('unknown_step:' + step)


def _promote(packet, *, confirm):
    from services.model_artifact_registry import (list_champion_pointers,
                                                  run_active8_ensemble_bundle_promotion_controller)
    row = packet['ensemble_row']
    registry = _learning().query("SELECT * FROM model_artifact_registry WHERE training_run_id=? "
                                 "AND candidate_type='oof_full_fit_release'", [row['training_run_id']])
    result = run_active8_ensemble_bundle_promotion_controller(
        training_run_id=row['training_run_id'], registry_rows=registry, d1_pointers=list_champion_pointers(),
        ensemble_artifact_id=row['artifact_id'], ensemble_payload_checksum=row['payload_checksum'],
        evaluation_business_date=packet['admission']['business_date'], paper_admission=packet['admission'],
        confirm=confirm, reason='r33_cutover')
    result.pop('artifacts', None)
    from services import r33_switch
    result['roster'] = r33_switch.roster_status((_kv_read('ml:adaptive_params') or {}).get('meta_layer'))
    if confirm and result.get('status') != 'ok':
        raise RuntimeError('promotion_not_committed:' + str(result.get('decision')))
    return result


def activate(args, *, undo):
    from runtime_context import load_environment
    release = load_environment()
    from services import r33_switch
    out = args.out.resolve()
    packet = json.loads((out / 'packet.json').read_text())
    from services.paired_nav_journal import digest
    if digest({k: v for k, v in packet.items() if k not in ('packet_checksum', 'controller_source_sha',
                                                             'serving_table_stored')}) != packet['packet_checksum']:
        raise RuntimeError('packet_checksum_mismatch')
    observed = _observe(packet)
    step, states = (r33_switch.rollback_step if undo else r33_switch.next_step)(packet, observed)
    if step != args.step:
        raise SystemExit(f'--step {args.step} is not the {"last done" if undo else "next"} step ({step}); states={states}')
    if not undo and step == 'kv-config':
        # The grant being replaced must be the one KV serves now, for the live config and pointer.
        from services.active8_paper_admission import verify_active_approval
        from services.worker_config_client import load_active_trading_config
        old = packet['writes']['admission']['before']
        r33_switch.check_prior(packet['approval']['prior_runtime_approval'], live_prior=verify_active_approval(old),
                               merged_config=load_active_trading_config(), admission=old,
                               pointer=observed['pointer'])
    if undo and step == 'promotion':
        raise SystemExit('promotion rollback is the atomic publisher run for the prior ensemble under its own '
                         'admission (Wei go); this tool does not republish an older pointer.')
    plan = {'mode': 'execute' if args.execute else 'dry_run', 'action': 'rollback' if undo else 'activate',
            'step': step, 'states': states, 'controller_source': release['source_sha'],
            'packet_checksum': packet['packet_checksum']}
    if step in packet['writes']:
        write = packet['writes'][step]
        before, after = (write['after'], write['before']) if undo else (write['before'], write['after'])
        plan['write'] = {'key': write['key'], 'from_checksum': digest(before), 'to_checksum': digest(after)}
    elif step == 'r33-row':
        plan['write'] = {'table': 'active8_ensemble_artifacts_v1', 'artifact_id': packet['ensemble_row']['artifact_id'],
                         'action': 'delete_candidate' if undo else 'insert_candidate'}
    stem = f"{'rollback' if undo else 'activate'}-{step}"
    if not args.execute:
        if step == 'promotion':
            plan['publisher_dry_run'] = _promote(packet, confirm=False)
        _save(out / (stem + '-dry-run.json'), plan)
        print(json.dumps(plan, default=str))
        return
    receipt = {**plan, 'started_at': _now(), 'status': 'writing'}
    # A step can run again after its rollback; each run keeps its own receipt.
    receipt_path = out / f"{stem}-{len(list(out.glob(stem + '-*-receipt.json'))) + 1:02d}-receipt.json"
    _save(receipt_path, receipt, exclusive=True)
    if not undo:
        receipt.update(_execute(step, packet, observed))
    elif step in packet['writes']:
        write = packet['writes'][step]
        if _kv_read(write['key']) != write['after']:
            raise RuntimeError('live_value_changed_before_rollback:' + write['key'])
        if step == 'kv-config':
            receipt['snapshot_id'] = _snapshot_config(write['after'], write['before'],
                                                      'r33_cutover_rollback_' + packet['packet_checksum'][:16])
        _kv_write(write['key'], write['before'])
    else:
        _learning().execute("DELETE FROM active8_ensemble_artifacts_v1 WHERE artifact_id=? AND state='candidate' "
                            "AND production_effect=0", [packet['ensemble_row']['artifact_id']])
        if _observe(packet)['r33_row'] is not None:
            raise RuntimeError('r33_row_not_removed')
    receipt.update(status='written_readback_verified', completed_at=_now())
    _save(receipt_path, receipt)
    print(json.dumps({k: receipt[k] for k in ('status', 'action', 'step')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=('prepare', 'activate', 'rollback'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--step', help='activate/rollback: the step to run (must be the next / last done one)')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--bundle-path', help='r33/monthly_candidates/<cohort>/bundle.json')
    parser.add_argument('--serving-table', type=Path, help='local output of r33_crossfit_serving --out')
    parser.add_argument('--source-evidence', type=Path, help='engineering evidence JSON (evidence_files checksums)')
    parser.add_argument('--wei-approval', type=Path, help='{approved, scope, approved_at, source_reference}')
    parser.add_argument('--source-reference')
    parser.add_argument('--business-date')
    parser.add_argument('--effective-signal-date')
    # No defaults: these are trading:config.exit values whose owner is KV (NEW-H1d).
    parser.add_argument('--swing-hard-stop-pct', type=float)
    parser.add_argument('--swing-max-hold-sessions', type=int)
    args = parser.parse_args()
    if args.command == 'prepare':
        needed = ('bundle_path', 'serving_table', 'source_evidence', 'wei_approval', 'source_reference',
                  'business_date', 'effective_signal_date', 'swing_hard_stop_pct', 'swing_max_hold_sessions')
        missing = [n for n in needed if getattr(args, n) is None]
        if missing:
            raise SystemExit('prepare needs --' + ', --'.join(m.replace('_', '-') for m in missing))
        prepare(args)
    else:
        if not args.step:
            raise SystemExit(args.command + ' needs --step')
        activate(args, undo=args.command == 'rollback')


if __name__ == '__main__':
    main()
