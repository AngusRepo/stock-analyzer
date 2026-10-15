"""Sealed cross-fold, date-equal Rank IC selection. No test-label access."""
import numpy as np
from scipy.stats import rankdata

def daily_rank_ic(predictions, target, dates):
    values=np.asarray(predictions,np.float64)
    if values.ndim==1:values=values[None,:]
    target=np.asarray(target,np.float64);dates=np.asarray(dates)
    if values.shape[1]!=len(target) or len(dates)!=len(target) or not np.isfinite(values).all() or not np.isfinite(target).all():
        raise ValueError('invalid_rank_ic_inputs')
    metrics=[];valid_days=[]
    for day in sorted(set(dates)):
        mask=dates==day;y=rankdata(target[mask],method='average');y-=y.mean()
        if len(y)<3 or y@y==0:continue
        ranks=rankdata(values[:,mask],axis=1,method='average');ranks-=ranks.mean(axis=1,keepdims=True)
        denom=np.sqrt((ranks*ranks).sum(axis=1)*(y@y))
        metrics.append(np.divide(ranks@y,denom,out=np.zeros(len(values)),where=denom>0))
        valid_days.append(str(day))
    if not metrics:raise ValueError('no_valid_rank_ic_days')
    daily=np.stack(metrics,axis=1)
    return daily.mean(axis=1),daily,valid_days

def greedy(pool, target, dates, *, max_size=32):
    """Latest epoch plus prior selected states; fixed IDs, replacement permitted.

    Candidate keys sort by epoch then member ID. Strict improvement selects a
    larger ensemble; ties prefer the earlier/smaller ensemble. No restarts.
    """
    keys=sorted(pool);pred=np.stack([pool[k] for k in keys])
    total=np.zeros(pred.shape[1],np.float64);chosen=[];best=[];best_score=-np.inf
    for size in range(1,max_size+1):
        scores,_,_=daily_rank_ic((pred+total)/size,target,dates)
        index=int(np.argmax(scores));chosen.append(keys[index]);total+=pred[index]
        if float(scores[index])>best_score+1e-12:
            best_score=float(scores[index]);best=list(chosen)
    aggregate=np.mean([pool[k] for k in best],axis=0)
    return best,aggregate,best_score

def select_weight_and_calibration(anchor,delta,returns,dates):
    anchor,delta,returns=[np.asarray(v,np.float64) for v in (anchor,delta,returns)]
    dates=np.asarray(dates)
    trials=[]
    for w in (0.,.5,1.):
        score=w*anchor+delta
        ic,_,_=daily_rank_ic(score,returns,dates)
        trials.append(dict(w=w,rank_ic=float(ic[0])))
    chosen=max(trials,key=lambda r:(r['rank_ic'],-r['w']))
    score=chosen['w']*anchor+delta
    numerator=denominator=0.
    for day in sorted(set(dates)):
        mask=dates==day;s=score[mask]-score[mask].mean();y=returns[mask]-returns[mask].mean()
        numerator+=float(np.mean(s*y));denominator+=float(np.mean(s*s))
    if denominator<=1e-16:raise ValueError('degenerate_mu_calibration')
    return dict(w=chosen['w'],b=numerator/denominator,trials=trials,
        method='daily_equal_weight_pooled_centered_OLS_no_intercept',
        evidence_scope='inner_selection_development_only',outer_used=False)
