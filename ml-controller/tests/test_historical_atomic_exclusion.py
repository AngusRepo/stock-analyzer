from copy import deepcopy
from datetime import datetime,timezone
import pytest
from services.historical_atomic_exclusion import reconcile,valid,ERRORS
from services.paired_nav_pipeline import pipeline_shadow_errors
from services.paired_nav_journal import digest

def fixture():
    collection={'status':'failed','stage':'atomic_candidate_setup','reason':'paired_nav_atomic_no_executable_plans',
        'snapshot_id':'a'*64,'prospective':False,'nav_maturity_credit':0,'promotion_allowed':False,
        'atomic_collection':{'status':'historical_not_prospective','plans':[],'nav_maturity_credit':0},
        'atomic_daily':{'status':'incomplete','reason':'requires_allocation_and_native_execution'}}
    state={'run_date':'2026-10-15','producer_run_id':'root','premarket_context':{'trade_date':'2026-10-16'},
        'trading_config':{'l4Distribution':{'scope':'paper'}},'paired_nav_collection':collection}
    manifest={'snapshot_id':'a'*64,'prospective':0,'snapshot_kind':'allocation_context','signal_date':'2026-10-15',
        'source_run_id':'root','payload_checksum':'c'*64,'frozen_at':'2026-10-16T13:33:25+08:00'}
    cold={'snapshot_id':'a'*64,'payload_checksum':'c'*64}
    return state,manifest,cold

def test_historical_exclusion_keeps_original_errors_and_no_credit(monkeypatch):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER','premarket_once_v1')
    state,m,c=fixture();before=deepcopy(state)
    result=reconcile(state,query=lambda sql,args:[c if 'cold_objects' in sql else m],now=datetime(2026,10,16,6,tzinfo=timezone.utc))
    assert state==before and set(pipeline_shadow_errors(state['paired_nav_collection']))==ERRORS
    assert valid(result) and pipeline_shadow_errors(result)==[]
    assert result['status']=='historical_not_prospective'
    assert result['historical_exclusion']['original_collection']==before['paired_nav_collection']
    assert result['historical_exclusion']['nav_maturity_credit']==0
    assert result['historical_exclusion']['prospective_credit'] is False
    result['historical_exclusion']['original_collection']['reason']='unknown_error'
    assert not valid(result) and pipeline_shadow_errors(result)==['paired_nav:invalid_historical_exclusion']

@pytest.mark.parametrize('errors,expected',[([], 'completed'),(['d1_write:failed'],'error')])
def test_historical_exclusion_never_silences_unrelated_serving_failures(monkeypatch,errors,expected):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER','premarket_once_v1')
    from graphs.daily_pipeline_v2 import _pipeline_terminal_result
    from test_pipeline_terminal_truth import _closed_metrics
    state,m,c=fixture()
    state['paired_nav_collection']=reconcile(state,query=lambda sql,args:[c if 'cold_objects' in sql else m],now=datetime(2026,10,16,6,tzinfo=timezone.utc))
    state.update(metrics=_closed_metrics(),errors=errors)
    result=_pipeline_terminal_result(state,run_date=state['run_date'],elapsed=0)
    assert result['status']==expected and result['critical_errors']==errors
    assert result['paired_nav_collection']['historical_exclusion']['nav_maturity_credit']==0

@pytest.mark.parametrize('fault',['prospective','future','source','checksum','other_day','live_scope','mode','extra_error'])
def test_other_cases_cannot_borrow_historical_exclusion(monkeypatch,fault):
    monkeypatch.setenv('PIPELINE_DAILY_PLAN_OWNER','premarket_once_v1')
    state,m,c=fixture()
    if fault=='prospective':m['prospective']=1
    elif fault=='future':m['frozen_at']='2026-10-17T13:33:25+08:00'
    elif fault=='source':m['source_run_id']='different'
    elif fault=='checksum':c['payload_checksum']='d'*64
    elif fault=='other_day':state['premarket_context']['trade_date']='2026-10-19'
    elif fault=='live_scope':state['trading_config']['l4Distribution']['scope']='live'
    elif fault=='mode':monkeypatch.delenv('PIPELINE_DAILY_PLAN_OWNER')
    elif fault=='extra_error':state['paired_nav_collection']['owner_failures']={'extra':{'stage':'bad','reason':'corrupt'}}
    try:result=reconcile(state,query=lambda sql,args:[c if 'cold_objects' in sql else m],now=datetime(2026,10,16,6,tzinfo=timezone.utc))
    except ValueError:return
    assert not result.get('historical_exclusion') and pipeline_shadow_errors(result)
