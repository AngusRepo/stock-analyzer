"""Original SQL and merge -> actual daily candidate capture, local fixtures."""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json

import pytest

from services.screener_core_replay import replay_core_upsert
from services.screener_seed_domain_merge import capture_screener_seed_context, merge_screener_seed_domains
from services.paired_nav_atomic_inputs import prepare_daily_inputs
from services.payload_builder import build_ml_universe
from test_screener_core_replay import fixture


def inputs():
    before, sql, bind = fixture()
    at = '2026-09-07T12:00:10Z'
    baseline = replay_core_upsert(before, sql, [bind('2330', 53)], observed_at=at)
    def item(symbol, score):
        return dict(symbol=symbol, name=symbol, stage='l1_candidate_seed_after_overlay', decision='selected',
            reasonCode='selected_for_l1_breadth_seed', scoreAfter=score, rank=1,
            evidence=dict(industry='IC', strategy_pool_reason='own route ' + symbol,
                l15_route_contrast={'own_symbol': symbol}))
    raw = [dict(symbol=s, stage='scoring', decision='pass', scoreAfter=41,
        evidence=dict(score_components={'before_calibration': 41, 'symbol': s})) for s in ['2330','2317']]
    formal = item('2330', 67)
    ops = [dict(screener_run_id='run-sql', decision_universe_frozen_at='2026-09-07T12:00:00Z',
        symbol='2330', seed_name='2330', seed_stage=formal['stage'], seed_reason_code=formal['reasonCode'],
        seed_rank=1, seed_score=67, seed_evidence=formal['evidence'], scoring_score=41,
        scoring_evidence=raw[0]['evidence'], l1_evidence=formal['evidence'])]
    stocks = [{**r, 'stock_id': r['id']} for r in before['stock_rows']]
    rows = merge_screener_seed_domains(run_date='2026-09-07', ops_seed_rows=ops, daily_rows=baseline, stock_rows=stocks)
    context = capture_screener_seed_context(run_date='2026-09-07', ops_seed_rows=ops, daily_rows=baseline,
        stock_rows=stocks, merged_rows=rows, read_started_at=datetime.now(timezone.utc).isoformat())
    def core(symbol):
        return dict(seed=dict(row=dict(symbol=symbol,name=symbol,sector='IC')),
            marketSegment='LISTED', eligibleForPendingBuy=True, watchPoints=[])
    candidate = dict(definition_checksum='c'*64, replacement=dict(candidateId='new', incumbentId='base'),
        candidate=dict(status='materialized', rows=[core('2317')]), core_upsert_bindings=[bind('2317', 48)],
        recommendation_seed=dict(status='replayed', final_seed=[{'symbol':'2317'}], merge_items=[item('2317',74)]))
    p = dict(schema_version='atomic-canonical-population-v1', signal_date='2026-09-07', producer_run_id='run-sql',
        source_checksum='a'*64, canonical_artifact_id='canonical', canonical_artifact_checksum='sha256:'+'b'*64,
        source_observed_at='2026-09-07T12:00:00Z', artifact_created_at='2026-09-07T13:00:00Z',
        decision_deadline='2026-09-07T14:00:00Z', production_effect=False, promotion_allowed=False, nav_maturity_credit=0,
        baseline=dict(status='matched',rows=[core('2330')]), replacements=[candidate],
        screener_seed_source=dict(schema_version='atomic-screener-seed-source-v1', source_item_count=3, items=[*raw,formal]),
        core_seed_persistence=[dict(status='captured', started_at='2026-09-07T12:00:01Z', completed_at=at,
            symbols=before['symbols'], value=dict(before=before,upsert_sql=sql,baseline_bindings=[bind('2330',53)]))])
    return p, context, rows, stocks


def prepare(p, context, rows, stocks):
    return prepare_daily_inputs(p, signal_date=p['signal_date'], producer_run_id=p['producer_run_id'],
        formal_stocks=build_ml_universe([],rows), query=lambda sql,params: [
            {'id':r['id'],'symbol':r['symbol']} for r in stocks if r['symbol'] in params], screener_seed_context=context)


def test_candidate_uses_own_sql_and_original_merge_not_formal_picks_or_core_score():
    p, context, rows, stocks = inputs()
    before = deepcopy([p,context,rows,stocks])
    packet = prepare(p,context,rows,stocks)
    own = packet['candidate_recommendation_seeds']['definitions']['c'*64]
    assert own['status'] == 'materialized'
    assert [r['symbol'] for r in own['screener_recs']] == ['2317']
    assert [r['symbol'] for r in rows] == ['2330']
    rec = own['screener_recs'][0]
    assert rec['score'] == 74 != own['inputs']['daily_rows'][0]['score'] == 48
    assert json.loads(rec['score_components']) == {'before_calibration':41,'symbol':'2317'}
    assert rec['l15_route_source']['l1_contrast'] == {'own_symbol':'2317'}
    assert packet['candidate_stocks']['c'*64] == build_ml_universe([], own['screener_recs'])
    assert {r['symbol'] for r in packet['required_stocks']} == {'2330','2317'}
    assert [p,context,rows,stocks] == before
    assert packet['nav_maturity_credit'] == 0


def test_missing_candidate_scoring_does_not_hide_definition_or_erase_formal():
    p, context, rows, stocks = inputs()
    p['screener_seed_source']['items'] = [i for i in p['screener_seed_source']['items'] if i['symbol'] != '2317']
    packet = prepare(p,context,rows,stocks)
    own = packet['candidate_recommendation_seeds']['definitions']['c'*64]
    assert own['status'] == 'unavailable' and 'original_scoring_missing:2317' in own['reason']
    assert packet['candidate_stocks'] == {}
    assert [r['symbol'] for r in packet['formal_stocks']] == ['2330']
    assert len(packet['population']['replacements']) == 1


def test_actual_daily_capture_delivers_original_merged_candidate_metadata(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    from services import paired_nav_atomic_inputs as atomic, payload_builder as builder
    p, context, rows, stocks = inputs()
    async def read(**kwargs): return deepcopy(p)
    monkeypatch.setattr(atomic,'read_daily_population',read)
    monkeypatch.setattr(builder.CORE_D1_CLIENT,'query', lambda sql,params: [
        {'id':r['id'],'symbol':r['symbol']} for r in stocks if r['symbol'] in params])
    requested = []
    def capture(stocks,date):
        requested.extend(deepcopy(stocks))
        return {'fixture':True}
    monkeypatch.setattr(builder,'capture_payload_sources',capture)
    state = dict(run_date=p['signal_date'],screener_run_id=p['producer_run_id'],screener_recs=rows,
        active_stocks=build_ml_universe([],rows),pipeline_screener_seed_context=context)
    result = asyncio.run(graph.node_capture_atomic_inputs(state))
    assert result['paired_nav_atomic_inputs']['status'] == 'pre_l2_inputs_captured'
    assert {r['symbol'] for r in requested} == {'2330','2317'}
    assert result['paired_nav_atomic_inputs']['candidate_stocks']['c'*64][0]['symbol'] == '2317'
    state.update(result)
    assert asyncio.run(graph.node_capture_atomic_inputs(state)) == {}
