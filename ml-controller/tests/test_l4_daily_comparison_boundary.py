"""Local proposed scope boundary: full current Paper proof, original NAV errors retained."""
import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace
import pytest
from services.l4_oof_lifecycle import verified_paper_closure_with_incomplete_comparison as check

@pytest.fixture
def source():
    nav={'status':'failed','as_of_date':'2026-09-21','journal_chain_verified':True,
         'accounting_status':'awaiting_execution_pairs',
         'family_reviews':{'failures':[{'reason':'nav_daily_population_unresolved',
             'counts':{'unmaterialized_selections':5,'unresolved_selection_sources':1}}]}}
    for key in ('candidate_decisions','opb_candidate_decisions','l3_candidate_decisions','atomic_candidate_decisions','route_candidate_decisions'):
        nav[key]={'failures':[]}
    closure={'plan_id':'plan','model_checksum':'model','signal_date':'2026-09-21'}
    plan={**closure,'execution_scope':'paper'}
    rows={'paper':[{'allocation_snapshot_id':'snapshot','payload_json':json.dumps(plan)}],
          'learning':[{'signal_date':'2026-09-21','source_run_id':'current'}],
          'ops':[{'canonical_run_id':'current','status':'success'}]}
    def clients(domain):
        return SimpleNamespace(query=lambda *args:rows[domain])
    return nav,closure,rows,clients


def test_exact_current_paper_proof_retains_historical_error(source):
    nav,closure,_,clients=source
    before=deepcopy(nav)
    assert check(nav,closure,clients)
    assert nav==before and nav['status']=='failed'

@pytest.mark.parametrize('kind',['journal','accounting','missing_registered','unknown','legacy','projection','source','stage','live','model','date','missing_plan'])
def test_real_or_current_failures_cannot_close(source,kind):
    nav,closure,rows,clients=source
    if kind=='journal':nav['journal_chain_verified']=False
    elif kind=='accounting':nav['accounting_status']='valuation_incomplete'
    elif kind=='missing_registered':nav['family_reviews']['failures'][0]['reason']='nav_daily_registered_evidence_missing'
    elif kind=='unknown':del nav['route_candidate_decisions']
    elif kind=='legacy':nav['family_reviews']['failures'][0]['counts']['unresolved_journal_pair_ids']=1
    elif kind=='projection':nav['route_candidate_decisions']['failures']=[{'reason':'bad_source'}]
    elif kind=='source':rows['learning'][0]['source_run_id']='superseded'
    elif kind=='stage':rows['ops'][0]['status']='error'
    elif kind=='missing_plan':rows['paper']=[]
    else:
        plan=json.loads(rows['paper'][0]['payload_json'])
        plan[{'live':'execution_scope','model':'model_checksum','date':'signal_date'}[kind]]='wrong'
        rows['paper'][0]['payload_json']=json.dumps(plan)
    assert not check(nav,closure,clients)


def test_daily_branch_keeps_nav_failed_and_discloses_scope(source,monkeypatch):
    import oof_materialize_job_main as job
    from services import l4_oof_lifecycle,trading_config_loader,d1_domain_client
    nav,closure,_,clients=source
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(job,'_execute_daily_nav',lambda **kwargs:deepcopy(nav))
    monkeypatch.setattr(l4_oof_lifecycle,'daily_plan_closure',lambda *args:closure)
    monkeypatch.setattr(d1_domain_client,'client_proxy_for_domain',clients)
    result=asyncio.run(job._execute_lifecycle(cadence='daily',end_date='2026-09-21',promote=True,
        dispatch_full_fit=False,expected_cohort_id=None,continuation_attempt=0,continuation_only=False))
    assert result['status']=='native_l4_daily_accounted'
    assert result['paired_nav_maturity']['status']=='failed'
    assert result['paired_nav_maturity']['adoption']['status']=='blocked_by_nav_failure'
    assert result['promoted'] is False and result['nav_retry_required'] is False
    summary=job._summary('run',result,mode='oof_lifecycle')
    assert 'comparison_review=incomplete_no_promotion' in summary
    assert 'completion_scope=verified_formal_paper_plan' in summary


@pytest.fixture
def actual_nav():
    # Captured from the original daily owner with full checksum-verified formal
    # snapshots and a read-only writer; no returns, orders or maturity invented.
    from pathlib import Path
    return json.loads((Path(__file__).parent/'fixtures/l4_daily_unmaterialized_route_20260921.json').read_text(encoding='utf-8'))


def test_actual_formal_route_absence_is_same_incomplete_comparison(source,actual_nav):
    _,closure,_,clients=source
    before=deepcopy(actual_nav)
    assert check(actual_nav,closure,clients)
    assert actual_nav==before
    assert actual_nav['route_candidate_decisions']['failure_count']==1
    assert actual_nav['status']=='failed'


@pytest.mark.parametrize('kind',['identity','owner','stage','reason','error_type','missing_population','population_changed','materialized_pair','wrong_date'])
def test_route_exception_cannot_waive_different_or_unverified_failures(source,actual_nav,kind):
    _,closure,_,clients=source
    route=actual_nav['route_candidate_decisions']['failures'][0]
    population=actual_nav['paired_nav_evidence']['candidate_population']
    if kind=='identity':route['candidate_checksum']='unrelated'
    elif kind in {'owner','stage','reason','error_type'}:route[kind]='wrong'
    elif kind=='missing_population':population['unmaterialized_selections']=[]
    elif kind=='population_changed':population['population_checksum']='other'
    elif kind=='wrong_date':actual_nav['paired_nav_evidence']['as_of_date']='2026-09-20'
    elif kind=='materialized_pair':population['pairs']=[{'owner':route['owner'],'candidate_checksum':route['candidate_checksum']}]
    assert not check(actual_nav,closure,clients)



def test_daily_plan_date_waits_but_model_change_fails(monkeypatch):
    from services import l4_oof_lifecycle,l4_distribution
    monkeypatch.setattr(l4_distribution, 'validate_bundle', lambda *args, **kwargs: None)
    plan={'plan_id':'plan','signal_date':'2026-09-21','model_checksum':'model',
          'l3_identity':{'artifact_id':'synthetic'}}
    paper=SimpleNamespace(query=lambda *args:[{'payload_json':json.dumps(plan)}])
    config={'l4Distribution':{'artifact':{'model_checksum':'model'}}}
    with pytest.raises(l4_oof_lifecycle.L4DailyPlanPending, match='pending_for_signal_date'):
        l4_oof_lifecycle.daily_plan_closure(config,'2026-09-22',paper)
    plan['signal_date']='2026-09-22'
    assert l4_oof_lifecycle.daily_plan_closure(config,'2026-09-22',paper)['plan_id']=='plan'
    plan['model_checksum']='changed'
    with pytest.raises(ValueError, match='l4_daily_plan_model_changed'):
        l4_oof_lifecycle.daily_plan_closure(config,'2026-09-22',paper)


def test_daily_plan_pending_retries_without_promotion(source,monkeypatch):
    import oof_materialize_job_main as job
    from services import l4_oof_lifecycle,trading_config_loader,d1_domain_client
    nav,_,_,clients=source
    nav={**nav,'status':'success','as_of_date':'2026-09-22'}
    monkeypatch.setattr(trading_config_loader,'load_merged_trading_config_with_contract',
                        lambda:SimpleNamespace(config={'l4Distribution':{}}))
    monkeypatch.setattr(job,'_execute_daily_nav',lambda **kwargs:deepcopy(nav))
    def pending(*args):
        raise l4_oof_lifecycle.L4DailyPlanPending('l4_daily_plan_pending_for_signal_date')
    monkeypatch.setattr(l4_oof_lifecycle,'daily_plan_closure',pending)
    monkeypatch.setattr(d1_domain_client,'client_proxy_for_domain',clients)
    result=asyncio.run(job._execute_lifecycle(
        cadence='daily',end_date='2026-09-22',promote=False,dispatch_full_fit=False,
        expected_cohort_id=None,continuation_attempt=0,continuation_only=False))
    assert result['status']=='pending'
    assert result['dependency_retry_required'] is True
    assert result['reason']=='l4_daily_plan_pending_for_signal_date'
    assert result['promoted'] is False
