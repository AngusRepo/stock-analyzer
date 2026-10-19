from datetime import date,timedelta
import pytest
from services.l4_r17_acceptance import primary,evaluate,paired_stats,seal

def day(i,values=(.02,.021,.022,0.)):
    return seal({'signal_date':str(date(2026,11,1)+timedelta(days=i)),
        'rules_sha':'rules','weight_timing_sha':'timing','primary_weight_sample':'preopen_sealed_targets','activation_checksum':'activation','label_status':'mature',
        'arms':{a:{'primary':v,'exposure':.5,'solve_success':True,'data_complete':True,
          'preopen_receipt_sha':'target','native_receipt_sha':'native','holding_age_value_sum':500.,
          'holding_market_value':100.} for a,v in zip(('A','B','C','L'),values)}})

def edit(d,arm,**changes):
    d.pop('checksum');d['arms'][arm].update(changes);return seal(d)

def test_metric_separates_exposure_and_missing_from_zero():
    assert primary({'x':.1},{'x':.1,'y':0.},['x','y'])['primary']==pytest.approx(.05)
    assert primary({'x':.8},{'x':.1,'y':0.},['x','y'])['primary']==pytest.approx(.05)
    assert primary({}, {'x':.1,'y':0.},['x','y'])['primary'] is None
    with pytest.raises(ValueError,match='label_missing'):primary({'held':.2},{'x':.1},['x'])

def test_twenty_only_not_early_stopping_or_lookahead():
    assert evaluate([day(i) for i in range(19)],rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')['status']=='accumulating'
    result=evaluate([day(i) for i in range(25)],rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')
    assert result['count']==20 and result['attempted_dates']==20
    assert result['selected_arm']=='C' and result['status']=='recommend_user_decision'
    assert result['promotion_allowed'] is False

def test_failed_solves_are_excluded_but_remain_rate_denominator():
    days=[day(i) for i in range(21)]
    days[0]=edit(days[0],'C',solve_success=False)
    result=evaluate(days,rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')
    assert result['count']==20 and result['attempted_dates']==21
    assert result['solve_success_rates']['C']==20/21
    assert result['status']=='retain_L_operational_gate_failed'
    assert result['comparisons_vs_L']['C']['n']==20

def test_cash_days_missing_no_result_driven_extension():
    days=[day(i) for i in range(23)]
    days[0]=edit(days[0],'A',primary=None,exposure=0.)
    result=evaluate(days,rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')
    assert result['count']==20 and result['attempted_dates']==20
    assert result['comparisons_vs_L']['A']['n']==19

def test_simplicity_ties_compared_with_original_leader():
    days=[day(i,values=(.02,.02,.02,0.)) for i in range(20)]
    result=evaluate(days,rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')
    assert result['selected_arm']=='A'

def test_pool_check_and_holding_gate_are_not_optional():
    days=[day(i,values=(-.01,-.02,-.03,-.04)) for i in range(20)]
    result=evaluate(days,rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')
    assert result['status']=='L4 選股未勝過候選池平均'
    days=[edit(day(i),'C',holding_age_value_sum=100.) for i in range(20)]
    assert evaluate(days,rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')['gates']['holding_period'] is False

def test_pending_does_not_leapfrog_and_corruption_rejected():
    days=[day(i) for i in range(22)]
    days[0].pop('checksum');days[0]['label_status']='pending';days[0]=seal(days[0])
    assert evaluate(days,rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')['count']==0
    days[0]['arms']['A']['primary']=100.
    with pytest.raises(ValueError,match='checksum'):evaluate(days,rules_sha='rules',weight_timing_sha='timing',activation_checksum='activation')

def test_bootstrap_deterministic_and_does_not_fill_missing():
    x=[None,.1,.2,.3,None,.4,.5]
    assert paired_stats(x)==paired_stats(x)
    assert paired_stats(x)['n']==5
    assert paired_stats([None]*20)['ci95'] is None
