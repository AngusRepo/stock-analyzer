"""Original L3 publication then prospective EV evidence/publication. NOT ROI."""
from copy import deepcopy
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

import pytest

from test_nav_l3_adoption import ready, publish
from test_paired_nav_l3_candidate import prepared
from test_nav_l3_opb_handoff import environment, base_environment
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot


def mature_ev_after_l3(environment, ready, monkeypatch):
    from services import paired_nav_candidate_collection as collection, paired_nav_lifecycle as lifecycle
    from services.paired_nav_intervention import run_isolated_allocation
    from services.paired_nav_ev_selection import select_ev_candidates
    from services.paired_nav_daily_review import run_daily_nav_reviews
    from services.paired_nav_daily_candidates import refresh_registered_ev_nav_decisions
    from services.paired_nav_journal import stage_execution_receipt, mature_staged_pairs
    from test_paired_nav_journal import packet, receipt, buy, FEES
    from test_paired_nav_execution_environment import environment_packet
    db, bucket, _, original = environment
    client, _, _, config, _ = ready
    clock = datetime.fromisoformat('2026-09-22T14:00:00+00:00')
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.astimezone(tz) if tz else clock.replace(tzinfo=None)
    monkeypatch.setattr(lifecycle, 'datetime', Clock)
    monkeypatch.setattr(collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=clock))
    inputs = deepcopy(original['inputs'])
    inputs.update(alpha_policy=deepcopy(config['trading_config']['alphaFramework']),
        ranking_config=deepcopy(config['trading_config']['ranking']),
        ensemble_v2_cfg=deepcopy(config['trading_config']['ensemble_v2']))
    baseline = run_isolated_allocation(inputs=inputs, inherited_state={})
    pointer = client.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    formal = {'schema_version': 'paired-nav-formal-ml-baseline-v1', **{key: pointer[key] for key in
        ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')}}
    days = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28',
        '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']
    for index, (signal, session) in enumerate(zip(days, days[1:])):
        clock = datetime.fromisoformat(signal + 'T14:00:00+00:00')
        context = {key: deepcopy(config[key]) for key in ('trading_config', 'risk_config', 'allocator_source_identity')}
        context.update(inputs=deepcopy(inputs), formal_output=deepcopy(baseline['output']),
            capture=deepcopy(baseline['capture']), formal_baseline_identity=formal,
            model_predictions=deepcopy(original['model_predictions']),
            native_execution_environment=environment_packet(day=signal),
            ev_candidate_selection=select_ev_candidates(snapshot_id='l3-ev:' + signal, signal_date=signal, query=client.query))
        parent = freeze_snapshot(signal_date=signal, source_run_id='l3-ev:' + signal,
            snapshot_kind='allocation_context', content=context, query=client.query, writer=db.writer, now=clock)
        collected = collection.collect_candidate_allocations(snapshot_id=parent['snapshot_id'],
            query=client.query, writer=db.writer, bucket=bucket)
        assert {item['owner'] for item in collected['plans']} == {'l4_alpha_ev', 'allocator_ev_fusion'}, json.dumps(collected)
        for item in collected['plans']:
            plan = read_snapshot(client.query, item['snapshot_id'])['payload']['content']
            p = packet(session, signal if index else None)
            p.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
            p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
                schedule=[{'observed_at': session + 'T00:00:00Z'}])
            p['configuration_checksum'] = digest(p['configuration'])
            execution_environment = context['native_execution_environment']
            p.update(execution_owner_version=execution_environment['execution_owner_version'],
                account_id=execution_environment['account_id'], kv_read_policy=execution_environment['kv_read_policy'],
                source_context=execution_environment['source_context'],
                variables=execution_environment['source_context']['variables'])
            execution = freeze_snapshot(signal_date=signal, source_run_id=p['pair_id'], snapshot_kind='execution_pair',
                content=p, query=client.query, writer=db.writer, now=clock)
            end = datetime.fromisoformat(session + 'T14:00:00+00:00')
            stage_execution_receipt(execution=receipt(p, execution,
                fills=[buy(session)] if index == 0 else [], marks={'2330': 110 + index * 30}),
                query=client.query, writer=db.writer, now=end)
        lifecycle.close_changed_comparisons(plans=collected['plans'], signal_date=signal,
            query=client.query, writer=db.writer, now=clock)
        mature_staged_pairs(business_date=session, query=client.query, writer=db.writer, now=end)
    reviews = run_daily_nav_reviews(business_date=days[-1], query=client.query, writer=db.writer, now=end)
    assert not reviews['failures'], reviews
    candidates = []
    result = refresh_registered_ev_nav_decisions(business_date=days[-1], query=client.query, writer=db.writer,
        bucket_factory=lambda: bucket, now=end, adoption_candidates=candidates)
    assert not result['failures'], result
    assert len(candidates) == 2 and all(item['payload']['prospective_validation']['decision'] == 'PASS'
                                      for item in candidates), candidates
    return candidates, end


@pytest.mark.parametrize('ready', [True], indirect=True)
def test_original_l3_then_ev_publication_keeps_l3_serving(ready, environment, monkeypatch, tmp_path):
    assert publish(ready)['readback_verified']
    client = ready[0]
    original_l3 = client.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    candidates, clock = mature_ev_after_l3(environment, ready, monkeypatch)
    root = Path(__file__).parents[2]
    schema = (root / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
    for table in ('expected_return_artifact_payloads', 'expected_return_owner_state_v2', 'expected_return_forward_guard_state'):
        client.conn.executescript(re.search(r'CREATE TABLE IF NOT EXISTS ' + table + r' \([\s\S]*?\n\);', schema)[0])
    # The frozen comparison already declares this incumbent L4 in config. Give
    # it the same authoritative fixture source as the original L3->OPB test;
    # an unbacked config artifact must NOT qualify as a valid dependency wait.
    import hashlib
    incumbent = ready[4]['trading_config']['ensemble_v2']['l4AlphaEv']
    incumbent_id = 'handoff-existing-l4'
    raw = json.dumps(incumbent)
    client.insert('model_artifact_registry', {'artifact_id': incumbent_id, 'model_name': 'l4_alpha_ev',
        'version': incumbent['model_version'], 'candidate_type': 'l4_alpha_ev_refresh',
        'state': 'production', 'checksum': 'b' * 64})
    client.insert('model_champion_pointers', {'model_name': 'l4_alpha_ev',
        'champion_version': incumbent['model_version'], 'champion_artifact_id': incumbent_id})
    client.insert('expected_return_artifact_payloads', {'artifact_id': incumbent_id, 'model_name': 'l4_alpha_ev',
        'model_version': incumbent['model_version'], 'serving_mode': 'alpha', 'artifact_json': raw,
        'payload_checksum': hashlib.sha256(raw.encode()).hexdigest(), 'source_artifact_checksum': 'b' * 64})
    client.insert('expected_return_owner_state_v2', {'owner': 'l4_alpha_ev', 'owner_state': 'learned_champion',
        'champion_artifact_id': incumbent_id, 'reason_code': 'original-existing-fixture',
        'contract_manifest_version': 'fixture'})
    client.conn.commit()
    database = tmp_path / 'original-l3-ev.sqlite'
    with sqlite3.connect(database) as copy:
        client.conn.backup(copy)
    fixture = tmp_path / 'original-l3-ev.json'
    fixture.write_text(json.dumps({'database': str(database), 'current': ready[4],
        'payloads': {item['owner']: item['payload'] for item in candidates},
        'l3_pointer': original_l3, 'now': (clock + timedelta(seconds=1)).isoformat(),
        'python': sys.executable}), encoding='utf-8')
    env = {**os.environ, 'NAV_L3_EV_FIXTURE': str(fixture)}
    env.pop('NODE_TEST_CONTEXT', None)
    result = subprocess.run(['node', '--import', 'tsx', '--test', 'src/lib/navL3EvHandoff.test.ts'],
        cwd=root / 'worker', env=env, capture_output=True, text=True, encoding='utf-8', timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
