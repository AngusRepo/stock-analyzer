"""Sequential original L3 and OPB publications. Synthetic I/O, never ROI."""
from copy import deepcopy
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess

import pytest

from test_nav_l3_adoption import ready, publish
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment as base_environment
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot


@pytest.fixture
def environment(base_environment, monkeypatch):
    # Declare the actual Worker configuration BEFORE the first L3 outcome.
    import test_paired_nav_l3_candidate as source
    from services import paired_nav_collection as capture
    from test_paired_native_session import native_config
    from test_paired_nav_intervention import inputs
    from services.evidence_contracts import L4_ARTIFACT_CONTRACT_VERSION, L4_FEATURE_SEMANTIC_VERSION, LABEL_SCHEMA_VERSION
    config = native_config()
    row = inputs()['recommendations'][0]['l4_alpha_ev']
    artifact = {'expected_return_owner': 'l4_alpha_ev', 'model_version': row['model_version'],
        'trained_until': row['trained_until'], 'output_is_net_of_costs': True,
        'artifact_contract_version': L4_ARTIFACT_CONTRACT_VERSION,
        'feature_semantic_version': L4_FEATURE_SEMANTIC_VERSION, 'label_schema_version': LABEL_SCHEMA_VERSION,
        'promotion_state': 'production_approved', 'validation_packet': {'decision': 'PASS'}}
    config['trading']['ensemble_v2'].update(l4AlphaEv=artifact, l4_alpha_ev=artifact)
    config['trading']['alphaFramework']['allocation']['controller'] = 'SparseTangent'
    original = source.run_and_capture_allocation
    def configured(**kwargs):
        kwargs.update(trading_config=deepcopy(config['trading']), risk_config=deepcopy(config['risk']),
            alpha_policy=deepcopy(config['trading']['alphaFramework']),
            ranking_config=deepcopy(config['trading']['ranking']),
            ensemble_v2_cfg=deepcopy(config['trading']['ensemble_v2']))
        return original(**kwargs)
    monkeypatch.setattr(source, 'run_and_capture_allocation', configured)
    monkeypatch.setattr(capture, 'run_and_capture_allocation', configured)
    return base_environment


def mature_opb(client, configuration, monkeypatch):
    from services import paired_nav_opb_candidate as collection, paired_nav_lifecycle as lifecycle
    from services import opb_counterfactual_prior as producer
    from services.paired_nav_intervention import run_isolated_allocation
    from services.paired_nav_journal import stage_execution_receipt, mature_staged_pairs
    from services.paired_nav_daily_review import run_daily_nav_reviews
    from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
    from routers.opb_arm_prior import _registry_record
    from test_paired_nav_intervention import inputs
    from test_paired_nav_journal import packet, receipt, buy, FEES
    clock = datetime.fromisoformat('2026-09-22T14:00:00+00:00')
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.astimezone(tz) if tz else clock.replace(tzinfo=None)
    monkeypatch.setattr(producer, 'datetime', Clock)
    monkeypatch.setattr(lifecycle, 'datetime', Clock)
    prior = producer.build_opb_arm_prior_artifact(rows=[], price_rows=[],
        expected_return_owner='l4_alpha_ev', trained_until='2026-08-25')['artifact']
    record = _registry_record(prior, promoted=False, promotion_error=None)
    record['created_at'] = prior['generated_at']
    client.insert('model_artifact_registry', record)
    client.conn.commit()
    def writer(statements):
        for sql, params in statements:
            client.conn.execute(sql, params)
        client.conn.commit()
        return {'success_count': len(statements), 'error_count': 0}
    actual = inputs()
    for index, row in enumerate(actual['recommendations'], 1):
        row.update(stock_id=index, score_seed_inputs={'chipFlowSeed40': 20, 'technicalSeed30': 15,
            'screenerMomentumSeed20': 10, 'mlEdgeSeed30': 15})
    actual.update(alpha_policy=deepcopy(configuration['trading_config']['alphaFramework']),
        ranking_config=deepcopy(configuration['trading_config']['ranking']),
        ensemble_v2_cfg=deepcopy(configuration['trading_config']['ensemble_v2']))
    baseline = run_isolated_allocation(inputs=actual, inherited_state={})
    pointer = client.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    formal = {'schema_version': 'paired-nav-formal-ml-baseline-v1', **{k: pointer[k] for k in
        ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')}}
    days = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28',
        '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']
    for index, (signal, session) in enumerate(zip(days, days[1:])):
        clock = datetime.fromisoformat(signal + 'T14:00:00+00:00')
        monkeypatch.setattr(collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=clock))
        context = {k: deepcopy(configuration[k]) for k in ('trading_config', 'risk_config', 'allocator_source_identity')}
        context.update(inputs=actual, capture=baseline['capture'], formal_output=baseline['output'],
            formal_baseline_identity=formal, model_predictions={},
            opb_candidate_selection=collection.select_opb_candidates(query=client.query, signal_date=signal, now=clock))
        parent = freeze_snapshot(signal_date=signal, source_run_id='l3-opb:' + signal,
            snapshot_kind='allocation_context', content=context, query=client.query, writer=writer, now=clock)
        collected = collection.collect_opb_allocations(snapshot_id=parent['snapshot_id'], query=client.query, writer=writer)
        assert len(collected['plans']) == 1, collected
        item = collected['plans'][0]
        plan = read_snapshot(client.query, item['snapshot_id'])['payload']['content']
        execution = packet(session, signal if index else None)
        execution.update({k: plan[k] for k in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
        execution.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': session + 'T00:00:00Z'}])
        execution['configuration_checksum'] = digest(execution['configuration'])
        sealed = freeze_snapshot(signal_date=signal, source_run_id=execution['pair_id'], snapshot_kind='execution_pair',
            content=execution, query=client.query, writer=writer, now=clock)
        end = datetime.fromisoformat(session + 'T14:00:00+00:00')
        stage_execution_receipt(execution=receipt(execution, sealed,
            fills=[buy(session)] if index == 0 else [], marks={'2330': 105 + index * 5}),
            query=client.query, writer=writer, now=end)
        mature_staged_pairs(business_date=session, query=client.query, writer=writer, now=end)
    review = run_daily_nav_reviews(business_date=days[-1], query=client.query, writer=writer, now=end)
    assert not review['failures'], review
    publications = []
    refreshed = refresh_registered_opb_nav_decisions(business_date=days[-1], query=client.query, writer=writer,
        now=end, adoption_candidates=publications)
    assert not refreshed['failures'], refreshed
    assert len(publications) == 1 and publications[0]['payload']['prospective_validation']['decision'] == 'PASS'
    return publications[0]['payload'], end


@pytest.mark.parametrize('ready', [True], indirect=True)
def test_original_l3_then_opb_projection_keeps_next_day_serving(ready, monkeypatch, tmp_path):
    client, candidate, _, configuration, current = ready
    assert publish(ready)['readback_verified']
    original_receipt = client.query('SELECT promotion_evidence_json FROM active8_ensemble_pointer_v1')[0]
    payload, clock = mature_opb(client, configuration, monkeypatch)
    root = Path(__file__).parents[2]
    source = (root / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
    for table in ('expected_return_artifact_payloads', 'expected_return_owner_state_v2', 'expected_return_forward_guard_state'):
        client.conn.executescript(re.search(r'CREATE TABLE IF NOT EXISTS ' + table + r' \([\s\S]*?\n\);', source)[0])
    artifact = current['trading_config']['ensemble_v2']['l4AlphaEv']
    identity = 'handoff-existing-l4'
    raw = json.dumps(artifact)
    import hashlib
    client.insert('model_artifact_registry', {'artifact_id': identity, 'model_name': 'l4_alpha_ev',
        'version': artifact['model_version'], 'candidate_type': 'l4_alpha_ev_refresh', 'state': 'production', 'checksum': 'b' * 64})
    client.insert('model_champion_pointers', {'model_name': 'l4_alpha_ev', 'champion_version': artifact['model_version'],
        'champion_artifact_id': identity})
    client.insert('expected_return_artifact_payloads', {'artifact_id': identity, 'model_name': 'l4_alpha_ev',
        'model_version': artifact['model_version'], 'serving_mode': 'alpha', 'artifact_json': raw,
        'payload_checksum': hashlib.sha256(raw.encode()).hexdigest(), 'source_artifact_checksum': 'b' * 64})
    client.insert('expected_return_owner_state_v2', {'owner': 'l4_alpha_ev', 'owner_state': 'learned_champion',
        'champion_artifact_id': identity, 'reason_code': 'original-existing-fixture', 'contract_manifest_version': 'fixture'})
    client.conn.commit()
    database = tmp_path / 'sequential-original-nav.sqlite'
    with sqlite3.connect(database) as saved:
        client.conn.backup(saved)
    fixture = tmp_path / 'sequential-original-nav.json'
    fixture.write_text(json.dumps({'database': str(database), 'now': (clock + timedelta(seconds=1)).isoformat(),
        'payload': payload, 'current': current, 'l3_receipt': original_receipt,
        'python': str(root.parent / 'ml-service/.venv/Scripts/python.exe')}, ensure_ascii=False), encoding='utf-8')
    env = {**os.environ, 'NAV_L3_OPB_FIXTURE': str(fixture)}
    env.pop('NODE_TEST_CONTEXT', None)
    checked = subprocess.run(['node', '--import', 'tsx', '--test', 'src/lib/navL3OpbHandoff.test.ts'],
        cwd=root / 'worker', env=env, capture_output=True, text=True, encoding='utf-8', timeout=180)
    assert checked.returncode == 0, checked.stdout + checked.stderr
