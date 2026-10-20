"""R32 inner report and explicit B gate. Never publishes or promotes a model."""
import math
import numpy as np
import polars as pl
from services.l4_distribution import digest
from services.l4_p6_calibration import fit_oof, interval, Z_EDGES

METRICS=('rank_ic','top20_bottom20_pp','top5_excess_pp','rank6_20_excess_pp')

def _summary(records):
    result={}
    for field in METRICS:
        values=[r[field] for r in records]
        missing=[r['date'] for r in records if r[field] is None]
        result[field]={'status':'missing_daily_evidence','missing_dates':missing} if missing else interval(values)
    return result

def inner_report(frame, *, source_sha256, cutoff, expected_keys_checksum, windows=None):
    frame=frame.sort('date','symbol')
    calibration=fit_oof(frame,source_sha256=source_sha256,cutoff=cutoff,
        expected_keys_checksum=expected_keys_checksum)
    days=sorted(frame['date'].unique())
    if windows is not None and set(windows)!=set(days):raise ValueError('p6_report_window_dates_mismatch')
    records=[];daily_bins=[]
    previous_top10=None
    for group in frame.partition_by('date',maintain_order=True):
        day=group['date'][0];ranked=group.sort(['score','symbol'],descending=[True,False])
        pool=group['gross_return'].mean();k=math.ceil(group.height*.2)
        ic=group.select(pl.corr('score','gross_return',method='spearman')).item()
        top10=ranked.head(10)['symbol'].to_list()
        records.append(dict(date=day,window=windows[day] if windows is not None else None,rows=group.height,
            rank_ic=float(ic) if ic is not None and math.isfinite(ic) else None,
            top20_bottom20_pp=100*(ranked.head(k)['gross_return'].mean()-ranked.tail(k)['gross_return'].mean()),
            top5_excess_pp=100*(ranked.head(5)['gross_return'].mean()-pool) if group.height>=5 else None,
            rank6_20_excess_pp=100*(ranked.slice(5,15)['gross_return'].mean()-pool) if group.height>=20 else None,
            top10_overlap_previous=None if previous_top10 is None else len(set(top10)&set(previous_top10)),
            top10=top10))
        previous_top10=top10
        scores=group['score'].to_numpy();excess=group['gross_return'].to_numpy()-pool
        z=(scores-scores.mean())/scores.std()
        bins=np.searchsorted(Z_EDGES,z,side='right')-1
        for b in range(9):
            mask=bins==b
            daily_bins.append(dict(date=day,bin=b,rows=int(mask.sum()),
                realized_excess_pp=float(excess[mask].mean()*100) if mask.any() else None))
    summary={'all':_summary(records)}
    if windows is not None:
        for window in sorted(set(windows.values())):
            summary[window]=_summary([r for r in records if r['window']==window])
    top5=summary['all']['top5_excess_pp']
    high_bins=[r for r in calibration['realized_bins'] if r['bin']>=6]
    missing=[r['bin'] for r in high_bins if r['mean'] is None]
    failed=[r['bin'] for r in high_bins if r['mean'] is not None and r['mean']<=0]
    evidence_complete=not missing and 'mean' in top5
    passed=evidence_complete and top5['mean']>0 and not failed
    gate=dict(rule='R32-section-2-P6-a-B',status='pass' if passed else 'fail' if evidence_complete else 'incomplete',
        top5_excess_mean_pp=top5.get('mean'),high_z_bins=high_bins,missing_high_z_bins=missing,
        nonpositive_high_z_bins=failed,criterion='top5 mean > 0 AND raw realized excess > 0 in each z>=2 bin',
        uses_empirical_bayes_for_gate=False,requires_monotonic_order_between_positive_bins=False,
        user_decision_required=not passed,deployment_authorized=False)
    result=dict(schema_version='p6-inner-validation-r32-v1',source_sha256=source_sha256,
        candidate_keys_checksum=expected_keys_checksum,requested_cutoff=cutoff.__dict__,dates=days,rows=frame.height,
        metrics=summary,daily=records,z_daily=daily_bins,calibration=calibration,champion_B_gate=gate,
        bootstrap=dict(method='trading_day_circular_block',block=5,repetitions=5000,coverage=.95,seed=20261015),
        evidence_scope='inner_development_only',reference_role='R16 reference is not the live champion comparison',
        top_bottom_definition='top and bottom ceil(0.2*N) full candidate pool',tie_break='symbol ascending',
        z_std_ddof=0,outer_credit=0,production_changed=False)
    return {**result,'checksum':digest(result)}
