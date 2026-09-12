"""Native execution identity is frozen before pair identity; local synthetic inputs."""
from copy import deepcopy
from pathlib import Path

import pytest

from services import paired_nav_candidate_collection as candidates
from services.native_paper_sandbox import native_execution_identity
from services.paired_nav_journal import freeze_snapshot, read_snapshot
from test_native_paper_sandbox import native_runner
from test_paired_nav_candidate_collection import environment
from test_paired_nav_lifecycle import stamp


def environment_packet(version='native-paper-v1:fixture', *, day='2026-09-07'):
    return {'schema_version': 'paired-nav-execution-environment-v1',
        'execution_owner_version': version, 'account_id': 1,
        'kv_read_policy': {'source': ['market:'], 'private': ['paper:']},
        'source_context': {'schema_version': 'native-paper-source-context-v1',
            'observed_at': stamp(day).isoformat(), 'variables': {},
            'frozen_kv': {'ml:config': '{"enabled":true}', 'ml:adaptive_params': None}}}


def patch_graph_environment(monkeypatch, native_runner, *, day='2026-09-07'):
    from functools import partial
    from services import paired_nav_opb_candidate
    # This fixture freezes the graph in a synthetic historical session. Its
    # candidate inventory must use the SAME clock, not today's real registry cutoff.
    monkeypatch.setattr(paired_nav_opb_candidate, 'select_opb_candidates',
        partial(paired_nav_opb_candidate.select_opb_candidates, now=stamp(day)))
    from services import paired_nav_execution_environment as module
    from services.native_paper_source_capture import ImmutableNativeObjects
    from test_native_paper_source_capture import Bucket
    original = module.capture_pipeline_execution_environment
    objects = ImmutableNativeObjects(Bucket())
    context = environment_packet(day=day)['source_context']
    def capture(**kw):
        return original(**kw, objects=objects, context_reader=lambda: context,
            runner=native_runner, clock=lambda: stamp(day))
    packet = module.capture_execution_environment(context_reader=lambda: context,
        runner=native_runner, clock=lambda: stamp(day))
    monkeypatch.setattr(module, 'capture_pipeline_execution_environment', capture)
    return packet


def test_retired_statistical_experiment_is_not_an_execution_dependency(native_runner, monkeypatch):
    original = Path.read_bytes
    baseline = native_execution_identity(native_runner)
    def changed(path):
        raw = original(path)
        return raw + b'\n# audit-only change\n' if path.name == 'paired_nav_sequential_state.py' else raw
    monkeypatch.setattr(Path, 'read_bytes', changed)
    assert native_execution_identity(native_runner) == baseline


def test_real_execution_code_change_still_changes_identity(native_runner, monkeypatch):
    original = Path.read_bytes
    baseline = native_execution_identity(native_runner)
    monkeypatch.setattr(Path, 'read_bytes', lambda path: original(path) +
        (b'\n# real engine revision\n' if path.name == 'paired_native_session.py' else b''))
    assert native_execution_identity(native_runner) != baseline


def adaptive_environment(monkeypatch, *, day='2026-09-07', risk=20, losses=0, version=1):
    import json
    from services import adaptive
    monkeypatch.setattr(adaptive, '_tw_now', lambda: stamp(day).isoformat())
    params = adaptive.compute_adaptive_params(risk_score=risk, risk_level='green' if risk < 50 else 'red',
        accuracy_30d=.65 if risk < 50 else .45, rows_30d=[], rows_90d=[], losses_5d=losses,
        total_5d=5, current_version=version, L2_formula={'bandit_max_mult_low': 2.5},
        regime='bull' if risk < 50 else 'bear', regime_as_of_date=day, regime_source='hmm')
    packet = environment_packet(day=day)
    packet['source_context']['frozen_kv']['ml:adaptive_params'] = json.dumps(params)
    return packet, params


def test_actual_daily_adaptive_producer_is_observation_not_new_policy(monkeypatch):
    from services.paired_nav_execution_environment import execution_policy
    first, p1 = adaptive_environment(monkeypatch)
    second, p2 = adaptive_environment(monkeypatch, day='2026-09-08', risk=80, losses=4, version=2)
    assert p1['bandit_max_mult'] != p2['bandit_max_mult']
    assert p1['confidence_delta'] != p2['confidence_delta']
    assert execution_policy(first) == execution_policy(second)


@pytest.mark.parametrize('field', ['model_allocator', 'meta_layer', 'bandit_constants', 'unknown_field', 'manual_source'])
def test_adaptive_policy_owners_and_unknown_fields_are_not_ignored(monkeypatch, field):
    import json
    from services.paired_nav_execution_environment import execution_policy
    first, _ = adaptive_environment(monkeypatch)
    second, value = adaptive_environment(monkeypatch)
    if field == 'model_allocator':
        value['model_allocator'] = {'policy_id': 'new-meta-policy'}
    elif field == 'meta_layer':
        value['meta_layer']['immutable_risk_boundaries'].append('new_boundary')
    elif field == 'bandit_constants':
        value['bandit_context']['thresholds']['high'] = .8
    elif field == 'manual_source':
        value['provenance']['source'] = 'manual'
    else:
        value['unknown_future_policy'] = True
    second['source_context']['frozen_kv']['ml:adaptive_params'] = json.dumps(value)
    assert execution_policy(first) != execution_policy(second)


def test_daily_adaptive_carry_changes_inputs_without_changing_experiment(monkeypatch):
    from services.paired_native_registration import validate_carry_context
    from services.paired_nav_execution_environment import execution_policy
    from services.paired_nav_journal import digest
    from test_paired_nav_carry_context import fixture
    first, _ = adaptive_environment(monkeypatch)
    second, _ = adaptive_environment(monkeypatch, day='2026-09-08', risk=80, losses=4, version=2)
    previous, kwargs = fixture()
    kwargs['allocation']['configuration']['native_execution_policy'] = execution_policy(first)
    previous['configuration_checksum'] = digest({**kwargs['allocation']['configuration'],
        'fees': kwargs['allocation']['configuration']['trading_config']['fees']})
    previous['source_context'] = first['source_context']
    kwargs['source_context'] = second['source_context']
    validate_carry_context(previous, **kwargs)
    assert previous['source_context'] != kwargs['source_context']


def test_daily_state_is_still_exactly_bound_to_its_own_frozen_parent(monkeypatch):
    from services.paired_nav_execution_environment import execution_policy, validate_registered_environment
    first, _ = adaptive_environment(monkeypatch)
    second, _ = adaptive_environment(monkeypatch, day='2026-09-08', risk=80, losses=4, version=2)
    with pytest.raises(ValueError, match='changed_after_freeze'):
        validate_registered_environment(parent={'manifest': {'frozen_at': stamp('2026-09-07').isoformat()},
            'payload': {'content': {'native_execution_environment': first}}},
            allocation={'configuration': {'native_execution_policy': execution_policy(first)}},
            runtime={'execution_owner_version': first['execution_owner_version']}, account_id=1,
            variables={}, kv_read_policy=first['kv_read_policy'], source_context=second['source_context'])


def test_future_computed_adaptive_state_is_not_valid_daily_evidence(monkeypatch):
    from services.paired_nav_execution_environment import execution_policy
    future, _ = adaptive_environment(monkeypatch, day='2026-09-08')
    future['source_context']['observed_at'] = stamp('2026-09-07').isoformat()
    with pytest.raises(ValueError, match='observed_before_computed'):
        execution_policy(future)


@pytest.mark.parametrize('change', ['engine', 'flags', 'policy', 'observation_only', 'adaptive_daily'])
def test_actual_ev_pair_identity_includes_execution_environment(environment, monkeypatch, change):
    db, bucket, _, original = environment
    content = deepcopy(original)
    content['native_execution_environment'] = environment_packet()
    if change == 'adaptive_daily':
        content['native_execution_environment'], _ = adaptive_environment(monkeypatch)
    first = freeze_snapshot(signal_date='2026-09-07', source_run_id='environment-before',
        snapshot_kind='allocation_context', content=content, query=db.query, writer=db.writer,
        now=stamp('2026-09-07'))
    before = candidates.collect_candidate_allocations(snapshot_id=first['snapshot_id'],
        query=db.query, writer=db.writer, bucket=bucket)
    after_content = deepcopy(content)
    packet = after_content['native_execution_environment']
    packet['source_context']['observed_at'] = stamp('2026-09-08').isoformat()
    if change == 'engine':
        packet['execution_owner_version'] += '-new'
    elif change == 'flags':
        packet['source_context']['variables']['S12_INTRADAY_GATE_MODE'] = 'assist_entry'
    elif change == 'policy':
        packet['source_context']['frozen_kv']['ml:config'] = '{"enabled":false}'
    elif change == 'adaptive_daily':
        after_content['native_execution_environment'], _ = adaptive_environment(monkeypatch,
            day='2026-09-08', risk=80, losses=4, version=2)
    else:
        packet['source_context']['frozen_kv']['ml:config'] = '{ "enabled" : true }'
    second = freeze_snapshot(signal_date='2026-09-08', source_run_id='environment-after',
        snapshot_kind='allocation_context', content=after_content, query=db.query, writer=db.writer,
        now=stamp('2026-09-08'))
    monkeypatch.setattr(candidates, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp('2026-09-08')))
    after = candidates.collect_candidate_allocations(snapshot_id=second['snapshot_id'],
        query=db.query, writer=db.writer, bucket=bucket)
    before_ids, after_ids = ({p['pair_id'] for p in result['plans']} for result in (before, after))
    assert (before_ids == after_ids) if change in {'observation_only', 'adaptive_daily'} else before_ids.isdisjoint(after_ids)
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


def test_actual_capture_retry_reuses_environment_without_new_source_read(monkeypatch):
    from services import paired_nav_collection as capture
    from test_paired_nav_pipeline import allocation_args
    from test_paired_nav_journal import DB
    db, calls = DB(legacy_assessments=False), []
    monkeypatch.setattr(capture, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp('2026-09-07')))
    packet = environment_packet()
    def reader():
        calls.append('read')
        assert len(calls) == 1, 'Retry must not read mutable Worker policy'
        return packet
    def allocator(**kwargs):
        kwargs['allocation_evidence_sink']({'weights': .2})
        return kwargs['recommendations']
    results = [capture.run_and_capture_allocation(**allocation_args(db),
        run_allocation=allocator, execution_environment_reader=reader)[1] for _ in range(2)]
    assert results[0] == results[1]
    assert results[0]['status'] == 'allocation_context_frozen'
    saved = read_snapshot(db.query, results[0]['snapshot_id'])['payload']['content']
    assert saved['native_execution_environment'] == packet and calls == ['read']


def test_environment_capture_failure_preserves_formal_output(monkeypatch):
    from services import paired_nav_collection as capture
    from test_paired_nav_pipeline import allocation_args
    from test_paired_nav_journal import DB
    db, calls = DB(legacy_assessments=False), []
    def allocator(**kwargs):
        calls.append('formal')
        kwargs['recommendations'][0]['signal'] = 'BUY'
        kwargs['allocation_evidence_sink']({'weights': .2})
        return kwargs['recommendations']
    def failed():
        raise RuntimeError('native_worker_context_transport_failed')
    output, result = capture.run_and_capture_allocation(**allocation_args(db),
        run_allocation=allocator, execution_environment_reader=failed)
    assert output[0]['signal'] == 'BUY' and calls == ['formal']
    assert result['status'] == 'failed' and result['promotion_allowed'] is False
    assert not db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])


@pytest.mark.parametrize('interruption', ['parts', 'manifest', 'lost_ack'])
def test_d1_seal_interruption_recovers_first_environment_from_existing_inbox(monkeypatch, native_runner, interruption):
    from services import paired_nav_collection as capture
    from services.paired_nav_execution_environment import capture_pipeline_execution_environment
    from services.native_paper_source_capture import ImmutableNativeObjects
    from test_native_paper_source_capture import Bucket
    from test_paired_nav_pipeline import allocation_args
    from test_paired_nav_journal import DB
    db, reads = DB(legacy_assessments=False), []
    objects = ImmutableNativeObjects(Bucket())
    monkeypatch.setattr(capture, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp('2026-09-07')))
    def reader():
        reads.append(1)
        assert len(reads) == 1, 'Partial D1 seal must not acquire later Worker flags'
        return environment_packet()['source_context']
    def environment_reader():
        return capture_pipeline_execution_environment(signal_date='2026-09-07', source_run_id='pipeline-fault',
            objects=objects, context_reader=reader, runner=native_runner, clock=lambda: stamp('2026-09-07'))
    def allocator(**kwargs):
        kwargs['allocation_evidence_sink']({'weights': .2})
        return kwargs['recommendations']
    def fail(statements):
        if interruption == 'parts' and 'INSERT OR IGNORE INTO paired_nav_frozen_parts' in statements[0][0]:
            db.writer(statements[:1])
            raise RuntimeError('fixture_partial_parts')
        if 'INSERT OR IGNORE INTO paired_nav_frozen_manifests' in statements[0][0]:
            if interruption == 'lost_ack':
                db.writer(statements)
            raise RuntimeError('fixture_manifest_failure')
        return db.writer(statements)
    args = allocation_args(db)
    # Force several part writes; preserve every part already stored on retry.
    args['model_predictions'] = {'synthetic_padding': 'x' * 230000}
    first = capture.run_and_capture_allocation(**(args | {'writer': fail}),
        run_allocation=allocator, execution_environment_reader=environment_reader)[1]
    assert first['status'] == 'failed'
    before = db.query('SELECT * FROM paired_nav_frozen_parts_v1 ORDER BY snapshot_id,part_no', [])
    second = capture.run_and_capture_allocation(**args,
        run_allocation=allocator, execution_environment_reader=environment_reader)[1]
    assert second['status'] == 'allocation_context_frozen' and reads == [1]
    after = db.query('SELECT * FROM paired_nav_frozen_parts_v1 ORDER BY snapshot_id,part_no', [])
    assert all(row in after for row in before)
    saved = read_snapshot(db.query, second['snapshot_id'])['payload']['content']
    assert saved['native_execution_environment']['source_context'] == environment_packet()['source_context']


@pytest.mark.parametrize('change', ['engine', 'flags', 'policy', 'account', 'read_policy', 'missing_parent', 'future_source'])
def test_registration_cannot_use_an_environment_other_than_the_parent(change):
    from services.paired_nav_execution_environment import execution_policy, validate_registered_environment
    environment = environment_packet()
    parent = {'manifest': {'frozen_at': stamp('2026-09-07').isoformat()},
        'payload': {'content': {'native_execution_environment': environment}}}
    plan = {'configuration': {'native_execution_policy': execution_policy(environment)}}
    kwargs = dict(parent=parent, allocation=plan,
        runtime={'execution_owner_version': environment['execution_owner_version']},
        account_id=1, variables={}, kv_read_policy=deepcopy(environment['kv_read_policy']),
        source_context=deepcopy(environment['source_context']))
    if change == 'engine':
        kwargs['runtime']['execution_owner_version'] += '-new'
    elif change == 'flags':
        kwargs['variables'] = {'extra': '1'}
    elif change == 'policy':
        kwargs['source_context']['frozen_kv']['ml:config'] = '{}'
    elif change == 'account':
        kwargs['account_id'] = 2
    elif change == 'read_policy':
        kwargs['kv_read_policy'] = {}
    elif change == 'missing_parent':
        parent['payload']['content'] = {}
    else:
        environment['source_context']['observed_at'] = stamp('2026-09-08').isoformat()
    with pytest.raises(ValueError, match='execution_environment'):
        validate_registered_environment(**kwargs)


@pytest.mark.parametrize('scenario', ['success', 'engine_changed', 'partial_registration', 'adaptive_values'])
def test_actual_native_registration_consumes_frozen_environment(environment, monkeypatch, native_runner, scenario):
    from services import paired_native_runtime as native
    from services.paired_nav_pipeline import complete_pipeline_shadow, pipeline_shadow_errors
    from services.paired_nav_execution_environment import capture_execution_environment
    from services.paired_nav_comparison import resolve_comparison
    from services.native_paper_sandbox import native_runtime_manifest
    from services.native_paper_source_capture import ImmutableNativeObjects
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_native_paper_source_capture import Bucket
    from test_paired_native_registration import calendar
    db, bucket, _, original_context = environment
    context = deepcopy(original_context)
    source_context = environment_packet()['source_context']
    if scenario == 'adaptive_values':
        adaptive_packet, adaptive_values = adaptive_environment(monkeypatch, risk=80, losses=4)
        source_context = adaptive_packet['source_context']
    frozen = capture_execution_environment(context_reader=lambda: source_context,
        runner=native_runner, clock=lambda: stamp('2026-09-07'))
    if scenario == 'engine_changed':
        frozen['execution_owner_version'] = 'native-paper-v1:previous-executable'
    context['native_execution_environment'] = frozen
    parent = freeze_snapshot(signal_date='2026-09-07', source_run_id='real-native-environment',
        snapshot_kind='allocation_context', content=context, query=db.query, writer=db.writer,
        now=stamp('2026-09-07'))
    source, source_query = source_fixture()
    try:
        source.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(2,'2317','fixture','TWSE')")
        source.execute("INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES('2026-09-07',2,'2317','fixture',2,50,'seed')")
        before = source.total_changes
        objects = ImmutableNativeObjects(Bucket())
        owners = native_runtime_manifest(native_runner)['tables']
        register, register_pair = native.register_candidate_execution_plans, native.register_allocation_pair
        calls = []
        def pair(**kw):
            calls.append(kw['snapshot_id'])
            if scenario == 'partial_registration' and len(calls) == 2:
                raise RuntimeError('native_fixture_second_registration_interrupted')
            return register_pair(**kw)
        def no_source():
            raise AssertionError('New native plans must not re-read mutable Worker context')
        monkeypatch.setattr(native, 'register_allocation_pair', pair)
        monkeypatch.setattr(candidates, '_bucket', lambda: bucket)
        monkeypatch.setattr(native, 'register_candidate_execution_plans', lambda **kw: register(**kw,
            objects=objects, domain_queries={owner: source_query for owner in set(owners.values())},
            kv_read=calendar, context_reader=no_source, runner=native_runner, clock=lambda: stamp('2026-09-07')))
        result = complete_pipeline_shadow({'status': 'allocation_context_frozen', 'snapshot_id': parent['snapshot_id']},
            query=db.query, writer=db.writer)
        if scenario == 'engine_changed':
            assert result['status'] == 'failed' and result['reason'] == 'paired_native_execution_environment_changed_after_freeze'
            assert not db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'", [])
            assert source.total_changes == before and pipeline_shadow_errors(result)
            return
        if scenario == 'partial_registration':
            assert result['status'] == 'failed' and result['stage'] == 'native_registration'
            first = db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'", [])
            assert len(first) == 1
            result = complete_pipeline_shadow(result, query=db.query, writer=db.writer)
            assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [first[0]['snapshot_id']]) == first
        assert result['status'] == 'native_execution_pairs_registered' and not pipeline_shadow_errors(result)
        for item in result['native_execution']['registrations']:
            saved = read_snapshot(db.query, item['snapshot_id'])
            assert saved['payload']['content']['source_context'] == frozen['source_context']
            assert resolve_comparison(query=db.query, execution=saved)['owner'] in {'l4_alpha_ev', 'allocator_ev_fusion'}
            if scenario == 'adaptive_values':
                import json
                import sqlite3
                for arm in ('baseline', 'candidate'):
                    state = objects.get(saved['payload']['content']['initial_state_objects'][arm])
                    with sqlite3.connect(':memory:') as private:
                        private.executescript(state['state_sql'])
                        raw = private.execute("SELECT value FROM _native_private_kv WHERE key='ml:adaptive_params'").fetchone()[0]
                        assert json.loads(raw) == adaptive_values
        assert complete_pipeline_shadow(result, query=db.query, writer=db.writer) == result
        assert source.total_changes == before
    finally:
        source.close()


def test_two_actual_market_days_keep_ledger_through_daily_adaptive_change(monkeypatch, native_runner):
    """Two distinct 281-frame dates, not two retries of the same session. Cash fixture, no ROI."""
    import json
    import sqlite3
    from services.paired_nav_journal import digest, mature_staged_pairs
    from services.paired_nav_execution_environment import execution_policy
    from services.paired_native_registration import register_allocation_pair
    from services.paired_native_runtime import KV_READ_POLICY
    from services.paired_native_session import run_paired_session
    from services.native_paper_sandbox import native_runtime_manifest
    from services.native_paper_source_capture import ImmutableNativeObjects
    from test_native_paper_sandbox import checksum
    from test_paired_native_session import paired_fixture
    from test_paired_nav_journal import DB
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_native_paper_source_capture import Bucket
    from test_paired_native_registration import calendar
    old_db, args = paired_fixture(native_runner)
    packet = read_snapshot(old_db.query, args['snapshot_id'])['payload']['content']
    assert len(packet['schedule']) == 281
    old_db.conn.close()
    db, objects = DB(legacy_assessments=False), ImmutableNativeObjects(Bucket())
    formal = {'schema_version': 'paired-nav-formal-ml-baseline-v1', 'artifact_id': 'fixture-ml',
        'cohort_id': 'fixture-cohort', 'payload_checksum': 'a' * 64, 'base_artifact_set_checksum': 'b' * 64}
    first, _ = adaptive_environment(monkeypatch, day='2026-09-04')
    first.update(account_id=2, execution_owner_version=native_execution_identity(native_runner), kv_read_policy=KV_READ_POLICY)
    configuration = {key: value for key, value in packet['configuration'].items() if key != 'fees'}
    configuration.update(formal_baseline_identity=formal, native_execution_policy=execution_policy(first))
    baseline_checksum = digest(formal)
    pair_id = digest(['l4_alpha_ev', packet['candidate_checksum'], baseline_checksum, digest(configuration)])
    def allocation(day, env):
        config = {**configuration, 'native_execution_policy': execution_policy(env)}
        assert config == configuration, 'Ordinary adaptive updates must not change comparison identity'
        context = freeze_snapshot(signal_date=day, source_run_id='native-day:' + day, snapshot_kind='allocation_context',
            content={'formal_baseline_identity': formal, 'formal_output': [], 'model_predictions': {},
                'native_execution_environment': env}, query=db.query, writer=db.writer, now=stamp(day))
        return freeze_snapshot(signal_date=day, source_run_id=pair_id, snapshot_kind='allocation_pair',
            content={'pair_id': pair_id, 'owner': 'l4_alpha_ev', 'candidate_checksum': packet['candidate_checksum'],
                'baseline_checksum': baseline_checksum, 'allocation_context_snapshot_id': context['snapshot_id'],
                'configuration': config, 'configuration_checksum': digest(config), 'model_predictions_checksum': digest({}),
                'baseline': {'output': [], 'recommendations': []}, 'candidate': {'output': [], 'recommendations': []}},
            query=db.query, writer=db.writer, now=stamp(day))
    plan = allocation('2026-09-04', first)
    with sqlite3.connect(':memory:') as initial:
        initial.executescript(args['states']['baseline']['state_sql'])
        for key, value in first['source_context']['frozen_kv'].items():
            initial.execute('DELETE FROM _native_private_kv WHERE key=?', [key])
            if value is not None:
                initial.execute('INSERT INTO _native_private_kv VALUES(?,?,NULL,NULL)', [key, value])
        raw = '\n'.join(initial.iterdump())
    state = {'state_sql': raw, 'state_checksum': checksum(raw)}
    packet.update(pair_id=pair_id, owner='l4_alpha_ev', baseline_checksum=baseline_checksum,
        allocation_snapshot_id=plan['snapshot_id'], configuration={**configuration, 'fees': configuration['trading_config']['fees']},
        source_context=first['source_context'], kv_read_policy=KV_READ_POLICY,
        model_predictions={}, model_predictions_checksum=digest({}),
        initial_state_checksums={arm: state['state_checksum'] for arm in ('baseline', 'candidate')})
    packet['configuration_checksum'] = digest(packet['configuration'])
    first_execution = freeze_snapshot(signal_date='2026-09-04', source_run_id=pair_id, snapshot_kind='execution_pair',
        content=packet, query=db.query, writer=db.writer, now=stamp('2026-09-04'))
    args.update(snapshot_id=first_execution['snapshot_id'], query=db.query, writer=db.writer,
        state_objects=objects, states={arm: deepcopy(state) for arm in ('baseline', 'candidate')})
    run_paired_session(**args)
    day1 = mature_staged_pairs(business_date='2026-09-07', query=db.query, writer=db.writer, now=stamp('2026-09-07'))
    assert day1['processed_pair_sessions'] == 1
    population1 = day1['paired_nav_evidence']['candidate_population']
    assert population1['pair_count'] == population1['hypothesis_count'] == 1
    assert population1['pairs'][0]['metadata_missing_fields'] == ['candidate_artifact_id', 'candidate_training_run_id']
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    second, params = adaptive_environment(monkeypatch, day='2026-09-07', risk=80, losses=4, version=2)
    second.update(account_id=2, execution_owner_version=first['execution_owner_version'], kv_read_policy=KV_READ_POLICY)
    next_plan = allocation('2026-09-07', second)
    source, source_query = source_fixture()
    try:
        source_changes = source.total_changes
        owners = native_runtime_manifest(native_runner)['tables']
        next_execution = register_allocation_pair(snapshot_id=next_plan['snapshot_id'], query=db.query, writer=db.writer,
            domain_queries={owner: source_query for owner in set(owners.values())}, kv_read=calendar,
            objects=objects, account_id=2, variables={}, kv_read_policy=KV_READ_POLICY,
            runner=native_runner, now=stamp('2026-09-07'), source_context=second['source_context'])
        saved = read_snapshot(db.query, next_execution['snapshot_id'])['payload']['content']
        assert saved['previous_session_date'] == '2026-09-07' and saved['session_date'] == '2026-09-08'
        assert len(saved['schedule']) == 281
        states = {arm: objects.get(saved['initial_state_objects'][arm]) for arm in ('baseline', 'candidate')}
        for state in states.values():
            with sqlite3.connect(':memory:') as private:
                private.executescript(state['state_sql'])
                # Day 1 settled -1,000/+3,000: cash 90,000 -> 92,000.
                # Another +7,000 is due on day 2, so economic NAV is 99,000.
                assert private.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 92000
                assert private.execute('SELECT SUM(amount) FROM paper_settlements WHERE account_id=2 AND settled=0').fetchone()[0] == 7000
                assert json.loads(private.execute("SELECT value FROM _native_private_kv WHERE key='ml:adaptive_params'").fetchone()[0]) == params
        source_receipt = {'session_date': saved['session_date'], 'complete': True, 'schedule_checksum': digest(saved['schedule']),
            'closed_at': '2026-09-08T06:20:00Z', 'corporate_actions_complete': True, 'corporate_actions': [], 'closing_marks': {}}
        tapes = {arm: {'frames': {f['input_id']: f for f in saved['schedule']}, 'source_receipt': deepcopy(source_receipt)}
                 for arm in ('baseline', 'candidate')}
        output = run_paired_session(snapshot_id=next_execution['snapshot_id'], tapes=tapes, states=states,
            query=db.query, writer=db.writer, runner=native_runner, state_objects=objects, now=stamp('2026-09-08'))
        day2 = mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=stamp('2026-09-08'))
        assert day2['processed_pair_sessions'] == 1 and output['promotion_allowed'] is False
        population2 = day2['paired_nav_evidence']['candidate_population']
        assert population2['hypothesis_count'] == 1
        assert population2['pairs'][0]['hypothesis_checksum'] == population1['pairs'][0]['hypothesis_checksum']
        assert population2['pairs'][0]['accounted_sessions'] == 2
        rows = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY session_date', [])
        assert [r['session_date'] for r in rows] == ['2026-09-07', '2026-09-08']
        assert {r['pair_id'] for r in rows} == {pair_id} and rows[0] == before[0]
        assert all(json.loads(r['payload_json'])['arms']['candidate']['nav'] == 99000 for r in rows)
        assert all(json.loads(r['payload_json'])['net_return_delta'] == 0 for r in rows)
        with sqlite3.connect(':memory:') as closed:
            closed.executescript(output['states']['candidate']['state_sql'])
            assert closed.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 99000
        assert source.total_changes == source_changes
    finally:
        source.close()
