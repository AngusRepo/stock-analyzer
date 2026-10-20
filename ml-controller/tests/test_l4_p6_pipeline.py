from copy import deepcopy
import ast
import asyncio
from pathlib import Path
import pytest
from services import l4_p6_pipeline as owner
from services.l4_distribution import digest
from test_l4_p6_runtime import setup


def fixture():
    rows,policy,history,loader=setup()
    state=dict(run_date='2026-10-19',active_stocks=[{'symbol':r['symbol']} for r in rows],
        trading_config={'l4Distribution':policy},screener_recs=deepcopy(rows))
    roster=[{'symbol':s} for s in ('A','B','C','D')]
    catalog={'rows':[dict(symbol=s,cfi='ESVUFR',listing_date='2000-01-01',instrument_type='stock') for s in ('A','B','C','D')]}
    kwargs=dict(roster_reader=lambda day:(roster,{'source':'frozen-listing'}),
        catalog_reader=lambda bucket,day:(catalog,{'path':'catalog','sha256':'a'*64}))
    return state,kwargs


def test_full_inference_does_not_expand_router_and_retry_reuses_receipt():
    state,kwargs=fixture();before=deepcopy(state)
    update=owner.prepare_universe(state,**kwargs)
    assert state==before and len(update['active_stocks'])==4
    assert update['p6_inference_universe']['routed_symbols']==['A','B','C']
    assert update['p6_inference_universe']['second_inference_required'] is False
    def forbidden(*a,**kw):raise AssertionError('retry reread external data')
    assert owner.prepare_universe({**state,**update},roster_reader=forbidden,catalog_reader=forbidden)==update


def test_captured_subset_cannot_be_relabelled_full_and_legacy_stays_unchanged():
    state,kwargs=fixture()
    with pytest.raises(ValueError,match='upgrade_captured'):owner.prepare_universe({**state,'payload_source_observations':{}},**kwargs)
    assert owner.prepare_universe({**state,'trading_config':{}},**kwargs)=={}
    update=owner.prepare_universe(state,**kwargs);changed={**state,**update}
    changed['active_stocks']=changed['active_stocks'][:-1]
    with pytest.raises(ValueError,match='retry_roster_changed'):owner.prepare_universe(changed,**kwargs)


def test_pool_projection_rejects_partial_inference_or_changed_l3(monkeypatch):
    state,kwargs=fixture();state.update(owner.prepare_universe(state,**kwargs))
    bundle=state['trading_config']['l4Distribution']['artifact'];identity=bundle['l3_identity']
    predictions=state['trading_config']['l4Distribution']['runtime']['predictions']
    with pytest.raises(ValueError,match='full_inference_coverage'):owner.project_predictions(state,predictions,identity)
    predictions={**predictions,'D':deepcopy(predictions['C'])}
    update=owner.project_predictions(state,predictions,identity)
    assert update['p6_native_pool']['eligible_symbols']==['A','B','C','D']
    assert update['p6_native_pool']['native_predictions_checksum']==digest(predictions)
    with pytest.raises(ValueError,match='frozen_l3_changed'):owner.project_predictions(state,predictions,{'artifact_id':'other'})


def test_actual_l3_node_returns_sealed_pool_alongside_router_predictions(monkeypatch):
    # Execute the actual node body without initializing unrelated service clients.
    import services.paired_nav_collection as identity_owner
    state,kwargs=fixture();state.update(owner.prepare_universe(state,**kwargs))
    policy=state['trading_config']['l4Distribution'];identity=policy['artifact']['l3_identity']
    predictions={**policy['runtime']['predictions'],'D':deepcopy(policy['runtime']['predictions']['C'])}
    state['payloads']=[dict(symbol=s) for s in predictions]
    path=Path(owner.__file__).parents[1]/'graphs/daily_pipeline_v2.py'
    tree=ast.parse(path.read_text(encoding='utf-8'))
    node=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='_node_l3_formal_predict')
    node.decorator_list=[]
    async def infer(value):
        assert {r['symbol'] for r in value['payloads']}==set(predictions)
        return {'predictions':deepcopy(predictions)}
    monkeypatch.setattr(identity_owner,'baseline_model_identity',lambda manifest:identity)
    import logging
    namespace=dict(PipelineStateV2=dict,node_ml_predict=infer,build_prediction_dispersion_report=lambda p:{},
        logger=logging.getLogger('test'),_pipeline_frozen_serving_manifest=lambda s:{})
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),namespace)
    result=asyncio.run(namespace[node.name](state))
    assert len(result['p6_native_pool']['feature_rows'])==4
    assert state['screener_recs']==fixture()[0]['screener_recs']


def test_event_resume_expands_before_frozen_source_capture(monkeypatch):
    from contextlib import nullcontext
    from services import pipeline_input_events,pipeline_runtime_preflight,payload_builder
    state,kwargs=fixture();original=owner.prepare_universe;seen=[]
    monkeypatch.setattr(owner,'prepare_universe',lambda state:original(state,**kwargs))
    async def verify(**kw):return {}
    monkeypatch.setattr(pipeline_runtime_preflight,'verify_pipeline_runtime',verify)
    def capture(stocks,day):
        assert [r['symbol'] for r in stocks]==['A','B','C','D']
        seen.append('capture');return {'stocks':stocks}
    monkeypatch.setattr(payload_builder,'capture_payload_sources',capture)
    def seal(state):
        assert 'p6_inference_universe' in state and seen==['capture']
        seen.append('seal');return 'sealed'
    monkeypatch.setattr(pipeline_input_events,'seal_pre_l2_checkpoint',seal)
    monkeypatch.setattr(pipeline_input_events,'input_context',lambda *a,**k:nullcontext())
    path=Path(owner.__file__).parents[1]/'graphs/daily_pipeline_v2.py'
    node=next(n for n in ast.parse(path.read_text(encoding='utf-8')).body if isinstance(n,ast.AsyncFunctionDef) and n.name=='_continue_pipeline_before_l2')
    async def nodes(state,steps):
        assert seen==['capture','seal']
        # Build retries must reuse the already-expanded universe.
        assert original(state,**kwargs)['p6_inference_universe']==state['p6_inference_universe']
    async def after(state):return {'status':'deferred'}
    namespace=dict(PipelineStateV2=dict,asyncio=asyncio,assert_canonical_window_open=lambda d:None,
        _run_pipeline_nodes=nodes,node_build_payloads='build',node_prepare_sequence_inputs='sequence',
        build_pipeline_payload_identity=lambda p:{},_continue_pipeline_after_l2=after)
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(path),'exec'),namespace)
    assert asyncio.run(namespace[node.name](state))=={'status':'deferred'}
