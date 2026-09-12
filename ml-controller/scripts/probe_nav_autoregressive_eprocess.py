"""Research-only universal likelihood probe. NEVER a promotion consumer.

Q is a proper mixture of two causal Bayesian regression marginal likelihoods.
The denominator is a constrained Gaussian AR(p) maximum likelihood. Under that
stated null family, Q / sup(P_null) is dominated by the true likelihood-ratio
martingale. This does NOT give distribution-free validity for market returns.

Sources: Wasserman et al., Universal Inference, arXiv:1912.11436;
Wang/Ramdas, arXiv:2310.03722, Lemma 2.5 and Section 3.
"""
from __future__ import annotations

import json
import argparse
import numpy as np
from scipy.special import gammaln, logsumexp
from scipy.stats import beta


def likelihood_path(raw: np.ndarray, order: int = 4) -> np.ndarray:
    count, days = raw.shape
    if type(order) is not int or order < 1 or days <= order:
        raise ValueError('invalid_autoregressive_order')
    # Initial lags are conditioned on, not scored or recounted as new evidence.
    # A one-point standard deviation is always zero; it used to scale AR(1)
    # by 1e10 and trip the numerical guard on every path. RMS conditions only
    # on the same initial lags and the fixed one-basis-point floor is not fit
    # to subsequent outcomes. Flat initial cash days must remain computable.
    scale = np.maximum(np.sqrt(np.mean(raw[:, :order] ** 2, axis=1)), 1e-4)
    values = raw / scale[:, None]
    dimension = order + 1
    gram = np.zeros((count, dimension, dimension))
    cross = np.zeros((count, dimension))
    squares = np.zeros(count)
    path = np.full((count, days), -np.inf)
    eye = np.eye(dimension)
    for index in range(order, days):
        x = np.column_stack([np.ones(count)] + [values[:, index - lag] for lag in range(1, order + 1)])
        y = values[:, index]
        gram += x[:, :, None] * x[:, None, :]
        cross += x * y[:, None]
        squares += y ** 2
        n = index - order + 1
        if n <= dimension:
            continue
        inverse = np.linalg.pinv(gram, rcond=1e-12)
        coefficients = np.einsum('bij,bj->bi', inverse, cross)
        unconstrained = squares - np.sum(coefficients * cross, axis=1)
        restricted_coef = np.einsum('bij,bj->bi', np.linalg.pinv(gram[:, 1:, 1:], rcond=1e-12), cross[:, 1:])
        boundary = squares - np.sum(restricted_coef * cross[:, 1:], axis=1)
        residual = np.where(coefficients[:, 0] <= 0, unconstrained, boundary)
        # Do not turn cancellation/interpolation into an infinite e-value.
        residual -= 1e-10 * np.maximum(1, squares)
        good = (residual > 0) & (np.linalg.cond(gram) < 1e10)
        mle = np.full(count, np.inf)
        mle[good] = -.5 * n * (np.log(2 * np.pi * residual[good] / n) + 1)
        posterior = gram + eye
        q = np.linalg.solve(posterior, cross[..., None])[..., 0]
        post_b = 1 + .5 * (squares - np.sum(q * cross, axis=1))
        common = gammaln(1 + n / 2) - n / 2 * np.log(2 * np.pi)
        log_ar = common - .5 * np.linalg.slogdet(posterior)[1] - (1 + n / 2) * np.log(post_b)
        iid_b = 1 + .5 * (squares - cross[:, 0] ** 2 / (1 + n))
        log_iid = common - .5 * np.log(1 + n) - (1 + n / 2) * np.log(iid_b)
        numerator = logsumexp(np.stack((log_ar, log_iid)), axis=0) - np.log(2)
        path[:, index] = numerator - mle
    return path


def summarize(x: np.ndarray, order: int = 4) -> dict:
    path = likelihood_path(x, order)
    hits = np.any(path[:, 9:] >= np.log(20), axis=1)
    k, n = int(hits.sum()), len(hits)
    maximum = np.max(path[:, 9:], axis=1)
    finite = np.isfinite(maximum)
    return {'ever_crossed_five_percent': k / n, 'crossings': k,
            'binomial_upper_95': 1. if k == n else float(beta.ppf(.95, k + 1, n - k)),
            'numerically_evaluable_fraction': float(np.mean(finite)),
            'max_log_e_median': float(np.median(maximum[finite])) if np.any(finite) else None}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--order', type=int, default=4)
    args = parser.parse_args()
    rng = np.random.default_rng(20260909)
    count, days = 5000, 120
    streams = {'iid_normal_null': rng.normal(size=(count, days)),
               'student_t3_null': rng.standard_t(3, size=(count, days)) / np.sqrt(3)}
    shocks = rng.normal(size=(count, days + 4))
    streams['MA4_null'] = sum(shocks[:, lag:lag + days] for lag in range(5)) / np.sqrt(5)
    for rho in (.5, .8, .95):
        x = np.empty((count, days))
        x[:, 0] = rng.normal(size=count)
        for day in range(1, days):
            x[:, day] = rho * x[:, day - 1] + np.sqrt(1 - rho ** 2) * rng.normal(size=count)
        streams[f'AR1_{rho}_null'] = x
    x, variance = np.empty((count, days)), np.ones(count)
    for day in range(days):
        x[:, day] = np.sqrt(variance) * rng.normal(size=count)
        variance = .05 + .1 * x[:, day] ** 2 + .85 * variance
    streams['GARCH_null'] = x
    for effect in (.1, .3, .5, 1.):
        streams[f'iid_positive_mean_{effect}_sd'] = rng.normal(size=(count, days)) + effect
    # A realistic failure mode for a Gaussian-model-only claim: frequent small
    # gains and rare losses, exactly zero expected mean. Keep this seed separate
    # so the original null/power draws remain reproducible across additions.
    tail_rng = np.random.default_rng(20260911)
    tail = tail_rng.normal(0, .0002, (count, days)) + .001
    tail -= tail_rng.binomial(1, .005, (count, days)) * .2
    streams['zero_mean_rare_loss'] = tail
    streams['zero_mean_rare_gain'] = -tail
    results = {name: summarize(x, args.order) for name, x in streams.items()}
    print(json.dumps({'research_only': True, 'production_effect': False,
        'seed': 20260909, 'repetitions': count, 'dates': days, 'order': args.order,
        'assumption': f'conditional Gaussian AR({args.order}), constant innovation variance; other generators are misspecification stress only',
        'tail_stress_seed': 20260911,
        'tail_stress': {'ordinary_shift': .001, 'noise_sd': .0002, 'shock_probability': .005,
                        'shock_magnitude': .2, 'true_expected_delta': 0},
        'stress_screen_passed': all(row['binomial_upper_95'] <= .05 for name, row in results.items()
                                   if not name.startswith('iid_positive')),
        'results': results}, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
