"""A failed formal persona_opinions write stays non-fatal but is reported as advisory."""
import asyncio

from test_pipeline_persona_context import persona_db, _payload
from test_pipeline_prediction_universe import batch
from test_premarket_pipeline import f
from test_premarket_publication import prepared
from services import premarket_publication as publication

ADVISORY = 'persona_opinions: d1_write_failed:RuntimeError'


def _fail_write(monkeypatch, graph):
    def write(client, rows):
        raise RuntimeError('D1 request failed: HTTP 429: {"errors":[{"message":"D1 DB is overloaded"}]}')
    monkeypatch.setattr(graph, 'write_persona_opinions', write)


def test_successful_persona_write_records_status_without_advisory(persona_db):
    graph, _, _, writes = persona_db
    result = asyncio.run(graph.node_compute_personas({'run_date': '2026-09-06', 'payloads': [_payload()]}))
    assert result['persona_opinions_write'] == {'status': 'written', 'rows': 1, 'expected_rows': 1}
    assert 'errors' not in result and len(writes) == 1


def test_failed_persona_write_is_advisory_and_still_publishes(persona_db, batch, monkeypatch):
    graph = persona_db[0]
    _fail_write(monkeypatch, graph)
    state, effects = batch
    state['payloads'] = [_payload()]
    update = asyncio.run(graph.node_compute_personas(state))
    assert update['persona_opinions_write'] == {'status': 'failed', 'rows': 0, 'expected_rows': 1,
                                               'error_type': 'RuntimeError'}
    assert update['errors'] == [ADVISORY] and set(update['persona_opinions']) == {'2330'}
    graph._merge_pipeline_state_update(state, update)
    graph._merge_pipeline_state_update(state, asyncio.run(graph.node_write_d1(state)))
    assert effects and state['metrics']['persona_opinions_write']['status'] == 'failed'
    result = graph._pipeline_terminal_result(state, run_date=state['run_date'], elapsed=0.)
    # The fixture has no NAV collection; the persona failure must add nothing critical to it.
    clean = graph._pipeline_terminal_result({**state, 'errors': []}, run_date=state['run_date'], elapsed=0.)
    assert result['advisory_errors'] == [ADVISORY] and result['errors'][0] == ADVISORY
    assert result['critical_errors'] == clean['critical_errors'] and result['status'] == clean['status']
    assert result['metrics']['persona_opinions_write']['status'] == 'failed'


def test_persona_advisory_does_not_block_the_serving_receipt(f):
    storage, state, _ = prepared(f)
    state['errors'] = [ADVISORY]
    assert publication.record(state, client=storage)['plan_id'] == 'a' * 64
