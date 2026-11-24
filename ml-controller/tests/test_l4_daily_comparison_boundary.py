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
    result=asyncio.run(job._execute_account_lifecycle(cadence='daily',end_date='2026-09-21',promote=True,
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


def _superseded_paper(head,plans,row_ids=None,row_dates=None):
    """head is the current head; plans are the activated rows (row_ids/row_dates forge the columns)."""
    def query(sql,params):
        if 'l4_portfolio_head_v1' in sql:return [{'payload_json':json.dumps(head)}]
        if 'signal_date=?' in sql:
            return [{'plan_id':(row_ids or {}).get(p['plan_id'],p['plan_id']),'payload_json':json.dumps(p)}
                    for p in plans if (row_dates or {}).get(p['plan_id'],p['signal_date'])==params[0]]
        assert 'plan_id=?' in sql
        return [{'payload_json':json.dumps(p)} for p in plans+[head] if p['plan_id']==params[0]]
    return SimpleNamespace(query=query)


def _plan(plan_id,signal_date,parent):
    return {'plan_id':plan_id,'signal_date':signal_date,'parent_plan_id':parent,'model_checksum':'model',
            'l3_identity':{'artifact_id':signal_date}}


@pytest.mark.parametrize('hops',[1,2])
def test_superseded_plan_closes_with_marker_and_original_identity(monkeypatch,hops):
    # 11-20 type: the 11-20 plan traded, its daily failed, then 11-23 (and 11-24) became head.
    from services import l4_oof_lifecycle,l4_distribution
    bundles=[]
    monkeypatch.setattr(l4_distribution,'validate_bundle',lambda bundle,**kw:bundles.append(kw))
    original=_plan('p1120','2026-11-20','p1119')
    successor=_plan('p1123','2026-11-23','p1120')
    head=successor if hops==1 else _plan('p1124','2026-11-24','p1123')
    config={'l4Distribution':{'artifact':{'model_checksum':'model'}}}
    closure=l4_oof_lifecycle.daily_plan_closure(config,'2026-11-20',_superseded_paper(head,[original,successor]))
    assert closure=={'schema_version':'l4-daily-plan-closure-v1','signal_date':'2026-11-20','plan_id':'p1120',
        'model_checksum':'model','legacy_oof_maturity_requested':False,'training_dispatched':False,'promoted':False,
        'superseded_by_plan_id':'p1123','superseded_by_signal_date':'2026-11-23'}
    assert bundles==[{'l3_identity':{'artifact_id':'2026-11-20'},'signal_date':'2026-11-20'}]


def test_head_plan_closure_has_no_superseded_marker(monkeypatch):
    from services import l4_oof_lifecycle,l4_distribution
    monkeypatch.setattr(l4_distribution,'validate_bundle',lambda *a,**kw:None)
    head=_plan('p1120','2026-11-20','p1119')
    paper=_superseded_paper(head,[])
    closure=l4_oof_lifecycle.daily_plan_closure({'l4Distribution':{'artifact':{'model_checksum':'model'}}},'2026-11-20',paper)
    assert closure['plan_id']=='p1120' and not any(k.startswith('superseded') for k in closure)


@pytest.mark.parametrize('fault,reason',[('missing','missing'),('multiple','ambiguous'),('row_id','lineage_mismatch'),
    ('payload_date','lineage_mismatch'),('lineage','lineage_mismatch'),('inactive_hop','lineage_mismatch'),('model','model_changed')])
def test_superseded_plan_without_consistent_evidence_fails_closed(monkeypatch,fault,reason):
    from services import l4_oof_lifecycle,l4_distribution
    monkeypatch.setattr(l4_distribution,'validate_bundle',lambda *a,**kw:None)
    monkeypatch.setattr(l4_oof_lifecycle,'_superseded_by_cutover',lambda *a:None)
    original=_plan('p1120','2026-11-20','p1119')
    successor=_plan('p1123','2026-11-23','p1120')
    head=_plan('p1124','2026-11-24','p1123')
    plans,row_ids,row_dates=[original,successor],None,None
    if fault=='missing':plans=[successor]
    if fault=='multiple':plans.append(_plan('p1120b','2026-11-20','p1119'))
    if fault=='row_id':row_ids={'p1120':'other'}
    if fault=='payload_date':original['signal_date']='2026-11-19';row_dates={'p1120':'2026-11-20'}
    if fault=='lineage':successor['parent_plan_id']='elsewhere'
    if fault=='inactive_hop':plans=[original]
    if fault=='model':original['model_checksum']='changed'
    with pytest.raises(ValueError,match=reason) as raised:
        l4_oof_lifecycle.daily_plan_closure({'l4Distribution':{'artifact':{'model_checksum':'model'}}},'2026-11-20',
                                            _superseded_paper(head,plans,row_ids,row_dates))
    assert not isinstance(raised.value,l4_oof_lifecycle.L4DailyPlanPending)


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
    result=asyncio.run(job._execute_account_lifecycle(
        cadence='daily',end_date='2026-09-22',promote=False,dispatch_full_fit=False,
        expected_cohort_id=None,continuation_attempt=0,continuation_only=False))
    assert result['status']=='pending'
    assert result['dependency_retry_required'] is True
    assert result['reason']=='l4_daily_plan_pending_for_signal_date'
    assert result['promoted'] is False
