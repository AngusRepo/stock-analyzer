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
