from pathlib import Path
import sqlite3
from types import SimpleNamespace
import pytest
from services.research_study_capture import recorded_optimize
from services.research_trial_ledger import verified_rows, search_inventory


class State:
    def __init__(self,name):self.name=name
    def is_finished(self):return self.name in ('COMPLETE','FAIL','PRUNED')


class Study:
    study_name='synthetic'
    def __init__(self,interrupt=False):
        self.user_attrs={};self.interrupt=interrupt
        self.trials=[]
        self.planned=[SimpleNamespace(number=i,state=State(state),values=[.5] if state=='COMPLETE' else None,
            params={'x':i},user_attrs={'sharpe':.5} if state=='COMPLETE' else {})
            for i,state in enumerate(('COMPLETE','FAIL','PRUNED'))]
    def set_user_attr(self,key,value):self.user_attrs[key]=value
    def optimize(self,objective,callbacks=(),**kw):
        self.trials.extend(self.planned)
        if self.interrupt:raise RuntimeError('synthetic_objective_failure')
        for trial in self.trials:
            for callback in callbacks:callback(self,trial)


@pytest.mark.parametrize('interrupted',[False,True])
def test_live_capture_preserves_failed_pruned_and_interrupted_runs(monkeypatch,interrupted):
    from services import d1_domain_client
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.executescript((Path(__file__).parents[2]/'worker/domain-migrations/research/0002_research_trial_ledger.sql').read_text())
    def query(sql,params):return [dict(row) for row in db.execute(sql,params)]
    def write(statements):
        with db:
            for sql,params in statements:db.execute(sql,params)
    monkeypatch.setenv('CF_D1_RESEARCH_DB_ID','synthetic-local-only')
    monkeypatch.setattr(d1_domain_client,'DomainD1Client',lambda domain,require_specific:SimpleNamespace(query=query,batch_execute=write))
    study=Study(interrupted)
    if interrupted:
        with pytest.raises(RuntimeError,match='objective_failure'):
            recorded_optimize(study,lambda _:0,n_trials=3)
    else:recorded_optimize(study,lambda _:0,n_trials=3)
    run_key=study.user_attrs['research_ledger_run_key']
    rows=verified_rows('trial',query=query,run_key=run_key)
    assert {r['content']['state'] for r in rows}=={'complete','fail','pruned'}
    assert len(rows)==3
    assert all(r['content']['validation']['sharpe'] is None for r in rows)
    assert all(r['content']['evaluation_scope']=='optimization' for r in rows)
    inventory=search_inventory(run_key,query=query)
    assert inventory['coverage']==('partial' if interrupted else 'sealed_complete')
    assert inventory['promotion_authority'] is False


def test_local_capture_without_binding_has_no_production_writer(monkeypatch):
    monkeypatch.delenv('CF_D1_RESEARCH_DB_ID',raising=False)
    study=Study()
    recorded_optimize(study,lambda _:0,n_trials=3)
    assert study.user_attrs=={}
