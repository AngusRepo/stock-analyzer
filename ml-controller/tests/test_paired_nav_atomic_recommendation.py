"""Original Core SQL -> actual daily L2/ML/persona -> recommendation node.

Forecasts and provider data are synthetic/local. No investment ROI claims.
"""
import asyncio
import gzip
import json
from copy import deepcopy
from datetime import date, datetime, timezone, timedelta
import sqlite3
from types import SimpleNamespace

import pytest

from test_paired_nav_atomic_dispatch import dispatched, _compute
from test_screener_core_replay import fixture as sql_fixture
from test_paired_nav_candidate_collection import environment
from test_native_paper_sandbox import native_runner
from test_paired_nav_journal import FEES
from test_recommendation_source_context import source_db
from test_recommendation_provenance import _score_components
from services.screener_core_replay import replay_core_upsert
from services.screener_seed_domain_merge import capture_screener_seed_context, merge_screener_seed_domains
from services.paired_nav_journal import digest
from services.paired_nav_atomic_recommendation import prepare_atomic_recommendations, run_atomic_recommendations


def _differences(a,b,prefix=''):
    if isinstance(a,dict) and isinstance(b,dict):
        return [item for k in sorted(set(a)|set(b)) for item in _differences(a.get(k),b.get(k),prefix+'/'+str(k))]
    if isinstance(a,list) and isinstance(b,list) and len(a)==len(b):
        return [item for i,(x,y) in enumerate(zip(a,b)) for item in _differences(x,y,prefix+'/'+str(i))]
    return [] if a==b else [(prefix,str(a)[:220],str(b)[:220])]


@pytest.fixture
def full_atomic(monkeypatch, request):
    import test_paired_nav_atomic_daily_inputs as daily
    from services.payload_builder import build_ml_universe
    original_setup = daily._setup
    def setup(mp):
        graph, state, reads = original_setup(mp)
        if getattr(request, 'param', '') == 'native_policy_initial_unavailable':
            from services import paired_nav_native_holdings as holdings
            capture = holdings.capture_native_holdings
            def missing_bootstrap(**kwargs):
                result = capture(**kwargs)
                # Negative boundary input: verified private symbols are still
                # usable, but no current-account bootstrap observation exists.
                for member in result['definitions'].values():
                    if member['status']=='ready':
                        member['source_kind']='verified_native_carry'
                result['initial_observation']={'status':'failed','reason':'paper_source_unavailable'}
                result['source_checksum']=digest({k:v for k,v in result.items() if k!='source_checksum'})
                return result
            mp.setattr(holdings,'capture_native_holdings',missing_bootstrap)
        if getattr(request, 'param', '') == 'native_policy_holdings':
            graph.PAPER_D1_CLIENT.connection.execute("INSERT INTO paper_positions VALUES(1,'1001',100)")
            graph.PAPER_D1_CLIENT.connection.commit()
        from services import payload_builder
        original_prices = payload_builder._bulk_load_prices
        def adjusted_prices(ids,**kwargs):
            result=original_prices(ids,**kwargs)
            for sid, values in result.items():
                older=[{'date':(date(2026,9,1)-timedelta(days=i)).isoformat(),
                        'close':100.,'adj_close':50.,'volume':2_000_000} for i in reversed(range(1,65))]
                result[sid]=older+[{**row,'adj_close':row['close']/2} for row in values]
            return result
        mp.setattr(payload_builder,'_bulk_load_prices',adjusted_prices)
        population = daily._population()
        if str(getattr(request, 'param', '')).startswith('native_policy'):
            from test_paired_nav_atomic_candidate import attach_policy
            if request.param in {'native_policy_complete', 'native_policy_weight_owner_complete'}:
                for definition in population['replacements']:
                    if definition['candidate']['status'] != 'materialized':
                        definition['candidate'] = deepcopy(population['replacements'][0]['candidate'])
            population = attach_policy(population, daily_weight_owner=request.param in {
                'native_policy_weight_owner', 'native_policy_weight_owner_complete'})
        before, sql, original_bind = sql_fixture()
        symbols = ['1000','1001','1002','1003']
        before.update(signal_date=state['run_date'], symbols=symbols,
            stock_rows=[dict(id=i,symbol=s,name=s,sector='Semiconductor',market='TWSE') for i,s in enumerate(symbols,1)])
        def bind(symbol, rank):
            values = original_bind(symbol,60)
            values[0],values[4],values[5],values[14] = state['run_date'],'Semiconductor',rank,'Semiconductor'
            return values
        def item(symbol, rank):
            contrast = {'own_symbol': symbol}
            if str(getattr(request, 'param', '')).startswith('native_policy'):
                contrast = {'schema_version': 'l15-route-contrast-v1',
                    'slate_builder_version': 'l15-continuous-full-universe-priority-v4',
                    'incumbent': {'version': 'fixture-incumbent', 'score': 100-rank*10},
                    'challenger': {'version': 'fixture-challenger', 'score': rank*10},
                    'serving_arm': 'incumbent', 'effect_scope': 'dispatch_priority_only',
                    'allocation_weight_applied': False}
            return dict(symbol=symbol,name=symbol,stage='l1_candidate_seed_after_overlay',decision='selected',
                reasonCode='selected_for_l1_breadth_seed',scoreAfter=67,rank=rank,
                evidence=dict(industry='Semiconductor',strategy_pool_reason='own '+symbol,l15_route_contrast=contrast))
        formal_symbols = [r['seed']['row']['symbol'] for r in population['baseline']['rows']]
        formal_items = [item(s,i) for i,s in enumerate(formal_symbols,1)]
        raw = [dict(symbol=s,stage='scoring',decision='pass',rank=1,scoreAfter=41,
                    evidence={'score_components':_score_components()}) for s in symbols]
        ops = [dict(screener_run_id=state['screener_run_id'],decision_universe_frozen_at='2026-09-06T12:00:00Z',
            symbol=r['symbol'],seed_name=r['name'],seed_stage=r['stage'],seed_reason_code=r['reasonCode'],
            seed_rank=r['rank'],seed_score=r['scoreAfter'],seed_evidence=r['evidence'],scoring_score=41,
            scoring_evidence=next(v['evidence'] for v in raw if v['symbol']==r['symbol']),l1_evidence=r['evidence']) for r in formal_items]
        bindings = [bind(s,i) for i,s in enumerate(formal_symbols,1)]
        at = '2026-09-06T12:00:10Z'
        baseline = replay_core_upsert(before,sql,bindings,observed_at=at)
        stocks = [{**r,'stock_id':r['id']} for r in before['stock_rows']]
        rows = merge_screener_seed_domains(run_date=state['run_date'],ops_seed_rows=ops,daily_rows=baseline,stock_rows=stocks)
        state['pipeline_screener_seed_context'] = capture_screener_seed_context(run_date=state['run_date'],
            ops_seed_rows=ops,daily_rows=baseline,stock_rows=stocks,merged_rows=rows,
            read_started_at=datetime.now(timezone.utc).isoformat())
        state['screener_recs'] = rows
        # The existing dispatch fixture appends 1003 immediately after setup.
        state['active_stocks'] = build_ml_universe([], [r for r in rows if r['symbol']!='1003'])
        population['screener_seed_source'] = dict(schema_version='atomic-screener-seed-source-v1',
            source_item_count=len(raw)+len(formal_items),items=raw+formal_items)
        population['core_seed_persistence'] = [dict(status='captured',started_at='2026-09-06T12:00:01Z',
            completed_at=at,symbols=symbols,value=dict(before=before,upsert_sql=sql,baseline_bindings=bindings))]
        for definition in population['replacements']:
            if definition['candidate']['status'] != 'materialized': continue
            own = [r['seed']['row']['symbol'] for r in definition['candidate']['rows']]
            definition['core_upsert_bindings'] = [bind(s,i) for i,s in enumerate(own,1)]
            definition['recommendation_seed'] = dict(status='replayed',final_seed=[{'symbol':s} for s in own],
                merge_items=[item(s,i) for i,s in enumerate(own,1)])
        mp.setattr(daily,'_population',lambda:deepcopy(population))
        return graph,state,reads
    monkeypatch.setattr(daily,'_setup',setup)
    graph,state,request_packet = request.getfixturevalue('dispatched')
    bundle,_ = _compute(request_packet)
    if getattr(request, 'param', '') == 'native_policy_weight_owner_complete':
        from app.paired_nav_inference import run_candidate_bundles
        from test_paired_nav_atomic_dispatch import _model_bundle
        bundle['paired_nav_l3_inference'] = run_candidate_bundles(request_packet, compute=_model_bundle)
    state['modal_prediction_bundle'] = bundle
    state.update(asyncio.run(graph.node_l3_formal_predict(state)))
    monkeypatch.setattr(graph,'MARKET_D1_CLIENT',SimpleNamespace(query=lambda *a,**kw:[]))
    monkeypatch.setattr(graph,'kv_client',SimpleNamespace(get=lambda *a,**kw:None))
    monkeypatch.setattr(graph,'write_persona_opinions',lambda client,rows:len(rows))
    state.update(asyncio.run(graph.node_compute_personas(state)))
    return graph,state


def test_original_source_to_candidate_preparation(full_atomic):
    _,state = full_atomic
    before = deepcopy(state)
    prepared = prepare_atomic_recommendations(state)
    assert prepared['definitions']['c'*64]['status']=='ready'
    assert [r['symbol'] for r in prepared['definitions']['c'*64]['screener_recs']] == ['1000','1002','1003']
    assert prepared['definitions']['f'*64]['screener_recs'] == []
    assert prepared['definitions']['d'*64]['status']=='unavailable'
    assert state == before and prepared['nav_maturity_credit']==0
    from services.paired_nav_journal import encode
    restored = json.loads(gzip.decompress(gzip.compress(encode(state).encode())))
    assert prepare_atomic_recommendations(restored) == prepared


@pytest.mark.parametrize('fault',['seed','persona','core'])
def test_prepare_rejects_changed_upstream_even_with_outer_hash(full_atomic,fault):
    _,state = full_atomic
    source = state['paired_nav_atomic_inputs']
    if fault=='seed': source['candidate_recommendation_seeds']['definitions']['c'*64]['screener_recs'][0]['score'] += 1
    if fault=='core': source['core_domain_replay']['definitions']['c'*64]['daily_rows'][0]['score'] += 1
    if fault=='persona': state['paired_nav_atomic_personas']['definitions']['c'*64]['status']='incomplete'
    source['input_checksum'] = digest({k:v for k,v in source.items() if k!='input_checksum'})
    with pytest.raises(ValueError): prepare_atomic_recommendations(state)


@pytest.mark.parametrize('source_fault',[None,'candidate_only','formal_only'])
@pytest.mark.parametrize('controller',['SparseTangent','OnlinePortfolioBandit'])
def test_actual_daily_node_runs_own_candidates_without_formal_writes(full_atomic,monkeypatch,environment,native_runner,source_db,source_fault,controller):
    graph,state = full_atomic
    from services import paired_nav_collection as capture, recommendation_service as service, trading_config_loader
    from services.paired_nav_journal import freeze_snapshot,read_snapshot
    from services.paired_nav_atomic_inputs import daily_setup_status
    db,_,_,_ = environment
    threaded = sqlite3.connect(':memory:',check_same_thread=False)
    db.conn.backup(threaded)
    db.conn.close()
    db.conn = threaded
    db.conn.row_factory = sqlite3.Row
    monkeypatch.setattr(graph,'LEARNING_D1_CLIENT',SimpleNamespace(query=db.query,batch_execute=db.writer))
    def market_query(sql,params,**kwargs):
        bad_symbol = '1002' if source_fault=='candidate_only' else '1001'
        if source_fault and 'FROM canonical_fundamental_features' in sql and bad_symbol in params:
            raise ValueError('paired_nav_test_provider_unavailable')
        return source_db[2](sql,params,**kwargs)
    monkeypatch.setattr(graph,'MARKET_D1_CLIENT',SimpleNamespace(query=market_query))
    monkeypatch.setattr(graph,'_resolve_runtime_regime_contract',lambda *a,**kw:{'alpha_regime':'bull','regime_surface':{'bull':1.}})
    from test_l4_alpha_ev_producer import _artifact
    from test_allocator_direction_authority import _validated_l4_prior
    configuration={'ranking':{'enabled':True},'fees':FEES,
        'alphaFramework':{'l4_alpha_ev':_artifact(intercept=.05),
            'allocation':{'controller':controller,'method':'sparse_tangent_inverse_risk','opb_arm_prior':_validated_l4_prior()}}}
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:
        SimpleNamespace(config=deepcopy(configuration),contract=SimpleNamespace(degraded=False)))
    monkeypatch.setattr(graph,'kv_client',SimpleNamespace(get_json=lambda key,**kw:{'maxSingleNamePct':.25} if key=='trading:risk_config' else 1))
    monkeypatch.setattr(graph,'load_online_portfolio_bandit_reward_ledger',lambda:[])
    monkeypatch.setattr(service,'load_inherited_paper_weights',lambda *a,**kw:{'status':'fixture','weights':{},'portfolio_value_twd':100000})
    monkeypatch.setattr(service,'build_portfolio_ml_shadow_inputs',lambda *a,**kw:{})
    monkeypatch.setattr(service,'build_rfs_implementable_frontier_shadow',lambda *a,**kw:{'status':'fixture_observer','weights':{},'metrics':{}})
    monkeypatch.setattr(capture,'freeze_snapshot',lambda **kw:freeze_snapshot(**kw,now=datetime(2026,9,6,14,tzinfo=timezone.utc)))
    from test_paired_nav_execution_environment import patch_graph_environment
    patch_graph_environment(monkeypatch,native_runner)
    from services import paired_nav_recommendation_path as path
    original_capture = path.run_and_capture_recommendation_path
    def verify_capture(**kwargs):
        result, context = original_capture(**kwargs)
        assert context['status']=='recommendation_context_captured', str(context)
        replay_inputs=deepcopy(context['inputs'])
        replay_result=path.run_recommendation_path(inputs=replay_inputs)
        assert not _differences(context['expected'],replay_result), str(_differences(context['expected'],replay_result)[:12])
        assert not _differences(context['post_predictions'],replay_inputs['predictions']), str(_differences(context['post_predictions'],replay_inputs['predictions'])[:12])
        path.replay_recommendation_context(context)
        return result, context
    monkeypatch.setattr(path,'run_and_capture_recommendation_path',verify_capture)
    result = asyncio.run(graph.node_recommend(state))
    assert 'snapshot_id' in result['paired_nav_collection'], str(result['paired_nav_collection'])
    parent = read_snapshot(db.query,result['paired_nav_collection']['snapshot_id'])['payload']['content']
    from services.paired_nav_intervention import run_isolated_allocation
    baseline=run_isolated_allocation(inputs=parent['inputs'],inherited_state=parent['capture']['inherited_state'])
    assert baseline['output']==parent['formal_output'],str(_differences(parent['formal_output'],baseline['output']))
    from services.paired_nav_atomic_allocation import allocation_economic_evidence
    assert digest(allocation_economic_evidence(baseline['capture']))==digest(allocation_economic_evidence(parent['capture'])),str(_differences(parent['capture'],baseline['capture'])[:12])
    assert parent['recommendation_context']['status']=='recommendation_context_captured', str(parent['recommendation_context'])
    assert parent['recommendation_context']['l3_candidate_selection']['status']=='failed'
    own = result['paired_nav_atomic_recommendation']
    allocation=result['paired_nav_atomic_allocation']
    assert allocation['status']=='incomplete', str(allocation)
    assert own['status']=='incomplete', str(own)  # unavailable semantic definition remains visible
    ready = own['definitions']['c'*64]
    if source_fault:
        assert ready['status']=='unavailable', str(ready)
        assert ready['reason']==('recommendation_sources_incomplete' if source_fault=='candidate_only'
                                else 'incumbent_recommendation_sources_incomplete')
        assert own['definitions']['d'*64]['status']=='unavailable'
        assert own['nav_maturity_credit']==0 and own['production_effect'] is False
        assert parent['recommendation_context']['status']=='recommendation_context_captured'
        assert allocation['definitions']['c'*64]['status']=='unavailable'
        return
    assert ready['status']=='recommendations_materialized', ready
    assert set(ready['inputs']['predictions']) == {'1000','1002','1003'}
    assert own['definitions']['f'*64]['result']['recommendations']==[]
    assert own['definitions']['d'*64]['status']=='unavailable'
    assert own['nav_maturity_credit']==0 and own['production_effect'] is False
    allocated=allocation['definitions']['c'*64]
    assert allocated['status']=='allocation_materialized', str(allocated)
    assert set(allocated['inputs']['return_history'])=={'1000','1002'}
    assert set(parent['inputs']['return_history'])=={'1000','1001'}
    assert allocated['risk_history_missing_symbols']==['1003']
    assert allocated['allocation']['capture']['allocation_contract']['controller_requested']==controller
    assert allocated['allocation']['capture']['allocation_contract']['controller_effective']==controller, str(allocated['allocation']['capture']['opb_packet'])
    assert sum(allocated['allocation']['capture']['effective_weights'].values())>0, str(allocated['allocation']['output'])
    assert allocation['definitions']['f'*64]['allocation']['output']==[]
    from services.paired_native_models import prediction_arms, validate_model_frame
    from test_paired_native_models import capture as native_capture, FRAME, request as rescore_request, Bucket, ImmutableNativeObjects
    native = deepcopy(allocated['native_model_context'])
    native.update(variables={'ML_CONTROLLER_URL':'https://controller.fixture','SHIOAJI_PROXY_URL':'https://broker.fixture'},
        session_date='2026-09-07')
    native['configuration']['trading_config'] = configuration
    native['source_context'] = {'variables':native['variables'],'frozen_kv':{}}
    arms = prediction_arms(native)
    assert arms['baseline']['model_identity']==arms['candidate']['model_identity']
    assert set(arms['baseline']['predictions'])=={'1000','1001','1003'}
    assert set(arms['candidate']['predictions'])=={'1000','1002','1003'}
    captured_native = native_capture(native, ImmutableNativeObjects(Bucket()))
    for arm, symbol in [('baseline','1001'),('candidate','1002')]:
        request = rescore_request()
        body = json.loads(request['body'])
        body['positions'][0]['symbol'] = symbol
        request['body'] = json.dumps(body)
        response = captured_native.for_arm(arm).read('frozen_fetch',request,FRAME)
        validate_model_frame(native,arm,{**FRAME,'responses':[response]})
        with pytest.raises(ValueError, match='arm_prediction_missing'):
            captured_native.for_arm('candidate' if arm=='baseline' else 'baseline').read('frozen_fetch',request,FRAME)
    assert allocation['definitions']['f'*64]['native_model_context']['model_prediction_arms']['candidate']['predictions']=={}
    assert allocation['can_write_order'] is False and allocation['nav_maturity_credit']==0
    assert set(parent['recommendation_context']['inputs']['predictions'])=={'1000','1001','1003'}
    # Replay uses captured raw observations, not changed or missing live providers.
    count = len(source_db[1])
    replay = run_atomic_recommendations(prepared=prepare_atomic_recommendations(state),
        formal_context=parent['recommendation_context'], source_context=result['pipeline_recommendation_source_context'])
    assert replay == own and len(source_db[1]) == count
    from services.paired_nav_atomic_allocation import run_atomic_allocations
    monkeypatch.setenv('STOCKVISION_GNN_RETURN_HISTORY_LOOKBACK','504')
    again=run_atomic_allocations(snapshot_id=result['paired_nav_collection']['snapshot_id'],query=db.query,
        prepared=prepare_atomic_recommendations(state),recommendations=own)
    assert again==allocation
    state.update(result)
    status = daily_setup_status(state)
    assert status['status']=='incomplete' and status['reason']=='requires_allocation_and_native_execution'
    assert status['recommendation_status']=='incomplete'
    assert status['allocation_status']=='incomplete'
