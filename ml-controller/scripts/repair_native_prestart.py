"""Plan or explicitly apply exact immutable first-session owner replacements.

Run in the deployed controller image with its existing credentials. Default is
read-only. Never creates schemas, approvals, real orders or model artifacts.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.paired_native_prestart import (inspect_unstarted_registration,
    replace_unstarted_registration, successor_plan, succession, assert_collectible, _schema)
from services.paired_nav_journal import read_snapshot, reuse_frozen_snapshot, digest
from services.paired_nav_read_cache import reuse_verified_cold_reads
from services.native_paper_sandbox import native_execution_identity


def run(*, targets, query, writer, objects, expected_owner, apply=False, runner=None):
    actual = native_execution_identity(runner)
    if actual != expected_owner:
        raise ValueError('prestart_requested_runtime_mismatch')
    if not targets or len(targets) > 8 or len({t['snapshot_id'] for t in targets}) != len(targets):
        raise ValueError('prestart_target_set_invalid')
    reports = []
    # Validate ALL targets before the first mutation. Each receipt remains an
    # independent atomic activation; an interrupted batch resumes idempotently.
    for target in targets:
        with reuse_verified_cold_reads():
            old = read_snapshot(query, target['snapshot_id'])
            if old['manifest']['payload_checksum'] != target['payload_checksum']:
                raise ValueError('prestart_expected_payload_mismatch')
            with reuse_frozen_snapshot(old['payload']['content']['allocation_context_snapshot_id']):
                committed = succession(query, old_snapshot_id=target['snapshot_id'])
                if committed:
                    new = read_snapshot(query, committed['new_snapshot_id'])
                    assert_collectible(new, query=query)
                    if new['payload']['content']['execution_owner_version'] != actual:
                        raise ValueError('prestart_existing_owner_mismatch')
                    reports.append({'status': 'already_committed', **committed})
                    continue
                old, allocation = inspect_unstarted_registration(snapshot_id=target['snapshot_id'],
                    query=query, objects=objects)
                plan = successor_plan(old, allocation, actual)
                packet = old['payload']['content']
                reports.append({'status': 'ready_to_replace', 'old_snapshot_id': target['snapshot_id'],
                    'old_pair_id': packet['pair_id'], 'new_pair_id': plan['pair_id'],
                    'old_payload_checksum': old['manifest']['payload_checksum'],
                    'session_date': packet['session_date'], 'first_phase_at': packet['schedule'][0]['observed_at'],
                    'old_owner': packet['execution_owner_version'], 'new_owner': actual,
                    'preserved_input_checksum': digest({k:v for k,v in packet.items() if k not in
                        {'pair_id','allocation_snapshot_id','configuration','configuration_checksum','execution_owner_version'}}),
                    'initial_nav': packet['initial_account']['nav'], 'inherited_mature_sessions': 0})
    if apply:
        _schema(query)
        # The local behavior release declaration never grants runtime admission.
        from services import kv_client, active8_paper_admission as paper, active8_nav_adoption as authority
        admission = kv_client.get_json(paper.KEY, strict=True)
        approval = kv_client.get_json(paper.RUNTIME_KEY, strict=True)
        paper.validate_runtime_approval(approval, admission)
        if paper.runtime_configuration_identity(authority.current_execution_configuration()) != paper.runtime_configuration_identity(approval['configuration']):
            raise ValueError('prestart_exact_serving_approval_required')
        for target in targets:
            with reuse_verified_cold_reads():
                old = read_snapshot(query, target['snapshot_id'])
                if old['manifest']['payload_checksum'] != target['payload_checksum']:
                    raise ValueError('prestart_expected_payload_mismatch')
                with reuse_frozen_snapshot(old['payload']['content']['allocation_context_snapshot_id']):
                    replace_unstarted_registration(snapshot_id=target['snapshot_id'], new_owner=actual,
                        query=query, writer=writer, objects=objects, runner=runner)
        reports = [succession(query, old_snapshot_id=t['snapshot_id']) for t in targets]
    return {'mode': 'apply' if apply else 'plan', 'runtime_owner': actual, 'pairs': reports,
        'real_order_writes': 0, 'model_training_calls': 0, 'maturity_transfer': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--targets', required=True, type=Path, help='JSON array of snapshot_id + payload_checksum')
    parser.add_argument('--expected-owner', required=True)
    parser.add_argument('--apply', action='store_true', help='Requires explicit operator authorization')
    args = parser.parse_args()
    from services.d1_domain_client import client_proxy_for_domain
    from services.paper_corporate_source import production_objects
    learning = client_proxy_for_domain('learning')
    def forbidden(*a, **kw):
        raise RuntimeError('prestart_plan_cannot_write')
    result = run(targets=json.loads(args.targets.read_text()), query=learning.query,
        writer=learning.batch_execute if args.apply else forbidden, objects=production_objects(),
        expected_owner=args.expected_owner, apply=args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
