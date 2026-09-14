"""Dated, masked risk observations. Missing prices never become return labels."""
from datetime import date
import math
import numpy as np
from services.l4_distribution import digest
SCHEMA='l4-dated-risk-v1'
MIN_OBSERVATIONS=20

def build_dated_risk(payloads, *, signal_date, lookback):
    date.fromisoformat(signal_date)
    if type(lookback) is not int or not 20<=lookback<=504:raise ValueError('l4_risk_lookback_invalid')
    prices={};invalid={};calendar=set()
    for row in payloads:
        symbol=str(row.get('symbol') or row.get('stock_id') or '')
        if not symbol or symbol in prices:raise ValueError('l4_risk_duplicate_or_missing_symbol')
        values={};bad=[]
        for bar in row.get('prices') or []:
            day=str(bar.get('date') or '')[:10];date.fromisoformat(day)
            if day>signal_date:raise ValueError('paired_nav_allocator_history_future_price')
            if day in values:raise ValueError('l4_risk_duplicate_price_date')
            calendar.add(day);raw=bar.get('adj_close')
            value=float(raw) if raw is not None else float('nan')
            values[day]=value if math.isfinite(value) and value>0 else None
            if values[day] is None:bad.append(day)
        prices[symbol]=values;invalid[symbol]=bad
    days=sorted(calendar)[-(lookback+1):]
    if len(days)<21:raise ValueError('l4_risk_calendar_insufficient')
    intervals=[list(pair) for pair in zip(days,days[1:])];returns={};coverage={}
    for symbol,values in prices.items():
        rr=[round(values[b]/values[a]-1,8) if values.get(a) is not None and values.get(b) is not None else None for a,b in intervals]
        valid=[d for d,v in values.items() if v is not None];last=max(valid) if valid else None
        reasons=[]
        if sum(v is not None for v in rr)<MIN_OBSERVATIONS:reasons.append('insufficient_observed_daily_returns')
        if last!=signal_date:reasons.append('latest_canonical_price_missing')
        returns[symbol]=rr
        coverage[symbol]={'observations':sum(v is not None for v in rr),'missing_intervals':sum(v is None for v in rr),
            'latest_price_date':last,'first_observed_price_date':min(valid) if valid else None,
            'before_first_observation_days':sum(d<min(valid) for d in days) if valid else len(days),
            'new_buys_allowed':not reasons,'reasons':reasons,
            'missing_price_dates':[d for d in days if values.get(d) is None and (not valid or d>=min(valid))],
            'invalid_price_dates':[d for d in invalid[symbol] if d in days]}
    packet={'schema_version':SCHEMA,'signal_date':signal_date,'lookback':lookback,'intervals':intervals,'returns':returns,
        'coverage':coverage,'missing_data_policy':'observed_pairwise_intervals_no_forward_fill_no_raw_close_substitution',
        'repair_required_symbols':sorted(s for s,c in coverage.items() if c['missing_price_dates'] or c['reasons'])}
    packet['checksum']=digest(packet)
    return packet

def is_dated_risk(value):return isinstance(value,dict) and value.get('schema_version')==SCHEMA

def estimate_risk(packet, symbols, *, daily_vol_floor=.01):
    if not is_dated_risk(packet) or packet.get('checksum')!=digest({k:v for k,v in packet.items() if k!='checksum'}):
        raise ValueError('l4_risk_packet_checksum_invalid')
    if not symbols or len(symbols)!=len(set(symbols)) or set(symbols)-set(packet['returns']):raise ValueError('l4_risk_packet_symbols_invalid')
    x=np.array([[np.nan if v is None else v for v in packet['returns'][s]] for s in symbols],float).T
    if x.shape!=(len(packet['intervals']),len(symbols)) or np.isinf(x).any():raise ValueError('l4_risk_packet_shape_invalid')
    floor=max(1e-8,daily_vol_floor**2);observed=np.isfinite(x);mask=observed.astype(float);safe=np.where(observed,x,0.)
    counts=mask.T@mask;totals=safe.T@mask
    supported=counts>=MIN_OBSERVATIONS
    cov=np.divide(safe.T@safe-np.divide(totals*totals.T,counts,out=np.zeros_like(counts),where=counts>0),counts-1,
        out=np.zeros_like(counts),where=supported)
    covariance_correction=0.;negative_eigenvalues=0;unknown_loading=np.zeros(len(symbols))
    if observed.all():
        from services.similarity_evidence import ledoit_wolf_covariance,sample_return_correlation_matrix
        history={s:x[:,i].tolist() for i,s in enumerate(symbols)}
        result=ledoit_wolf_covariance(symbols,history,daily_vol_floor=daily_vol_floor,min_observations=MIN_OBSERVATIONS)
        corr,method=sample_return_correlation_matrix(symbols,history,min_observations=MIN_OBSERVATIONS)
    else:
        variance=np.maximum(np.diag(cov),floor)
        denom=np.sqrt(np.outer(variance,variance));corr=np.clip(cov/denom,-1,1);np.fill_diagonal(corr,1.)
        unknown=~supported;np.fill_diagonal(unknown,False)
        # Missing pair covariance is not evidence of independence. Bound all
        # unknown cross terms by Cauchy-Schwarz and 2|wi*wj| <= wi^2+wj^2.
        eligible=np.array([packet['coverage'][s]['observations']>=MIN_OBSERVATIONS for s in symbols])
        # Insufficient-history names cannot be bought; holding them is rejected
        # by runtime. Their zero feasible weight must not penalize other names.
        unknown_loading=(denom*unknown*np.outer(eligible,eligible)).sum(axis=1)
        np.fill_diagonal(cov,variance+unknown_loading)
        eigenvalues,eigenvectors=np.linalg.eigh(cov)
        negative_eigenvalues=int((eigenvalues<0).sum())
        covariance_correction=float(np.linalg.norm(np.minimum(eigenvalues,0.)))
        # Nearest PSD spectral projection adds only negative-eigenvalue modes,
        # rather than penalizing every stock with the worst eigenvalue.
        if negative_eigenvalues:
            cov=(eigenvectors*np.maximum(eigenvalues,0.))@eigenvectors.T
        cov=(cov+cov.T)*.5+np.eye(len(symbols))*floor
        corr[unknown & np.outer(eligible,eligible)]=1.
        method='dated_pairwise_observed_conservative_unknown_pairs'
        result={'symbols':symbols,'covariance':cov.tolist(),'covariance_method':'dated_pairwise_psd_spectral',
            'covariance_shrinkage':None,'observation_count':len(packet['intervals']),'var_floor':floor}
    result.update(graph_correlation=corr.tolist(),correlation_method=method,
        coverage={s:packet['coverage'][s] for s in symbols},risk_packet_checksum=packet['checksum'],
        pair_observation_min=int(counts.min()),unsupported_pairs=int(np.triu(~supported,1).sum()),
        psd_correction_frobenius=covariance_correction,negative_eigenvalues=negative_eigenvalues,unknown_pair_diagonal_loading=unknown_loading.tolist(),
        forbidden_buys=[s for s in symbols if not packet['coverage'][s]['new_buys_allowed']],
        repair_required_symbols=[s for s in symbols if packet['coverage'][s]['missing_price_dates']],
        data_guarantee='available observations retained; missing external data remains explicit')
    return result
