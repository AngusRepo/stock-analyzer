"""R30 P3/P7 inner comparison on one admitted OOF pool. No publication.

Each window freezes fitting at its first prediction date. Qualification priors
use only complete mature folds, separately at the outer and inner cutoffs.
"""
import math
import numpy as np
import polars as pl
from services.active8_oof_stacker import (
    _fit_selected_ridge, _fit_ridge, _select_regularization,
    fit_qualified_prior_ridge, _spearman, RIDGE_CANDIDATES, MODEL_WEIGHT_ZERO_TOLERANCE,
)
from services.model_tail_validation import evaluate_tail_fold_guard
from services.l4_comparison_statistics import paired_stats, difference
from services.l4_distribution import digest

TREES=('LightGBM','XGBoost','ExtraTrees')


def ablated_fit(x,y,dates,markets,*,known,order,removed):
    active=tuple(m for m in order if m!=removed)
    def fit(names):
        lam=_select_regularization(x,y,dates,markets,label_known_dates=known,model_order=order,active_models=names)
        w,b=_fit_ridge(x,y,lam,model_order=order,active_models=names)
        return w,b,lam
    w,b,lam=fit(active)
    selected=tuple(m for i,m in enumerate(order) if m in active and w[i]>MODEL_WEIGHT_ZERO_TOLERANCE)
    if not selected:return np.zeros(x.shape[1]),float(np.mean(y)),lam,selected
    if selected!=active:w,b,lam=fit(selected)
    return w,b,lam,selected


def causal_prior(evidence, order, maturity, cutoff, *, excluded=()):
    values=[];details={}
    for name in order:
        proof=evidence[name];folds=[]
        for row in proof['fold_metrics']:
            clusters=row.get('date_cluster_ics') or []
            if clusters and all(c['date'] in maturity and maturity[c['date']]<cutoff for c in clusters):
                folds.append(row)
        guard={**proof['policy']['tail_fold_guard'],'enabled':True,'required_for_serving_promotion':True}
        stats,failed,warnings=evaluate_tail_fold_guard(folds,guard,stage='promotion')
        eligible=bool(stats) and not failed and not warnings and name not in excluded
        values.append(float(eligible))
        details[name]=dict(folds=[r['fold_id'] for r in folds],eligible=eligible,
            failed=failed,warnings=warnings,
            label_known_max=max((maturity[c['date']] for r in folds for c in r['date_cluster_ics']),default=None))
    prior=np.asarray(values)
    if prior.sum():prior/=prior.sum()
    return prior,details


def daily_metrics(frame, column):
    rows=[]
    for group in frame.partition_by('date',maintain_order=True):
        ranked=group.sort([column,'symbol'],descending=[True,False])
        n=group.height;baseline=group['target'].mean();tail=math.ceil(n*.2)
        if n<20:raise ValueError('monthly_stacker_top20_pool_incomplete')
        score=group[column].to_numpy();y=group['target'].to_numpy()
        ic=None if np.ptp(score)==0 or np.ptp(y)==0 else float(_spearman(score,y))
        rows.append(dict(date=group['date'][0],window=group['window'][0],variant=column,rows=n,
            rank_ic=ic,top_bottom_pp=100*(ranked.head(tail)['target'].mean()-ranked.tail(tail)['target'].mean()),
            top5_excess_pp=100*(ranked.head(5)['target'].mean()-baseline),
            rank6_20_excess_pp=100*(ranked.slice(5,15)['target'].mean()-baseline)))
    return rows


def compare(stacked_rows, *, order, windows, qualification, manifest_checksum, cutoff):
    """Caller supplies checksum-verified current-cohort stacked OOF rows.

    P3 and each P7 arm are independent changes against the same sum-loss control.
    Passing removals are reported separately, never silently combined.
    """
    order=tuple(order)
    if len(order)!=8 or not set(TREES)<=set(order) or set(qualification)!=set(order):
        raise ValueError('monthly_stacker_roster')
    if (len(manifest_checksum)!=64 or any(c not in '0123456789abcdef' for c in manifest_checksum)
            or len(windows)!=3 or len(set(windows))!=3):raise ValueError('monthly_stacker_source')
    keys=[(r['prediction_date'],r['symbol']) for r in stacked_rows]
    if len(set(keys))!=len(keys):raise ValueError('monthly_stacker_duplicate_pool')
    if any(not cutoff.admits(r['prediction_date'],r['label_known_date']) for r in stacked_rows):
        raise ValueError('monthly_stacker_dual_cutoff')
    x=np.asarray([r['stacker_features'] for r in stacked_rows],float)
    y=np.asarray([r['target_return'] for r in stacked_rows],float)
    dates=np.asarray([r['prediction_date'] for r in stacked_rows],object)
    known=np.asarray([r['label_known_date'] for r in stacked_rows],object)
    markets=np.asarray([r['market_segment'] for r in stacked_rows],object)
    if x.shape!=(len(y),16) or not np.isfinite(x).all() or not np.isfinite(y).all() or np.any(known<=dates):
        raise ValueError('monthly_stacker_matrix')
    maturity={d:max(known[dates==d]) for d in sorted(set(dates))}
    frame=pl.DataFrame(dict(date=dates,known=known,symbol=[r['symbol'] for r in stacked_rows],
        window=[r['fold_id'] for r in stacked_rows],target=y))
    fits=[];predictions=[];daily=[];correlations=[]
    variants=['sum_loss','mean_loss_causal_prior',*[f'without_{m}' for m in TREES]]
    for window in windows:
        indexes=np.flatnonzero(np.asarray([r['fold_id']==window for r in stacked_rows]))
        if not len(indexes):raise ValueError('monthly_stacker_window_missing')
        start=min(dates[indexes]);train=(dates<start)&(known<start)
        train_dates=sorted(set(dates[train]))
        if len(train_dates)<5 or train.sum()<100:raise ValueError('monthly_stacker_history_insufficient')
        inner_start=train_dates[max(1,int(len(train_dates)*.8))]
        prior,proof=causal_prior(qualification,order,maturity,start)
        inner,inner_proof=causal_prior(qualification,order,maturity,inner_start)
        part=frame.filter(pl.col('window')==window)
        for variant in variants:
            if variant=='sum_loss':
                w,b,lam,selected=_fit_selected_ridge(x[train],y[train],dates[train],markets[train],
                    label_known_dates=known[train],model_order=order)
            elif variant=='mean_loss_causal_prior':
                selected=order
                w,b,lam=fit_qualified_prior_ridge(x[train],y[train],dates[train],markets[train],
                    label_known_dates=known[train],model_order=order,rank_prior=prior,inner_rank_prior=inner,loss_units='mean')
            else:
                # Keep the eight-model feature contract; constrain this arm's
                # excluded model through the existing active-model mechanism.
                w,b,lam,selected=ablated_fit(x[train],y[train],dates[train],markets[train],
                    known=known[train],order=order,removed=variant.removeprefix('without_'))
            if lam not in RIDGE_CANDIDATES:raise ValueError('monthly_stacker_unapproved_lambda')
            score=x[indexes]@w+b;part=part.with_columns(pl.Series(variant,score))
            fits.append(dict(window=window,variant=variant,cutoff_exclusive=start,train_rows=int(train.sum()),
                label_known_max=str(max(known[train])),inner_validation_start=inner_start,
                regularization=float(lam),intercept=float(b),weights=dict(zip(order,w[:8].tolist())),
                availability_weights=dict(zip(order,w[8:].tolist())),selected_models=list(selected),
                prior=prior.tolist() if variant=='mean_loss_causal_prior' else None,
                prior_evidence=proof if variant=='mean_loss_causal_prior' else None,
                inner_prior_evidence=inner_proof if variant=='mean_loss_causal_prior' else None))
            daily.extend(daily_metrics(part,variant))
        predictions.append(part)
        for i,a in enumerate(TREES):
            for b in TREES[i+1:]:
                values=[]
                for day in sorted(set(dates[indexes])):
                    mask=(dates==day)&(x[:,order.index(a)+8]==1)&(x[:,order.index(b)+8]==1)
                    if mask.sum()>1:values.append(float(_spearman(x[mask,order.index(a)],x[mask,order.index(b)])))
                correlations.append(dict(window=window,left=a,right=b,days=len(values),rank_correlation=float(np.mean(values)) if values else None))
    baseline={r['date']:r for r in daily if r['variant']=='sum_loss'}
    decisions={};marginal={}
    for variant in variants[1:]:
        rows=sorted([r for r in daily if r['variant']==variant],key=lambda r:r['date'])
        ic=paired_stats(difference([r['rank_ic'] for r in rows],[baseline[r['date']]['rank_ic'] for r in rows]))
        top=paired_stats(difference([r['top5_excess_pp'] for r in rows],[baseline[r['date']]['top5_excess_pp'] for r in rows]))
        decisions[variant]=dict(rank_ic_paired=ic,top5_excess_paired=top,
            eligible=ic['ci95'] is not None and ic['ci95'][1]>=0 and top['mean'] is not None and top['mean']>0)
        if variant.startswith('without_'):
            marginal[variant.removeprefix('without_')]={window:paired_stats(difference(
                [baseline[r['date']]['rank_ic'] for r in rows if r['window']==window],
                [r['rank_ic'] for r in rows if r['window']==window])) for window in windows}
    report=dict(schema='r32-P3-P7-fixed-window-inner-v1',manifest_checksum=manifest_checksum,
        input_checksum=digest(stacked_rows),qualification_checksum=digest(qualification),model_order=list(order),
        requested_cutoff=cutoff.__dict__,windows=list(windows),variants=variants,decisions=decisions,tree_rank_correlations=correlations,
        tree_marginal_IC=marginal,combined_removals_tested=False,online_switch=False,outer_credit=0,
        caveat='P3/P7 independent single-change comparisons; no automatic composition')
    return pl.concat(predictions),daily,fits,{**report,'checksum':digest(report)}
