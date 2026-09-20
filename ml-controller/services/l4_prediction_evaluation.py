"""Full-pool, date-equal diagnostics against native L3; never selects a model."""
from collections import defaultdict
import numpy as np
from scipy.stats import rankdata
from services.l4_distribution import finite, digest
from services.l4_l3_baseline import validate_baseline, CANONICAL_LABEL_COST


def rank_ic(prediction, target):
    a,b = rankdata(prediction), rankdata(target)
    if np.ptp(a) == 0 or np.ptp(b) == 0:
        return None
    return float(np.corrcoef(a,b)[0,1])


def mean_error(prediction,target):
    error = prediction - target
    return {'mse':float(np.mean(error**2)), 'date_mean_error_squared':float(np.mean(error)**2),
            'within_date_error_variance':float(np.var(error)), 'rank_ic':rank_ic(prediction,target)}


def binary_metrics(probability,target):
    p=np.asarray(probability,float);y=np.asarray(target,bool)
    if np.any((p<0)|(p>1)) or not np.isfinite(p).all():
        raise ValueError('l4_evaluation_probability_invalid')
    q=np.clip(p,1e-12,1-1e-12)
    n=int(y.sum());m=len(y)-n
    auc=None if n==0 or m==0 else float((rankdata(p)[y].sum()-n*(n+1)/2)/(n*m))
    return {'brier':float(np.mean((p-y)**2)),
        'logloss':float(-np.mean(y*np.log(q)+(1-y)*np.log1p(-q))), 'auc':auc}


def evaluate_predictions(rows, outputs, *, model=None):
    if not rows or len(rows)!=len(outputs):
        raise ValueError('l4_evaluation_pool_mismatch')
    correction_model = (model or {}).get('residual_mlp')
    if correction_model is not None:
        from services.l4_residual_mlp import validate
        validate(correction_model, anchor_model={key:model[key] for key in ('recipe','heads')})
    groups=defaultdict(list);seen=set()
    for i,(row,output) in enumerate(zip(rows,outputs,strict=True)):
        key=(row['date'],row['symbol'])
        if key in seen:
            raise ValueError('l4_evaluation_duplicate_row')
        seen.add(key);groups[row['date']].append(i)
        validate_baseline(row.get('l3_baseline'))
        finite(row.get('gross_return'),'gross_return')
        for name in ('p_loss','gain','loss','expected_return_gross'):
            finite(output.get(name),name)
        if output['gain']<0 or output['loss']<0:
            raise ValueError('l4_evaluation_magnitude_invalid')
        implied=(1-output['p_loss'])*output['gain']-output['p_loss']*output['loss']
        if correction_model is None:
            if abs(implied-output['expected_return_gross'])>1e-12 or 'calibration_model' in output:
                raise ValueError('l4_evaluation_distribution_mean_incoherent')
        else:
            if (output.get('calibration_model') != correction_model['schema_version']
                    or output.get('calibration_checksum') != correction_model['payload_checksum']
                    or abs(finite(output.get('three_head_expected_return_gross'),'three_head_mean')-implied)>1e-12):
                raise ValueError('l4_evaluation_residual_anchor_mismatch')
            corrected=float(np.float32(np.float32(implied)+np.float32(finite(output.get('residual_ev_correction'),'residual_correction'))))
            if abs(corrected-output['expected_return_gross'])>1e-12:
                raise ValueError('l4_evaluation_residual_mean_incoherent')
    daily=[]
    for day,indices in sorted(groups.items()):
        rr=[rows[i] for i in indices];pp=[outputs[i] for i in indices]
        y=np.asarray([r['gross_return'] for r in rr]);native=np.asarray([r['l3_baseline']['expected_return_gross'] for r in rr])
        mu=np.asarray([p['expected_return_gross'] for p in pp])
        gain=np.asarray([p['gain'] for p in pp]);loss=np.asarray([p['loss'] for p in pp])
        d={'date':day,'rows':len(rr),'l3':mean_error(native,y),'l4':mean_error(mu,y),
            'zero':mean_error(np.zeros(len(y)),y),
            'l3_net_positive':binary_metrics([r['l3_baseline']['probability_positive_net_return'] for r in rr],y>CANONICAL_LABEL_COST),
            'l4_gross_loss':binary_metrics([p['p_loss'] for p in pp],y<0),
            'gain_conditional_mse':float(np.mean((gain[y>=0]-y[y>=0])**2)) if np.any(y>=0) else None,
            'loss_conditional_mse':float(np.mean((loss[y<0]+y[y<0])**2)) if np.any(y<0) else None,
            'l3_mean_unique':len(set(native)),'l3_probability_unique':len({r['l3_baseline']['probability_positive_net_return'] for r in rr})}
        if correction_model is not None:
            d['three_head']=mean_error(np.asarray([p['three_head_expected_return_gross'] for p in pp]),y)
        daily.append(d)
    aggregate={}
    for name in (('l3','l4','zero','three_head') if correction_model is not None else ('l3','l4','zero')):
        aggregate[name]={key:float(np.mean([d[name][key] for d in daily]))
                         for key in ('mse','date_mean_error_squared','within_date_error_variance')}
        defined=[d[name]['rank_ic'] for d in daily if d[name]['rank_ic'] is not None]
        aggregate[name].update(daily_rank_ic=float(np.mean(defined)) if defined else None,
            rank_ic_defined_dates=len(defined),rank_ic_undefined_dates=len(daily)-len(defined))
    return {'schema_version':'l4-full-pool-l3-diagnostics-v1','rows':len(rows),'dates':sorted(groups),
        'weighting':'equal_date_then_equal_security','rows_checksum':digest(rows),'outputs_checksum':digest(outputs),
        'metrics':aggregate,'daily':daily,'model_selection_performed':False,
        'probability_events_compared_directly':False,'financial_superiority_proven':False}
