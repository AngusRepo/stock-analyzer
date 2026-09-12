"""Actual OPS/Core SQL, daily loader and original recommendation; no live I/O."""
import asyncio
from copy import deepcopy
import gzip
import json
import sqlite3

import pytest

from services import screener_seed_domain_shadow as loader
from services import screener_seed_domain_merge as merge
from services import paired_nav_recommendation_path as recommendation
from services.paired_nav_journal import digest
from test_paired_nav_recommendation_path import recommendation_inputs, forbid_live_io


class MemoryDB:
    def __init__(self):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.calls = []

    def query(self, sql, params=None, timeout=60):
        self.calls.append((sql, params))
        return [dict(r) for r in self.db.execute(sql, params or [])]


@pytest.fixture
def source():
    ops, core = MemoryDB(), MemoryDB()
    ops.db.executescript('''
        CREATE TABLE screener_funnel_runs(run_id,date,status,created_at);
        CREATE TABLE screener_funnel_items(run_id,symbol,name,stage,decision,
            reason_code,rank,score_after,evidence,created_at);
        INSERT INTO screener_funnel_runs VALUES('run-seed','2026-09-07','success','2026-09-07T13:00:00Z');
    ''')
    columns = ('id stock_id symbol name sector industry rank score signal confidence reason watch_points '
        'has_buy_signal current_price foreign_net_5d trust_net_5d rsi14 macd_hist sector_rank '
        'market_segment recommendation_lane eligible_for_ml eligible_for_pending_buy '
        'alpha_context alpha_allocation ml_vote_summary score_components date').split()
    core.db.execute('CREATE TABLE daily_recommendations(' + ','.join(columns) + ')')
    core.db.execute('CREATE TABLE stocks(id,symbol,name,sector,market)')
    fixture = recommendation_inputs()
    for index, rec in enumerate(fixture['screener_recs'], 1):
        components = deepcopy(rec['score_components'])
        daily = {**rec, 'id': index, 'rank': 19 + index, 'score': 99,
            'score_components': json.dumps({'different_post_calibration': True}), 'current_price': 100}
        core.db.execute('INSERT INTO daily_recommendations VALUES(' + ','.join('?' for _ in columns) + ')',
            [json.dumps(daily[c]) if isinstance(daily.get(c), (dict, list)) else daily.get(c) for c in columns])
        core.db.execute('INSERT INTO stocks VALUES(?,?,?,?,?)',
            [rec['stock_id'], rec['symbol'], rec['name'], 'Semis', 'TWSE'])
        for stage, decision, score, evidence in (
            ('scoring', 'pass', 60, {'score_components': components}),
            ('final_selection', 'selected', 91, {'legacy_final': True}),
            ('l1_candidate_seed_after_overlay', 'selected', 67, {
                'strategy_pool_reason': 'original route',
                'l15_route_contrast': {'fixture': 'full-source-not-reconstructed'}}),
        ):
            ops.db.execute('INSERT INTO screener_funnel_items VALUES(?,?,?,?,?,?,?,?,?,?)',
                ['run-seed', rec['symbol'], rec['name'], stage, decision, 'reason', index,
                 score, json.dumps(evidence), '2026-09-07T13:00:00Z'])
    yield ops, core, fixture
    ops.db.close()
    core.db.close()


def capture(source):
    ops, core, _ = source
    context = {}
    rows = loader.load_screener_seed_domain_rows(run_date='2026-09-07',
        ops_client=ops, core_client=core, captured_context=context)
    assert context['status'] == 'captured'
    return rows, context


def test_actual_sql_precedence_and_complete_input_replay(source):
    rows, context = capture(source)
    ops, core, _ = source
    assert len(ops.calls) == 1 and len(core.calls) == 2
    assert rows[0]['score'] == 67 != context['inputs']['daily_rows'][0]['score']
    assert 'different_post_calibration' not in json.loads(rows[0]['score_components'])
    assert rows[0]['l15_route_source']['l1_contrast']['fixture'] == 'full-source-not-reconstructed'
    assert context['knowledge_scope'] == 'observed_at_capture_not_historical_asof'
    assert merge.replay_screener_seed_context(context, run_date='2026-09-07', producer_run_id='run-seed') == rows
    rows[0]['score'] = -999
    assert context['expected'][0]['score'] == 67


def test_actual_daily_node_restores_gzip_without_rereading_mutable_core(source, monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    ops, core, _ = source
    monkeypatch.setattr(loader, 'client_for_domain', lambda domain:
        ops if domain == loader.D1DataDomain.OPS else core)
    state = {'run_date': '2026-09-07'}
    result = asyncio.run(graph.node_load_inputs(state))
    state.update(result)
    calls = len(ops.calls) + len(core.calls)
    ops.db.execute("UPDATE screener_funnel_items SET score_after=-999")
    core.db.execute("UPDATE daily_recommendations SET score=-999,current_price=1")
    restored = json.loads(gzip.decompress(gzip.compress(json.dumps(state).encode())))
    assert asyncio.run(graph.node_load_inputs(restored)) == result
    assert len(ops.calls) + len(core.calls) == calls
    assert result['screener_recs'][0]['score'] == 67
    assert result['screener_recs'][0]['current_price'] == 100


@pytest.mark.parametrize('change,error', [
    ('checksum', 'context_invalid'), ('source', 'source_changed'),
    ('expected', 'replay_mismatch'), ('route', 'replay_mismatch'),
    ('time', 'time_invalid'), ('producer', 'producer_mismatch'),
])
def test_invalid_snapshot_cannot_be_relabelled_or_requeried(source, change, error):
    _, context = capture(source)
    if change == 'checksum':
        context['content_checksum'] = '0' * 64
    else:
        if change == 'source':
            context['source_identity'] = '0' * 64
        elif change == 'expected':
            context['expected'][0]['score'] = 99
        elif change == 'route':
            context['expected'][0]['l15_route_source'] = None
        elif change == 'time':
            context['observed_at'] = '2099-01-01T00:00:00Z'
        elif change == 'producer':
            context['inputs']['ops_seed_rows'][0]['screener_run_id'] = 'different-run'
        context['content_checksum'] = digest({k: v for k, v in context.items() if k != 'content_checksum'})
    with pytest.raises(ValueError, match=error):
        merge.replay_screener_seed_context(context, run_date='2026-09-07', producer_run_id='run-seed')


def test_capture_failure_preserves_formal_rows_but_no_replay_authority(source, monkeypatch):
    ops, core, _ = source
    def fail(**kwargs):
        raise RuntimeError('synthetic capture failure')
    monkeypatch.setattr(loader, 'capture_screener_seed_context', fail)
    context = {}
    rows = loader.load_screener_seed_domain_rows(run_date='2026-09-07',
        ops_client=ops, core_client=core, captured_context=context)
    assert len(rows) == 2 and rows[0]['score'] == 67
    assert context['status'] == 'failed'
    with pytest.raises(ValueError):
        merge.replay_screener_seed_context(context, run_date='2026-09-07')


def test_source_capture_through_original_recommendation_consumer(source):
    rows, context = capture(source)
    inputs = deepcopy(source[2])
    inputs.update(screener_recs=rows, screener_seed_context=context)
    result, captured = recommendation.run_and_capture_recommendation_path(inputs=inputs)
    assert captured['status'] == 'recommendation_context_captured'
    assert recommendation.replay_recommendation_context(captured) == result
    assert result['sell_count'] == 1
    # Whole input boundary, not just final selected recommendations.
    assert len(captured['inputs']['screener_recs']) == 2
    changed = deepcopy(captured['inputs'])
    changed['screener_recs'][1]['score'] = 99
    formal_result, failure = recommendation.run_and_capture_recommendation_path(inputs=changed)
    assert failure['status'] == 'failed'
    assert formal_result['sell_count'] == 1
    assert 'boundary_mismatch' in str(failure)


def test_no_rows_is_valid_source_capture_not_complete_empty_pipeline(source):
    source[0].db.execute('DELETE FROM screener_funnel_items')
    rows, context = capture(source)
    assert rows == merge.replay_screener_seed_context(context, run_date='2026-09-07') == []
    assert context['inputs']['daily_rows'] == []
    assert len(source[1].calls) == 0


def canonical_population(source):
    from test_paired_nav_atomic_daily_inputs import _population
    population = _population()
    rows = source[0].query('SELECT * FROM screener_funnel_items')
    items = [dict(symbol=r['symbol'], name=r['name'], stage=r['stage'], decision=r['decision'],
        reasonCode=r['reason_code'], rank=r['rank'], scoreAfter=r['score_after'], evidence=json.loads(r['evidence']))
        for r in rows]
    population.update(signal_date='2026-09-07', producer_run_id='run-seed',
        source_observed_at='2026-09-07T12:00:00Z', artifact_created_at='2026-09-07T14:00:00Z',
        decision_deadline='2026-09-07T15:00:00Z',
        screener_seed_source={'schema_version': 'atomic-screener-seed-source-v1',
            'source_item_count': len(items), 'items': items})
    for row, symbol in zip(population['baseline']['rows'], ['2330', '2317']):
        row['seed']['row']['symbol'] = symbol
    population['replacements'][0]['candidate']['rows'] = deepcopy(population['baseline']['rows'])
    return population


def test_canonical_original_scoring_reconciles_with_actual_ops_not_core(source):
    _, context = capture(source)
    population = canonical_population(source)
    receipt = merge.verify_canonical_seed_boundary(population, context)
    assert receipt['status'] == 'matched' and receipt['ops_seed_count'] == 2
    assert receipt['raw_scoring_symbol_count'] == 2
    assert receipt['screener_seed_context_checksum'] == context['content_checksum']
    # Core=99 is a legitimate different downstream field, not OPS seed=67.
    assert context['inputs']['daily_rows'][0]['score'] == 99
    population['screener_seed_source']['items'][0]['evidence'] = {'substituted_core': True}
    with pytest.raises(ValueError, match='ops_seed_boundary_mismatch'):
        merge.verify_canonical_seed_boundary(population, context)


@pytest.mark.parametrize('fault', ['missing_scoring', 'different_seed', 'different_route', 'ambiguous_tie'])
def test_canonical_missing_or_different_stage_cannot_be_hidden(source, fault):
    _, context = capture(source)
    population = canonical_population(source)
    items = population['screener_seed_source']['items']
    if fault == 'missing_scoring':
        items.pop(0)
    elif fault == 'different_seed':
        items[2]['scoreAfter'] = 99
    elif fault == 'different_route':
        items[2]['evidence']['l15_route_contrast'] = {'changed': True}
    else:
        items.append({**deepcopy(items[0]), 'scoreAfter': 999})
        population['screener_seed_source']['source_item_count'] += 1
    with pytest.raises(ValueError, match='boundary_mismatch|tie_timestamp_missing'):
        merge.verify_canonical_seed_boundary(population, context)


def test_actual_daily_candidate_capture_verifies_canonical_source_and_retry(source, monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    from services import paired_nav_atomic_inputs as atomic
    from services import payload_builder as builder
    rows, context = capture(source)
    population = canonical_population(source)
    async def read(**kwargs):
        return deepcopy(population)
    monkeypatch.setattr(atomic, 'read_daily_population', read)
    monkeypatch.setattr(builder.CORE_D1_CLIENT, 'query', source[1].query)
    monkeypatch.setattr(builder, 'capture_payload_sources', lambda stocks, date: {'fixture_stocks': stocks})
    state = dict(run_date='2026-09-07', screener_run_id='run-seed', screener_recs=rows,
        active_stocks=builder.build_ml_universe([], rows), pipeline_screener_seed_context=context)
    update = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert update['paired_nav_atomic_inputs']['status'] == 'pre_l2_inputs_captured'
    assert update['paired_nav_atomic_inputs']['screener_seed_boundary']['status'] == 'matched'
    assert update['paired_nav_atomic_inputs']['nav_maturity_credit'] == 0
    state.update(update)
    monkeypatch.setattr(atomic, 'read_daily_population', lambda **kw: pytest.fail('reread canonical on retry'))
    assert asyncio.run(graph.node_capture_atomic_inputs(state)) == {}
    # Re-sealing contradictory source is not an idempotent retry.
    state['paired_nav_atomic_inputs']['population']['screener_seed_source']['items'][0]['scoreAfter'] = -99
    packet = state['paired_nav_atomic_inputs']
    packet['input_checksum'] = digest({k: v for k, v in packet.items() if k != 'input_checksum'})
    failure = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert failure['paired_nav_atomic_inputs']['status'] == 'failed'
    assert 'screener_recs' not in failure and 'active_stocks' not in failure
