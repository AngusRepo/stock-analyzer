from copy import deepcopy
from datetime import datetime, timezone
import ast
from pathlib import Path

import pytest
from services import premarket_atomic_research as research
from services.paired_nav_journal import digest


@pytest.fixture
def inputs(monkeypatch):
    from services import premarket_publication, paired_nav_atomic_inputs
    state={'premarket_execution_scope':'postclose','run_date':'2026-10-16','producer_run_id':'run',
        'premarket_context':{'trade_date':'2026-10-19','checksum':'context'},
        'paired_nav_collection':{'snapshot_id':'parent'},'screener_run_id':'screener',
        'active_stocks':[], 'paired_nav_atomic_inputs':{'population':{'replacements':[]},'input_checksum':'atomic'}}
    parent={'manifest':{'snapshot_id':'parent','signal_date':'2026-10-16',
        'snapshot_kind':'allocation_context','payload_checksum':'payload'},'payload':{'content':{}}}
    publication={'context_checksum':'context','allocation_snapshot_id':'parent','checksum':'pub'}
    class Clock(datetime):
        @classmethod
        def now(cls,tz=None):return datetime(2026,10,19,6,20,tzinfo=timezone.utc)
    monkeypatch.setattr(research,'datetime',Clock)
    monkeypatch.setattr(research,'read_snapshot',lambda query,key:deepcopy(parent))
    monkeypatch.setattr(premarket_publication,'read',lambda *args:deepcopy(publication))
    monkeypatch.setattr(paired_nav_atomic_inputs,'validate_daily_inputs',lambda value,**kw:value)
    return state,parent,publication


def no_io(*args,**kwargs):pytest.fail('no database write/account registration expected')


def test_verified_empty_population_is_calculation_only_and_does_not_mutate_parent(inputs):
    state,_,_=inputs;before=deepcopy(state)
    result=research.calculate(state,query=no_io,writer=no_io,market_query=no_io,core_query=no_io)
    research.validate_result(result,state)
    assert result['reason']=='verified_empty_atomic_population' and state==before
    assert result['prospective'] is False and result['nav_maturity_credit']==0
    result['nav_maturity_credit']=1
    result['checksum']=digest({k:v for k,v in result.items() if k!='checksum'})
    with pytest.raises(ValueError,match='not_verified'):research.validate_result(result,state)


@pytest.mark.parametrize('fault',['scope','clock','publication','parent'])
def test_afterclose_research_requires_actual_publication_and_original_parent(inputs,fault):
    state,parent,publication=inputs
    if fault=='scope':state['premarket_execution_scope']='serving'
    if fault=='clock':state['premarket_context']['trade_date']='2100-01-01'
    if fault=='publication':publication['allocation_snapshot_id']='other'
    if fault=='parent':parent['manifest']['signal_date']='2026-10-15'
    with pytest.raises(ValueError):
        research.calculate(state,query=no_io,writer=no_io,market_query=no_io,core_query=no_io)


def test_nonempty_missing_atomic_computation_is_failure_never_skipped(inputs,monkeypatch):
    from services import paired_nav_atomic_personas
    state,_,_=inputs
    state['paired_nav_atomic_inputs']['population']['replacements']=[{'definition_checksum':'one'}]
    def unavailable(*args,**kwargs):raise ValueError('archived_atomic_input_missing')
    monkeypatch.setattr(paired_nav_atomic_personas,'atomic_persona_slates',unavailable)
    with pytest.raises(ValueError,match='archived_atomic_input_missing'):
        research.calculate(state,query=lambda *args:[],writer=no_io,market_query=no_io,core_query=no_io)


def test_afterclose_graph_refuses_formal_allocation_and_preserves_research_failure():
    # Execute the real graph guards without constructing unrelated model services.
    path=Path(__file__).resolve().parents[1]/'graphs/daily_pipeline_v2.py'
    tree=ast.parse(path.read_text(encoding='utf-8'))
    import asyncio
    for name in ('node_recommend','node_write_d1'):
        fn=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef) and n.name==name)
        fn.decorator_list=[]
        ns={'PipelineStateV2':dict}
        exec(compile(ast.Module(body=[fn],type_ignores=[]),str(path),'exec'),ns)
        with pytest.raises(ValueError,match='postclose_formal_'):
            asyncio.run(ns[name]({'premarket_execution_scope':'postclose'}))
    fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_pipeline_terminal_result')
    ns={'PipelineStateV2':dict,
        'classify_pipeline_terminal_errors':lambda errors:{'critical':errors,'advisory':[]},
        'classify_pipeline_terminal_invariants':lambda metrics:[]}
    exec(compile(ast.Module(body=[fn],type_ignores=[]),str(path),'exec'),ns)
    result=ns[fn.name]({'premarket_execution_scope':'postclose','run_date':'2026-10-16','producer_run_id':'run'},
        run_date='2026-10-16',elapsed=1.)
    assert result['status']=='error' and 'postclose_atomic_research_not_verified' in result['error']

from test_paired_nav_atomic_candidate import allocated, full_atomic, environment, native_runner
from test_paired_nav_atomic_dispatch import dispatched


@pytest.mark.parametrize('full_atomic',['native_policy_complete'],indirect=True)
def test_real_nonempty_atomic_research_replays_calculation_without_native_accounts(allocated,monkeypatch):
    from services import premarket_publication
    from services.paired_nav_journal import read_snapshot
    db,graph,state=allocated
    parent_id=state['paired_nav_collection']['snapshot_id']
    original=read_snapshot(db.query,parent_id)
    state.update(premarket_execution_scope='postclose',
        premarket_context={'trade_date':'2026-09-07','checksum':'context'})
    publication={'context_checksum':'context','allocation_snapshot_id':parent_id,'checksum':'pub'}
    monkeypatch.setattr(premarket_publication,'read',lambda *args:publication)
    from services import paired_native_runtime
    monkeypatch.setattr(paired_native_runtime,'register_candidate_execution_plans',no_io)
    result=research.calculate(state,query=db.query,writer=db.writer,
        market_query=graph.MARKET_D1_CLIENT.query,core_query=graph.CORE_D1_CLIENT.query)
    research.validate_result(result,state)
    assert result['definition_count']>0
    assert result['allocations']['baseline_economic_replay']=='PASS'
    assert read_snapshot(db.query,parent_id)==original
    assert read_snapshot(db.query,result['child_snapshot_id'])['manifest']['prospective']==0
    again=research.calculate(state,query=db.query,writer=no_io,
        market_query=no_io,core_query=no_io)
    assert again==result
