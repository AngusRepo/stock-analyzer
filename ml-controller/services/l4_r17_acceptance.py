"""R17 frozen decision semantics. Pure reporting; no promotion capability."""
from __future__ import annotations
import hashlib,json,math
from pathlib import Path
import numpy as np

ARMS=('A','B','C','L')
SEED=20261015

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()

def verify(record):
    if record.get('checksum')!=digest({k:v for k,v in record.items() if k!='checksum'}):
        raise ValueError('receipt_checksum_mismatch')

def seal(record):
    return {**record,'checksum':digest(record)}

def finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)

def primary(weights,returns,pool):
    if not pool or len(pool)!=len(set(pool)):raise ValueError('candidate_pool_invalid')
    if any(not finite(v) or v<0 for v in weights.values()):raise ValueError('holding_weight_invalid')
    needed=set(pool)|{s for s,w in weights.items() if w>0}
    if any(s not in returns or not finite(returns[s]) for s in needed):raise ValueError('mature_label_missing')
    benchmark=float(np.mean([returns[s] for s in pool]))
    exposure=sum(weights.values())
    excess=sum(w*returns[s] for s,w in weights.items() if w>0)/exposure-benchmark if exposure>0 else None
    return {'exposure':exposure,'primary':excess,'pool_return':benchmark}

def paired_stats(values):
    """Keep missing/excluded calendar positions; never squeeze gaps into adjacency."""
    data=np.asarray([v if finite(v) else np.nan for v in values],float)
    n=len(data); mask=np.isfinite(data)
    if not n or not mask.any():return {'n':0,'mean':None,'ci95':None,'bootstrap_valid':0}
    rng=np.random.default_rng(SEED)
    starts=rng.integers(0,n,size=(5000,math.ceil(n/5)))
    indices=((starts[:,:,None]+np.arange(5))%n).reshape(5000,-1)[:,:n]
    sampled=data[indices]; counts=np.isfinite(sampled).sum(axis=1)
    means=np.divide(np.nansum(sampled,axis=1),counts,out=np.full(5000,np.nan),where=counts>0)
    valid=means[np.isfinite(means)]
    return {'n':int(mask.sum()),'mean':float(data[mask].mean()),
            'ci95':np.quantile(valid,[.025,.975]).tolist(),'bootstrap_valid':len(valid)}

def difference(left,right):
    return [a-b if finite(a) and finite(b) else None for a,b in zip(left,right,strict=True)]

def evaluate(days,*,rules_sha,weight_timing_sha,activation_checksum):
    """Requires every registered calendar attempt, including failed solves/cash days.

    Twenty structurally valid matured dates; cash days stay in the twenty and
    have missing paired observations. Never extend because a return was poor or
    an exposure was zero. Daily records are immutable coordinator receipts.
    """
    dates=[d['signal_date'] for d in days]
    if dates!=sorted(set(dates)):raise ValueError('calendar_order_or_duplicate')
    selected=[]; exclusions=[]; pending=[]; cutoff=None
    for d in days:
        verify(d)
        if (d['rules_sha']!=rules_sha or d['activation_checksum']!=activation_checksum
                or d.get('weight_timing_sha')!=weight_timing_sha
                or d.get('primary_weight_sample')!='preopen_sealed_targets'):
            raise ValueError('experiment_binding_mismatch')
        if set(d['arms'])!=set(ARMS):raise ValueError('four_arms_required')
        if d['label_status']=='pending':
            pending.append(d['signal_date']);break # cannot leapfrog an earlier unobserved outcome
        reasons=list(d.get('exclusion_reasons',[]))
        if d['label_status']!='mature':reasons.append('label_data_missing')
        for a in ARMS:
            row=d['arms'][a]
            if row.get('solve_success') is not True:reasons.append(a+':solve_failed')
            if not row.get('preopen_receipt_sha'):reasons.append(a+':preopen_receipt_missing')
            if not row.get('native_receipt_sha'):reasons.append(a+':native_receipt_missing')
            if row.get('data_complete') is not True:reasons.append(a+':data_missing')
            if not finite(row.get('exposure')) or row['exposure']<0:
                reasons.append(a+':invalid_target_exposure')
            if finite(row.get('exposure')) and row['exposure']==0 and row.get('primary') is not None:
                raise ValueError('zero_exposure_must_be_missing')
            if finite(row.get('exposure')) and row['exposure']>0 and not finite(row.get('primary')):
                reasons.append(a+':holding_labels_missing')
        if reasons:exclusions.append({'signal_date':d['signal_date'],'reasons':sorted(set(reasons))})
        else:selected.append(d['signal_date'])
        if len(selected)==20:cutoff=d['signal_date'];break
    result={'rules_sha':rules_sha,'weight_timing_sha':weight_timing_sha,
            'primary_weight_sample':'preopen_sealed_targets',
            'activation_checksum':activation_checksum,'eligible_dates':selected,
            'exclusions':exclusions,'pending':pending,'count':len(selected),'target':20,
            'promotion_allowed':False,'user_decision_required':True}
    if cutoff is None:return {**result,'status':'accumulating','selected_arm':None}
    attempts=[d for d in days if d['signal_date']<=cutoff]
    # All calendar dates remain on bootstrap axis; excluded dates are missing.
    scores={a:[d['arms'][a]['primary'] if d['signal_date'] in selected else None for d in attempts] for a in ARMS}
    comparisons={a:paired_stats(difference(scores[a],scores['L'])) for a in ARMS[:-1]}
    eligible=[a for a in ARMS[:-1] if comparisons[a]['n'] and comparisons[a]['mean']>0 and comparisons[a]['ci95'][1]>=0]
    result.update(comparisons_vs_L=comparisons,attempted_dates=len(attempts),last_signal_date=cutoff)
    if not eligible:return {**result,'status':'retain_L_no_eligible_candidate','selected_arm':None}
    leader=max(eligible,key=lambda a:(comparisons[a]['mean'],-ARMS.index(a)))
    chosen=leader; ties={}
    # Compare each simpler eligible candidate against the original best mean.
    # Do not create a chain of non-transitive ties by changing the comparator.
    for a in ARMS[:ARMS.index(leader)]:
        if a not in eligible:continue
        stat=paired_stats(difference(scores[a],scores[leader]));ties[a]=stat
        if stat['ci95'] and stat['ci95'][0]<=0<=stat['ci95'][1]:
            chosen=a;break
    pool=paired_stats(scores[chosen])
    rates={a:sum(d['arms'][a].get('solve_success') is True for d in attempts)/len(attempts) for a in (chosen,'L')}
    holds={}
    for a in (chosen,'L'):
        rows=[d['arms'][a] for d in attempts if d['signal_date'] in selected]
        if any(not finite(r.get('holding_age_value_sum')) or not finite(r.get('holding_market_value')) or r['holding_market_value']<0 for r in rows):
            holds[a]=None
        else:
            denom=sum(r['holding_market_value'] for r in rows)
            holds[a]=sum(r['holding_age_value_sum'] for r in rows)/denom if denom>0 else None
    gates={'beat_pool':finite(pool['mean']) and pool['mean']>0,
           'solve_rate':rates[chosen]>=rates['L'],
           'holding_period':finite(holds[chosen]) and finite(holds['L']) and holds[chosen]>=holds['L']}
    status='recommend_user_decision' if all(gates.values()) else ('L4 選股未勝過候選池平均' if not gates['beat_pool'] else 'retain_L_operational_gate_failed')
    return {**result,'status':status,'selected_arm':chosen,'best_mean_arm':leader,'simplicity_comparisons':ties,
            'selected_vs_D':pool,'solve_success_rates':rates,'market_value_weighted_holding_days':holds,'gates':gates}
