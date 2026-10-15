"""Frozen-version prospective evaluation; maturity never grants promotion."""
from datetime import date,datetime,time
import json
import numpy as np
from scipy.stats import rankdata
from services.l4_forward_materialization import digest,timestamp,TZ,materialize
from services.l4_native_observation import read_reference,discover


def validate_policy(policy):
    import re
    if (policy.get('schema_version')!='l4-r2-forward-evaluation-policy-v1'
            or policy.get('required_mature_days')!=20 or policy.get('risk_horizon_sessions')!=5
            or policy.get('automatic_promotion') is not False
            or policy.get('uncertainty')!={'method':'paired_five_session_moving_block','replicates':5000,'seed':42,'confidence':.95}
            or policy.get('acceptance')!='manual_review_of_precommitted_metrics_no_automatic_promotion'
            or policy.get('head_policy')!='causal_latest_known_anchor_same_identity_full_pool_whole_mature_dates'
            or any(not re.fullmatch('[a-f0-9]{64}',str(policy.get(k,''))) for k in
                ('model_checksum','baseline_model_checksum','cost_policy_checksum','allocation_policy_checksum','implementation_checksum'))):
        raise ValueError('l4_r2_evaluation_policy_invalid')
    for k in ('first_signal_date','last_inspected_signal_date'):date.fromisoformat(policy[k])
    if policy['first_signal_date']<=policy['last_inspected_signal_date']:
        raise ValueError('l4_r2_evaluation_reuses_inspected_dates')


def daily_metrics(forecast,rows):
    predictions={r['symbol']:r for r in forecast['forecasts']}
    if (len(predictions)!=len(forecast['forecasts']) or set(predictions)!={r['symbol'] for r in rows}
            or len(rows)!=len({r['symbol'] for r in rows})
            or digest(forecast['forecasts'])!=forecast['forecasts_checksum']):
        raise ValueError('l4_r2_evaluation_pool_mismatch')
    symbols=sorted(predictions);actual={r['symbol']:r['gross_return'] for r in rows}
    y=np.array([actual[s] for s in symbols]);y-=y.mean();result={}
    for name,key in (('new','relative_mu'),('old','baseline_relative')):
        mu=np.array([predictions[s][key] for s in symbols],float)
        if not np.isfinite(mu).all() or abs(mu.mean())>1e-8:
            raise ValueError('l4_r2_evaluation_uncentered_or_nonfinite')
        ranks=rankdata(mu);yr=rankdata(y)
        ic=float(np.corrcoef(ranks,yr)[0,1]) if np.ptp(ranks) and np.ptp(yr) else None
        order=sorted(range(len(symbols)),key=lambda i:(-mu[i],symbols[i]))
        bins={}
        for label,start,end in (('1_5',0,5),('6_20',5,20),('21_50',20,50)):
            ids=order[start:end]
            bins[label]=dict(rows=len(ids),predicted=float(mu[ids].mean()) if ids else None,
                realized=float(y[ids].mean()) if ids else None)
        sd=float(mu.std());z=(mu-mu.mean())/sd if sd else np.zeros(len(mu))
        tails=[]
        for lo,hi in ((-1e100,0),(0,1),(1,1.5),(1.5,2.5),(2.5,3),(3,1e100)):
            mask=(z>=lo)&(z<hi)
            tails.append(dict(z_min=None if lo< -1e99 else lo,z_max=None if hi>1e99 else hi,
                rows=int(mask.sum()),predicted=float(mu[mask].mean()) if mask.any() else None,
                realized=float(y[mask].mean()) if mask.any() else None))
        result[name]=dict(rank_ic=ic,relative_mse=float(np.mean((mu-y)**2)),relative_bias=float(np.mean(mu-y)),
            top10=[symbols[i] for i in order[:10]],rank_bands=bins,z_calibration=tails)
    return dict(signal_date=forecast['signal_date'],rows=len(rows),**result)


def evaluate(items,*,policy,policy_created_at,calendar,prices,cutoff,identity):
    validate_policy(policy);clock=timestamp(cutoff);policy_time=timestamp(policy_created_at)
    days=[];excluded=[];seen=set()
    for item in sorted(items,key=lambda i:i['forecast']['signal_date']):
        forecast=item['forecast'];snapshot=item['snapshot'];day=forecast['signal_date']
        if day in seen:raise ValueError('l4_r2_evaluation_duplicate_day')
        seen.add(day)
        if (forecast.get('schema_version')!='l4-r2-daily-shadow-v1'
                or forecast.get('implementation_checksum')!=policy['implementation_checksum']
                or forecast['policy_checksum']!=digest(policy) or forecast['model_checksum']!=policy['model_checksum']
                or forecast['baseline_model_checksum']!=policy['baseline_model_checksum']
                or forecast['l3_identity']!=identity or snapshot['l3_identity']!=identity
                or forecast['native_snapshot_id']!=snapshot['snapshot_id']
                or forecast['native_original_sha256']!=snapshot['original_sha256']
                or forecast['signal_date']!=snapshot['signal_date']):
            raise ValueError('l4_r2_evaluation_binding')
        frozen=max(timestamp(forecast['frozen_at']),timestamp(item['server_created_at']))
        if day<policy['first_signal_date'] or not policy_time<=frozen<=clock:
            excluded.append(dict(signal_date=day,reason='outside_frozen_policy_window'));continue
        # Both full-pool inference AND the R2 forecast must precede entry.
        projected={**snapshot,'frozen_at':max(frozen,timestamp(snapshot['frozen_at'])).isoformat()}
        rows,receipt=materialize(projected,calendar=calendar,prices=prices,cutoff=cutoff,
            expected_identity=identity,pool_contract='native_non_etf_equity_v1')
        if receipt['status']!='ready' or not receipt['training_eligible']:
            excluded.append(dict(signal_date=day,reason=receipt['status'] if receipt['status']!='ready' else receipt['training_blocker']));continue
        metric=daily_metrics(forecast,rows)
        metric.update(label_known_date=receipt['label_known_date'],forecast_sha256=item['forecast_sha256'])
        if days:
            for model in ('new','old'):
                metric[model]['top10_previous_observation_overlap']=len(set(metric[model]['top10'])&set(days[-1][model]['top10']))
        days.append(metric)
    # Fixed first 20 eligible days; later observations cannot move the test window.
    selected=days[:20];summary={}
    for metric in ('rank_ic','relative_mse','relative_bias'):
        pairs=[(d['new'][metric],d['old'][metric]) for d in selected if d['new'][metric] is not None and d['old'][metric] is not None]
        delta=np.array([a-b for a,b in pairs]);ci=None
        if len(delta)>=20:
            rng=np.random.default_rng(42);samples=[]
            for _ in range(5000):
                starts=rng.integers(0,len(delta)-4,size=(len(delta)+4)//5)
                samples.append(float(np.concatenate([delta[s:s+5] for s in starts])[:len(delta)].mean()))
            ci=np.quantile(samples,[.025,.975]).tolist()
        summary[metric]=dict(paired_days=len(pairs),new_mean=float(np.mean([a for a,b in pairs])) if pairs else None,
            old_mean=float(np.mean([b for a,b in pairs])) if pairs else None,
            difference=float(delta.mean()) if pairs else None,difference_ci95=ci)
    return dict(schema_version='l4-r2-forward-evaluation-v1',policy_checksum=digest(policy),cutoff=cutoff,
        matured_days=len(selected),required_mature_days=20,days_remaining=max(0,20-len(selected)),
        status='ready_for_manual_review' if len(selected)==20 else 'awaiting_unseen_matured_labels',
        dates=[d['signal_date'] for d in selected],daily=selected,summary=summary,excluded=excluded,
        additional_mature_days=len(days)-len(selected),promoted=False,promotion_allowed=False)


def run(*,bucket,config,price_capture,cutoff,identity):
    from services.l4_forward_refresh import load_prices,publish
    policy=read_reference(bucket,config['evaluation_policy']);validate_policy(policy)
    policy_blob=bucket.blob(config['evaluation_policy']['path']);policy_blob.reload()
    if policy_blob.time_created is None:raise ValueError('l4_r2_policy_server_clock_missing')
    end=timestamp(cutoff).astimezone(TZ).date().isoformat()
    snapshots={s['snapshot_id']:s for s,ref in discover(bucket,start=policy['first_signal_date'],end=end,cutoff=cutoff)}
    items=[]
    for index in bucket.list_blobs(prefix='l4_distribution/r2_shadow_index/'):
        saved=json.loads(index.download_as_bytes(if_generation_match=index.generation))
        forecast=read_reference(bucket,saved['reference'])
        if forecast['policy_checksum']!=digest(policy):continue
        blob=bucket.blob(saved['reference']['path']);blob.reload()
        if blob.time_created is None:raise ValueError('l4_r2_forecast_server_clock_missing')
        if blob.time_created>timestamp(cutoff):continue
        snapshot=snapshots.get(forecast['native_snapshot_id'])
        if snapshot is None:raise ValueError('l4_r2_evaluation_native_snapshot_missing')
        items.append(dict(forecast=forecast,snapshot=snapshot,server_created_at=blob.time_created.isoformat(),forecast_sha256=saved['reference']['sha256']))
    calendar,prices,proof=load_prices(bucket,price_capture,start=policy['first_signal_date'],cutoff_day=end)
    body=evaluate(items,policy=policy,policy_created_at=policy_blob.time_created.isoformat(),calendar=calendar,
        prices=prices,cutoff=cutoff,identity=identity)
    body['price_proof']=proof
    ref=publish(bucket,'r2_forward_evaluations',body)
    return {k:body[k] for k in ('status','matured_days','required_mature_days','days_remaining','promoted','promotion_allowed')}|dict(reference=ref)
