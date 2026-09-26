"""Reproducible causal replay, validation-only neighborhoods and bundle drift."""
from __future__ import annotations
from copy import deepcopy
from datetime import date
import hashlib
import math
from pathlib import Path
import numpy as np
import polars as pl
from services.research_trial_ledger import checksum

BUNDLE_SCHEMA = 'research-validation-bundle-v1'
COMPONENTS = ('strategy', 'models', 'parameters', 'data_semantics', 'cost', 'execution')


def bundle(*, candidate_id, components, snapshot, window):
    missing = [key for key in COMPONENTS if not components.get(key)]
    if not snapshot.get('snapshot_checksum') or not snapshot.get('snapshot_id'):
        missing.append('immutable_evaluation_snapshot')
    body = {'schema_version':BUNDLE_SCHEMA,'candidate_id':candidate_id,
            'components':deepcopy(components),'evaluation':{'snapshot':deepcopy(snapshot),'window':window},
            'component_checksums':{k:checksum(components.get(k)) for k in COMPONENTS},
            'missing':missing,'promotion_authority':False}
    return {**body,'bundle_checksum':checksum(body)}


def bundle_drift(saved, current_components):
    if (not isinstance(saved,dict) or saved.get('schema_version') != BUNDLE_SCHEMA
            or saved.get('bundle_checksum') != checksum({k:v for k,v in saved.items() if k!='bundle_checksum'})):
        return {'status':'FAIL','reason':'bundle_missing_or_corrupt','fields':[]}
    if (not isinstance(saved.get('components'),dict) or not isinstance(saved.get('component_checksums'),dict)
            or any(saved['component_checksums'].get(k)!=checksum(saved['components'].get(k)) for k in COMPONENTS)):
        return {'status':'FAIL','reason':'component_checksum_invalid','fields':[]}
    missing=[key for key in COMPONENTS if not saved['components'].get(key)]
    snapshot=saved.get('evaluation',{}).get('snapshot',{})
    if not snapshot.get('snapshot_id') or not snapshot.get('snapshot_checksum'):
        missing.append('immutable_evaluation_snapshot')
    if missing!=saved.get('missing'):
        return {'status':'FAIL','reason':'bundle_completeness_invalid','fields':[]}
    fields=[{'component':key,'validated':saved['component_checksums'][key],
             'current':checksum(current_components.get(key))}
            for key in COMPONENTS if saved['component_checksums'][key] != checksum(current_components.get(key))]
    return {'status':'FAIL' if fields else ('INSUFFICIENT' if saved['missing'] else 'PASS'),
            'reason':'semantic_drift' if fields else ('bundle_components_missing' if saved['missing'] else 'matched'),
            'fields':fields,'missing':saved['missing'],'daily_snapshot_rotation_is_not_semantic_drift':True}


def execution_component():
    root=Path(__file__).resolve().parents[1]
    paths=['services/backtest_engine.py','services/backtest_state.py']
    return {'owner':'research-mode-a-replay','source_hashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest()
            for p in paths},'entry_timing':'previous_close_to_next_session','settlement':'T+2'}


def dataset_variant(dataset, *, cutoff, perturb=False):
    from services.backtest_engine import BacktestDataset
    frames={}
    changed=0
    for name in ('prices','indicators','chips','market_risk'):
        frame=getattr(dataset,name)
        if frame.is_empty() or 'date' not in frame.columns:
            frames[name]=frame.clone();continue
        if not perturb:
            frames[name]=frame.filter(pl.col('date').cast(pl.String)<=cutoff)
        else:
            future=pl.col('date').cast(pl.String)>cutoff
            columns=[c for c,dtype in frame.schema.items() if dtype.is_numeric() and c not in ('stock_id','id')]
            transforms={c:pl.when(future).then(pl.col(c)*1.731+7.0)
                .otherwise(pl.col(c)).cast(frame.schema[c]) for c in columns}
            changed+=sum(frame.select((future & (pl.col(c)!=expr)).fill_null(False).sum()).item()
                for c,expr in transforms.items())
            frames[name]=frame.with_columns([expr.alias(c) for c,expr in transforms.items()])
    result=BacktestDataset(**frames,stocks=dataset.stocks.clone(),
        trading_days=list(dataset.trading_days) if perturb else [d for d in dataset.trading_days if d<=cutoff],
        start_date=dataset.start_date,end_date=dataset.end_date if perturb else cutoff,
        corporate_sources=deepcopy({d:v for d,v in dataset.corporate_sources.items() if perturb or d<=cutoff}))
    result._build_hot_caches()
    return result,changed


def causal_replay_audit(*, dataset, params, start_date, end_date, snapshot, mode='A', replay_fn=None):
    from services.backtest_engine import replay_period
    replay_fn=replay_fn or replay_period
    base={'schema_version':'causal-replay-audit-v1','mode':mode,'snapshot':snapshot,
          'parameters_checksum':checksum(params),'scope':'execution_on_precomputed_snapshot_features',
          'upstream_feature_recomputation_verified':False,'production_effect':False}
    if mode!='A':
        return {**base,'status':'INSUFFICIENT','reason':'mode_b_requires_pinned_prediction_and_market_state_inputs'}
    days=[d for d in dataset.trading_days if start_date<=d<=end_date]
    if len(days)<6 or not snapshot.get('snapshot_id') or not snapshot.get('snapshot_checksum'):
        return {**base,'status':'INSUFFICIENT','reason':'immutable_snapshot_or_replay_days_missing'}
    def replay(ds,end):
        trace=[]
        replay_fn(dataset=ds,params=deepcopy(params),start_date=start_date,end_date=end,
                  mode=mode,decision_observer=trace.append)
        return trace
    full=replay(dataset,end_date);again=replay(dataset,end_date)
    if checksum(full)!=checksum(again):
        return {**base,'status':'FAIL','reason':'nondeterministic_replay'}
    # Exclude the artificial terminal session: its screener/forced close differs by design.
    cutoffs=sorted({days[len(days)//3],days[2*len(days)//3]})
    checks=[];decisions=0
    for cutoff in cutoffs:
        expected=[row for row in full if row['date']<cutoff]
        decisions+=sum(len(row.get('candidates',[]))+len(row.get('entries',[]))+len(row.get('exits',[])) for row in expected)
        prefix,_=dataset_variant(dataset,cutoff=cutoff)
        future,changed=dataset_variant(dataset,cutoff=cutoff,perturb=True)
        for kind,ds,end in [('prefix',prefix,cutoff),('future_perturbation',future,end_date)]:
            actual=[row for row in replay(ds,end) if row['date']<cutoff]
            checks.append({'kind':kind,'cutoff':cutoff,'passed':checksum(actual)==checksum(expected),
                'trace_checksum':checksum(actual),'expected_checksum':checksum(expected),'future_cells_changed':changed})
    if any(not row['passed'] for row in checks):status,reason='FAIL','past_decisions_changed'
    elif not decisions or any(row['future_cells_changed']==0 for row in checks):status,reason='INSUFFICIENT','no_decisions_or_future_data'
    else:status,reason='PASS','execution_prefix_and_future_perturbation_stable'
    return {**base,'status':status,'reason':reason,'checks':checks,'decision_samples':decisions,
            'trace_checksum':checksum(full),'execution':execution_component()}


def robustness_report(trials, *, current_parameters, search_space, radius=.25, minimum_neighbors=5):
    """Select using validation only; never optimize against displayed holdout."""
    usable=[];rejected=[];seen=set()
    def comparable_context(content):
        window=content.get('validation_window');snap=content.get('data_snapshot');cost=content.get('cost')
        if not isinstance(window,list) or len(window)!=2 or not all(isinstance(v,str) for v in window):return False
        try:
            if date.fromisoformat(window[0])>=date.fromisoformat(window[1]):return False
        except ValueError:return False
        return (isinstance(snap,dict) and bool(snap.get('snapshot_id'))
            and isinstance(snap.get('snapshot_checksum'),str) and len(snap['snapshot_checksum'])==64
            and all(c in '0123456789abcdef' for c in snap['snapshot_checksum'])
            and isinstance(cost,dict) and bool(cost) and not content.get('gaps'))
    for trial in trials:
        content=trial['content'];params=content.get('parameters')
        score=(content.get('validation') or {}).get('sharpe')
        identity=checksum([params,content.get('validation_window'),content.get('cost'),content.get('data_snapshot')])
        if (not isinstance(params,dict) or not isinstance(score,(int,float)) or isinstance(score,bool)
                or not math.isfinite(score) or identity in seen):
            rejected.append(trial['logical_id']);continue
        seen.add(identity);usable.append((trial,params,float(score)))
    def distance(a,b):
        values=[]
        for dimension in search_space:
            name=dimension['name']
            if name not in a or name not in b:return math.inf
            if dimension.get('type')=='categorical':values.append(float(a[name]!=b[name]));continue
            low,high=dimension.get('low'),dimension.get('high')
            if not isinstance(low,(int,float)) or not isinstance(high,(int,float)) or high<=low:return math.inf
            try:
                x,y=float(a[name]),float(b[name])
                if not all(math.isfinite(v) for v in (x,y,low,high)):return math.inf
                if dimension.get('log') or dimension.get('type')=='log_uniform':
                    if min(low,x,y)<=0:return math.inf
                    values.append(abs(math.log(x)-math.log(y))/(math.log(high)-math.log(low)))
                else:values.append(abs(x-y)/(high-low))
            except (ValueError,TypeError):return math.inf
        return max(values) if values else math.inf
    rows=[]
    for trial,params,score in usable:
        context=trial['content']
        known=comparable_context(context)
        neighbors=[v for other,p,v in usable if known and comparable_context(other['content'])
            and other['logical_id']!=trial['logical_id']
            and all(other['content'].get(k)==context.get(k) for k in ('validation_window','cost','data_snapshot'))
            and distance(params,p)<=radius]
        enough=len(neighbors)>=minimum_neighbors
        rows.append({'trial_id':trial['logical_id'],'parameters':params,'validation_sharpe':score,
            'neighbor_count':len(neighbors),'neighbor_lower_quartile':float(np.quantile(neighbors,.25)) if enough else None,
            'holdout':context.get('holdout'),'cost':context.get('cost'),'sample_count':context.get('sample_count'),
            'cost_stress':context.get('cost_stress'),'current_distance':distance(params,current_parameters)
                if math.isfinite(distance(params,current_parameters)) else None,
            'evaluation_context_verified':known,
            'status':'plateau_diagnostic' if enough else ('needs_neighbor_sweep' if known else 'evaluation_context_incomplete')})
    eligible=[r for r in rows if r['neighbor_lower_quartile'] is not None]
    preferred=max(eligible,key=lambda r:r['neighbor_lower_quartile'])['trial_id'] if eligible else None
    return {'schema_version':'parameter-neighborhood-report-v1','status':'DIAGNOSTIC' if eligible else 'INSUFFICIENT',
            'selection_metric':'validation_neighbor_lower_quartile','holdout_used_for_selection':False,
            'recommended_for_review':preferred,'current_parameters':current_parameters,'radius':radius,
            'minimum_neighbors':minimum_neighbors,'rows':rows,'excluded':rejected,'promotion_authority':False}
