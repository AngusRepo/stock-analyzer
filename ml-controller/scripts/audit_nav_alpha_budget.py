"""Isolate alpha-allocation power costs using *known-variance Gaussian* data.

The Gaussian/sub-Gaussian assumption is deliberately granted in this benchmark
to separate spending from invalid p-values. This is NOT a NAV inference owner:
no historical variance estimate becomes a predictable bound, and no production
data, pointer, database, model or policy is read/written by the experiment.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from scipy.special import log_ndtr
from scipy.stats import beta, norm

from services.paired_nav_sequential_state import POLICY, allocation_fraction


def log_half_normal_mixture(total, count, rho):
    """Integral over lambda>=0 of exp(lambda*S-lambda^2*n/2).

    lambda has the fixed half-normal density with precision rho. Under a unit
    conditional sub-Gaussian proxy, Ville controls crossing over ALL dates;
    there is no additional per-date alpha split. No such proxy is asserted for
    the application's raw paired NAV or for autocorrelated financial returns.
    """
    return (np.log(2.) + .5 * np.log(rho / (count + rho))
            + total * total / (2 * (count + rho))
            + log_ndtr(total / np.sqrt(count + rho)))


def summary(hits, first, *, alpha):
    count, trials = int(hits.sum()), len(hits)
    return {'crossings': count, 'trials': trials, 'crossing_rate': count / trials,
            'binomial_95_interval': [float(beta.ppf(.025, count, trials-count+1)) if count else 0.,
                float(beta.ppf(.975, count+1, trials-count)) if count < trials else 1.],
            'hypothesis_alpha': alpha,
            'median_detection_session_if_detected': float(np.median(first[hits])) if count else None}


def audit(*, trials=20000, sessions=120, seed=20260910):
    if type(trials) is not int or trials < 1 or type(sessions) is not int or sessions < 10:
        raise ValueError('invalid_audit_size')
    alpha = POLICY['family_alpha'] * allocation_fraction(1)
    rng = np.random.default_rng(seed)
    null_sums = np.cumsum(rng.normal(size=(trials, sessions)), axis=1)
    days = np.arange(1, sessions + 1)
    out = {}
    # Sensitivities declared before any outcomes. Do not pick the best rho after
    # seeing this table or combine their PASS events without multiplicity control.
    for effect in (0., .3, .5):
        totals = null_sums + effect * days
        result = {}
        for method in ('existing_daily_spending', 'one_lifecycle_mixture_rho1',
                       'one_lifecycle_mixture_rho10', 'one_lifecycle_mixture_rho30'):
            hits = np.zeros(trials, dtype=bool)
            first = np.zeros(trials, dtype=int)
            for n in range(10, sessions + 1):
                total = totals[:, n - 1]
                if method == 'existing_daily_spending':
                    level = alpha * allocation_fraction(n - 9)
                    now = total / np.sqrt(n) > norm.isf(level)
                else:
                    rho = float(method.rsplit('rho', 1)[1])
                    now = log_half_normal_mixture(total, n, rho) >= np.log(1 / alpha)
                first[now & ~hits] = n
                hits |= now
            result[method] = summary(hits, first, alpha=alpha)
        out[str(effect)] = result
    return {'schema': 'nav-alpha-allocation-oracle-audit-v1', 'synthetic_only': True,
            'assumptions': 'iid_gaussian_unit_variance_known_not_estimated',
            'production_eligible': False, 'validates_real_nav_inference': False,
            'seed': seed, 'first_look': 10, 'last_look': sessions,
            'family_alpha': POLICY['family_alpha'], 'nomination_fraction': allocation_fraction(1),
            'hypothesis_alpha': alpha, 'effects_in_standard_deviations': out,
            'warning': 'Do not select a rho from observed performance or plug estimated NAV variance into this test.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--trials', type=int, default=20000)
    parser.add_argument('--sessions', type=int, default=120)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = audit(trials=args.trials, sessions=args.sessions)
    print(json.dumps(result, indent=2, allow_nan=False))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')
