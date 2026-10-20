import numpy as np
import pytest
from services import active8_oof_stacker as stack

ORDER=('LightGBM','XGBoost','ExtraTrees','TabM','GNN','TimeXer','PatchTST','iTransformer')

def fixture():
    rng=np.random.default_rng(42)
    x=np.column_stack((rng.uniform(size=(256,8)),rng.integers(0,2,(256,8)))).astype(float)
    y=.01*x[:,0]-.02*x[:,1]+rng.normal(0,.01,len(x))
    prior=np.array([1/6]*5+[0.,0.,1/6])
    return x,y,prior


@pytest.mark.parametrize('penalty',stack.RIDGE_CANDIDATES)
def test_mean_loss_is_replication_invariant_and_same_as_n_scaled_sum(penalty):
    x,y,prior=fixture()
    w,b=stack._fit_ridge(x,y,penalty,rank_prior=prior,model_order=ORDER,loss_units='mean')
    ww,bb=stack._fit_ridge(np.tile(x,(3,1)),np.tile(y,3),penalty,rank_prior=prior,model_order=ORDER,loss_units='mean')
    np.testing.assert_allclose(w,ww,rtol=1e-7,atol=1e-9);np.testing.assert_allclose(b,bb,rtol=1e-7,atol=1e-9)
    sw,sb=stack._fit_ridge(x,y,penalty*len(x),rank_prior=prior,model_order=ORDER)
    np.testing.assert_array_equal(w,sw);assert b==sb and np.min(w[:8])>=0


def test_zero_prior_does_not_exclude_model_but_explicit_ablation_does():
    x,_,prior=fixture();y=10*x[:,5]
    w,_=stack._fit_ridge(x,y,.01,rank_prior=prior,model_order=ORDER,loss_units='mean')
    assert prior[5]==0 and w[5]>0
    dropped,_=stack._fit_ridge(x,y,.01,rank_prior=prior,model_order=ORDER,loss_units='mean',active_models=tuple(m for m in ORDER if m!='TimeXer'))
    assert dropped[5]==dropped[13]==0


def test_inner_selection_uses_each_inner_fit_row_count_and_own_prior(monkeypatch):
    x,y,prior=fixture();x=np.tile(x,(4,1));y=np.tile(y,4)
    dates=np.array([f'2026-08-{i//64+1:02d}' for i in range(len(x))])
    known=np.array([f'2026-08-{i//64+2:02d}' for i in range(len(x))]);markets=np.array(['TWSE']*len(x))
    original=stack._fit_ridge;calls=[]
    def observe(x,y,penalty,**kw):
        calls.append((len(x),penalty,kw));return original(x,y,penalty,**kw)
    monkeypatch.setattr(stack,'_fit_ridge',observe)
    stack.fit_qualified_prior_ridge(x,y,dates,markets,label_known_dates=known,model_order=ORDER,rank_prior=prior,inner_rank_prior=np.zeros(8))
    assert len(calls)==5 and all(c[0]<len(x) and c[2]['loss_units']=='mean' for c in calls[:-1])
    assert all(np.array_equal(c[2]['rank_prior'],np.zeros(8)) for c in calls[:-1])
    assert calls[-1][0]==len(x) and np.array_equal(calls[-1][2]['rank_prior'],prior)
