"""Reproducible synthetic full-runtime scale test; never investment evidence."""
import json,time,sys
from pathlib import Path
from copy import deepcopy
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from test_l4_distribution_runtime import fixture,prediction
from services.l4_distribution_runtime import run
from services.l4_distribution import digest,FEATURE_NAMES
from services.l4_allocation_contract import inherited_sparse_controls

def measure(size,case):
    _,policy,_=fixture();rng=np.random.default_rng(42)
    rows=[{'symbol':f'S{i:04d}','sector':f'SECTOR{i%20}','eligible_for_pending_buy':1,
           'score_components':{'components':{'mlEdge':12.5}}} for i in range(size)]
    policy['scope']='private_research';policy['artifact'].pop('release')
    if case=='negative':
        policy['artifact']['model']['heads']['gain']['intercept']=.01
        policy['artifact']['model']['heads']['loss']['intercept']=.08
        policy['artifact']['model_checksum']=digest(policy['artifact']['model'])
    policy['constraints'].update(inherited_sparse_controls({}))
    policy['constraints'].update(name_cap=.08,max_positions=5,buy_cost=.001425,sell_cost=.004425)
    if case!='negative':
        policy['artifact']['model']['heads']['gain']['beta'][FEATURE_NAMES.index('TabM_raw')]=.05
        policy['artifact']['model_checksum']=digest(policy['artifact']['model'])
    account=policy['runtime']['account'];account['forbidden_buys']=[]
    policy['runtime']['predictions']={row['symbol']:prediction(rank=.05+.9*i/max(1,size-1)) for i,row in enumerate(rows)}
    history={row['symbol']:rng.normal(0,.015,60).tolist() for row in rows}
    if case=='locked':
        account.update(available_cash=900000,holdings=[{'symbol':'HELD','market_value':100000,'sector':'SECTOR0'}])
        history['HELD']=rng.normal(0,.02,60).tolist()
    print('START',size,case,flush=True)
    started=time.perf_counter()
    result=run(rows,policy,return_history=history,private_research=True)
    elapsed=time.perf_counter()-started;plan=result[0]['_l4_portfolio_plan']
    expected=size+(case=='locked')
    assert plan['proof']['evaluated_candidate_count']==expected and plan['proof']['preselection'] is False
    assert plan['proof']['within_tolerance'] is True and elapsed<120
    assert sum(w>1e-7 for w in plan['weights'].values())<=5
    if case=='negative':assert plan['cash_weight']==1
    if case=='locked':assert abs(plan['weights']['HELD']-.1)<1e-9
    return {'pool':size,'case':case,'elapsed_seconds':elapsed,'plan_json_bytes':len(json.dumps(plan).encode()),
        'selected':sum(w>1e-7 for w in plan['weights'].values()),'cash_weight':plan['cash_weight'],
        'group_count':len(plan['constraints']['exposure_groups']),'proof':plan['proof']}
if __name__=='__main__':
    results=[measure(n,c) for n,c in [(643,'positive'),(643,'negative'),(643,'locked'),(1500,'positive')]]
    packet={'scope':'synthetic_engineering_only','source_script':__file__,'runtime_budget_seconds':120,
        'results':results,'complete':True,'financial_superiority_proven':False}
    Path(sys.argv[1]).write_text(json.dumps(packet,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(packet,ensure_ascii=False))
