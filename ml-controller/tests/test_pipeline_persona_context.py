"""Original daily persona path with SQLite reads; never production writes."""
import asyncio
from copy import deepcopy
from datetime import date, timedelta
import sqlite3

import pytest

from test_paired_nav_atomic_dispatch import dispatched, _compute


def _payload(symbol='2330', stock_id=7):
    return {'symbol': symbol, 'stock_id': stock_id, 'chips': [
        {'date': (date(2026, 8, 10) + timedelta(days=i)).isoformat(),
         'trust_net': i + 1., 'margin_balance': 120. if i == 24 else 100.}
        for i in range(25)]}


@pytest.fixture
def with_chips(monkeypatch):
    import test_paired_nav_atomic_daily_inputs as daily
    from services import payload_builder
    original = daily._frozen_loaders
    def loaders(mp):
        stocks = original(mp)
        mp.setattr(payload_builder, '_bulk_load_chips', lambda symbols, **kwargs:
            {s: _payload(s)['chips'] for s in symbols})
        return stocks
    monkeypatch.setattr(daily, '_frozen_loaders', loaders)


@pytest.fixture
def persona_db(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.executescript('''
        CREATE TABLE finlab_taxonomy_tags(symbol TEXT, tag TEXT, tag_type TEXT,
            source TEXT, weight REAL, as_of_date TEXT, created_at TEXT);
        CREATE TABLE concept_buzz(date TEXT, concept TEXT, sentiment_avg REAL,
            source TEXT, created_at TEXT);
        INSERT INTO finlab_taxonomy_tags VALUES('2330','Semiconductor','industry_theme',
            'finlab.security_industry_themes',1,'2026-09-06','2026-09-06 00:00:00');
        INSERT INTO concept_buzz VALUES('2026-09-06','Semiconductor',0.8,'ptt','2026-09-06 10:00:00');
    ''')
    reads, writes = [], []
    def query(sql, args, **kwargs):
        reads.append((sql, deepcopy(args)))
        return [dict(r) for r in db.execute(sql, args)]
    monkeypatch.setattr(graph.MARKET_D1_CLIENT, 'query', query)
    monkeypatch.setattr(graph.kv_client, 'get', lambda key, **kwargs: None)
    monkeypatch.setattr(graph, 'write_persona_opinions',
        lambda client, rows: writes.append(deepcopy(rows)) or len(rows))
    yield graph, db, reads, writes
    db.close()


def test_daily_persona_uses_symbol_not_internal_stock_id(persona_db):
    graph, db, reads, writes = persona_db
    state = {'run_date': '2026-09-06', 'payloads': [_payload()]}
    result = asyncio.run(graph.node_compute_personas(state))
    assert set(result['persona_opinions']) == {'2330'}
    assert result['persona_opinions']['2330']['retail']['signal'] == 'CAUTION'
    assert [r.symbol for r in writes[0]] == ['2330']


def test_daily_persona_does_not_treat_early_september_as_quarter_end(persona_db):
    graph, db, reads, writes = persona_db
    result = asyncio.run(graph.node_compute_personas({'run_date': '2026-09-06', 'payloads': [_payload()]}))
    # Historical chips end at the decision, not at quarter end. There are far
    # more than ten remaining scheduled sessions in this test calendar.
    assert result['persona_opinions']['2330']['trust']['is_window_dress'] is False


def test_retry_keeps_first_observation_instead_of_reading_refreshed_buzz(persona_db):
    graph, db, reads, writes = persona_db
    state = {'run_date': '2026-09-06', 'payloads': [_payload()]}
    first = asyncio.run(graph.node_compute_personas(state))
    state.update(deepcopy(first))
    count = len(reads)
    db.execute('UPDATE concept_buzz SET sentiment_avg=-0.8')
    second = asyncio.run(graph.node_compute_personas(state))
    assert len(reads) == count
    assert second == first


def test_future_taxonomy_and_other_buzz_feeds_are_not_selected(persona_db):
    graph, db, reads, writes = persona_db
    db.executescript('''
        INSERT INTO finlab_taxonomy_tags VALUES('2330','Future','industry_theme',
            'finlab.security_industry_themes',99,'2026-09-07','2026-09-06 00:00:00');
        INSERT INTO concept_buzz VALUES('2026-09-06','Semiconductor',-0.8,'other','2026-09-06 10:00:00');
    ''')
    result = asyncio.run(graph.node_compute_personas({'run_date': '2026-09-06', 'payloads': [_payload()]}))
    obs = result['pipeline_persona_context']['observations']['2330']
    assert [r['tag'] for r in obs['taxonomy_rows']] == ['Semiconductor']
    assert obs['sentiment'] == .8 and obs['buzz_row']['source'] == 'ptt'


def test_candidate_only_source_failure_retries_without_refreshing_formal(persona_db, monkeypatch):
    from services.pipeline_persona_context import capture_persona_context, compute_payload_personas
    graph, db, reads, writes = persona_db
    db.execute("INSERT INTO finlab_taxonomy_tags VALUES('3715','Semiconductor','industry_theme',"
        "'finlab.security_industry_themes',1,'2026-09-06','2026-09-06 00:00:00')")
    query = graph.MARKET_D1_CLIENT.query
    def fail_candidate(sql, args, **kwargs):
        if '3715' in args:
            raise RuntimeError('temporary provider failure')
        return query(sql, args, **kwargs)
    first = capture_persona_context(run_date='2026-09-06', formal_payloads=[_payload()],
        extra_payloads=[_payload('3715', 9)], query=fail_candidate, read_holiday=lambda key: None)
    assert first['observations']['2330']['status'] == 'captured'
    assert first['observations']['3715']['status'] == 'failed'
    _, unavailable = compute_payload_personas(payloads=[_payload('3715', 9)], run_date='2026-09-06', context=first)
    assert unavailable['status'] == 'incomplete' and not unavailable['opinions']
    count = len(reads)
    db.execute('UPDATE concept_buzz SET sentiment_avg=-0.8')
    second = capture_persona_context(run_date='2026-09-06', formal_payloads=[_payload()],
        extra_payloads=[_payload('3715', 9)], query=query, saved=first,
        read_holiday=lambda key: pytest.fail('calendar already frozen'))
    assert len(reads) == count + 1, 'only candidate taxonomy is retried; shared theme is already frozen'
    assert second['observations']['2330'] == first['observations']['2330']
    candidate = second['observations']['3715']
    assert candidate['status'] == 'captured' and candidate['sentiment'] == .8
    assert len(candidate['failed_attempts']) == 1


@pytest.mark.parametrize('fault', ['checksum', 'date', 'chips'])
def test_frozen_persona_context_cannot_be_reinterpreted(persona_db, fault):
    graph, db, reads, writes = persona_db
    state = {'run_date': '2026-09-06', 'payloads': [_payload()]}
    state.update(asyncio.run(graph.node_compute_personas(state)))
    count = len(reads)
    if fault == 'checksum': state['pipeline_persona_context']['source_checksum'] = '0'*64
    if fault == 'date': state['run_date'] = '2026-09-07'
    if fault == 'chips': state['payloads'][0]['chips'][-1]['trust_net'] += 1
    with pytest.raises(ValueError, match='paired_nav_persona_frozen'):
        asyncio.run(graph.node_compute_personas(state))
    assert len(reads) == count


def test_correct_symbol_opinion_is_consumed_by_original_recommendation_function(persona_db):
    from services.recommendation_service import filter_and_score_recommendations
    from test_persona_integration import _screener_rec, _prediction
    graph, db, reads, writes = persona_db
    payload = {**_payload(), 'prices': [{'date': '2026-09-06', 'close': 100.}]}
    state = {'run_date': '2026-09-06', 'payloads': [payload]}
    result = asyncio.run(graph.node_compute_personas(state))
    # Before the repair the real node keyed this exact computed opinion by
    # internal ID 7. The actual recommendation consumer looks up '2330'.
    wrong_key = {7: deepcopy(result['persona_opinions']['2330'])}
    before, _ = filter_and_score_recommendations([_screener_rec('2330')], {'2330': _prediction()},
        [payload], persona_opinions=wrong_key, run_date=state['run_date'])
    after, _ = filter_and_score_recommendations([_screener_rec('2330')], {'2330': _prediction()},
        [payload], persona_opinions=result['persona_opinions'], run_date=state['run_date'])
    assert before[0]['persona_score'] == 0 and before[0]['persona_applied'] is None
    assert after[0]['persona_score'] == 5.
    assert after[0]['persona_applied']['retail_signal'] == 'CAUTION'
    assert after[0]['score_components']['seedComponents']['personaAlphaSeed'] == 5.


def test_real_daily_ml_to_persona_candidate_membership_and_no_formal_writes(with_chips, dispatched, persona_db, monkeypatch):
    from services.pipeline_async_state_transport import (encode_pipeline_state_envelope,
        decode_pipeline_state_envelope, build_pipeline_payload_identity)
    graph, state, request = dispatched
    _, db, reads, writes = persona_db
    bundle, _ = _compute(request)
    state['modal_prediction_bundle'] = bundle
    state.update(asyncio.run(graph.node_l3_formal_predict(state)))
    before = deepcopy(state)
    result = asyncio.run(graph.node_compute_personas(state))
    assert state == before
    assert 'paired_nav_atomic_personas' in result
    atomic = result['paired_nav_atomic_personas']
    assert atomic['status'] == 'incomplete'  # semantic request remains unavailable
    candidate = atomic['definitions']['c'*64]
    assert candidate['status'] == 'ready'
    assert set(candidate['opinions']) == {'1000', '1002', '1003'}
    assert set(result['persona_opinions']) == {'1000', '1001', '1003'}
    assert [r.symbol for r in writes[0]] == ['1000', '1001', '1003']
    assert candidate == atomic['definitions']['e'*64], 'identical complete inputs may share computation'
    empty = atomic['definitions']['f'*64]
    assert empty['status'] == 'ready' and empty['opinions'] == {} and empty['errors'] == {}
    assert atomic['definitions']['d'*64]['status'] == 'unavailable'
    assert atomic['production_effect'] is False and atomic['nav_maturity_credit'] == 0
    assert candidate['opinions']['1000'] == result['persona_opinions']['1000']
    state.update(deepcopy(result))
    state['pipeline_payload_identity'] = build_pipeline_payload_identity(state['payloads'])
    encoded = encode_pipeline_state_envelope({'schema_version': 'pipeline-async-state-v1',
        'run_date': state['run_date'], 'producer_run_id': state['producer_run_id'], 'state': state})
    restored = decode_pipeline_state_envelope(encoded)['state']
    count = len(reads)
    monkeypatch.setattr(graph.MARKET_D1_CLIENT, 'query', lambda *a, **kw: pytest.fail('retry mutable read'))
    monkeypatch.setattr(graph.kv_client, 'get', lambda *a, **kw: pytest.fail('retry mutable holiday read'))
    assert asyncio.run(graph.node_compute_personas(restored)) == result
    assert len(reads) == count
    assert all('1002' not in [r.symbol for r in rows] for rows in writes)


def test_candidate_read_failure_cannot_remove_formal_personas(with_chips, dispatched, persona_db, monkeypatch):
    graph, state, request = dispatched
    _, db, reads, writes = persona_db
    bundle, _ = _compute(request)
    state['modal_prediction_bundle'] = bundle
    state.update(asyncio.run(graph.node_l3_formal_predict(state)))
    query = graph.MARKET_D1_CLIENT.query
    def read(sql, args, **kwargs):
        if '1002' in args:
            raise RuntimeError('candidate source temporarily unavailable')
        return query(sql, args, **kwargs)
    monkeypatch.setattr(graph.MARKET_D1_CLIENT, 'query', read)
    result = asyncio.run(graph.node_compute_personas(state))
    assert set(result['persona_opinions']) == {'1000', '1001', '1003'}
    atomic = result['paired_nav_atomic_personas']
    assert atomic['definitions']['c'*64]['status'] == 'incomplete'
    assert set(atomic['definitions']['c'*64]['errors']) == {'1002'}
    assert atomic['definitions']['f'*64]['status'] == 'ready'
    state.update(deepcopy(result))
    monkeypatch.setattr(graph.MARKET_D1_CLIENT, 'query', query)
    retry = asyncio.run(graph.node_compute_personas(state))
    assert retry['persona_opinions'] == result['persona_opinions']
    assert retry['paired_nav_atomic_personas']['definitions']['c'*64]['status'] == 'ready'
    assert all('1002' not in [r.symbol for r in rows] for rows in writes)


@pytest.mark.parametrize('fault', ['checksum', 'ml_binding', 'population'])
def test_bad_atomic_persona_source_remains_failure_and_preserves_formal(with_chips, dispatched, persona_db, fault):
    from services.paired_nav_journal import digest
    graph, state, request = dispatched
    bundle, _ = _compute(request)
    state['modal_prediction_bundle'] = bundle
    state.update(asyncio.run(graph.node_l3_formal_predict(state)))
    first = asyncio.run(graph.node_compute_personas(state))
    state.update(deepcopy(first))
    ml = state['paired_nav_atomic_ml']
    if fault == 'checksum':
        ml['output_checksum'] = '0'*64
    else:
        if fault == 'ml_binding': ml['dispatch_checksum'] = '0'*64
        if fault == 'population': del ml['definitions']['d'*64]
        ml['output_checksum'] = digest({k: v for k, v in ml.items() if k != 'output_checksum'})
    result = asyncio.run(graph.node_compute_personas(state))
    assert set(result['persona_opinions']) == {'1000', '1001', '1003'}
    assert result['paired_nav_atomic_personas']['status'] == 'failed'
    assert result['paired_nav_atomic_personas']['production_effect'] is False
    assert result['persona_opinions'] == first['persona_opinions']
    assert result['pipeline_persona_context'] == first['pipeline_persona_context']


def test_formal_source_failure_retains_trust_but_is_not_complete_paired_evidence(persona_db, monkeypatch):
    graph, db, reads, writes = persona_db
    def unavailable(*args, **kwargs):
        raise RuntimeError('provider outage')
    monkeypatch.setattr(graph.MARKET_D1_CLIENT, 'query', unavailable)
    result = asyncio.run(graph.node_compute_personas({'run_date': '2026-09-06', 'payloads': [_payload()]}))
    assert result['persona_opinions']['2330']['trust']['signal'] == 'BUY'
    assert result['persona_opinions']['2330']['retail']['signal'] == 'NEUTRAL'
    assert result['persona_computation']['status'] == 'incomplete'
    assert set(result['persona_computation']['errors']) == {'2330'}


@pytest.mark.parametrize('fault', ['future_chip', 'nan', 'duplicate_date'])
def test_invalid_chip_data_is_explicit_not_neutral_evidence(persona_db, fault):
    graph, db, reads, writes = persona_db
    payload = _payload()
    if fault == 'future_chip': payload['chips'][-1]['date'] = '2026-09-07'
    if fault == 'nan': payload['chips'][-1]['trust_net'] = float('nan')
    if fault == 'duplicate_date': payload['chips'][-1]['date'] = payload['chips'][-2]['date']
    if fault == 'nan':
        # Canonical digest rejects non-JSON numbers even before computation.
        with pytest.raises(ValueError):
            asyncio.run(graph.node_compute_personas({'run_date': '2026-09-06', 'payloads': [payload]}))
    else:
        result = asyncio.run(graph.node_compute_personas({'run_date': '2026-09-06', 'payloads': [payload]}))
        assert not result['persona_opinions']
        assert result['persona_computation']['status'] == 'incomplete'


def test_quarter_boundary_uses_same_holiday_rule_and_freezes_first_schedule(persona_db, monkeypatch):
    graph, db, reads, writes = persona_db
    state = {'run_date': '2026-09-16', 'payloads': [_payload()]}
    no_holiday = asyncio.run(graph.node_compute_personas(state))
    assert len(no_holiday['pipeline_persona_context']['calendar']['scheduled_dates']) == 11
    assert no_holiday['persona_opinions']['2330']['trust']['is_window_dress'] is False
    def calendar(key, **kwargs):
        assert kwargs['strict'] is True
        return 'fixture-holiday' if key == 'holiday:2026-09-25' else None
    monkeypatch.setattr(graph.kv_client, 'get', calendar)
    with_holiday = asyncio.run(graph.node_compute_personas(state))
    assert len(with_holiday['pipeline_persona_context']['calendar']['scheduled_dates']) == 10
    assert with_holiday['persona_opinions']['2330']['trust']['is_window_dress'] is True
    assert with_holiday['persona_opinions']['2330']['trust']['strength'] == pytest.approx(
        no_holiday['persona_opinions']['2330']['trust']['strength'] * .7)
    state.update(no_holiday)
    assert asyncio.run(graph.node_compute_personas(state)) == no_holiday


def test_calendar_transport_error_is_not_an_observed_nonholiday(persona_db, monkeypatch):
    graph, db, reads, writes = persona_db
    def fail(*args, **kwargs):
        raise RuntimeError('kv_read_http_failed:500')
    monkeypatch.setattr(graph.kv_client, 'get', fail)
    state = {'run_date': '2026-09-16', 'payloads': [_payload()]}
    first = asyncio.run(graph.node_compute_personas(state))
    assert first['pipeline_persona_context']['calendar']['status'] == 'failed'
    assert first['persona_computation']['status'] == 'incomplete'
    assert first['persona_opinions'] == {}
    state.update(first)
    count = len(reads)
    monkeypatch.setattr(graph.kv_client, 'get', lambda *args, **kwargs: None)
    second = asyncio.run(graph.node_compute_personas(state))
    assert len(reads) == count
    assert second['persona_computation']['status'] == 'personas_computed'
    assert len(second['pipeline_persona_context']['calendar']['failed_attempts']) == 1


def test_saved_calendar_cannot_disagree_with_its_holiday_observations(persona_db):
    from services.paired_nav_journal import digest
    graph, db, reads, writes = persona_db
    state = {'run_date': '2026-09-16', 'payloads': [_payload()]}
    state.update(asyncio.run(graph.node_compute_personas(state)))
    context = state['pipeline_persona_context']
    context['calendar']['scheduled_dates'].pop()
    context['source_checksum'] = digest({k: v for k, v in context.items() if k != 'source_checksum'})
    with pytest.raises(ValueError, match='paired_nav_persona_calendar_frozen_invalid'):
        asyncio.run(graph.node_compute_personas(state))


def test_actual_recommendation_capture_replays_from_frozen_persona_source(persona_db, monkeypatch):
    from services.paired_nav_recommendation_path import (run_and_capture_recommendation_path,
        replay_recommendation_context, run_recommendation_path)
    from test_paired_nav_recommendation_path import recommendation_inputs
    graph, db, reads, writes = persona_db
    inputs = recommendation_inputs()
    for payload in inputs['payloads']:
        payload['stock_id'] = 7 if payload['symbol'] == '2330' else 9
        payload['chips'] = _payload(payload['symbol'])['chips']
    state = {'run_date': inputs['filter_options']['run_date'], 'payloads': inputs['payloads']}
    persona = asyncio.run(graph.node_compute_personas(state))
    inputs['filter_options']['persona_opinions'] = persona['persona_opinions']
    inputs['filter_options']['persona_weight'] = 1.
    inputs['persona_context'] = persona['pipeline_persona_context']
    result, context = run_and_capture_recommendation_path(inputs=inputs)
    assert context['status'] == 'recommendation_context_captured'
    assert context['inputs']['persona_context'] == persona['pipeline_persona_context']
    assert result['recommendations'][0]['persona_score'] == 10.
    def forbidden(*args, **kwargs): pytest.fail('replay must not refresh source')
    monkeypatch.setattr(graph.MARKET_D1_CLIENT, 'query', forbidden)
    monkeypatch.setattr(graph.kv_client, 'get', forbidden)
    assert replay_recommendation_context(context) == result
    altered = deepcopy(context['inputs'])
    altered['filter_options']['persona_opinions']['2330']['trust']['strength'] = .01
    with pytest.raises(ValueError, match='paired_nav_persona_recommendation_boundary_mismatch'):
        run_recommendation_path(inputs=altered)
