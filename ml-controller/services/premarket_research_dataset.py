"""PIT data boundary for an approved future residual model. No fitting/serving.

Keep immutable L3 features separate from the global morning delta. The latter
is stored once, linked by checksum; a consumer must declare its feature recipe.
Labels are separate outcomes, joined only after their actual known timestamp.
"""
from copy import deepcopy
from math import isfinite
from services.premarket_information import _ts, _digest

def seal_research_observation(*, delta, symbol, l3_features, baseline_prediction,
                              prediction_horizon, frozen_at):
    if delta.get('schema_version')!='premarket-information-delta-v1' or _digest({k:v for k,v in delta.items() if k!='checksum'})!=delta.get('checksum'):
        raise ValueError('research_delta_checksum')
    for change in delta.get('changes',[]):
        current=change['current']
        if _ts(current['observed_at'])>_ts(current['available_at']) or _ts(current['available_at'])>_ts(delta['cutoff']):
            raise ValueError('research_future_source')
    if delta.get('scores_modified') is not False or delta.get('training_dispatched') is not False:
        raise ValueError('research_delta_policy_invalid')
    if not symbol or len(l3_features)!=30 or any(type(x) not in (float,int) or not isfinite(x) for x in l3_features):
        raise ValueError('research_l3_fixed30_required')
    if type(baseline_prediction) not in (float,int) or not isfinite(baseline_prediction) or not prediction_horizon:
        raise ValueError('research_prediction_contract')
    if _ts(frozen_at)<_ts(delta['cutoff']) or _ts(frozen_at)>=_ts(delta['trade_date']+'T08:45:00+08:00'):
        raise ValueError('research_freeze_cutoff')
    body={'schema_version':'premarket-residual-observation-v1','symbol':symbol,'trade_date':delta['trade_date'],
          'l3_snapshot_id':delta['l3_snapshot_id'],'l3_features':deepcopy(l3_features),
          'information_delta_checksum':delta['checksum'],'baseline_prediction':baseline_prediction,
          'return_unit':'decimal','prediction_horizon':prediction_horizon,'frozen_at':frozen_at}
    return {**body,'observation_id':_digest(body)}

def mature_training_rows(*, observations, deltas, outcomes, fit_cutoff):
    now=_ts(fit_cutoff);rows=[];pending=[];seen=set()
    lookup={}
    for outcome in outcomes:
        key=outcome['observation_id']
        if key in lookup:raise ValueError('research_duplicate_outcome')
        lookup[key]=outcome
    for row in observations:
        key=row['observation_id']
        if key in seen or _digest({k:v for k,v in row.items() if k!='observation_id'})!=key:
            raise ValueError('research_observation_conflict')
        seen.add(key)
        delta=deltas.get(row['information_delta_checksum'])
        if delta is None:raise ValueError('research_delta_missing')
        verified=seal_research_observation(delta=delta,symbol=row['symbol'],l3_features=row['l3_features'],
            baseline_prediction=row['baseline_prediction'],prediction_horizon=row['prediction_horizon'],frozen_at=row['frozen_at'])
        if verified!=row:raise ValueError('research_observation_mismatch')
        outcome=lookup.get(key)
        if _ts(row['frozen_at'])>now or not outcome or _ts(outcome['known_at'])>now:
            pending.append(key);continue
        if (outcome.get('horizon')!=row['prediction_horizon'] or outcome.get('return_unit')!='decimal'
            or _ts(outcome['known_at'])<_ts(outcome['closed_at']) or _ts(outcome['closed_at'])<=_ts(row['frozen_at'])
            or type(outcome.get('net_return')) not in (int,float) or not isfinite(outcome['net_return'])
            or outcome.get('complete') is not True or not outcome.get('source_checksum')):
            raise ValueError('research_outcome_contract')
        rows.append({**deepcopy(row),'target_residual':outcome['net_return']-row['baseline_prediction'],
                     'outcome':deepcopy(outcome)})
    return {'rows':rows,'pending_observation_ids':pending,'fit_cutoff':fit_cutoff,
            'training_dispatched':False,'scores_modified':False,'delta_artifacts':deepcopy(deltas)}
