"""Original OPB registry + NAV + durable daily job. Synthetic, not investment ROI."""
import json
from types import SimpleNamespace

import pytest

import oof_materialize_job_main as job
from services.paired_nav_journal import digest
from test_paired_nav_opb_candidate import environment, seal, collect, NOW, reject_observer_io


def run(db, **kwargs):
    from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
    return refresh_registered_opb_nav_decisions(business_date='2026-09-07',
        query=db.query, writer=db.writer, now=NOW, **kwargs)


def test_offline_fail_gets_original_pending_gate_without_budget_or_lifecycle_change(environment):
    db, artifact, content = environment
    collect(db, seal(db, content))
    before = db.query('SELECT * FROM model_artifact_registry', [])[0]
    publications = []
    result = run(db, adoption_candidates=publications)
    assert result['evaluated_count'] == result['candidate_count'] == 1
    assert not result['failures']
    after = db.query('SELECT * FROM model_artifact_registry', [])[0]
    gate = json.loads(after['live_evidence_json'])
    assert gate['decision'] == gate['nav_validation']['decision'] == 'PENDING'
    assert gate['offline_diagnostic']['decision'] == 'FAIL'
    assert gate['offline_diagnostic']['role'] == 'diagnostic_only'
    assert gate['evaluable_date_count'] == 0 and gate['minimum_evaluable_dates'] == 10
    assert after['state'] == before['state'] == 'offline_failed'
    assert after['offline_evidence_json'] == before['offline_evidence_json']
    assert gate['evaluation_evidence_checksum'] == gate['nav_validation']['decision_checksum']
    assert gate['training_dispatched'] is False
    assert publications[0]['payload']['artifact_checksum'] == digest(artifact)
    assert publications[0]['payload']['prospective_validation'] == gate
    assert not db.query("SELECT * FROM paired_nav_review_records_v1 WHERE record_kind='reservation'", [])
    assert run(db) == result


@pytest.mark.parametrize('state', ['production', 'archived', 'rejected'])
def test_frozen_candidate_still_audited_without_resurrecting_lifecycle(environment, state):
    db, _, content = environment
    collect(db, seal(db, content))
    db.conn.execute('UPDATE model_artifact_registry SET state=?,live_gate_status=?,promotion_decision=?',
        (state, 'existing-lifecycle', 'original-policy'))
    assert run(db)['evaluated_count'] == 1
    row = db.query('SELECT * FROM model_artifact_registry', [])[0]
    assert row['state'] == state
    assert row['live_gate_status'] == 'existing-lifecycle'
    assert row['promotion_decision'] == 'original-policy'


@pytest.mark.parametrize('fault', ['missing', 'corrupt', 'future_projection', 'metadata'])
def test_missing_or_changed_frozen_source_is_failure_not_zero_candidates(environment, fault):
    db, _, content = environment
    collect(db, seal(db, content))
    if fault == 'missing':
        db.conn.execute('DELETE FROM model_artifact_registry')
    elif fault == 'corrupt':
        db.conn.execute("UPDATE model_artifact_registry SET offline_evidence_json='{}'")
    elif fault == 'metadata':
        db.conn.execute("UPDATE model_artifact_registry SET training_run_id='changed'")
    else:
        db.conn.execute('UPDATE model_artifact_registry SET live_evidence_json=?',
            (json.dumps({'nav_validation': {'as_of_date': '2026-09-08'}}),))
    result = run(db)
    assert result['candidate_count'] == result['failure_count'] == 1
    assert result['evaluated_count'] == 0


def test_cas_rejects_concurrent_metadata_change_even_when_old_gate_already_matches(environment):
    db, _, content = environment
    collect(db, seal(db, content))
    run(db)
    original = db.writer
    def raced(statements):
        db.conn.execute("UPDATE model_artifact_registry SET offline_evidence_json='{}'")
        return original(statements)
    from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
    result = refresh_registered_opb_nav_decisions(business_date='2026-09-07',
        query=db.query, writer=raced, now=NOW)
    assert result['failure_count'] == 1 and result['evaluated_count'] == 0


def test_actual_daily_entry_materializes_opb_gate_without_bucket_or_publication(environment, monkeypatch):
    from services import d1_domain_client, walk_forward_retrain, worker_config_client
    db, _, content = environment
    collect(db, seal(db, content))
    monkeypatch.setattr(d1_domain_client, 'client_for_domain',
        lambda _domain: SimpleNamespace(query=db.query, batch_execute=db.writer, atomic_batch_execute=db.writer))
    def forbidden(*_a, **_kw):
        pytest.fail('OPB primary NAV must not require GCS, training or publication')
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', forbidden)
    monkeypatch.setattr(worker_config_client, 'worker_fetch', forbidden)
    result = job._execute_daily_nav(end_date='2026-09-07', now=NOW)
    assert result['status'] != 'failed', result
    assert result['opb_candidate_decisions']['evaluated_count'] == 1
    assert job._nav_callback_summary(result)['opb_candidate_decisions'] == result['opb_candidate_decisions']
    assert json.loads(db.query('SELECT live_evidence_json FROM model_artifact_registry', [])[0][
        'live_evidence_json'])['decision'] == 'PENDING'


def test_empty_legacy_inventory_does_not_query_current_registry(environment):
    db, _, content = environment
    content.pop('opb_candidate_selection')
    seal(db, content)
    original = db.query
    def query(sql, params):
        assert 'model_artifact_registry' not in sql
        return original(sql, params)
    from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
    result = refresh_registered_opb_nav_decisions(business_date='2026-09-07',
        query=query, writer=lambda _: pytest.fail('empty inventory must not write'), now=NOW)
    assert result['candidate_count'] == result['evaluated_count'] == 0
    assert not result['failures']


def test_original_candidate_refresh_cannot_erase_daily_nav_projection(environment, monkeypatch):
    import asyncio
    from routers import opb_arm_prior as route
    db, artifact, content = environment
    collect(db, seal(db, content))
    run(db)
    before = db.query('SELECT * FROM model_artifact_registry', [])[0]
    monkeypatch.setattr(route.artifact_registry_d1, 'query', db.query)
    monkeypatch.setattr(route.artifact_registry_d1, 'execute', lambda sql, params: db.writer([(sql, params)]))
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', lambda **_kw: ([], []))
    def forbidden(*_a, **_kw):
        pytest.fail('refresh observation cannot publish')
    from services import worker_config_client
    monkeypatch.setattr(worker_config_client, 'worker_fetch', forbidden)
    request = route.OpbArmPriorRefreshReq(end_date='2026-08-25',
        expected_return_owner='l4_alpha_ev', dry_run=True, promote=False)
    refreshed = asyncio.run(route.refresh_opb_arm_prior(request))
    assert refreshed['artifact'] == artifact
    assert refreshed['registry_verified'] and not refreshed['promoted']
    assert db.query('SELECT * FROM model_artifact_registry', [])[0] == before


def test_original_ten_session_opb_nav_reaches_worker_verifier(environment, monkeypatch, tmp_path):
    """Costed synthetic fills validate wiring, NEVER historical ROI or approval."""
    from copy import deepcopy
    from datetime import datetime
    from pathlib import Path
    import os
    import subprocess
    from services import paired_nav_opb_candidate as collection, paired_nav_lifecycle as lifecycle
    from services.paired_nav_journal import freeze_snapshot, read_snapshot, stage_execution_receipt, mature_staged_pairs
    from services.paired_nav_daily_review import run_daily_nav_reviews, POLICY
    from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
    from test_paired_nav_journal import packet, receipt, buy, FEES
    db, artifact, content = environment
    # Use the actual Worker config owner for the authenticated publication path.
    # The ten ledger sessions remain synthetic, not an investment return test.
    from test_paired_native_session import native_config
    from services.evidence_contracts import (
        L4_ARTIFACT_CONTRACT_VERSION, L4_FEATURE_SEMANTIC_VERSION, LABEL_SCHEMA_VERSION,
    )
    config = native_config()
    assert config['trading']['fees'] == FEES
    ev = content['capture']['allocation_candidates'][0]
    ev_artifact = {
        'expected_return_owner': 'l4_alpha_ev', 'model_version': ev['expected_return_model_version'],
        'trained_until': ev['expected_return_trained_until'], 'output_is_net_of_costs': True,
        'artifact_contract_version': L4_ARTIFACT_CONTRACT_VERSION,
        'feature_semantic_version': L4_FEATURE_SEMANTIC_VERSION, 'label_schema_version': LABEL_SCHEMA_VERSION,
        'promotion_state': 'production_approved', 'validation_packet': {'decision': 'PASS'},
    }
    config['trading']['ensemble_v2'].update(l4AlphaEv=ev_artifact, l4_alpha_ev=ev_artifact)
    config['trading']['alphaFramework']['allocation']['controller'] = 'SparseTangent'
    content['trading_config'], content['risk_config'] = config['trading'], config['risk']
    content['inputs']['alpha_policy'] = deepcopy(config['trading']['alphaFramework'])
    content['inputs']['ranking_config'] = deepcopy(config['trading']['ranking'])
    content['inputs']['ensemble_v2_cfg'] = deepcopy(config['trading']['ensemble_v2'])
    from services.paired_nav_intervention import run_isolated_allocation
    baseline = run_isolated_allocation(inputs=content['inputs'], inherited_state={})
    content['capture'], content['formal_output'] = baseline['capture'], baseline['output']
    dates = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
        '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21']
    def clock(day):
        return datetime.fromisoformat(day + 'T14:00:00+00:00')
    current = NOW
    class SessionClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return current.astimezone(tz) if tz else current.replace(tzinfo=None)
    monkeypatch.setattr(lifecycle, 'datetime', SessionClock)
    for index, (signal, session) in enumerate(zip(dates, dates[1:])):
        current = clock(signal)
        context = deepcopy(content)
        context['opb_candidate_selection'] = collection.select_opb_candidates(
            query=db.query, signal_date=signal, now=current)
        parent = freeze_snapshot(signal_date=signal, source_run_id='opb-ten:' + signal,
            snapshot_kind='allocation_context', content=context, query=db.query, writer=db.writer, now=current)
        monkeypatch.setattr(collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=current))
        plans = collect(db, parent)
        assert len(plans['plans']) == 1, plans
        item = plans['plans'][0]
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        execution = packet(session, signal if index else None)
        execution.update({k: plan[k] for k in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
        execution.update(allocation_snapshot_id=item['snapshot_id'],
            configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': session + 'T00:00:00Z'}])
        execution['configuration_checksum'] = digest(execution['configuration'])
        sealed = freeze_snapshot(signal_date=signal, source_run_id=execution['pair_id'],
            snapshot_kind='execution_pair', content=execution, query=db.query, writer=db.writer, now=current)
        stage_execution_receipt(execution=receipt(execution, sealed,
            fills=[buy(session)] if index == 0 else [], marks={'2330': 105 + index * 5}),
            query=db.query, writer=db.writer, now=clock(session))
        mature_staged_pairs(business_date=session, query=db.query, writer=db.writer, now=clock(session))
    day = dates[-1]
    reviewed = run_daily_nav_reviews(business_date=day, query=db.query, writer=db.writer, now=clock(day))
    assert reviewed['failures'] == []
    publications = []
    result = refresh_registered_opb_nav_decisions(business_date=day, query=db.query, writer=db.writer,
        now=clock(day), adoption_candidates=publications)
    assert result['evaluated_count'] == 1 and not result['failures']
    p = publications[0]['payload']
    gate = p['prospective_validation']
    assert gate['decision'] == 'PASS', gate
    assert gate['evaluable_date_count'] == POLICY.minimum_sessions == 10
    assert gate['offline_diagnostic']['decision'] == 'FAIL'
    assert gate['nav_validation']['universal_profit_guarantee'] is False
    assert db.query('SELECT state FROM model_artifact_registry', [])[0]['state'] == 'offline_failed'
    tables = ['model_artifact_registry', 'paired_nav_review_records_v1', 'paired_nav_review_parts_v1',
        'paired_nav_frozen_manifests_v1', 'paired_nav_frozen_parts_v1', 'paired_nav_daily_journal_v1']
    before = {table: db.query(f'SELECT * FROM {table} ORDER BY 1', []) for table in tables}
    fixture = tmp_path / 'original-opb-nav.json'
    fixture.write_text(json.dumps({'now': clock(day).isoformat(), 'payload': p, 'tables': before,
        'schemas': {table: db.query('SELECT sql FROM sqlite_master WHERE name=?', [table])[0]['sql']
            for table in tables}}, ensure_ascii=False), encoding='utf-8')
    child_env = {**os.environ, 'NAV_OPB_ORIGINAL_FIXTURE': str(fixture)}
    child_env.pop('NODE_TEST_CONTEXT', None)
    checked = subprocess.run(['node', '--import', 'tsx', '--test', 'src/lib/opbNavOriginalEvidence.test.ts'],
        cwd=Path(__file__).parents[2] / 'worker', env=child_env,
        capture_output=True, text=True, timeout=90, encoding='utf-8')
    assert checked.returncode == 0, checked.stdout + checked.stderr
    from test_opb_nav_control import exercise_original_publication
    activation_fixture = exercise_original_publication(Path(str(fixture) + '.control.json'), content['inputs'], monkeypatch)
    activation_env = {**child_env, 'NAV_OPB_CONTROL_FIXTURE': str(activation_fixture)}
    activated = subprocess.run(['node', '--import', 'tsx', '--test', 'src/lib/opbNavActivationEvidence.test.ts'],
        cwd=Path(__file__).parents[2] / 'worker', env=activation_env,
        capture_output=True, text=True, timeout=90, encoding='utf-8')
    assert activated.returncode == 0, activated.stdout + activated.stderr
    # Feed actual Hono responses into the original daily Controller transport.
    # No fabricated successful publication/control response can hide the gap.
    import asyncio
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    # Real read-only Hono observation: stop retrying this OLD comparison, while
    # retaining the original NAV and no publication/control success claim.
    waits = json.loads(Path(str(fixture) + '.comparison-waits.json').read_text(encoding='utf-8'))
    assert len(waits) == 2
    for observed in waits:
        response = deepcopy(observed)
        async def fetch_wait(path, **kw):
            assert path == '/api/admin/config/opb/promote' and kw['json_body'] == p
            return response
        monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch_wait)
        adopted = asyncio.run(run_daily_ev_adoption(candidates=publications, business_date=day))
        assert adopted['status'] == 'completed', adopted
        assert adopted['opb']['complete'] is False and adopted['opb']['pointer_committed'] is False
        assert adopted['waiting'][0]['state'] == 'baseline_changed'
        from oof_materialize_job_main import _summary
        summary = _summary('local-fixture', {'paired_nav_maturity': {'adoption': adopted}}, mode='oof_lifecycle')
        assert 'nav_committed=none' in summary and 'nav_waiting=opb_arm_prior:baseline_changed' in summary
        for fault in ('hash', 'decision', 'source', 'publication', 'empty_change'):
            response = deepcopy(observed)
            comparison = response['comparison']
            if fault == 'hash': comparison['observation_checksum'] = 'f' * 64
            elif fault == 'decision': comparison['decision_checksum'] = 'f' * 64
            elif fault == 'source': comparison['current_context_checksum'] = ''
            elif fault == 'publication': response['pointer_committed'] = True
            else: comparison['changed_fields'] = []
            if fault != 'hash':
                comparison['observation_checksum'] = digest({k: v for k, v in comparison.items() if k != 'observation_checksum'})
            assert asyncio.run(run_daily_ev_adoption(candidates=publications, business_date=day))['status'] == 'incomplete'
    retired_response = json.loads(Path(str(fixture) + '.retirement.json').read_text(encoding='utf-8'))
    async def fetch_retired(path, **kw):
        assert path == '/api/admin/config/opb/promote'
        return retired_response
    monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch_retired)
    retired = asyncio.run(run_daily_ev_adoption(candidates=publications, business_date=day))
    assert retired['status'] == 'completed', retired
    assert retired['opb']['completion_scope'] == 'retirement'
    assert retired['opb']['pointer_committed'] is False
    summary = _summary('local-retirement', {'paired_nav_maturity': {'adoption': retired}}, mode='oof_lifecycle')
    assert 'nav_committed=none' in summary and 'nav_retired=opb_arm_prior' in summary
    retired_response['retirement']['retirement_checksum'] = '0' * 64
    assert asyncio.run(run_daily_ev_adoption(candidates=publications, business_date=day))['status'] == 'incomplete'
    for response in json.loads(Path(str(fixture) + '.responses.json').read_text(encoding='utf-8')):
        async def fetch(path, **kw):
            assert path == '/api/admin/config/opb/promote'
            assert kw['json_body'] == p
            return response
        monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
        adopted = asyncio.run(run_daily_ev_adoption(candidates=publications, business_date=day))
        assert adopted['status'] == ('completed' if response.get('success') else 'incomplete'), adopted
        if response.get('success'):
            assert adopted['opb']['control']['status'] == 'awaiting_next_allocation'
            assert adopted['opb']['completion_scope'] == 'publication'
        else:
            assert adopted['reason'] == 'nav_opb_adoption_incomplete'
        assert adopted['opb']['pointer_committed'] is True
        assert adopted['opb']['control_activation_verified'] is False
    for table in tables:
        assert db.query(f'SELECT * FROM {table} ORDER BY 1', []) == before[table]
    for response in json.loads(Path(str(activation_fixture) + '.responses.json').read_text(encoding='utf-8')):
        async def fetch_activation(path, **kw):
            assert path == '/api/admin/config/opb/promote'
            return response
        monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch_activation)
        adopted = asyncio.run(run_daily_ev_adoption(candidates=publications, business_date=day))
        state = response['control']['status']
        assert adopted['status'] == ('incomplete' if state == 'failed' else 'completed'), adopted
        assert adopted['opb']['control_activation_verified'] is (state == 'completed')
    # Original daily materializer, dispatcher and durable job callback. Only the
    # unrelated OOF branch and HTTP transport are isolated; NAV is not stubbed.
    from services import d1_domain_client
    original_daily = job._execute_daily_nav
    callbacks = []
    root_env = {**child_env, 'NAV_ROOT_TEST_DAY': day}
    def root(mode, *args):
        result = subprocess.run(['node', '--import', 'tsx', 'tests/navCallbackRootProjection.ts',
            str(tmp_path / 'retirement-root'), mode, *args],
            cwd=Path(__file__).parents[2] / 'worker', env=root_env,
            capture_output=True, text=True, timeout=90, encoding='utf-8')
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout
    root_identity, = [json.loads(line.removeprefix('NAV_ROOT_IDENTITY='))
        for line in root('prepare').splitlines() if line.startswith('NAV_ROOT_IDENTITY=')]
    with monkeypatch.context() as scoped:
        scoped.setattr(d1_domain_client, 'client_for_domain', lambda _domain:
            SimpleNamespace(query=db.query, batch_execute=db.writer, atomic_batch_execute=db.writer))
        scoped.setattr(job, '_execute_daily_nav', lambda **kw: original_daily(**kw, now=clock(day)))
        async def offline(**kwargs):
            assert kwargs['promote'] is False
            return {'status': 'idempotent_complete', 'cohort_id': 'fixture-opb', 'calendar': {'mature_max_date': '2026-09-14'},
                'physical_prediction_coverage': {'max_date': '2026-09-14'}}
        async def callback(payload):
            callbacks.append(payload)
        scoped.setattr(job, '_execute_oof_lifecycle', offline)
        scoped.setattr(job, '_callback_worker', callback)
        for key, value in {'MODE': 'oof_lifecycle', 'CADENCE': 'daily', 'END_DATE': day,
            'PROMOTE': '1', 'DISPATCH_FULL_FIT': '0', 'CONTINUATION_ATTEMPT': '0',
            'CONTINUATION_ONLY': '0', 'SCHEDULER_TICKET_ID': root_identity['ticket_id'],
            'SCHEDULER_RUN_ID': root_identity['run_id'], 'RUN_ID': root_identity['callback_run_id'],
            'CALLBACK_TASK': 'active8-oof-daily'}.items():
            scoped.setenv('OOF_MATERIALIZE_' + key, value)
        for kind, broken in [('wait', False), ('wait', True), ('retirement', False), ('retirement', True)]:
            response = (deepcopy(waits[0]) if kind == 'wait' else
                json.loads(Path(str(fixture) + '.retirement.json').read_text(encoding='utf-8')))
            if broken:
                if kind == 'wait': response['comparison']['observation_checksum'] = 'f' * 64
                else: response['retirement']['retirement_checksum'] = 'f' * 64
            async def original_wait(path, **kw):
                assert path == '/api/admin/config/opb/promote'
                assert kw['json_body']['artifact_checksum'] == p['artifact_checksum']
                return response
            scoped.setattr(worker_config_client, 'worker_fetch', original_wait)
            assert asyncio.run(job._run()) == 0
            final = callbacks[-1]
            assert final['status'] == ('triggered' if broken else 'success'), final
            assert final['metadata']['nav_retry_required'] is broken
            if not broken:
                assert 'nav_committed=none' in final['summary']
                assert ('nav_waiting=opb_arm_prior:baseline_changed' if kind == 'wait'
                    else 'nav_retired=opb_arm_prior') in final['summary']
            assert final['metadata']['paired_nav_maturity']['opb_candidate_decisions']['decisions'][0]['decision'] == 'PASS'

        # One continuous original sequence: invalid retirement response -> job
        # retry callback -> original controller dispatch -> job recovery/replay
        # -> actual Worker queue consumer, readiness and durable root receipt.
        from routers import walk_forward
        from services import cloud_run_jobs_client, walk_forward_retrain
        root_callbacks, dispatches = [], []
        class PrivateCloudJob:
            def __init__(self, **kw):
                pass
            def run_job(self, *, env_overrides):
                dispatches.append(dict(env_overrides))
                return SimpleNamespace(execution_id='isolated-opb-retirement', execution_name='isolated-opb-retirement')
        for attempt in range(3):
            if attempt == 1:
                continuation_request = {'cadence': 'daily', 'end_date': day, 'dry_run': False,
                    'promote': True, 'dispatch_full_fit': True,
                    'expected_cohort_id': root_callbacks[0]['metadata']['cohort_id'],
                    'continuation_attempt': 1, 'continuation_only': True,
                    'scheduler_ticket_id': root_identity['ticket_id'], 'scheduler_run_id': root_identity['run_id']}
                with scoped.context() as dispatch_scope:
                    dispatch_scope.setattr(cloud_run_jobs_client, 'CloudRunJobsClient', PrivateCloudJob)
                    dispatch_scope.setattr(walk_forward_retrain, '_get_bucket', lambda: object())
                    dispatch_scope.delenv('OOF_MATERIALIZE_JOB_EXECUTION', raising=False)
                    continuation_dispatch = asyncio.run(walk_forward.run_walk_forward_oof_lifecycle(
                        walk_forward.OofLifecycleRequest(**continuation_request)))
                assert continuation_dispatch['status'] == 'spawned'
                assert dispatches[-1]['OOF_MATERIALIZE_RUN_ID'] == root_identity['callback_run_id']
                for key, value in dispatches[-1].items():
                    scoped.setenv(key, value)
            response = json.loads(Path(str(fixture) + '.retirement.json').read_text(encoding='utf-8'))
            if attempt == 0:
                response['retirement']['retirement_checksum'] = 'f' * 64
            async def root_retirement(path, **kw):
                assert path == '/api/admin/config/opb/promote'
                assert kw['json_body']['artifact_checksum'] == p['artifact_checksum']
                return response
            scoped.setattr(worker_config_client, 'worker_fetch', root_retirement)
            assert asyncio.run(job._run()) == 0
            root_callbacks.append(deepcopy(callbacks[-1]))
            assert root_callbacks[-1]['status'] == ('triggered' if attempt == 0 else 'success')
        root_input = tmp_path / 'retirement-root-callbacks.json'
        root_input.write_text(json.dumps({'identity': root_identity, 'callbacks': root_callbacks,
            'continuation_request': continuation_request, 'continuation_dispatch': continuation_dispatch,
            'retirement_state': json.loads(Path(str(fixture) + '.retirement-state.json').read_text(encoding='utf-8'))}), encoding='utf-8')
        root_result, = [json.loads(line.removeprefix('NAV_ROOT_RESULT='))
            for line in root('verify', str(root_input)).splitlines() if line.startswith('NAV_ROOT_RESULT=')]
        assert root_result['child_status'] == root_result['root_status'] == 'success'
        assert root_result['dispatch_calls'] == 1 and root_result['queue_count'] == 5
        assert root_result['production_effect'] is False

    # Next original capture actually starts the new contrast. Keep all ten OLD
    # observations; do not copy them into the new baseline or wait forever.
    old_journal = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    old_reviews = db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id', [])
    from datetime import timedelta
    current = clock(day) + timedelta(seconds=1)
    # Import the actual Hono retirement result into this private SQLite fixture.
    # Preserve every original journal/review/lifecycle table; do not simulate
    # retirement by assigning a shadowing state or hand-written new config.
    retired_state = json.loads(Path(str(fixture) + '.retirement-state.json').read_text(encoding='utf-8'))
    for table, saved_table in retired_state['tables'].items():
        if not db.query('SELECT name FROM sqlite_master WHERE name=?', [table]):
            db.conn.execute(saved_table['schema'])
        else:
            db.conn.execute(f'DELETE FROM {table}')
        for row in saved_table['rows']:
            fields = list(row)
            db.conn.execute(f'INSERT INTO {table}(' + ','.join(fields) + ') VALUES('
                + ','.join('?' for _ in fields) + ')', [row[key] for key in fields])
    db.conn.commit()
    assert db.query("SELECT state FROM model_artifact_registry WHERE model_name='opb_arm_prior'", [])[0]['state'] == 'shadowing'
    assert not db.query("SELECT * FROM model_champion_pointers WHERE model_name='opb_arm_prior'", [])
    from services import paired_nav_collection as capture, recommendation_service as allocator
    actual = deepcopy(content['inputs'])
    actual['alpha_policy'] = deepcopy(retired_state['trading_config']['alphaFramework'])
    actual['ranking_config'] = deepcopy(retired_state['trading_config']['ranking'])
    actual['ensemble_v2_cfg'] = deepcopy(retired_state['trading_config']['ensemble_v2'])
    formal = db.query('SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum FROM active8_ensemble_pointer_v1', [])[0]
    with monkeypatch.context() as local:
        local.setattr(collection, 'datetime', SessionClock)
        local.setattr(capture, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=current))
        local.setattr(allocator, 'load_inherited_paper_weights', lambda *a, **kw:
            deepcopy(content['capture'].get('inherited_state') or {}))
        local.setattr(allocator, 'build_portfolio_ml_shadow_inputs', lambda *a, **kw: {})
        local.setattr(allocator, 'build_rfs_implementable_frontier_shadow', lambda *a, **kw: {})
        output, parent = capture.run_and_capture_allocation(**actual,
            trading_config=retired_state['trading_config'], risk_config=retired_state['risk_config'],
            signal_date=day, source_run_id='opb-retired-next-capture', query=db.query, writer=db.writer,
            formal_model_manifest={'active8_ensemble': formal, 'active8_action_authority': {
                **formal, 'buy_authorized': True, 'production_effect': True}})
    assert parent['status'] == 'allocation_context_frozen', parent
    captured = read_snapshot(db.query, parent['snapshot_id'])['payload']['content']
    assert captured['capture']['allocation_contract']['controller_effective'] == 'SparseTangent'
    assert captured['formal_output'] == capture.allocation_projection(output)
    assert captured['risk_config'] == retired_state['risk_config']
    # Admission retains the original pre-inference registration, independently
    # of today's lifecycle state; no re-registration or evidence-budget reset.
    assert captured['opb_candidate_selection']['registry_rows'] == content['opb_candidate_selection']['registry_rows']
    next_plan, = collect(db, parent)['plans']
    new = read_snapshot(db.query, next_plan['snapshot_id'])['payload']['content']
    assert new['pair_id'] != plan['pair_id'] and new['candidate_checksum'] == plan['candidate_checksum']
    execution = packet('2026-09-22')
    execution.update({k: new[k] for k in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
    execution.update(allocation_snapshot_id=next_plan['snapshot_id'], configuration={**new['configuration'], 'fees': FEES},
        schedule=[{'observed_at': '2026-09-22T00:00:00Z'}])
    execution['configuration_checksum'] = digest(execution['configuration'])
    registered = freeze_snapshot(signal_date=day, source_run_id=new['pair_id'], snapshot_kind='execution_pair',
        content=execution, query=db.query, writer=db.writer, now=current)
    closures = lifecycle.close_changed_comparisons(plans=[next_plan], signal_date=day, query=db.query,
        writer=db.writer, now=current)
    assert len(closures) == 1 and closures[0]['inherited_mature_sessions'] == 0
    assert lifecycle.closure_for_pair(plan['pair_id'], signal_date=day, query=db.query,
        observed_at=clock(day)) is None
    assert lifecycle.closure_for_pair(plan['pair_id'], signal_date=day, query=db.query,
        observed_at=current) == closures[0]
    # Even a later event must be decoded, not silently accepted as valid history.
    def corrupt_closure(sql, params):
        rows = db.query(sql, params)
        if sql.startswith('SELECT * FROM paired_nav_lifecycle_closures_v1'):
            return [{**row, 'payload_checksum': 'f' * 64} for row in rows]
        return rows
    with pytest.raises(ValueError, match='paired_nav_lifecycle_receipt_corrupt'):
        lifecycle.closure_for_pair(plan['pair_id'], signal_date=day, query=corrupt_closure,
            observed_at=clock(day))
    stage_execution_receipt(execution=receipt(execution, registered), query=db.query, writer=db.writer, now=clock('2026-09-22'))
    mature_staged_pairs(business_date='2026-09-22', query=db.query, writer=db.writer, now=clock('2026-09-22'))
    review = run_daily_nav_reviews(business_date='2026-09-22', query=db.query, writer=db.writer,
        now=clock('2026-09-22'))
    assert review['failures'] == [], review
    next_day = refresh_registered_opb_nav_decisions(business_date='2026-09-22', query=db.query,
        writer=db.writer, now=clock('2026-09-22'))
    assert next_day['failure_count'] == 0 and next_day['decisions'][0]['decision'] == 'PENDING'
    assert next_day['decisions'][0]['evaluable_date_count'] == 1
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 WHERE pair_id=? ORDER BY pair_id,session_date',
        [plan['pair_id']]) == old_journal
    assert db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id', []) == old_reviews
    from nav_opb_generations_fixture import verify_successor_generation
    verify_successor_generation(fixture, content['inputs'], monkeypatch, tmp_path)
