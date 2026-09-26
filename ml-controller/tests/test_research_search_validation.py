from datetime import date,timedelta
from pathlib import Path
import sqlite3
import numpy as np
import pytest
from services.research_trial_ledger import observation,append,checksum
from services.research_search_validation import verify_search_binding
from services.research_validation import execution_component
from services.backtest_engine import FeeParams
from dataclasses import asdict


def fixture(*, selected='strong', complete=True, misaligned=False):
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.executescript((Path(__file__).parents[2]/'worker/domain-migrations/research/0002_research_trial_ledger.sql').read_text())
    def query(sql,params):return [dict(row) for row in db.execute(sql,params)]
    def writer(statements):
        with db:
            for sql,params in statements:db.execute(sql,params)
    source={'pointer':'fixture://sealed-search','sha256':'a'*64}
    def add(kind,logical_id,content):return append(observation(kind,run_key='search',logical_id=logical_id,
        source=source,content=content),query=query,writer=writer)
    dates=[(date(2025,1,1)+timedelta(days=i)).isoformat() for i in range(100)]
    rng=np.random.default_rng(34)
    matrix={'__verified_benchmark__':[0.]*100,'strong':(.025+rng.normal(0,.01,100)).tolist(),
        'weak':(-.003+rng.normal(0,.01,100)).tolist()}
    config={'threshold':.63};snapshot={'snapshot_id':'sealed','snapshot_checksum':'b'*64};cost=asdict(FeeParams.from_trading_config(config))
    for name in ('strong','weak'):
        add('trial',name,{'state':'complete','evaluation_scope':'validation','parameters':config,
            'configuration_checksum':checksum(config),'data_snapshot':snapshot,'cost':cost,
            'validation_dates':dates[1:]+['2026-01-01'] if misaligned and name=='weak' else dates,
            'validation_daily_returns':matrix[name],'execution':execution_component(),'gaps':[]})
    add('run','finished',{'coverage':'sealed_complete' if complete else 'partial','trial_ids':['strong','weak']})
    rid=add('run','validation',{'schema_version':'research-search-validation-v1','search_run_key':'search',
        'candidate_id':'candidate','selected_trial_id':selected,'configuration_checksum':checksum(config),
        'dates':dates,'benchmark_daily_returns':matrix['__verified_benchmark__'],'data_snapshot':snapshot,
        'cost':cost,'execution':execution_component(),'panel_checksum':checksum({'dates':dates,'returns':matrix})})
    binding={'run_key':'search','selected_trial_id':selected,'validation_receipt_id':rid}
    return dict(candidate_id='candidate',configuration=config,binding=binding,query=query,
        runtime_evaluation={'snapshot':snapshot,'dates':dates,'benchmark_daily_returns':matrix['__verified_benchmark__'],
            'candidate_daily_returns':matrix[selected]})


def test_verified_search_binds_actual_winner_configuration_dates_and_receipts():
    result=verify_search_binding(**fixture())
    assert result['status']=='PASS' and result['statistical_evidence']['best_candidate']=='strong'
    assert len(result['trial_receipt_ids'])==2 and result['promotion_authority'] is False


@pytest.mark.parametrize('options,reason',[
    ({'selected':'weak'},'selected_trial_is_not_verified_spa_winner'),
    ({'complete':False},'search_ledger_not_complete'),
    ({'misaligned':True},'search_trial_panel_incomplete_or_misaligned'),
])
def test_caller_manifest_family_pass_and_equal_lengths_cannot_bypass_binding(options,reason):
    result=verify_search_binding(**fixture(**options))
    assert result['status']=='FAIL' and result['reason']==reason


def test_configuration_drift_missing_receipt_and_absent_binding_fail_closed():
    args=fixture();args['configuration']['threshold']=.64
    assert verify_search_binding(**args)['reason']=='search_selected_configuration_mismatch'
    args=fixture();args['binding']['validation_receipt_id']='0'*64
    assert verify_search_binding(**args)['reason']=='search_validation_receipt_missing'
    assert verify_search_binding(candidate_id='candidate',configuration={},binding=None)['status']=='FAIL'


def test_unrelated_current_snapshot_cost_and_observed_candidate_returns_fail():
    args=fixture();args['runtime_evaluation']['snapshot']={'snapshot_id':'different','snapshot_checksum':'c'*64}
    assert verify_search_binding(**args)['reason']=='search_current_replay_scope_mismatch'
    args=fixture();args['runtime_evaluation']['candidate_daily_returns']=[.1]*100
    assert verify_search_binding(**args)['reason']=='search_selected_configuration_mismatch'
