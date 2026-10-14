"""Measured pre-seal evidence; never impute returns or fit an alpha model."""
from datetime import date
import numpy as np
from services.l4_distribution import digest
from services.l4_dated_risk import is_dated_risk


def measured_five_session_covariance(history, symbols, minimum_windows):
    """Compound disjoint five-session windows, masking missing names individually.

    The universe is unchanged. Insufficient per-name history prohibits new buys;
    missing pair observations carry conservative risk, never zero-risk credit.
    """
    if (not is_dated_risk(history)
            or history.get('checksum') != digest({k:v for k,v in history.items() if k!='checksum'})
            or type(minimum_windows) is not int or minimum_windows < 2
            or not symbols or len(symbols)!=len(set(symbols))
            or set(symbols)-set(history['returns'])):
        raise ValueError('l4_measured_risk_source_invalid')
    signal_date=history['signal_date'];date.fromisoformat(signal_date)
    intervals=history['intervals']
    previous=None
    for start,end in intervals:
        date.fromisoformat(start);date.fromisoformat(end)
        if start>=end or end>signal_date or previous is not None and start!=previous:
            raise ValueError('l4_measured_risk_calendar_invalid')
        previous=end
    x=np.asarray([[np.nan if v is None else v for v in history['returns'][s]] for s in symbols],float).T
    if x.shape!=(len(intervals),len(symbols)) or np.isinf(x).any() or np.any(x<=-1):
        raise ValueError('l4_measured_risk_returns_invalid')
    samples=[];windows=[];missing=[]
    # Anchor backwards to the signal date. Every sample covers five returns.
    for start in range(len(intervals)%5,len(intervals)-4,5):
        block=x[start:start+5]
        span=[intervals[start][0],intervals[start+4][1]]
        if not np.isfinite(block).all():missing.append(span)
        samples.append(np.prod(1+block,axis=0)-1);windows.append(span)
    if len(samples)<minimum_windows:
        raise ValueError(f'l4_measured_risk_complete_windows_insufficient:{len(samples)}:{minimum_windows}')
    samples=np.asarray(samples);observed=np.isfinite(samples)
    counts=observed.astype(float).T@observed.astype(float)
    eligible=np.diag(counts)>=minimum_windows
    if not eligible.any():raise ValueError('l4_measured_risk_per_name_windows_insufficient')
    coverage={s:{'observed_windows':int(counts[i,i]),'missing_windows':len(windows)-int(counts[i,i]),
        'new_buys_allowed':bool(eligible[i])} for i,s in enumerate(symbols)}
    correction=0.;loading=np.zeros(len(symbols));negative=0
    if observed.all():
        # Shrink actual compounded observations, never a daily covariance proxy.
        from sklearn.covariance import LedoitWolf
        fit=LedoitWolf().fit(samples);covariance=fit.covariance_;shrinkage=float(fit.shrinkage_)
        method='observed_nonoverlapping_five_session_returns'
        estimator='ledoit_wolf_on_compounded_five_session_returns'
    else:
        # Zeros below are masked algebra, not synthetic return observations.
        safe=np.where(observed,samples,0.);totals=safe.T@observed.astype(float)
        supported=counts>=minimum_windows
        covariance=np.divide(safe.T@safe-np.divide(totals*totals.T,counts,
            out=np.zeros_like(counts),where=counts>0),counts-1,
            out=np.zeros_like(counts),where=supported)
        variance=np.maximum(np.diag(covariance),1e-8)
        unknown=~supported;np.fill_diagonal(unknown,False)
        # Cauchy-Schwarz bounds missing cross terms; forbidden names have zero
        # feasible weight (runtime rejects insufficient-history holdings).
        loading=(np.sqrt(np.outer(variance,variance))*unknown*np.outer(eligible,eligible)).sum(axis=1)
        np.fill_diagonal(covariance,variance+loading)
        values,vectors=np.linalg.eigh(covariance)
        negative=int((values<0).sum());correction=float(np.linalg.norm(np.minimum(values,0.)))
        if negative:covariance=(vectors*np.maximum(values,0.))@vectors.T
        covariance=(covariance+covariance.T)*.5
        shrinkage=None;method='observed_pairwise_nonoverlapping_five_session_returns'
        estimator='pairwise_compounded_returns_conservative_unknown_pairs_psd_spectral'
    packet={'schema_version':'l4-measured-horizon-covariance-v1','horizon_sessions':5,
        'symbols':list(symbols),'signal_date':signal_date,'known_date_max':windows[-1][1],
        'observed_windows':int(np.diag(counts)[eligible].min()),'method':method,
        'source_reference':'l4-dated-risk-v1:'+history['checksum'],
        'source_checksum':history['checksum'],'windows':windows,'incomplete_windows':missing,
        'total_windows':len(windows),'minimum_windows':minimum_windows,'coverage':coverage,
        'forbidden_buys':[s for s in symbols if not coverage[s]['new_buys_allowed']],
        'pair_observation_counts':counts.astype(int).tolist(),
        'unknown_pair_diagonal_loading':loading.tolist(),'psd_correction_frobenius':correction,
        'negative_eigenvalues':negative,'estimator':estimator,
        'shrinkage':shrinkage,'covariance':covariance.tolist()}
    packet['checksum']=digest(packet)
    return packet


def bind_calibration_packets(policy, signal_date):
    """Bind previously reviewed immutable calibration summaries to today's seal.

    No forward filling, cross-model reuse, or fabrication when evidence is absent.
    The calibrated artifact checksum is static; only signal_date is contextual.
    """
    config=policy.get('sealedExecution') or {}
    saved=policy.get('sealedExecutionCalibration') or {}
    result={}
    for checksum_key, runtime_key in (
        ('uncertainty_calibration_checksum','sealed_execution_evidence'),
        ('execution_cost_calibration_checksum','sealed_execution_cost_evidence'),
    ):
        expected=config.get(checksum_key)
        if expected is None:continue
        packet=saved.get(runtime_key)
        if (not isinstance(packet,dict) or packet.get('checksum')!=expected
                or expected!=digest({k:v for k,v in packet.items() if k!='checksum'})
                or not packet.get('known_date_max') or packet['known_date_max']>=signal_date
                or 'signal_date' in packet or 'calibration_checksum' in packet):
            raise ValueError('l4_sealed_calibration_artifact_missing_or_invalid')
        dated={**{k:v for k,v in packet.items() if k!='checksum'},
               'calibration_checksum':expected,'signal_date':signal_date}
        dated['checksum']=digest(dated)
        result[runtime_key]=dated
    return result


def calibrate_trade_uncertainty(records, *, model_checksum, symbols, as_of, minimum_dates, source_reference):
    """Summarize actual held-out errors; no model fitting or seed dispersion."""
    date.fromisoformat(as_of)
    if type(minimum_dates) is not int or minimum_dates<1 or not source_reference:
        raise ValueError('l4_uncertainty_calibration_configuration_invalid')
    by_date={};seen=set()
    for row in records:
        key=(row['symbol'],row['prediction_date'])
        if (key in seen or row.get('checksum')!=digest({k:v for k,v in row.items() if k!='checksum'})
                or row.get('model_checksum')!=model_checksum or row.get('horizon_sessions')!=5
                or row.get('return_semantic')!='canonical_adjusted_five_session_gross_decimal'
                or not row['training_label_known_max']<row['prediction_date']<row['label_end_date']<=row['known_date']<as_of
                or not row.get('prediction_source') or not row.get('label_source')):
            raise ValueError('l4_uncertainty_observation_lineage_invalid')
        for field in ('training_label_known_max','prediction_date','label_end_date','known_date'):date.fromisoformat(row[field])
        values=np.asarray([row['expected_return_gross'],row['actual_return_gross']],float)
        if not np.isfinite(values).all():raise ValueError('l4_uncertainty_observation_nonfinite')
        seen.add(key);by_date.setdefault(row['prediction_date'],[]).append(row)
    chosen=[];end=None
    for day,cohort in sorted(by_date.items()):
        if end is not None and day<end:continue
        chosen.extend(cohort);end=max(r['label_end_date'] for r in cohort)
    errors={};counts={}
    for symbol in symbols:
        rows=[r for r in chosen if r['symbol']==symbol]
        if len(rows)<minimum_dates:raise ValueError('l4_uncertainty_independent_coverage_insufficient:'+symbol)
        counts[symbol]=len(rows)
        errors[symbol]=float(np.mean([abs(r['expected_return_gross']-r['actual_return_gross']) for r in rows]))
    if not errors:raise ValueError('l4_uncertainty_calibration_empty')
    packet={'schema_version':'l4-oos-trade-uncertainty-v1','model_checksum':model_checksum,
        'horizon_sessions':5,'known_date_max':max(r['known_date'] for r in chosen),
        'independent_dates':min(counts.values()),'independent_dates_by_symbol':counts,
        'status':'validated_oos','source_reference':source_reference,'source_records_checksum':digest(records),
        'method':'mean_absolute_heldout_error_disjoint_label_windows',
        'absolute_return_error_by_symbol':errors}
    packet['checksum']=digest(packet)
    return packet


def calibrate_execution_cost(records, *, symbols, as_of, minimum_observations, source_reference, max_quote_age_ms):
    """Additional adverse slippage only; existing commission/tax remain separate."""
    from datetime import datetime,timezone
    date.fromisoformat(as_of)
    if (type(minimum_observations) is not int or minimum_observations<1 or not source_reference
            or type(max_quote_age_ms) is not int or max_quote_age_ms<1):
        raise ValueError('l4_execution_calibration_configuration_invalid')
    costs={};seen=set();days=[]
    for row in records:
        key=row.get('execution_id')
        if (not key or key in seen or row.get('checksum')!=digest({k:v for k,v in row.items() if k!='checksum'})
                or row.get('side') not in ('buy','sell') or not row.get('execution_source') or not row.get('quote_source')
                or not row['known_date']<as_of):
            raise ValueError('l4_execution_observation_lineage_invalid')
        date.fromisoformat(row['known_date'])
        at=datetime.fromisoformat(row['executed_at'].replace('Z','+00:00'))
        quote=datetime.fromisoformat(row['quote_observed_at'].replace('Z','+00:00'))
        if (at.tzinfo is None or quote.tzinfo is None or not 0<=(at-quote).total_seconds()*1000<=max_quote_age_ms
                or at.astimezone(timezone.utc).date().isoformat()>row['known_date']):
            raise ValueError('l4_execution_quote_not_point_in_time')
        price=float(row['fill_price']);reference=float(row['arrival_mid_price'])
        if not np.isfinite([price,reference]).all() or min(price,reference)<=0:
            raise ValueError('l4_execution_observation_price_invalid')
        seen.add(key);days.append(row['known_date'])
        adverse=(price/reference-1)*(1 if row['side']=='buy' else -1)
        costs.setdefault((row['symbol'],row['side']),[]).append(max(0.,adverse))
    packet={'schema_version':'l4-observed-execution-cost-v1','status':'verified_execution_receipts',
        'source_reference':source_reference,'source_records_checksum':digest(records),
        'method':'mean_adverse_fill_vs_observed_arrival_mid_excluding_commission_tax',
        'observations':len(records),'known_date_max':max(days) if days else None,'observations_by_symbol_side':{}}
    for side in ('buy','sell'):
        values={}
        for symbol in symbols:
            observations=costs.get((symbol,side),[])
            if len(observations)<minimum_observations:
                raise ValueError('l4_execution_observed_coverage_insufficient:'+symbol+':'+side)
            values[symbol]=float(np.mean(observations))
            packet['observations_by_symbol_side'][symbol+':'+side]=len(observations)
        packet['additional_'+side+'_cost_by_symbol']=values
    if not symbols:raise ValueError('l4_execution_calibration_empty')
    packet['checksum']=digest(packet)
    return packet
