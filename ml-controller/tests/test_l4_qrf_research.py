"""Independent full-CDF checks before the offline QRF fit."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import numpy as np
import pytest
from l4_qrf_research import LeafQRF


def model():
    x=np.arange(24,dtype=float).reshape(-1,1);y=np.array([-.12,-.06,0,.02,.10,.20]*4)
    w=np.arange(1,25,dtype=float)
    return LeafQRF(n_estimators=7,max_depth=2,min_samples_leaf=3,random_state=4,n_jobs=1).fit(x,y,w),x,y,w


def test_distribution_matches_independent_bootstrap_enumeration():
    m,x,y,w=model();query=x[[0,7,23]]
    for q,actual in zip(query,m.distributions(query)):
        expected=np.zeros(len(y))
        for tree,draw in zip(m.forest.estimators_,m.forest.estimators_samples_):
            leaf=tree.apply(q.reshape(1,-1))[0];chosen=[int(i) for i in draw if tree.apply(x[i:i+1])[0]==leaf]
            denom=sum(w[i] for i in chosen)
            for i in chosen:expected[i]+=w[i]/denom/len(m.leaves)
        np.testing.assert_allclose(actual,expected,atol=1e-14)
        assert abs(actual.sum()-1)<1e-12


def test_moments_match_full_distribution_and_forest_mean():
    m,x,y,w=model();pred=m.predict(x)
    np.testing.assert_allclose([p['expected_return_gross'] for p in pred],m.forest.predict(x),atol=1e-12)
    for d,p in zip(m.distributions(x),pred):
        assert p['p_loss']==pytest.approx(d[y<0].sum())
        assert p['probability_positive_net_return']==pytest.approx(d[y>.0018].sum())
        assert (1-p['p_loss'])*p['gain']-p['p_loss']*p['loss']==pytest.approx(d@y)
        assert p['gain']==pytest.approx(d[y>=0]@y[y>=0]/d[y>=0].sum())
        assert p['loss']==pytest.approx(-d[y<0]@y[y<0]/d[y<0].sum())


def test_exact_crps_matches_pairwise_definition():
    m,x,y,w=model();query=x[[0,7,23]];z=np.array([-.1,0,.15])
    expected=[]
    for d,v in zip(m.distributions(query),z):expected.append(d@abs(y-v)-.5*np.sum(d[:,None]*d[None,:]*abs(y[:,None]-y[None,:])))
    np.testing.assert_allclose(m.crps(query,z),expected,atol=1e-12)


def test_quantiles_preserve_order_and_empirical_support():
    m,x,y,w=model();q=m.quantiles(x,[0,.1,.5,.9,1])
    assert np.all(np.diff(q,axis=1)>=0)
    assert set(q.ravel())<=set(y)


@pytest.mark.parametrize('outcome',[-.05,0,.05])
def test_zero_mass_events(outcome):
    x=np.arange(12).reshape(-1,1);m=LeafQRF(n_estimators=3,random_state=1).fit(x,np.full(12,outcome),np.ones(12))
    for p in m.predict(x):
        assert p['expected_return_gross']==pytest.approx(outcome)
        assert p['p_loss']==pytest.approx(float(outcome<0))
        assert p['loss_defined']==(outcome<0)
        assert p['gain_defined']==(outcome>=0)


def test_invalid_data_rejected():
    with pytest.raises(ValueError):LeafQRF().fit([[0],[1]],[0,1],[1,0])
