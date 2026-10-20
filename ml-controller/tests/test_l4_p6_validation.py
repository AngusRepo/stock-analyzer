import numpy as np
import polars as pl
import pytest
from services.l4_distribution import digest
from services.l4_p6_validation import inner_report
from services.training_dual_cutoff import TrainingCutoff

def panel():
    # Dense low-score pool plus populated, distinct high-score tails.
    score=np.concatenate([np.linspace(-1,1,200),[1.4,1.7,2.2]])
    return pl.DataFrame([dict(date=date,label_known_date=known,symbol=str(i),score=float(x),
        gross_return=float(x*.01),prediction_kind='oof')
        for date,known in [('2026-09-21','2026-09-30'),('2026-09-22','2026-10-01')]
        for i,x in enumerate(score)])

def report(frame,**kwargs):
    return inner_report(frame,source_sha256='a'*64,cutoff=TrainingCutoff('2026-09-22','2026-10-01'),
        expected_keys_checksum=digest(frame.sort('date','symbol').select('date','symbol').to_dicts()),**kwargs)

def test_r32_positive_tail_gate_and_same_window_table():
    value=report(panel(),windows={'2026-09-21':'w6','2026-09-22':'w6'})
    assert value['champion_B_gate']['status']=='pass'
    assert value['metrics']['all']==value['metrics']['w6']
    assert value['metrics']['all']['rank_ic']['mean']==pytest.approx(1.)
    assert value['daily'][1]['top10_overlap_previous']==10
    assert value['champion_B_gate']['deployment_authorized'] is False
    assert value['outer_credit']==0

def test_missing_high_bin_is_not_positive_or_eb_filled():
    frame=panel().filter(pl.col('score')<=1.4)
    value=report(frame)
    assert value['champion_B_gate']['status']=='incomplete'
    assert value['champion_B_gate']['missing_high_z_bins']
    assert value['champion_B_gate']['user_decision_required']

def test_negative_tail_or_top5_fails_even_if_other_metrics_are_positive():
    frame=panel().with_columns(pl.when(pl.col('score')>=2.2).then(-.1).otherwise(pl.col('gross_return')).alias('gross_return'))
    value=report(frame)
    assert value['metrics']['all']['rank_ic']['mean']>0
    assert value['champion_B_gate']['status']=='fail'
    assert 8 in value['champion_B_gate']['nonpositive_high_z_bins']
    negative=report(panel().with_columns((-pl.col('gross_return')).alias('gross_return')))
    assert negative['champion_B_gate']['top5_excess_mean_pp']<0
    assert negative['champion_B_gate']['status']=='fail'

def test_wrong_windows_rejected_without_silent_date_intersection():
    with pytest.raises(ValueError,match='window_dates_mismatch'):
        report(panel(),windows={'2026-09-22':'w6'})
