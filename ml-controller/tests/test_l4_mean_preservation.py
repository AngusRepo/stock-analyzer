import numpy as np
import pytest
from scripts.l4_mean_preservation import EmpiricalError,matured_history
from services.l4_portfolio import allocate


@pytest.mark.parametrize('centered',[True,False])
def test_prefix_moments_match_independent_brute_force(centered):
    e=np.array([-.08,-.01,0,.04,.11]);w=np.array([1,4,2,2,1],float);w/=w.sum()
    cdf=EmpiricalError(e,w,centered=centered);x=e-w@e if centered else e
    for mu,output in zip([-.2,-.01,0,.2],cdf.distribution([-.2,-.01,0,.2])):
        y=mu+x;negative=y<0;p=w[negative].sum()
        gain=(w[~negative]@y[~negative])/(1-p) if p<1 else 0
        loss=-(w[negative]@y[negative])/p if p>0 else 0
        assert output['p_loss']==pytest.approx(p)
        assert output['gain']==pytest.approx(gain)
        assert output['loss']==pytest.approx(loss)
        assert output['expected_return_gross']==pytest.approx(w@y)
        assert output['probability_positive_net_return']==pytest.approx(w[y>.0018].sum())
        if centered:assert output['expected_return_gross']==mu


def test_crps_matches_weighted_pair_distance_definition():
    rng=np.random.default_rng(43);e=rng.normal(0,.1,11);w=rng.uniform(.1,1,11);w/=w.sum()
    cdf=EmpiricalError(e,w,centered=True);mu=np.array([-.03,0,.02]);y=np.array([-.1,.001,.15])
    for m,target,actual in zip(mu,y,cdf.crps(mu,y)):
        values=m+e-w@e
        expected=w@abs(values-target)-.5*np.sum(w[:,None]*w[None,:]*abs(values[:,None]-values[None,:]))
        assert actual==pytest.approx(expected,abs=1e-14)


def test_zero_return_belongs_to_nonloss_event_not_positive_net():
    cdf=EmpiricalError([-.125,0,.125],[.25,.5,.25],centered=True)
    p=cdf.distribution([0])[0]
    assert p['p_loss']==.25 and p['probability_positive_net_return']==.25
    assert (1-p['p_loss'])*p['gain']-p['p_loss']*p['loss']==pytest.approx(0)


def test_prior_error_bank_excludes_future_labels_and_rejects_leaked_forecasts():
    rows=[{'date':'2026-08-01','symbol':'A','label_known_date':'2026-08-10','l3_training_label_known_max':'2026-07-31','prediction_kind':'oof','gross_return':.02},
          {'date':'2026-08-08','symbol':'A','label_known_date':'2026-08-17','l3_training_label_known_max':'2026-08-01','prediction_kind':'oof','gross_return':999}]
    base={(r['date'],r['symbol']):.01 for r in rows}
    train,e,w=matured_history(rows,base,'2026-08-11')
    assert len(train)==1 and e.tolist()==pytest.approx([.01])
    rows[0]['l3_training_label_known_max']='2026-08-01'
    with pytest.raises(ValueError,match='point_in_time'):matured_history(rows,base,'2026-08-11')


def test_same_mean_does_not_change_sparse_weights_or_create_extra_profit():
    mu=[.08,-.005,.02];output=EmpiricalError([-.1,0,.1],[1,2,1],centered=True).distribution(mu)
    args=dict(symbols=['A','B','C'],covariance=np.array([[.1,-.09,0],[-.09,.1,0],[0,0,.04]]),
        current_weights=[.1,.05,0],capital_available=.9,exposure_cap=.8,name_cap=.5,min_weight=.03,
        max_positions=None,buy_cost=.001425,sell_cost=.004425)
    base=allocate(expected_gross=mu,**args)
    alternative=allocate(expected_gross=[p['expected_return_gross'] for p in output],**args)
    assert base['weights']==alternative['weights']
    assert base['cash_weight']==alternative['cash_weight']
    assert base['proof']['evaluated_candidate_count']==3 and not base['proof']['preselection']
