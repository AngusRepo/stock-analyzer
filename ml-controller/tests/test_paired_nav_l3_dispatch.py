"""Fixed synthetic scores; real registry selection/normalization/allocator."""
from copy import deepcopy
import json

import pytest

from services import paired_nav_l3_dispatch as dispatch
from services.paired_nav_journal import digest, read_snapshot
from services.paired_nav_l3_candidate import collect_ensemble_allocations
from services.active8_ensemble_repository import _exact_artifact_row
from test_paired_nav_l3_candidate import prepared, fixed_artifact, seal, DAY, CUTOFF
from test_native_paper_sandbox import native_runner
from test_paired_nav_candidate_collection import environment
import graphs.daily_pipeline_v2 as graph


def add_base_rows(db, artifact):
    for name, identity in artifact['observation_artifacts'].items():
        metadata = {'target_semantic_version': graph.LABEL_SCHEMA_VERSION,
            'feature_semantic_version': graph.FORMAL_FEATURE_SEMANTIC_VERSION,
            'graph_context': {'semantic_version': graph.FORMAL_GNN_GRAPH_SEMANTIC_VERSION},
            'seq_len': 3, 'pred_len': 5}
        row = {**identity, 'model_name': name, 'state': 'shadowing',
            'artifact_path': f'{name}/{identity["version"]}.bin',
            'metadata_path': f'{name}/{identity["version"]}.json',
            'offline_gate_decision': 'PASS', 'live_gate_status': 'shadowing',
            'offline_evidence_json': json.dumps({'registration': {'metadata': metadata}})}
        db.conn.execute('INSERT INTO model_artifact_registry(' + ','.join(row) + ') VALUES('
                        + ','.join('?' for _ in row) + ')', list(row.values()))


def setup_dispatch(prepared):
    db, _, manifest, inputs, old = prepared
    db.conn.execute('ALTER TABLE model_artifact_registry ADD COLUMN metadata_path TEXT')
    add_base_rows(db, old['candidates'][0]['artifact'])
    second = fixed_artifact('candidate-v2')
    row = _exact_artifact_row(second, training_run_id=second['cohort_id'], archive_uri='gs://fixture/v2')
    row.update(created_at='2026-09-07 01:00:00', updated_at='2026-09-07 01:00:00')
    db.conn.execute('INSERT INTO active8_ensemble_artifacts_v1(' + ','.join(row) + ') VALUES('
                    + ','.join('?' for _ in row) + ')', list(row.values()))
    add_base_rows(db, second)
    series = [{'symbol': symbol, 'prices': [100, 101, 102, 103]} for symbol in inputs['predictions']]
    selection = dispatch.prepare_candidate_requests(signal_date=DAY, decision_cutoff=CUTOFF,
        sequence_series=series, query=db.query, project=graph._pipeline_modal_active8_shadow_projection,
        subsets=graph._sequence_model_subsets)
    assert len(selection['requests']) == 2
    state = {'run_date': DAY, 'producer_run_id': 'dispatch-test', 'paired_nav_l3_dispatch': selection,
        'pipeline_modal_serving_context': {'serving_manifest': manifest, 'expected_source_sha': 'a' * 40}}
    return state


def attach_outputs(state, inputs):
    selection = state['paired_nav_l3_dispatch']
    bundles = {}
    for index, request in enumerate(selection['requests']):
        manifest = deepcopy(state['pipeline_modal_serving_context']['serving_manifest'])
        manifest['active8_shadow_candidates'] = request['candidates']
        manifest['active8_shadow_suppressions'] = []
        ids = graph._pipeline_modal_active8_shadow_identities(manifest)
        ranks = {'2330': 0., '2317': 1., '2454': .5} if index == 0 else {'2330': 1., '2317': 0., '2454': .5}
        rows = [{'symbol': symbol, 'challenger_rank_scores': {name: rank for name in ids
                 if name not in graph.SEQUENCE_ALPHA_MODELS}} for symbol, rank in ranks.items()]
        sequences = {name: {'status': 'complete', 'identity': ids[name], 'results': [
            {'symbol': symbol, 'forecast_pct': ranks[symbol]} for symbol in inputs['predictions']]}
            for name in graph.SEQUENCE_ALPHA_MODELS}
        bundles[request['bundle_key']] = {'status': 'complete', 'result': {
            'serving_manifest_digest': digest(manifest), 'active8_shadow_artifact_identities': ids,
            'run_date': DAY, 'run_id': state['producer_run_id'], 'modal_source_sha': 'a' * 40,
            'predict_batch_v2_results': rows, 'active8_sequence_shadow_raw': {'candidates': sequences}}}
    state['modal_prediction_bundle'] = {'paired_nav_l3_inference': {
        'schema_version': 'paired-nav-l3-inference-v1', 'request_checksum': selection['request_checksum'],
        'production_effect': False, 'status': 'complete', 'bundles': bundles}}


def test_two_versions_keep_own_inference_through_real_allocator(prepared):
    db, bucket, manifest, inputs, _ = prepared
    state = setup_dispatch(prepared)
    attach_outputs(state, inputs)
    before = deepcopy(inputs)
    selection = dispatch.capture_candidate_selection(state=state, predictions=inputs['predictions'])
    receipt = seal((db, bucket, manifest, inputs, selection))
    result = collect_ensemble_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    assert len(result['plans']) == 2
    plans = [read_snapshot(db.query, p['snapshot_id'])['payload']['content'] for p in result['plans']]
    assert len({p['pair_id'] for p in plans}) == 2
    assert [p['candidate']['recommendations'][0]['symbol'] for p in plans] == ['2317', '2330']
    assert inputs == before
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])


def test_pinned_l3_comparisons_close_after_journal_and_move_to_new_config(prepared, monkeypatch):
    from datetime import datetime
    from services import paired_nav_l3_candidate as l3
    from services.paired_nav_journal import freeze_snapshot, stage_execution_receipt, mature_staged_pairs
    from test_paired_nav_journal import packet, receipt, FEES
    db, bucket, manifest, inputs, _ = prepared
    state = setup_dispatch(prepared)
    attach_outputs(state, inputs)
    selected = dispatch.capture_candidate_selection(state=state, predictions=inputs['predictions'])
    origin = seal((db, bucket, manifest, inputs, selected))
    old = collect_ensemble_allocations(snapshot_id=origin['snapshot_id'], query=db.query, writer=db.writer)
    now = datetime.fromisoformat('2026-09-08T14:00:00+00:00')
    for item in old['plans']:
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        p = packet()
        p.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
        p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': '2026-09-08T00:00:00Z'}])
        p['configuration_checksum'] = digest(p['configuration'])
        registered = freeze_snapshot(signal_date=DAY, source_run_id=p['pair_id'], snapshot_kind='execution_pair',
            content=p, query=db.query, writer=db.writer, now=datetime.fromisoformat('2026-09-07T14:00:00+00:00'))
        stage_execution_receipt(execution=receipt(p, registered), query=db.query, writer=db.writer, now=now)
    mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=now)
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
    pins = dispatch.registered_candidate_pins(signal_date='2026-09-08', query=db.query)
    assert len(pins) == 2
    # Synthetic next-day forecasts use the same values, with fresh input envelopes.
    state['run_date'] = '2026-09-08'
    state['paired_nav_l3_dispatch'] = dispatch.prepare_candidate_requests(signal_date='2026-09-08',
        decision_cutoff='2026-09-08T10:00:00Z', sequence_series=[{'symbol': s, 'prices': [1, 2, 3, 4]}
        for s in inputs['predictions']], query=db.query, project=graph._pipeline_modal_active8_shadow_projection,
        subsets=graph._sequence_model_subsets)
    attach_outputs(state, inputs)
    for item in state['modal_prediction_bundle']['paired_nav_l3_inference']['bundles'].values():
        item['result']['run_date'] = '2026-09-08'
    selected = dispatch.capture_candidate_selection(state=state, predictions=inputs['predictions'])
    context = deepcopy(read_snapshot(db.query, origin['snapshot_id'])['payload']['content'])
    # A new business-day parent needs its own pre-inference registry inventory.
    # Keep the previous parent's immutable selection untouched, not relabelled.
    from services.paired_nav_opb_candidate import select_opb_candidates
    context['opb_candidate_selection'] = select_opb_candidates(
        query=db.query, signal_date='2026-09-08', now=now)
    from services.paired_nav_recommendation_path import run_and_capture_recommendation_path
    from services.paired_nav_intervention import run_isolated_allocation
    next_inputs = deepcopy(context['recommendation_context']['inputs'])
    next_inputs['filter_options']['run_date'] = '2026-09-08'
    output, rec_context = run_and_capture_recommendation_path(inputs=next_inputs, candidate_reader=lambda: selected)
    context['recommendation_context'] = rec_context
    context['inputs']['recommendations'] = output['recommendations']
    baseline = run_isolated_allocation(inputs=context['inputs'], inherited_state={})
    context['formal_output'], context['capture'] = baseline['output'], baseline['capture']
    context['risk_config']['maxSingleNamePct'] = .20
    next_parent = freeze_snapshot(signal_date='2026-09-08', source_run_id='next-l3', snapshot_kind='allocation_context',
        content=context, query=db.query, writer=db.writer, now=now)
    monkeypatch.setattr(l3, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=now))
    result = collect_ensemble_allocations(snapshot_id=next_parent['snapshot_id'], query=db.query, writer=db.writer)
    assert len(result['lifecycle_transition_plan']) == 2
    assert result['lifecycle_transitions'] == []
    assert all(event['final_evidence']['exact_nav_sessions'] == 1 for event in result['lifecycle_transition_plan'])
    assert {p['pair_id'] for p in old['plans']}.isdisjoint(p['pair_id'] for p in result['plans'])
    # A process interruption before native registration cannot unpin archived models.
    db.conn.execute("UPDATE active8_ensemble_artifacts_v1 SET state='archived'")
    kept = dispatch.prepare_candidate_requests(signal_date='2026-09-09', decision_cutoff='2026-09-09T10:00:00Z',
        sequence_series=[], query=db.query, project=graph._pipeline_modal_active8_shadow_projection,
        subsets=graph._sequence_model_subsets)
    assert len(kept['candidates']) == 2
    from test_paired_nav_lifecycle import register_successors, commit
    register_successors(db, result['plans'])
    assert commit(db, result) == result['lifecycle_transition_plan']
    assert dispatch.registered_candidate_pins(signal_date='2026-09-08', query=db.query) == []
    assert len(dispatch.registered_candidate_pins(signal_date='2026-09-09', query=db.query)) == 2
    assert collect_ensemble_allocations(snapshot_id=next_parent['snapshot_id'], query=db.query, writer=db.writer) == result
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == before
    assert read_snapshot(db.query, origin['snapshot_id'])['payload']['content'][
        'opb_candidate_selection']['signal_date'] == DAY
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])


@pytest.mark.parametrize('fault', ['missing_bundle', 'wrong_request', 'wrong_base', 'wrong_date', 'wrong_source', 'partial_features', 'failed_sequence'])
def test_candidate_failure_never_uses_latest_or_formal_fallback(prepared, fault):
    _, _, _, inputs, _ = prepared
    state = setup_dispatch(prepared)
    attach_outputs(state, inputs)
    inference = state['modal_prediction_bundle']['paired_nav_l3_inference']
    key = next(iter(inference['bundles']))
    bundle = inference['bundles'][key]['result']
    if fault == 'missing_bundle': inference['bundles'].pop(key)
    elif fault == 'wrong_request': inference['request_checksum'] = 'wrong'
    elif fault == 'wrong_base': bundle['active8_shadow_artifact_identities']['LightGBM']['version'] = 'wrong'
    elif fault == 'wrong_date': bundle['run_date'] = '2026-09-08'
    elif fault == 'wrong_source': bundle['modal_source_sha'] = 'b' * 40
    elif fault == 'partial_features': bundle['predict_batch_v2_results'].pop()
    elif fault == 'failed_sequence': bundle['active8_sequence_shadow_raw']['candidates']['DLinear']['status'] = 'failed'
    original = deepcopy(inputs)
    with pytest.raises(ValueError, match='paired_nav_l3_dispatch_'):
        dispatch.capture_candidate_selection(state=state, predictions=inputs['predictions'])
    assert inputs == original


def test_registry_artifact_missing_is_not_silently_latest_only(prepared):
    db, *_ = prepared
    state = setup_dispatch(prepared)
    db.conn.execute("DELETE FROM model_artifact_registry WHERE model_name='TabM' AND version='candidate-v1'")
    with pytest.raises(ValueError, match='base_registry_missing'):
        dispatch.prepare_candidate_requests(signal_date=DAY, decision_cutoff=CUTOFF,
            sequence_series=[], query=db.query, project=graph._pipeline_modal_active8_shadow_projection,
            subsets=graph._sequence_model_subsets)


def test_real_registered_candidate_survives_mutable_registry_retirement(prepared, native_runner):
    from test_paired_nav_l3_candidate import test_real_native_registration_keeps_each_models_actual_buy_slate
    db, _, _, inputs, _ = prepared
    test_real_native_registration_keeps_each_models_actual_buy_slate(prepared, native_runner)
    setup_dispatch(prepared)
    old = fixed_artifact('candidate-v1')
    db.conn.execute("UPDATE active8_ensemble_artifacts_v1 SET state='archived' WHERE payload_checksum=?", [old['payload_checksum']])
    db.conn.execute("UPDATE model_artifact_registry SET state='archived' WHERE version='candidate-v1'")
    result = dispatch.prepare_candidate_requests(signal_date='2026-09-08', decision_cutoff='2026-09-08T10:00:00Z',
        sequence_series=[{'symbol': s, 'prices': [1, 2, 3, 4]} for s in inputs['predictions']],
        query=db.query, project=graph._pipeline_modal_active8_shadow_projection, subsets=graph._sequence_model_subsets)
    assert len(result['candidates']) == len(result['requests']) == 2
    pinned = next(c for c in result['candidates'] if c['artifact']['payload_checksum'] == old['payload_checksum'])
    assert len(pinned['registered_pairs']) == 1
    assert pinned['registry']['state'] == 'candidate'  # original immutable admission, not a registry rewrite
    assert db.query('SELECT state FROM active8_ensemble_artifacts_v1 WHERE payload_checksum=?', [old['payload_checksum']])[0]['state'] == 'archived'
    prior_request = next(item for item in result['requests'] if item['bundle_key'] == pinned['bundle_key'])
    assert {item['registry_state'] for item in prior_request['candidates']} == {'archived'}
    assert {item['artifact_id'] for item in prior_request['candidates']} == {
        item['artifact_id'] for item in old['observation_artifacts'].values()}
    assert all(item['production_effect'] is False and item['vote_weight'] == 0
               for item in prior_request['candidates'])
    assert {row['state'] for row in db.query(
        "SELECT state FROM model_artifact_registry WHERE version='candidate-v1'", [])} == {'archived'}
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])


def test_declared_sequence_unavailability_preserves_missingness_not_fake_scores(prepared):
    _, _, _, inputs, _ = prepared
    state = setup_dispatch(prepared)
    selection = state['paired_nav_l3_dispatch']
    for request in selection['requests']:
        request['sequence_series_by_model']['DLinear'] = []
    selection['request_checksum'] = digest(selection['requests'])
    attach_outputs(state, inputs)
    for record in state['modal_prediction_bundle']['paired_nav_l3_inference']['bundles'].values():
        seq = record['result']['active8_sequence_shadow_raw']['candidates']['DLinear']
        seq.update(status='insufficient_sequence_input', results=[], n_input=0, n_success=0)
    captured = dispatch.capture_candidate_selection(state=state, predictions=inputs['predictions'])
    for arm in captured['predictions_by_bundle'].values():
        assert all('DLinear' not in p['challenger_rank_scores'] for p in arm.values())
        assert all(p['challenger_model_score_lineage']['complete'] for p in arm.values())


def test_actual_payload_builder_freezes_every_candidate_before_spawn(prepared, monkeypatch):
    import asyncio
    from datetime import datetime, timezone
    from types import SimpleNamespace
    db, _, manifest, inputs, _ = prepared
    dispatch_state = setup_dispatch(prepared)
    manifest = {**manifest, 'schema_version': graph.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
                'active8_shadow_candidates': dispatch_state['paired_nav_l3_dispatch']['requests'][0]['candidates']}
    series = [{'symbol': s, 'prices': [1, 2, 3, 4],
               'observed_at': datetime(2026, 9, 7, 6, tzinfo=timezone.utc)} for s in inputs['predictions']]
    state = {'run_date': DAY, 'producer_run_id': 'payload-test',
        'decision_universe_frozen_at': CUTOFF, 'payloads': inputs['payloads'],
        'pipeline_modal_serving_context': {'schema_version': 'pipeline-modal-serving-context-v1',
            'serving_manifest': manifest, 'serving_manifest_digest': digest(manifest),
            'serving_pool': {}, 'model_status': {}, 'active_versions': {}, 'expected_source_sha': 'a' * 40}}
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=db.query))
    monkeypatch.setattr(graph, 'batch_predict_contract', lambda **kw: {'chunk_size': 3})
    monkeypatch.setattr(graph, 'build_state_space_series_from_payloads', lambda rows: series)
    monkeypatch.setattr(graph, 'enrich_state_space_series_with_long_history', lambda *a, **kw: (series, {}))
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_url', lambda: 'https://fixture.invalid')
    monkeypatch.setattr(graph, '_pipeline_modal_prediction_callback_token', lambda: 'fixture-not-real')
    result = asyncio.run(graph._build_pipeline_modal_prediction_payload(state, state_gcs_uri='gs://fixture/state'))
    assert len(result['paired_nav_l3_requests']) == 2
    assert state['paired_nav_l3_dispatch']['request_checksum'] == digest(result['paired_nav_l3_requests'])
    assert result['serving_manifest'] == manifest
    assert result['sequence_series'] == graph._json_safe(series)
    assert result['paired_nav_l3_requests'][0]['sequence_series_by_model']['DLinear'] == result['sequence_series']


def test_changed_configuration_cannot_reset_registered_pair(prepared):
    db, bucket, manifest, inputs, _ = prepared
    state = setup_dispatch(prepared)
    attach_outputs(state, inputs)
    selection = dispatch.capture_candidate_selection(state=state, predictions=inputs['predictions'])
    selection['candidates'][0]['registered_pairs'] = [{'pair_id': 'another-configuration'}]
    receipt = seal((db, bucket, manifest, inputs, selection))
    with pytest.raises(ValueError, match='registered_pin_invalid'):
        collect_ensemble_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
