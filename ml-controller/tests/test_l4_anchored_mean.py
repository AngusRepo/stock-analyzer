"""Independent numerical checks for the authorized offline residual fit."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import numpy as np
import pytest
from l4_anchored_mean import fit_correction,correction_predict

def test_weighted_ridge_matches_augmented_least_squares():
    rng=np.random.default_rng(17);x=rng.normal(size=(23,4));mu=rng.normal(size=23);y=rng.normal(size=23);w=np.arange(1,24,dtype=float);w/=w.sum();lam=.1
    z=np.column_stack((np.ones(len(x)),x))
    expected=np.linalg.lstsq(np.vstack((np.sqrt(w)[:,None]*z,np.sqrt(lam)*np.eye(5))),np.concatenate((np.sqrt(w)*(y-mu),np.zeros(5))),rcond=None)[0]
    np.testing.assert_allclose(fit_correction(x,y,mu,w,lam),expected,atol=1e-12)

def test_zero_baseline_keeps_negative_and_positive_returns_exactly():
    x=np.array([[1.,2.],[3.,4.]]);mu=np.array([-.03,.04])
    beta=fit_correction(x,[1.,-1.],mu,[1.,1.],None)
    np.testing.assert_array_equal(correction_predict(x,mu,beta),mu)

def test_intercept_also_shrinks_and_sample_weight_scale_is_irrelevant():
    x=np.zeros((4,2));mu=np.zeros(4);y=np.full(4,.02)
    b=fit_correction(x,y,mu,[1,1,1,1],1.)
    assert b[0]==pytest.approx(.01)
    np.testing.assert_allclose(b,fit_correction(x,y,mu,[10,10,10,10],1.))

@pytest.mark.parametrize('lam',[0.,-1.,float('nan')])
def test_invalid_penalty_rejected(lam):
    with pytest.raises(ValueError):fit_correction([[1.],[2.]],[0.,1.],[0.,0.],[1.,1.],lam)
