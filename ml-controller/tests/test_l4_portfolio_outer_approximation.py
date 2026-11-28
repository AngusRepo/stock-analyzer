"""l4_portfolio.allocate: the decomposed outer approximation (per-name perspective cuts,
lifted leading eigen-directions, Kelley remainder) certifies cases the single-epigraph
form could not, matches an exhaustive support search, and certifies only on bounds
re-derived without HiGHS presolve. Synthetic instances only (no production data)."""
from itertools import combinations
import math

import numpy as np
import pytest
from scipy.optimize import Bounds, LinearConstraint, minimize

from services import l4_portfolio


def case(seed, n=60, rank=6, risk_aversion=8., l2_penalty=.02):
    """A rank-deficient factor covariance with a small floor, like a dated risk packet."""
    rng = np.random.default_rng(seed)
    loadings = rng.standard_normal((rank, n)) * .03
    return dict(symbols=[f'S{i}' for i in range(n)], expected_gross=rng.normal(.002, .004, n).tolist(),
                covariance=loadings.T @ loadings + 1e-6 * np.eye(n), current_weights=[0.] * n,
                exposure_cap=.3, name_cap=.1, min_weight=.02, max_positions=5, buy_cost=.001425,
                sell_cost=.004425, risk_aversion=risk_aversion, l2_penalty=l2_penalty)


# Each one ran out of the 30s budget under the single-epigraph form (2026-11-28, scipy 1.17.1).
@pytest.mark.parametrize('seed,risk_aversion,l2_penalty', [(3, 8., .02), (5, 8., .02), (6, 2., .2)])
def test_cases_the_single_epigraph_form_left_uncertified_now_certify(seed, risk_aversion, l2_penalty):
    plan = l4_portfolio.allocate(**case(seed, risk_aversion=risk_aversion, l2_penalty=l2_penalty))
    proof = plan['proof']
    assert proof['within_tolerance'] and proof['absolute_objective_gap'] <= proof['tolerance']
    # Round counts, not seconds: 11, 10 and 3 rounds on 2026-11-28 (scipy 1.17.1).
    assert proof['rounds'] <= l4_portfolio.LIFT_AFTER_ROUNDS + 3 and proof['presolve_free_verifications'] >= 1


def test_the_lift_is_added_only_after_rounds_without_a_certificate(monkeypatch):
    easy = l4_portfolio.allocate(**case(4, l2_penalty=.2, risk_aversion=2.))['proof']
    assert easy['rounds'] < l4_portfolio.LIFT_AFTER_ROUNDS and easy['lifted_directions'] == 0
    slow = {**case(1, n=200, rank=10, l2_penalty=0.), 'max_positions': 10}
    lifted = l4_portfolio.allocate(**slow)['proof']
    assert lifted['rounds'] > l4_portfolio.LIFT_AFTER_ROUNDS and lifted['lifted_directions'] == l4_portfolio.FACTOR_RANK
    # The rebuilt model keeps a cut at every earlier point: 13 rounds, 17 if it starts empty.
    assert lifted['rounds'] <= l4_portfolio.LIFT_AFTER_ROUNDS + 4
    # Without the lift the same case needs far more rounds (30 against 13 on 2026-11-28).
    monkeypatch.setattr(l4_portfolio, 'FACTOR_RANK', 0)
    unlifted = l4_portfolio.allocate(**slow)['proof']
    assert unlifted['lifted_directions'] == 0 and unlifted['rounds'] > lifted['rounds'] + 5


def exhaustive(kw):
    """Best utility over every support of at most max_positions names (fresh cash account)."""
    n = len(kw['symbols'])
    q = np.asarray(kw['covariance']) * kw['risk_aversion'] + kw['l2_penalty'] * np.eye(n)
    linear = np.asarray(kw['expected_gross']) - kw['buy_cost']
    best = 0.                                   # all cash
    for size in range(1, kw['max_positions'] + 1):
        for support in combinations(range(n), size):
            s = list(support)
            sub, lin = q[np.ix_(s, s)], linear[s]
            solved = minimize(lambda w: w @ sub @ w - lin @ w, np.full(size, kw['min_weight']),
                              jac=lambda w: 2 * sub @ w - lin, method='SLSQP',
                              bounds=Bounds(np.full(size, kw['min_weight']), np.full(size, kw['name_cap'])),
                              constraints=[LinearConstraint(np.ones((1, size)), -np.inf, kw['exposure_cap'])],
                              options={'ftol': 1e-15, 'maxiter': 500})
            best = max(best, -float(solved.fun))
    return best


@pytest.mark.parametrize('seed,risk_aversion,l2_penalty', [(0, 8., .02), (1, 64., 0.), (2, 2., .2), (3, 0., .02)])
def test_certified_utility_is_the_exhaustive_optimum(seed, risk_aversion, l2_penalty):
    kw = case(seed, n=10, rank=3, risk_aversion=risk_aversion, l2_penalty=l2_penalty)
    kw['expected_gross'] = (np.asarray(kw['expected_gross']) + .004).tolist()   # several names worth holding
    utility = l4_portfolio.allocate(**kw)['proof']['objective_utility']
    reference = exhaustive(kw)
    assert reference > 0
    # The certificate is a global bound: never beaten by any support, and attained.
    assert utility == pytest.approx(reference, abs=1e-8)


def lying_presolve(monkeypatch, kw, calls, mode, liar=True):
    """The solve with presolve=`liar` reports a wrong dual bound (presolve on: the r25 11/18
    failure); the other one tells the truth."""
    real = l4_portfolio.milp
    n = len(kw['symbols'])
    q = np.asarray(kw['covariance']) * kw['risk_aversion'] + kw['l2_penalty'] * np.eye(n)

    def milp(c, **options):
        result = real(c, **options)
        calls.append(options['options']['presolve'])
        if options['options']['presolve'] is liar and result.x is not None:
            w = result.x[:n]
            claimed = float(c[:4 * n] @ result.x[:4 * n]) / 1e4 + float(w @ q @ w)
            # 'silent': claims its own (possibly suboptimal) point optimal; 'high': far above it.
            result.mip_dual_bound = 1e4 * (claimed if mode == 'silent' else claimed + 1e-3)
        return result
    monkeypatch.setattr(l4_portfolio, 'milp', milp)


@pytest.mark.parametrize('liar', [True, False])
@pytest.mark.parametrize('mode', ['silent', 'high'])
def test_one_wrong_bound_never_certifies_or_condemns(monkeypatch, mode, liar):
    """Either solve may be the wrong one: the certificate keeps the smaller bound."""
    kw = case(3)
    truth = l4_portfolio.allocate(**kw)
    assert truth['proof']['rounds'] >= 2, 'round 1 must be suboptimal for the silent case to bite'
    calls = []
    lying_presolve(monkeypatch, kw, calls, mode, liar)
    plan = l4_portfolio.allocate(**kw)
    assert plan['proof']['objective_utility'] == pytest.approx(truth['proof']['objective_utility'], abs=1e-8)
    assert plan['weights'] == pytest.approx(truth['weights'], abs=1e-6)
    assert calls[-1] is False, 'the certifying bound comes from a solve without presolve'


def reported_bounds(monkeypatch, kw, report):
    """Every solve reports report(presolve, claimed) as its dual bound, where claimed is the
    exact objective at the solve's own point."""
    real = l4_portfolio.milp
    n = len(kw['symbols'])
    q = np.asarray(kw['covariance']) * kw['risk_aversion'] + kw['l2_penalty'] * np.eye(n)

    def milp(c, **options):
        result = real(c, **options)
        if result.x is not None:
            w = result.x[:n]
            claimed = float(c[:4 * n] @ result.x[:4 * n]) / 1e4 + float(w @ q @ w)
            bound = report(options['options']['presolve'], claimed)
            result.mip_dual_bound = None if bound is None else 1e4 * bound
        return result
    monkeypatch.setattr(l4_portfolio, 'milp', milp)


@pytest.mark.parametrize('missing', [None, math.nan])
def test_a_verification_solve_without_a_bound_never_certifies(monkeypatch, missing):
    """The presolve solve claims its point optimal; the presolve-free re-solve returns no bound."""
    kw = case(1)
    reported_bounds(monkeypatch, kw, lambda presolve, claimed: claimed if presolve else missing)
    with pytest.raises(ValueError, match='l4_portfolio_optimality_not_certified'):
        l4_portfolio.allocate(**kw, time_limit=2.)


def test_a_bound_above_the_incumbent_from_both_solves_is_an_invalid_bound(monkeypatch):
    kw = case(1)
    reported_bounds(monkeypatch, kw, lambda presolve, claimed: claimed + 1e-3)
    with pytest.raises(ValueError, match='l4_portfolio_invalid_bound'):
        l4_portfolio.allocate(**kw)


def test_every_certificate_is_rederived_without_presolve(monkeypatch):
    calls, real = [], l4_portfolio.milp

    def milp(c, **options):
        calls.append(options['options']['presolve'])
        return real(c, **options)
    monkeypatch.setattr(l4_portfolio, 'milp', milp)
    plan = l4_portfolio.allocate(**case(1))
    assert calls[-1] is False and calls.count(False) == plan['proof']['presolve_free_verifications'] >= 1
    assert calls.count(True) == plan['proof']['rounds']
