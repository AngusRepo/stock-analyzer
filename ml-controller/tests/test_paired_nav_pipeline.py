"""Real allocator/graph boundary tests; synthetic inputs, no investment claims."""
import asyncio
import sqlite3
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from services import paired_nav_collection as capture
from services.paired_nav_pipeline import complete_pipeline_shadow, pipeline_shadow_errors
from services.paired_nav_journal import freeze_snapshot
from test_paired_nav_journal import DB, FEES
from test_paired_nav_candidate_collection import environment
from test_native_paper_sandbox import native_runner


def allocation_args(db):
    return dict(recommendations=[{'symbol': '2330', 'signal': 'HOLD'}],
        ranking_config={'enabled': True}, ensemble_v2_cfg={}, regime_label='bull',
        regime_surface={}, alpha_policy={}, return_history={}, opb_reward_ledger=[],
        trading_config={'fees': FEES}, risk_config=None, signal_date='2026-09-07',
        source_run_id='pipeline-fault', query=db.query, writer=db.writer)


@pytest.mark.parametrize('fault', ['inputs', 'risk', 'recommendation', 'sink', 'missing_sink', 'multiple_sink', 'seal'])
def test_capture_failure_keeps_exact_allocator_output_and_never_reexecutes(monkeypatch, fault):
    db = DB(legacy_assessments=False)
    args, calls = allocation_args(db), []
    if fault == 'inputs':
        args['formal_model_manifest'] = {}
    if fault == 'recommendation':
        args['recommendation_context'] = capture.shadow_failure('recommendation_context_inputs', ValueError('unserializable input'))
    if fault == 'risk':
        args['risk_config_reader'] = lambda: (_ for _ in ()).throw(RuntimeError('https://secret?token=test'))
    if fault == 'seal':
        monkeypatch.setattr(capture, 'freeze_snapshot', lambda **kw: (_ for _ in ()).throw(RuntimeError('D1 unavailable')))
    def allocator(**kwargs):
        calls.append('formal')
        rows = kwargs['recommendations']
        rows[0].update(signal='BUY', allocation_weight=.2)
        if fault != 'missing_sink':
            kwargs['allocation_evidence_sink']({'weights': object() if fault == 'sink' else .2})
        if fault == 'multiple_sink':
            kwargs['allocation_evidence_sink']({'weights': .2})
        return rows
    output, collected = capture.run_and_capture_allocation(**args, run_allocation=allocator)
    assert output is args['recommendations']
    assert output[0]['allocation_weight'] == .2 and output[0]['signal'] == 'BUY'
    assert calls == ['formal']
    assert collected['status'] == 'failed' and collected['nav_maturity_credit'] == 0
    assert 'snapshot_id' not in collected
    assert 'secret' not in str(collected)
    assert pipeline_shadow_errors(collected)
    assert db.query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1', []) == []


def test_formal_allocator_exception_is_not_isolated_or_retried():
    calls = []
    def broken(**kw):
        calls.append(1)
        raise ValueError('real formal allocation failure')
    with pytest.raises(ValueError, match='real formal allocation failure'):
        capture.run_and_capture_allocation(**allocation_args(DB()), run_allocation=broken)
    assert calls == [1]


def test_real_sparse_output_is_identical_when_shadow_seal_fails(monkeypatch):
    from services import recommendation_service as service
    from test_allocator_direction_authority import _continuity_row
    monkeypatch.setattr(service, 'load_inherited_paper_weights', lambda *a, **k:
        {'status': 'fixture', 'weights': {}, 'portfolio_value_twd': 100000})
    monkeypatch.setattr(service, 'build_portfolio_ml_shadow_inputs', lambda *a, **k: {})
    monkeypatch.setattr(service, 'build_rfs_implementable_frontier_shadow', lambda *a, **k:
        {'status': 'fixture_observer', 'weights': {}, 'metrics': {}})
    inputs = dict(recommendations=[_continuity_row('2330'), _continuity_row('2317')],
        ranking_config={'enabled': True, 'promoteMinMlEdge': 0}, ensemble_v2_cfg={},
        regime_label='bull', regime_surface={},
        alpha_policy={'allocation': {'controller': 'SparseTangent', 'method': 'sparse_tangent_inverse_risk'}},
        return_history={'2330': [.01, -.01, .02, .00, -.02] * 10, '2317': [.02, .01, -.01, .00, -.02] * 10},
        opb_reward_ledger=[])
    expected = service.apply_sparse_tangent_allocation(**deepcopy(inputs))
    monkeypatch.setattr(capture, 'freeze_snapshot', lambda **kw: (_ for _ in ()).throw(RuntimeError('D1 unavailable')))
    args = allocation_args(DB()) | deepcopy(inputs)
    actual, result = capture.run_and_capture_allocation(**args)
    assert capture.allocation_projection(actual) == capture.allocation_projection(expected)
    assert result['status'] == 'failed'


def seal_context(db):
    manifest = freeze_snapshot(signal_date='2026-09-07', source_run_id='post-write-test',
        snapshot_kind='allocation_context', content={'fixture': True}, query=db.query, writer=db.writer,
        now=datetime(2026, 9, 7, 14, tzinfo=timezone.utc))
    return {'status': 'allocation_context_frozen', 'snapshot_id': manifest['snapshot_id'], 'nav_maturity_credit': 0}


@pytest.mark.parametrize('second_fault', ['registration', 'readback'])
def test_sibling_failures_preserve_each_member_and_never_close_unverified_successor(monkeypatch, second_fault):
    """Consumer-boundary fault injection; actual native registration has separate integration coverage."""
    from services.paired_nav_pipeline import _register_owner_groups
    from services import paired_native_runtime as native, paired_nav_lifecycle as lifecycle
    db = DB(legacy_assessments=False)
    now = datetime(2026,9,7,14,tzinfo=timezone.utc)
    plans = []
    for name in ('first','second','third'):
        value = {'pair_id':name, 'owner':'l4_alpha_ev'}
        saved = freeze_snapshot(signal_date='2026-09-07',source_run_id=name,
            snapshot_kind='allocation_pair',content=value,query=db.query,writer=db.writer,now=now)
        plans.append({**value,'snapshot_id':saved['snapshot_id']})
    collection = {'plans':plans, 'selection_materialization_complete':True}
    original = deepcopy(collection)
    attempted, closing = [], []
    fail = [True]
    def register(*, collection, **kwargs):
        assert len(collection['plans'])==1
        plan = collection['plans'][0]
        attempted.append(plan['pair_id'])
        if fail[0] and plan['pair_id']=='second':
            if second_fault=='registration':
                raise RuntimeError('https://provider.invalid/?token=secret')
            return {'status':'native_execution_pairs_registered','registrations':[]}
        saved = freeze_snapshot(signal_date='2026-09-07',source_run_id=plan['pair_id'],
            snapshot_kind='execution_pair', content={'pair_id':plan['pair_id'],'owner':plan['owner'],
                'allocation_snapshot_id':plan['snapshot_id'],'schedule':[{'observed_at':'2026-09-08T00:00:00Z'}]},
            query=db.query,writer=db.writer,now=now)
        return {'status':'native_execution_pairs_registered','registrations':[saved]}
    def close(*, plans, **kwargs):
        assert len(plans)==1
        name = plans[0]['pair_id']
        closing.append(name)
        if fail[0] and name=='third':
            raise ValueError('paired_nav_fixture_lifecycle_write_failed')
        return [{'pair_id':name}]
    monkeypatch.setattr(native,'register_candidate_execution_plans',register)
    monkeypatch.setattr(lifecycle,'close_changed_comparisons',close)
    kwargs = dict(signal_date='2026-09-07',query=db.query,writer=db.writer)
    registered, result, failures = _register_owner_groups(collection,**kwargs)
    assert attempted==['first','second','third'] and closing==['first','third']
    assert registered['status']=='partial_native_execution_registration'
    assert len(registered['registrations'])==2
    assert result['plans']==plans and result['lifecycle_transitions']==[{'pair_id':'first'}]
    members = failures['l4_alpha_ev']['candidate_failures']
    assert [(r['pair_id'],r['stage']) for r in members]==[('second','native_registration'),('third','lifecycle_commit')]
    assert members[0]['reason']==('paired_nav_source_or_capture_failed' if second_fault=='registration'
                                 else 'paired_nav_native_registration_coverage_missing')
    assert 'secret' not in str(failures)
    assert collection==original
    before = db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair' ORDER BY snapshot_id",[])
    fail[0]=False
    recovered, result, failures = _register_owner_groups(collection,**kwargs)
    assert failures=={} and recovered['status']=='native_execution_pairs_registered'
    assert len(recovered['registrations'])==3 and len(result['lifecycle_transitions'])==3
    for row in before:
        assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',[row['snapshot_id']])==[row]
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1',[])==[]
    db.conn.close()


@pytest.mark.parametrize('duplicate', ['snapshot_id','pair_id'])
def test_duplicate_candidate_plan_rejected_before_any_registration(duplicate):
    from services.paired_nav_pipeline import _register_owner_groups
    plans = [dict(snapshot_id='a',pair_id='first',owner='l4_alpha_ev'),
             dict(snapshot_id='b',pair_id='second',owner='l4_alpha_ev')]
    plans[1][duplicate]=plans[0][duplicate]
    def forbidden(*args,**kwargs):
        pytest.fail('duplicate plan must not reach I/O')
    with pytest.raises(ValueError,match='paired_nav_duplicate_allocation_plans'):
        _register_owner_groups({'plans':plans},signal_date='2026-09-07',query=forbidden,writer=forbidden)


@pytest.mark.parametrize('fault', ['capture', 'candidate', 'registration', 'incomplete_registration', 'waiting'])
def test_actual_graph_writes_incumbent_before_nav_failure_and_reports_truth(monkeypatch, fault):
    import graphs.daily_pipeline_v2 as graph
    from services import paired_nav_candidate_collection as candidates, paired_native_runtime as native
    db, events = DB(legacy_assessments=False), []
    # Production D1 is thread-safe; use an equivalent private connection for
    # the real asyncio.to_thread boundary instead of mocking thread dispatch.
    threaded = sqlite3.connect(':memory:', check_same_thread=False)
    db.conn.backup(threaded)
    db.conn.close()
    db.conn = threaded
    db.conn.row_factory = sqlite3.Row
    db.conn.execute('CREATE TABLE fixture_recommendations(symbol TEXT, weight REAL)')
    context = seal_context(db)
    state = dict(run_date='2026-09-07', active_stocks=[{'symbol': '2330', 'id': 1}],
        predictions={'2330': {'core_family_evidence': {'formal_model_contract_passed': True}}},
        screener_recs=[{'symbol': '2330'}],
        final_recommendations=[{'symbol': '2330', 'signal': 'BUY', 'allocation_weight': .2}],
        active8_action_authority={'mode': 'formal'}, paired_nav_collection=context, errors=[])
    manifest = {'schema_version': graph.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
                'active8_action_authority': {'mode': 'formal'}}
    state['pipeline_modal_serving_context'] = {'schema_version': 'pipeline-modal-serving-context-v1',
        'serving_manifest': manifest, 'serving_manifest_digest': graph._pipeline_modal_canonical_digest(manifest)}
    if fault == 'capture':
        state['paired_nav_collection'] = capture.shadow_failure('allocation_context_seal', RuntimeError('D1 failure'))
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=db.query, batch_execute=db.writer))
    for name in ['prune_predictions_outside_universe', 'write_layer2_timesfm_enrichment_audit',
                 'write_layer3_formal_gate_audit', 'delete_filtered_recommendations', 're_rank_recommendations']:
        monkeypatch.setattr(graph, name, lambda *a, **kw: 0)
    monkeypatch.setattr(graph, 'write_predictions_to_d1', lambda *a, **kw: 1)
    def write(rows, day):
        events.append('formal_write')
        db.conn.executemany('INSERT INTO fixture_recommendations VALUES(?,?)',
            [(r['symbol'], r['allocation_weight']) for r in rows])
        db.conn.commit()
        return len(rows)
    monkeypatch.setattr(graph, 'update_recommendations_in_d1', write)
    def collect(**kwargs):
        assert fault != 'capture', 'failed original seal must not enter candidate setup'
        assert db.query('SELECT * FROM fixture_recommendations', []) == [{'symbol': '2330', 'weight': .2}]
        events.append('candidate')
        if fault == 'candidate':
            raise ValueError('paired_nav_candidate_payload_corrupt')
        return {'status': 'awaiting_frozen_l4_candidate' if fault == 'waiting' else 'allocation_pairs_frozen',
            'plans': [] if fault == 'waiting' else [{'snapshot_id': 'plan', 'pair_id': 'pair', 'owner': 'l4_alpha_ev'}]}
    def register(**kwargs):
        events.append('register')
        if fault == 'registration':
            raise RuntimeError('native_worker_context_missing')
        return {'status': 'native_execution_pairs_registered', 'registrations': []}
    monkeypatch.setattr(candidates, 'collect_candidate_allocations', collect)
    monkeypatch.setattr(native, 'register_candidate_execution_plans', register)
    async def noop(state):
        return {}
    async def downstream(state):
        events.append('downstream')
        return {}
    # Execute the actual compiled graph, preserving real write_d1 + NAV setup;
    # upstream ML and external writer I/O are isolated local fixtures.
    for name in ['node_load_inputs', 'node_load_market_env', 'node_capture_atomic_inputs', 'node_build_payloads',
                 'node_l2_timesfm_enrich', 'node_l3_formal_predict', 'node_compute_personas',
                 'node_recommend', 'node_llm_reasons', 'node_compute_pit_residual_shadow',
                 'node_export_dataset_snapshot']:
        monkeypatch.setattr(graph, name, noop)
    monkeypatch.setattr(graph, 'node_compute_sector_flow', downstream)
    actual = asyncio.run(graph.build_graph().ainvoke(state))
    result = graph._pipeline_terminal_result(actual, run_date=state['run_date'], elapsed=0)
    assert events[0] == 'formal_write' and events[-1] == 'downstream'
    assert ('candidate' in events) == (fault != 'capture')
    assert result['metrics']['recommendation_row_closure_passed'] is True
    assert result['metrics']['recommendations_updated'] == 1
    assert result['status'] == ('completed' if fault == 'waiting' else 'error')
    assert result['advisory_errors'] == []
    assert bool(result['critical_errors']) == (fault != 'waiting')
    assert db.query('SELECT * FROM fixture_recommendations', []) == [{'symbol': '2330', 'weight': .2}]


@pytest.mark.parametrize('value', [None, {}, {'status': 'allocation_context_frozen', 'snapshot_id': 'id'}])
def test_terminal_cannot_close_when_nav_node_was_omitted(value):
    from graphs.daily_pipeline_v2 import _pipeline_terminal_result
    from test_pipeline_terminal_truth import _closed_metrics
    result = _pipeline_terminal_result({'metrics': _closed_metrics(), 'paired_nav_collection': value},
        run_date='2026-09-07', elapsed=0)
    assert result['status'] == 'error'
    assert result['critical_errors'][0].startswith('paired_nav:')


def test_setup_retry_reuses_sealed_parent_and_does_not_clear_unrelated_error(monkeypatch):
    import graphs.daily_pipeline_v2 as graph
    from services import paired_nav_candidate_collection as candidates
    from test_pipeline_terminal_truth import _closed_metrics
    db, calls = DB(legacy_assessments=False), []
    original = seal_context(db)
    before = db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])
    def collect(**kw):
        calls.append(kw['snapshot_id'])
        if len(calls) == 1:
            raise ValueError('paired_nav_candidate_payload_unavailable')
        return {'status': 'awaiting_frozen_l4_candidate', 'plans': []}
    monkeypatch.setattr(candidates, 'collect_candidate_allocations', collect)
    failed = complete_pipeline_shadow(original, query=db.query, writer=db.writer)
    assert failed['status'] == 'failed'
    recovered = complete_pipeline_shadow(failed, query=db.query, writer=db.writer)
    assert recovered['status'] == 'awaiting_frozen_l4_candidate'
    assert 'reason' not in recovered
    assert calls == [original['snapshot_id']] * 2
    assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1', []) == before
    for other_errors, expected in [([], 'completed'), (['d1_write: failure'], 'error')]:
        result = graph._pipeline_terminal_result({'metrics': _closed_metrics(),
            'paired_nav_collection': recovered, 'errors': other_errors}, run_date='2026-09-07', elapsed=0)
        assert result['status'] == expected
        assert result['critical_errors'] == other_errors


def test_missing_original_capture_is_not_silently_reconstructed(monkeypatch):
    from services import paired_nav_candidate_collection as candidates
    monkeypatch.setattr(candidates, 'collect_candidate_allocations',
        lambda **kw: pytest.fail('missing original capture cannot be reconstructed'))
    failed = capture.shadow_failure('allocation_context_seal', RuntimeError('no receipt'))
    db = DB()
    assert complete_pipeline_shadow(failed, query=db.query, writer=db.writer) == failed


@pytest.mark.parametrize('setup_failure', [False, True])
def test_actual_modal_callback_runs_nav_after_write_and_before_terminal(monkeypatch, setup_failure):
    import graphs.daily_pipeline_v2 as graph
    from test_pipeline_modal_prediction_callback_fail_closed import _state, _bundle, _callback
    from test_pipeline_terminal_truth import _closed_metrics
    state, events = _state(), []
    db = DB(legacy_assessments=False)
    threaded = sqlite3.connect(':memory:', check_same_thread=False)
    db.conn.backup(threaded)
    db.conn.close()
    db.conn, threaded.row_factory = threaded, sqlite3.Row
    manifest = freeze_snapshot(signal_date=state['run_date'], source_run_id='callback-test',
        snapshot_kind='allocation_context', content={'status': 'not_applicable_no_formal_ml_ensemble'},
        query=db.query, writer=db.writer)
    state['paired_nav_collection'] = {'snapshot_id': manifest['snapshot_id'],
        'status': 'not_applicable_no_formal_ml_ensemble', 'nav_maturity_credit': 0}
    monkeypatch.setattr(graph, '_read_pipeline_async_state_artifact', lambda uri: deepcopy(state))
    def query(sql, params):
        if setup_failure:
            raise RuntimeError('D1 temporary failure')
        return db.query(sql, params)
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=query, batch_execute=db.writer))
    async def noop(state):
        return {}
    for name in ['node_l3_formal_predict', 'node_compute_personas', 'node_recommend', 'node_llm_reasons',
                 'node_compute_sector_flow', 'node_compute_pit_residual_shadow', 'node_export_dataset_snapshot']:
        monkeypatch.setattr(graph, name, noop)
    async def write(state):
        events.append('formal_write')
        return {'metrics': _closed_metrics()}
    real_setup = graph.node_paired_nav_setup
    async def setup(state):
        events.append('nav_setup')
        return await real_setup(state)
    monkeypatch.setattr(graph, 'node_write_d1', write)
    monkeypatch.setattr(graph, 'node_paired_nav_setup', setup)
    result = asyncio.run(graph.run_pipeline_v2_from_modal_prediction_callback(_callback(_bundle())))
    assert events == ['formal_write', 'nav_setup'], result
    assert result['status'] == ('error' if setup_failure else 'completed'), result
    assert bool(result['critical_errors']) == setup_failure


@pytest.mark.parametrize('partial_failure,missing_seed,prereg_failure', [
    (False, False, None), (True, False, None), (False, True, None),
    (False, False, 'load'), (False, False, 'inference'), (False, False, 'seal')])
def test_real_candidates_native_registration_readback_and_partial_retry(environment, native_runner, monkeypatch, partial_failure, missing_seed, prereg_failure):
    from services import paired_native_runtime as native, paired_nav_candidate_collection as candidates
    from services.native_paper_source_capture import ImmutableNativeObjects
    from services.native_paper_sandbox import native_runtime_manifest
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_native_paper_source_capture import Bucket
    from test_paired_native_registration import calendar, NOW
    db, bucket, parent, _ = environment
    source, source_query = source_fixture()
    try:
        # The real candidate fixture contains two screener symbols, whereas
        # the generic native bootstrap fixture only supplies 2330.
        source.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(2,'2317','Hon Hai','TWSE')")
        if not missing_seed:
            source.execute("INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES('2026-09-07',2,'2317','Hon Hai',2,50,'seed')")
        objects = ImmutableNativeObjects(Bucket())
        owners = native_runtime_manifest(native_runner)['tables']
        context = {'schema_version': 'native-paper-source-context-v1', 'observed_at': NOW.isoformat(),
            'variables': {'FINLAB_L5_MARKET_DATA_ENABLED': '1', 'S12_INTRADAY_GATE_MODE': 'assist_entry'},
            'frozen_kv': {'ml:config': '{}', 'ml:config.debate_max_rounds': '3', 'ml:adaptive_params': None}}
        original_register, original_pair = native.register_candidate_execution_plans, native.register_allocation_pair
        calls = []
        def register_pair(**kw):
            calls.append(kw['snapshot_id'])
            if partial_failure and len(calls) == 2:
                raise RuntimeError('native_fixture_second_registration_interrupted')
            try:
                return original_pair(**kw)
            except Exception as exc:
                if missing_seed and str(exc) == 'native_registration_allocation_seed_coverage_missing':
                    raise
                pytest.fail(f'Unexpected isolated registration failure: {type(exc).__name__}: {exc}')
        monkeypatch.setattr(native, 'register_allocation_pair', register_pair)
        monkeypatch.setattr(candidates, '_bucket', lambda: bucket)
        monkeypatch.setattr(native, 'register_candidate_execution_plans', lambda **kw:
            original_register(**kw, objects=objects, domain_queries={d: source_query for d in set(owners.values())},
                kv_read=calendar, context_reader=lambda: context, runner=native_runner, clock=lambda: NOW))
        collection = {'status': 'allocation_context_frozen', 'snapshot_id': parent['snapshot_id'], 'nav_maturity_credit': 0}
        broken = db.query("SELECT * FROM model_artifact_registry WHERE model_name='allocator_ev_fusion'", [])[0]
        original_raw = bucket.payloads[broken['artifact_path']]
        original_infer, original_seal = candidates.infer_candidate_values, candidates.freeze_snapshot
        if prereg_failure == 'load':
            bucket.payloads[broken['artifact_path']] = b'{}'
        elif prereg_failure == 'inference':
            def infer(candidate, *args, **kwargs):
                if candidate['checksum'] == broken['checksum']:
                    raise ValueError('paired_nav_fixture_inference_failed')
                return original_infer(candidate, *args, **kwargs)
            monkeypatch.setattr(candidates, 'infer_candidate_values', infer)
        elif prereg_failure == 'seal':
            def seal(**kwargs):
                if kwargs['content'].get('candidate_checksum') == broken['checksum']:
                    raise RuntimeError('paired_nav_fixture_seal_failed')
                return original_seal(**kwargs)
            monkeypatch.setattr(candidates, 'freeze_snapshot', seal)
        before_source = source.total_changes
        result = complete_pipeline_shadow(collection, query=db.query, writer=db.writer)
        if prereg_failure:
            assert result['status'] == 'failed' and pipeline_shadow_errors(result)
            saved = db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'", [])
            assert len(saved) == 1  # Healthy L4 actually registered, not just planned.
            assert len(result['owner_failures']['expected_return']['candidate_failures']) == 1
            bucket.payloads[broken['artifact_path']] = original_raw
            monkeypatch.setattr(candidates, 'infer_candidate_values', original_infer)
            monkeypatch.setattr(candidates, 'freeze_snapshot', original_seal)
            result = complete_pipeline_shadow(result, query=db.query, writer=db.writer)
            assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [saved[0]['snapshot_id']]) == saved
        if missing_seed:
            assert result['status'] == 'failed'
            assert result['reason'] == 'native_registration_allocation_seed_coverage_missing'
            assert not db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'", [])
            assert source.total_changes == before_source
            return
        if partial_failure:
            assert result['status'] == 'failed'
            assert result['stage'] == 'native_registration'
            saved = db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_pair'", [])
            assert len(saved) == 1, (result.get('stage'), result.get('reason'))
            result = complete_pipeline_shadow(result, query=db.query, writer=db.writer)
            assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [saved[0]['snapshot_id']]) == saved
        assert result['status'] == 'native_execution_pairs_registered', (result.get('stage'), result.get('reason'))
        assert len(result['native_execution']['registrations']) == 2
        assert pipeline_shadow_errors(result) == []
        manifests = db.query('SELECT * FROM paired_nav_frozen_manifests_v1 ORDER BY snapshot_id', [])
        retry = complete_pipeline_shadow(result, query=db.query, writer=db.writer)
        assert retry == result
        assert len(calls) == (3 if partial_failure else 2)
        assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 ORDER BY snapshot_id', []) == manifests
        assert source.total_changes == before_source
    finally:
        source.close()
