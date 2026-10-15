"""Independent exhaustive-support QP oracle for the certified allocator."""
import itertools
import numpy as np
import pytest
from scipy.optimize import minimize
from services.l4_portfolio import allocate


@pytest.mark.parametrize('seed',range(5))
def test_global_certificate_matches_exhaustive_supports(seed):
    rng=np.random.default_rng(seed);n=5
    root=rng.normal(size=(n,n));cov=root@root.T*.001+np.eye(n)*.002
    mu=rng.uniform(.002,.025,n);risk=2.;buy=.000399
    best=0.
    for size in (1,2):
        for support in itertools.combinations(range(n),size):
            ids=list(support);q=cov[np.ix_(ids,ids)]*risk;alpha=mu[ids]-buy
            result=minimize(lambda w:float(w@q@w-alpha@w),np.full(size,.1),
                jac=lambda w:2*q@w-alpha,method='SLSQP',bounds=[(.05,.4)]*size,
                constraints=[{'type':'ineq','fun':lambda w:.7-w.sum(),'jac':lambda w:-np.ones(size)}],
                options={'ftol':1e-13,'maxiter':1000})
            assert result.success
            best=max(best,-float(result.fun))
    result=allocate(symbols=[str(i) for i in range(n)],expected_gross=mu,covariance=cov,current_weights=np.zeros(n),
        exposure_cap=.7,name_cap=.4,min_weight=.05,max_positions=2,buy_cost=buy,sell_cost=.003399,risk_aversion=risk)
    assert abs(result['proof']['objective_utility']-best)<=2e-8
    assert result['proof']['global_utility_upper_bound']>=best-1e-8
    assert result['proof']['absolute_objective_gap']<=1e-8
    assert result['proof']['evaluated_candidate_count']==n and result['proof']['preselection'] is False


def test_locked_position_and_forbidden_buy_are_preserved():
    result=allocate(symbols=['A','B','C'],expected_gross=[-.1,.3,.02],covariance=np.eye(3)*.01,
        current_weights=[.2,0,0],exposure_cap=.5,name_cap=.3,min_weight=.05,max_positions=2,
        locked_symbols=['A'],forbidden_buys=['B'],buy_cost=.000399,sell_cost=.003399)
    assert result['weights']['A']==pytest.approx(.2,abs=1e-8)
    assert result['weights']['B']==pytest.approx(0.,abs=1e-8)
    assert sum(result['weights'].values())<=.5+1e-8


def test_refinement_does_not_authorize_an_uncertified_milp(monkeypatch):
    from types import SimpleNamespace
    from services import l4_portfolio as portfolio
    monkeypatch.setattr(portfolio,'milp',lambda *a,**k:SimpleNamespace(x=None,mip_dual_bound=None))
    with pytest.raises(ValueError,match='optimality_not_certified'):
        allocate(symbols=['A'],expected_gross=[.03],covariance=[[.01]],current_weights=[0.],
            exposure_cap=.5,name_cap=.3,min_weight=.05,max_positions=1,buy_cost=.001,sell_cost=.003)


def test_refinement_failure_returns_original_candidate(monkeypatch):
    from services import l4_quadratic_refinement as qp
    def timed_out(*a,**k):raise TimeoutError('refinement_budget')
    monkeypatch.setattr(qp,'minimize',timed_out)
    result=allocate(symbols=['A'],expected_gross=[.03],covariance=[[.01]],current_weights=[0.],
        exposure_cap=.5,name_cap=.3,min_weight=.05,max_positions=1,buy_cost=.001,sell_cost=.003)
    assert result['proof']['within_tolerance']
    assert result['weights']['A']==pytest.approx(.3,abs=1e-8)
