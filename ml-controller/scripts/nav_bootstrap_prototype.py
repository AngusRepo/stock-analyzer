"""REJECTED promotion prototype: studentized circular-block NAV inference.

This module has no database/registry access and grants no serving authority.
Its coverage is approximate under stationary, short-range dependent returns
with adequate moments; it is not an arbitrary-market finite-sample guarantee.
The endpoint is the original costed NAV return difference, never clipped utility.
Independent n10/n60 calibration failed. Numerical PASS is a simulation outcome,
not a usable promotion verdict. No runtime service imports this research script.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import math
from typing import Any, Sequence

import numpy as np
from scipy.stats import beta


@dataclass(frozen=True)
class BootstrapPolicy:
    min_sessions: int = 10
    resamples: int = 9999
    max_resamples: int = 1000000
    batch_size: int = 512
    monte_carlo_budget_fraction: float = .1

    def __post_init__(self):
        for name in ('min_sessions', 'resamples', 'max_resamples', 'batch_size'):
            if type(getattr(self, name)) is not int or getattr(self, name) < 1:
                raise ValueError('nav_bootstrap_invalid_policy:' + name)
        if self.min_sessions < 10 or self.resamples < 99:
            raise ValueError('nav_bootstrap_inadequate_policy')
        if self.max_resamples < self.resamples:
            raise ValueError('nav_bootstrap_max_below_minimum')
        if (type(self.monte_carlo_budget_fraction) not in (int, float)
                or not 0 < self.monte_carlo_budget_fraction < 1):
            raise ValueError('nav_bootstrap_invalid_monte_carlo_budget')


def required_tail_resamples(alpha: float, mc_fraction: float) -> int:
    """Minimum fixed B at which even zero exceedances can certify the tail.

    For zero events the one-sided exact binomial upper limit is
    1 - mc_alpha**(1/B). Solving this avoids a hidden permanent HOLD as the
    lifetime look budget shrinks. The budget depends on no observed outcome.
    """
    test_alpha = alpha * (1 - mc_fraction)
    return math.ceil(math.log(alpha * mc_fraction) / math.log1p(-test_alpha))


def hac_mean_se(values: np.ndarray, lag: int) -> np.ndarray:
    """Bartlett/Newey-West standard error; last dimension is calendar time.

    No variance floor can turn a degenerate series into significant evidence.
    Centering is repeated per resample (not reused from the original sample).
    """
    n = values.shape[-1]
    if not 0 <= lag < n or n < 2:
        raise ValueError('nav_bootstrap_invalid_hac_lag')
    centered = values - values.mean(axis=-1, keepdims=True)
    long_run = np.mean(centered * centered, axis=-1)
    for k in range(1, lag + 1):
        covariance = np.sum(centered[..., k:] * centered[..., :-k], axis=-1) / n
        long_run = long_run + 2 * (1 - k / (lag + 1)) * covariance
    # Degrees-of-freedom correction applies equally to original and bootstrap.
    variance = long_run / (n - 1)
    return np.sqrt(np.maximum(variance, 0))


def circular_block_indices(rng: np.random.Generator, n: int, block: int, count: int) -> np.ndarray:
    if not 1 <= block < n or count < 1:
        raise ValueError('nav_bootstrap_invalid_blocks')
    starts = rng.integers(n, size=(count, math.ceil(n / block)))
    return ((starts[..., None] + np.arange(block)) % n).reshape(count, -1)[:, :n]


def infer_paired_nav(deltas: Sequence[float | None], *, alpha: float, seed: int,
                     policy: BootstrapPolicy | None = None,
                     block_length: int | None = None) -> dict[str, Any]:
    """One reserved look. Caller binds seed/alpha to pre-outcome nomination.

    A Monte Carlo upper bound, not an observed zero tail count, decides PASS.
    Part of the look's budget pays for Monte Carlo error. Missing observations
    remain calendar sessions; they are never dropped or filled with zero.
    ``block_length`` is for predeclared calibration/sensitivity, not selecting
    whichever observed result passes. Default depends on sample size only.
    """
    policy = policy or BootstrapPolicy()
    if type(alpha) not in (int, float) or not math.isfinite(alpha) or not 0 < alpha < 1:
        raise ValueError('nav_bootstrap_invalid_alpha')
    if type(seed) is not int or seed < 0:
        raise ValueError('nav_bootstrap_invalid_seed')
    raw = list(deltas)
    if any(value is not None and (type(value) not in (float, int) or not math.isfinite(value)) for value in raw):
        raise ValueError('nav_bootstrap_invalid_return')
    n = len(raw)
    exact = sum(value is not None for value in raw)
    base: dict[str, Any] = {
        'schema': 'paired-nav-studentized-circular-bootstrap-v1',
        'endpoint': 'candidate_minus_incumbent_costed_daily_nav_return',
        'decision': 'HOLD', 'reason': None, 'sessions': n, 'exact_nav_sessions': exact,
        'reserved_alpha': alpha, 'seed': seed, 'policy': asdict(policy),
        'validity': 'approximate_stationary_short_range_dependence_finite_moments',
        'universal_finite_sample_guarantee': False,
        'calibration_status': 'rejected_for_automatic_promotion',
        'promotion_allowed': False,
        'mean_delta': None, 'mean_delta_lcb': None, 'standard_error': None,
        'bootstrap_p_plus_one': None, 'bootstrap_p_mc_upper': None,
        'resamples_completed': 0, 'degenerate_resamples': 0,
    }
    if exact != n:
        return {**base, 'reason': 'nav_valuation_incomplete'}
    if n < policy.min_sessions:
        return {**base, 'reason': 'nav_sessions_incomplete'}
    mc_alpha = alpha * policy.monte_carlo_budget_fraction
    test_alpha = alpha - mc_alpha
    minimum = required_tail_resamples(alpha, policy.monte_carlo_budget_fraction)
    planned = min(policy.max_resamples, max(policy.resamples, math.ceil(minimum * 1.1)))
    base.update(minimum_tail_resamples=minimum, resamples_planned=planned,
                monte_carlo_error_alpha=mc_alpha, bootstrap_test_alpha=test_alpha)
    if minimum > policy.max_resamples:
        # This is a numerical resource limit, not failed performance or missing
        # mature dates. Never spend CPU on a run that cannot possibly certify.
        return {**base, 'reason': 'bootstrap_tail_resolution_insufficient',
                'mean_delta': sum(raw) / n}
    block = block_length if block_length is not None else max(2, math.ceil(n ** (1 / 3)))
    if type(block) is not int or not 1 <= block < n:
        raise ValueError('nav_bootstrap_invalid_block_length')
    x = np.array(raw, dtype=np.float64)
    scale = float(np.max(np.abs(x)))
    base.update(mean_delta=float(x.mean()), block_length=block, hac_lag=block - 1,
                nominal_blocks=n / block)
    if scale == 0:
        return {**base, 'reason': 'nav_variance_unidentified'}
    # Normalizing units is lossless for the t statistic; no return is clipped.
    x /= scale
    mean = float(x.mean())
    se = float(hac_mean_se(x, block - 1))
    base['standard_error'] = se * scale
    if not math.isfinite(se) or se <= np.finfo(float).eps:
        return {**base, 'reason': 'nav_variance_unidentified'}
    observed = mean / se
    centered = x - mean
    rng = np.random.default_rng(seed)
    statistics = np.empty(planned)
    degenerates = 0
    for start in range(0, planned, policy.batch_size):
        size = min(policy.batch_size, planned - start)
        draws = centered[circular_block_indices(rng, n, block, size)]
        errors = hac_mean_se(draws, block - 1)
        valid = np.isfinite(errors) & (errors > np.finfo(float).eps)
        t = np.full(size, np.inf)
        np.divide(draws.mean(axis=1), errors, out=t, where=valid)
        statistics[start:start + size] = t
        degenerates += int(np.sum(~valid))
    exceed = int(np.sum(statistics >= observed))
    p_upper = 1.0 if exceed == planned else float(beta.ppf(
        1 - mc_alpha, exceed + 1, planned - exceed))
    critical = float(np.quantile(statistics, 1 - test_alpha, method='higher'))
    lcb = (mean - critical * se) * scale if math.isfinite(critical) else None
    base.update(mean_delta_lcb=lcb, bootstrap_p_plus_one=(exceed + 1) / (planned + 1),
                bootstrap_p_mc_upper=p_upper, monte_carlo_error_alpha=mc_alpha,
                bootstrap_test_alpha=test_alpha, resamples_completed=planned,
                degenerate_resamples=degenerates, tail_exceedances=exceed,
                observed_t=observed)
    if lcb is not None and lcb > 0 and p_upper <= test_alpha:
        return {**base, 'decision': 'PASS', 'reason': 'positive_paired_nav_evidence'}
    reason = ('bootstrap_tail_resolution_insufficient' if exceed == 0 and p_upper > test_alpha
              else 'positive_paired_nav_not_established')
    return {**base, 'reason': reason}
