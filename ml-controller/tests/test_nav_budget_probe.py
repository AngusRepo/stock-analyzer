import pytest

from scripts.probe_nav_block_bootstrap import probe
from services.paired_nav_sequential_state import POLICY, allocation_fraction


def test_probe_default_uses_real_reservation_policy_and_keeps_scope_explicit(monkeypatch):
    calls = []
    def fake_infer(deltas, **kwargs):
        calls.append(kwargs['alpha'])
        return {'decision': 'HOLD'}
    monkeypatch.setattr('scripts.probe_nav_block_bootstrap.infer_paired_nav', fake_infer)
    expected = POLICY['family_alpha'] * allocation_fraction(1) * allocation_fraction(1)
    result = probe(trials=2, resamples=99, sessions=10)
    assert calls == [expected] * 14
    assert expected == .0125
    assert result['alpha'] == expected and not result['validates_daily_family_closure']
    assert not result['production_effect']


def test_comparison_changes_alpha_not_the_data_or_bootstrap_seeds(monkeypatch):
    calls = []
    def fake_infer(deltas, **kwargs):
        calls.append((deltas, kwargs['seed'], kwargs['alpha']))
        return {'decision': 'HOLD'}
    monkeypatch.setattr('scripts.probe_nav_block_bootstrap.infer_paired_nav', fake_infer)
    probe(trials=2, resamples=99, sessions=10, alpha=.0125)
    probe(trials=2, resamples=99, sessions=10, alpha=.05)
    assert [(x, seed) for x, seed, _ in calls[:14]] == [(x, seed) for x, seed, _ in calls[14:]]
    assert {level for _, _, level in calls[:14]} == {.0125}
    assert {level for _, _, level in calls[14:]} == {.05}


@pytest.mark.parametrize('alpha', [True, 0, -1, 1, float('nan'), float('inf')])
def test_bad_level_cannot_fall_back_to_a_more_lenient_default(alpha):
    with pytest.raises(ValueError, match='invalid_probe_alpha'):
        probe(trials=1, resamples=99, sessions=10, alpha=alpha)


@pytest.mark.parametrize('total,count,rho', [(-2., 10, 1.), (3., 10, 10.), (12., 60, 30.)])
def test_known_variance_oracle_mixture_matches_direct_integral(total, count, rho):
    import math
    from scipy.integrate import quad
    from scripts.audit_nav_alpha_budget import log_half_normal_mixture
    expected = quad(lambda lam: math.sqrt(2*rho/math.pi) *
        math.exp(lam*total - .5*(count+rho)*lam*lam), 0, math.inf)[0]
    assert math.exp(log_half_normal_mixture(total, count, rho)) == pytest.approx(expected, rel=1e-9)


def test_budget_audit_never_claims_a_fitted_market_variance_is_known():
    from scripts.audit_nav_alpha_budget import audit
    result = audit(trials=100, sessions=10)
    assert not result['production_eligible'] and not result['validates_real_nav_inference']
    assert result['hypothesis_alpha'] == .025
    assert result['assumptions'] == 'iid_gaussian_unit_variance_known_not_estimated'
