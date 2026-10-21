from copy import deepcopy
from datetime import date,timedelta
import numpy as np
import pytest
from services import l4_monthly_stacker_experiments as owner
from services.training_dual_cutoff import TrainingCutoff
from test_p3_mean_loss import ORDER


def fixture():
    first=date(2026,6,1);rng=np.random.default_rng(42);rows=[]
    days=[str(first+timedelta(days=d)) for d in range(70)]
    for d,day in enumerate(days):
        for symbol in range(24):
            x=rng.uniform(size=8)
            x[1]=x[0]*.97+x[1]*.03
            rows.append(dict(prediction_date=day,label_known_date=str(first+timedelta(days=d+5)),
                symbol=f'S{symbol:03d}',fold_id=f'w{4+(d-40)//10}' if d>=40 else 'warmup',
                market_segment='TW',stacker_features=[*x,*([1.]*8)],
                target_return=float(.02*x[0]+.03*x[4]+rng.normal(0,.01))))
    qualification={}
    for model in ORDER:
        folds=[dict(fold_id=f'q{f}',oos_ic=.1,date_cluster_ics=[dict(date=days[f*10+i],rank_ic=.1) for i in range(10)]) for f in range(7)]
        qualification[model]=dict(fold_metrics=folds,policy={'tail_fold_guard':{}})
    args=dict(order=ORDER,windows=['w4','w5','w6'],qualification=qualification,manifest_checksum='a'*64,
        cutoff=TrainingCutoff('2026-09-22','2026-10-01'))
    return rows,args


def test_fixed_windows_ablation_and_report_use_one_pool():
    rows,args=fixture();panel,daily,fits,report=owner.compare(rows,**args)
    assert len(fits)==15 and len(daily)==150 and panel.height==720
    assert report['combined_removals_tested'] is False and report['online_switch'] is False
    assert len(report['tree_rank_correlations'])==9 and len(report['tree_marginal_IC'])==3
    for fit in fits:
        assert fit['label_known_max']<fit['cutoff_exclusive']
        if fit['variant'].startswith('without_'):
            removed=fit['variant'].removeprefix('without_')
            assert fit['weights'][removed]==fit['availability_weights'][removed]==0
        if fit['prior_evidence']:
            assert all(p['label_known_max'] is None or p['label_known_max']<fit['cutoff_exclusive'] for p in fit['prior_evidence'].values())
            assert all(p['label_known_max'] is None or p['label_known_max']<fit['inner_validation_start'] for p in fit['inner_prior_evidence'].values())
    assert {r['rows'] for r in daily}=={24}


def test_current_window_labels_cannot_change_any_current_window_fit():
    rows,args=fixture();changed=deepcopy(rows)
    for row in changed:
        if row['fold_id']=='w4':row['target_return']=100-row['target_return']
    _,_,fits,_=owner.compare(rows,**args)
    _,_,other,_=owner.compare(changed,**args)
    assert [f for f in fits if f['window']=='w4']==[f for f in other if f['window']=='w4']
    assert [f for f in fits if f['window']=='w5']!=[f for f in other if f['window']=='w5']


def test_future_qualification_cannot_change_earlier_prior():
    rows,args=fixture();maturity={r['prediction_date']:r['label_known_date'] for r in rows}
    cutoff='2026-07-11'
    before=owner.causal_prior(args['qualification'],ORDER,maturity,cutoff)
    changed=deepcopy(args['qualification'])
    for proof in changed.values():
        for fold in proof['fold_metrics']:
            if any(maturity[c['date']]>=cutoff for c in fold['date_cluster_ics']):
                fold['oos_ic']=-100
                for c in fold['date_cluster_ics']:c['rank_ic']=-100
    after=owner.causal_prior(changed,ORDER,maturity,cutoff)
    np.testing.assert_array_equal(before[0],after[0]);assert before[1]==after[1]


def test_cutoff_violation_prevents_any_fit(monkeypatch):
    rows,args=fixture();rows[-1]['label_known_date']='2026-10-02'
    monkeypatch.setattr(owner,'_fit_selected_ridge',lambda *a,**k:pytest.fail('fit after cutoff'))
    with pytest.raises(ValueError,match='dual_cutoff'):owner.compare(rows,**args)
