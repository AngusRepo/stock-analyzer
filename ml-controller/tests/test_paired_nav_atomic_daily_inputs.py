"""Real daily capture/build nodes, with all external reads replaced locally."""
import asyncio
from copy import deepcopy
import sqlite3
from types import SimpleNamespace

import pytest

from services import paired_nav_atomic_inputs as atomic
from services import payload_builder as builder
from services.paired_nav_journal import digest
from test_paired_nav_atomic_payload_boundary import _frozen_loaders


def _population():
    def row(symbol):
        return {'seed': {'row': {'symbol': symbol, 'name': symbol, 'sector': 'Semiconductor'}},
                'marketSegment': 'LISTED', 'eligibleForPendingBuy': True, 'watchPoints': []}
    return {'schema_version': 'atomic-canonical-population-v1', 'signal_date': '2026-09-06',
        'producer_run_id': 'pinned-screener', 'source_checksum': 'a' * 64,
        'canonical_artifact_id': 'canonical', 'canonical_artifact_checksum': 'sha256:' + 'b' * 64,
        'source_observed_at': '2026-09-06T12:00:00Z', 'artifact_created_at': '2026-09-06T12:01:00Z',
        'decision_deadline': '2026-09-06T12:02:00Z', 'source_input_status': 'incomplete',
        'baseline': {'status': 'matched', 'rows': [row('1000'), row('1001')]},
        'replacements': [{'definition_checksum': 'c' * 64, 'replacement': {'candidateId': 'new', 'incumbentId': 'base'},
            'candidate': {'status': 'materialized', 'rows': [row('1000'), row('1002')]}},
            {'definition_checksum': 'd' * 64, 'replacement': {'candidateId': 'pending', 'incumbentId': 'base'},
             'candidate': {'status': 'unavailable', 'reason': 'breeze2:candidate_request_not_observed',
                           'pending_semantic_requests': [{'symbol': '1002'}]}}],
        'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}


def _setup(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    from test_paired_nav_journal import DB
    nav = DB(legacy_assessments=False)
    nav.conn.commit()
    threaded = sqlite3.connect(':memory:', check_same_thread=False)
    nav.conn.backup(threaded)
    nav.conn.close()
    nav.conn = threaded
    nav.conn.row_factory = sqlite3.Row
    monkeypatch.setattr(graph, 'LEARNING_D1_CLIENT', SimpleNamespace(query=nav.query, batch_execute=nav.writer))
    paper = sqlite3.connect(':memory:', check_same_thread=False)
    paper.row_factory = sqlite3.Row
    paper.executescript('CREATE TABLE paper_accounts(id INTEGER PRIMARY KEY); INSERT INTO paper_accounts VALUES(1);'
        'CREATE TABLE paper_positions(account_id INTEGER,symbol TEXT,shares REAL);'
        'CREATE TABLE paper_corporate_entitlements_v1(account_id INTEGER,action_id TEXT,symbol TEXT,shares_due REAL,settled INTEGER);')
    monkeypatch.setattr(graph, 'PAPER_D1_CLIENT', SimpleNamespace(
        query=lambda sql,args:[dict(r) for r in paper.execute(sql,args)], connection=paper))
    from datetime import datetime, timezone
    from services import paired_nav_native_holdings as holdings
    capture = holdings.capture_native_holdings
    monkeypatch.setattr(holdings, 'capture_native_holdings', lambda **kw: capture(**{
        'now': datetime(2026,9,6,13,tzinfo=timezone.utc), **kw}))
    raw = _frozen_loaders(monkeypatch)
    formal = builder.build_ml_universe(raw[:2], [])
    reads = []
    async def worker(path, **kwargs):
        assert path == atomic.PATH and kwargs['method'] == 'POST'
        assert kwargs['json_body']['producerRunId'] == 'pinned-screener'
        reads.append(('worker', kwargs))
        # Match the requested read cutoff, not a historical PIT claim.
        return {**_population(), 'decision_deadline': kwargs['json_body']['decisionDeadline']}
    def identities(sql, params):
        assert sql.startswith('SELECT id,symbol FROM stocks WHERE symbol IN (')
        reads.append(('identities', params))
        return [{'id': r['id'], 'symbol': r['symbol']} for r in raw if r['symbol'] in params]
    from services import worker_config_client
    monkeypatch.setattr(worker_config_client, 'worker_fetch', worker)
    monkeypatch.setattr(builder.CORE_D1_CLIENT, 'query', identities)
    return graph, {'run_date': '2026-09-06', 'screener_run_id': 'pinned-screener',
                   'active_stocks': formal, 'market_env': {}}, reads


def test_actual_daily_capture_and_own_slate_builder_keep_formal_and_retry_inputs(monkeypatch):
    graph, state, reads = _setup(monkeypatch)
    before = deepcopy(state)
    captured = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert state == before
    assert captured['paired_nav_atomic_inputs']['status'] == 'pre_l2_inputs_captured'
    assert captured['paired_nav_atomic_inputs']['population']['source_input_status'] == 'incomplete'
    assert [r['symbol'] for r in captured['payload_source_observations']['stocks']] == ['1000', '1001', '1002']
    assert [r[0] for r in reads] == ['worker', 'identities']
    state.update(captured)
    output = asyncio.run(graph.node_build_payloads(state))
    candidate = output['paired_nav_atomic_pre_l2']['slates']['c' * 64]
    assert [p['symbol'] for p in output['payloads']] == ['1000', '1001']
    assert [p['symbol'] for p in candidate] == ['1000', '1002']
    assert output['payloads'][0]['stock_meta']['sector_peer_return_1d'] == 0
    assert candidate[0]['stock_meta']['sector_peer_return_1d'] == .2
    assert output['payloads'][0]['prices'] == candidate[0]['prices']
    # The unavailable definition remains in the population, not an empty slate.
    assert len(state['paired_nav_atomic_inputs']['population']['replacements']) == 2
    assert 'd' * 64 not in output['paired_nav_atomic_pre_l2']['slates']
    for read in ('capture_payload_sources',):
        monkeypatch.setattr(builder, read, lambda *a, **k: pytest.fail('read on retry'))
    monkeypatch.setattr(atomic, 'read_daily_population', lambda **k: pytest.fail('read population on retry'))
    monkeypatch.setattr(builder.CORE_D1_CLIENT, 'query', lambda *a: pytest.fail('read IDs on retry'))
    assert asyncio.run(graph.node_capture_atomic_inputs(state)) == {}
    assert asyncio.run(graph.node_build_payloads(state)) == output
    output['payloads'][0]['prices'][0]['close'] = 999
    assert candidate[0]['prices'][0]['close'] == 100
    assert state['payload_source_observations']['sources']['prices_by_id']['1'][0]['close'] == 100


def test_held_stock_gets_separate_payload_not_a_recommendation(monkeypatch):
    graph, state, _ = _setup(monkeypatch)
    paper = graph.PAPER_D1_CLIENT.connection
    paper.execute("INSERT INTO paper_positions VALUES(1,'1001',100)")
    paper.commit()
    changes = paper.total_changes
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    source = state['paired_nav_atomic_inputs']
    definition = source['native_holdings']['definitions']['c'*64]
    assert definition['arms'] == {'baseline':['1001'], 'candidate':['1001']}
    assert [r['symbol'] for r in source['candidate_stocks']['c'*64]] == ['1000','1002']
    assert len(source['holding_scopes']) == 1
    scope_id, scope = next(iter(source['holding_scopes'].items()))
    assert scope['arm'] == 'candidate' and scope['target_symbol'] == '1001'
    output = asyncio.run(graph.node_build_payloads(state))
    assert output['payloads'][0]['stock_meta']['sector_peer_return_1d'] == 0
    assert output['paired_nav_atomic_pre_l2']['slates']['c'*64][0]['stock_meta']['sector_peer_return_1d'] == .2
    auxiliary = output['paired_nav_atomic_pre_l2']['holding_slates'][scope_id]
    assert [r['symbol'] for r in auxiliary] == ['1000','1001','1002']
    assert auxiliary[1]['stock_meta']['sector_peer_return_1d'] == .1
    assert auxiliary[1]['stock_meta']['eligible_for_pending_buy'] is False
    assert paper.total_changes == changes
    paper.execute("UPDATE paper_positions SET shares=500")
    assert asyncio.run(graph.node_capture_atomic_inputs(state)) == {}
    assert state['paired_nav_atomic_inputs'] == source  # Already frozen observations cannot drift.


def test_initial_holdings_source_failure_is_not_zero_holdings(monkeypatch):
    graph, state, _ = _setup(monkeypatch)
    def unavailable(*args):
        raise RuntimeError('paper_source_unavailable')
    monkeypatch.setattr(graph.PAPER_D1_CLIENT, 'query', unavailable)
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    source = state['paired_nav_atomic_inputs']['native_holdings']
    assert all(r['status']=='failed' for r in source['definitions'].values())
    assert source['initial_observation']['status']=='failed'
    assert state['active_stocks'][0]['symbol']=='1000'


def test_existing_private_exit_does_not_remove_successor_bootstrap_forecasts(monkeypatch):
    from services.paired_nav_native_holdings import attach_holding_scopes, validate_holding_prediction_coverage
    graph, state, _ = _setup(monkeypatch)
    graph.PAPER_D1_CLIENT.connection.execute("INSERT INTO paper_positions VALUES(1,'1001',100)")
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    packet = state['paired_nav_atomic_inputs']
    source = deepcopy(packet['native_holdings'])
    # Synthetic source contrast: old private accounts exited, but a new model /
    # configuration comparison would bootstrap the still-held formal symbol.
    member = source['definitions']['c'*64]
    member.update(source_kind='verified_native_carry', arms={'baseline':[], 'candidate':[]})
    source['source_checksum'] = digest({k:v for k,v in source.items() if k!='source_checksum'})
    output = attach_holding_scopes(packet, source, core_query=builder.CORE_D1_CLIENT.query)
    assert output['native_holdings']['definitions']['c'*64]['arms']=={'baseline':[], 'candidate':[]}
    assert len(output['holding_scopes'])==1
    scope_id, scope = next(iter(output['holding_scopes'].items()))
    assert scope['arm']=='candidate' and scope['target_symbol']=='1001'
    assert [r['symbol'] for r in output['candidate_stocks']['c'*64]]==['1000','1002']
    definition = {'holding_predictions':[dict(scope_checksum=scope_id,arm='candidate',target_symbol='1001')]}
    validate_holding_prediction_coverage(definition, definition_checksum='c'*64,arm='candidate',
        predictions={'1000':{},'1001':{},'1002':{}},selection_symbols=['1000','1002'],source=source)
    assert output['native_holdings']['initial_observation']['rows']['positions'][0]['shares']==100


@pytest.mark.parametrize('fault', ['identity', 'eligibility', 'population-date', 'duplicate-definition', 'future', 'malformed-state'])
def test_invalid_candidate_capture_does_not_erase_formal_recommendation_inputs(monkeypatch, fault):
    graph, state, reads = _setup(monkeypatch)
    population = _population()
    if fault == 'identity':
        monkeypatch.setattr(builder.CORE_D1_CLIENT, 'query', lambda *a: [])
    if fault == 'eligibility': population['baseline']['rows'][0]['eligibleForPendingBuy'] = False
    if fault == 'population-date': population['signal_date'] = '2026-09-05'
    if fault == 'duplicate-definition': population['replacements'].append(deepcopy(population['replacements'][0]))
    if fault == 'future': population['artifact_created_at'] = '2100-01-01T00:00:00Z'
    if fault == 'malformed-state': population['replacements'][0]['candidate']['status'] = 'complete'
    async def read(**kwargs): return population
    monkeypatch.setattr(atomic, 'read_daily_population', read)
    update = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert update['paired_nav_atomic_inputs']['status'] == 'failed'
    assert 'payload_source_observations' not in update
    state.update(update)
    output = asyncio.run(graph.node_build_payloads(state))
    assert [p['symbol'] for p in output['payloads']] == ['1000', '1001']
    assert 'paired_nav_atomic_pre_l2' not in output


def test_frozen_state_cannot_switch_screener_run_or_add_new_live_candidate(monkeypatch):
    graph, state, _ = _setup(monkeypatch)
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    state['screener_run_id'] = 'other-run'
    update = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert update['paired_nav_atomic_inputs']['reason'] == 'paired_nav_atomic_frozen_inputs_invalid'
    del state['paired_nav_atomic_inputs']
    update = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert update['paired_nav_atomic_inputs']['reason'] == 'paired_nav_atomic_capture_after_formal_freeze'


def test_daily_graph_reaches_capture_before_formal_payloads_and_l2():
    from graphs import daily_pipeline_v2 as graph
    edges = {(e.source, e.target) for e in graph.build_graph().get_graph().edges}
    assert ('load_market_env', 'capture_atomic_inputs') in edges
    assert ('capture_atomic_inputs', 'build_payloads') in edges
    assert ('build_payloads', 'l2_timesfm_enrich') in edges


def test_empty_population_is_distinct_from_missing_or_uncomputed_candidates(monkeypatch):
    from services.paired_nav_pipeline import pipeline_shadow_errors
    graph, state, _ = _setup(monkeypatch)
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    state.update(asyncio.run(graph.node_build_payloads(state)))
    status = atomic.daily_setup_status(state)
    assert status['status'] == 'incomplete'
    assert status['replacement_count'] == 2 and status['unavailable_replacement_count'] == 1
    collection = {'snapshot_id': 'real-other-lane', 'status': 'native_execution_pairs_registered', 'atomic_daily': status}
    assert pipeline_shadow_errors(collection) == ['paired_nav:atomic_daily:requires_l2_ml_and_native_execution']
    # A genuinely empty canonical population needs no fabricated predictions.
    empty = _population()
    empty['replacements'] = []
    packet = atomic.prepare_daily_inputs(empty, signal_date=state['run_date'], producer_run_id=state['screener_run_id'],
        formal_stocks=state['active_stocks'], query=builder.CORE_D1_CLIENT.query)
    state['paired_nav_atomic_inputs'] = packet
    collection['atomic_daily'] = atomic.daily_setup_status(state)
    assert collection['atomic_daily']['status'] == 'no_structural_candidates'
    assert pipeline_shadow_errors(collection) == []
    del packet['population']['replacements']
    collection['atomic_daily'] = atomic.daily_setup_status(state)
    assert pipeline_shadow_errors(collection), 'absent or corrupt population is not an empty population'


def test_actual_terminal_setup_preserves_other_registered_nav_lanes(monkeypatch):
    from services import paired_nav_pipeline
    graph, state, _ = _setup(monkeypatch)
    state.update(asyncio.run(graph.node_capture_atomic_inputs(state)))
    state.update(asyncio.run(graph.node_build_payloads(state)))
    existing = {'snapshot_id': 'immutable', 'status': 'native_execution_pairs_registered',
                'native_execution': {'registrations': [{'snapshot_id': 'existing-ev'}]}}
    monkeypatch.setattr(paired_nav_pipeline, 'complete_pipeline_shadow', lambda *a, **k: deepcopy(existing))
    update = asyncio.run(graph.node_paired_nav_setup(state))
    assert update['paired_nav_collection']['native_execution'] == existing['native_execution']
    assert update['paired_nav_collection']['atomic_daily']['status'] == 'incomplete'
    assert 'atomic_daily' not in existing
    from test_pipeline_terminal_truth import _closed_metrics
    terminal = graph._pipeline_terminal_result({**state, **update, 'metrics': _closed_metrics(), 'errors': []},
                                               run_date=state['run_date'], elapsed=1)
    assert terminal['status'] == 'error'
    assert terminal['critical_errors'] == ['paired_nav:atomic_daily:requires_l2_ml_and_native_execution']


def test_actual_async_entry_retains_candidate_inputs_in_compressed_handoff(monkeypatch):
    from google.cloud import storage
    from test_pipeline_modal_handoff import StorageClient
    graph, inputs, reads = _setup(monkeypatch)
    memory = StorageClient()
    monkeypatch.setenv('GCS_BUCKET_NAME', 'isolated-nav-handoff')
    monkeypatch.setattr(storage, 'Client', lambda: memory)
    async def load(state):
        return {key: deepcopy(value) for key, value in inputs.items() if key != 'run_date'}
    async def no_op(state): return {}
    # Only model/policy/network primitives are replaced. Execute the real entry,
    # raw capture, stock/slate builder and state envelope writer/reader.
    monkeypatch.setattr(graph, 'node_load_inputs', load)
    monkeypatch.setattr(graph, 'node_load_market_env', no_op)
    monkeypatch.setattr(graph, 'node_l2_timesfm_enrich', no_op)
    monkeypatch.setattr(graph, '_attach_pipeline_modal_serving_context', no_op)
    async def request(state, *, state_gcs_uri):
        assert state['paired_nav_atomic_pre_l2']['status'] == 'pre_l2_payloads_built'
        return {'payloads': deepcopy(state['payloads']), 'state_gcs_uri': state_gcs_uri}
    monkeypatch.setattr(graph, '_build_pipeline_modal_prediction_payload', request)
    received = []
    def spawn(payload):
        restored = graph._read_pipeline_async_state_artifact(payload['state_gcs_uri'])
        assert restored['payloads'] == payload['payloads']
        received.append(restored)
        return {'n_input': len(payload['payloads']), 'function_call_id': 'local-only'}
    monkeypatch.setattr(graph, '_spawn_pipeline_prediction_bundle_from_artifact', spawn)
    result = asyncio.run(graph.run_pipeline_v2_until_modal_prediction_spawn('2026-09-06', 'local-atomic-entry'))
    assert result['status'] == 'deferred', result
    assert len(received) == 1 and [r[0] for r in reads] == ['worker', 'identities']
    restored = received[0]
    assert len(restored['paired_nav_atomic_inputs']['population']['replacements']) == 2
    assert restored['paired_nav_atomic_pre_l2']['slates']['c' * 64][0]['stock_meta']['sector_peer_return_1d'] == .2
    assert restored['payloads'][0]['stock_meta']['sector_peer_return_1d'] == 0
    atomic.validate_daily_inputs(restored['paired_nav_atomic_inputs'], signal_date=restored['run_date'],
        producer_run_id=restored['screener_run_id'], formal_stocks=restored['active_stocks'])
    before = deepcopy(restored)
    monkeypatch.setattr(atomic, 'read_daily_population', lambda **kw: pytest.fail('recapture restored source'))
    assert asyncio.run(graph.node_capture_atomic_inputs(restored)) == {}
    assert restored == before
