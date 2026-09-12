"""Unknown-LRV falsification of a plug-in lifecycle boundary, RESEARCH ONLY.

The half-normal boundary is evaluated with estimated long-run variance. Its
values are NOT an e-process: a fitted variance is not a predictable upper bound.
This probes whether replacing daily alpha splitting alone fixes calibration.
No service imports this script; no model, database, source evidence or pointer.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np

from scripts.audit_nav_alpha_budget import log_half_normal_mixture, summary
from services.paired_nav_sequential_state import POLICY, allocation_fraction


def variance_estimates(x):
    """Sample variance, Bartlett HAC, and nonoverlapping batch means.

    Tuning rules are declared research sensitivities, never selected using a
    candidate's sign/performance. Batch tail is retained in the endpoint mean;
    only the variance estimator uses its complete fixed-length batches.
    """
    trials, n = x.shape
    centered = x - x.mean(axis=1, keepdims=True)
    iid = np.sum(centered * centered, axis=1) / (n - 1)
    lag = min(n - 2, int(np.ceil(n ** (1 / 3))))
    hac = np.sum(centered * centered, axis=1) / n
    for k in range(1, lag + 1):
        hac += 2 * (1 - k / (lag + 1)) * np.sum(centered[:, k:] * centered[:, :-k], axis=1) / n
    hac *= n / (n - 1)
    length = max(2, int(np.floor(np.sqrt(n))))
    batches = n // length
    batch = length * np.var(x[:, :length*batches].reshape(trials, batches, length).mean(axis=2), axis=1, ddof=1)
    return {'sample_variance': iid, 'bartlett_hac': hac, 'batch_means': batch}


def paths(kind, trials, sessions, seed):
    rng = np.random.default_rng(seed)
    burn = 500
    if kind == 'rare_loss_null':
        # Exact zero unconditional mean, not a negative-mean straw man.
        p, loss = .005, -.2
        ordinary = -p * loss / (1-p)
        return np.where(rng.random((trials, sessions)) < p, loss, ordinary) + rng.normal(0, .0002, (trials, sessions))
    rho = {'iid_null': 0., 'ar03_null': .3, 'ar08_null': .8, 'ar095_null': .95,
           'student5_null': 0., 'iid_improvement': 0.}[kind]
    z = (rng.standard_t(5, (trials, sessions+burn)) / np.sqrt(5/3)
         if kind == 'student5_null' else rng.normal(size=(trials, sessions+burn)))
    x = z[:, 0].copy()
    output = np.empty((trials, sessions))
    for i in range(sessions + burn):
        x = rho * x + np.sqrt(1-rho*rho) * z[:, i]
        if i >= burn:
            output[:, i-burn] = x * .01 + (.003 if kind == 'iid_improvement' else 0.)
    return output


def probe(*, trials=5000, sessions=250, seed=20260911):
    if type(trials) is not int or trials < 1 or type(sessions) is not int or sessions < 10:
        raise ValueError('invalid_probe_size')
    alpha = POLICY['family_alpha'] * allocation_fraction(1)
    starts = [n for n in (10, 30, 60, 120) if n <= sessions]
    results = {}
    for kind in ('iid_null', 'ar03_null', 'ar08_null', 'ar095_null', 'student5_null', 'rare_loss_null', 'iid_improvement'):
        x = paths(kind, trials, sessions, seed)
        totals = np.cumsum(x, axis=1)
        crosses = {name: np.zeros((trials, sessions), dtype=bool)
                   for name in ('sample_variance', 'bartlett_hac', 'batch_means')}
        for n in range(10, sessions + 1):
            for method, variance in variance_estimates(x[:, :n]).items():
                valid = np.isfinite(variance) & (variance > 0)
                normalized = np.divide(totals[:, n-1], np.sqrt(np.maximum(variance, 0)),
                    out=np.zeros(trials), where=valid)
                crosses[method][:, n-1] = valid & (log_half_normal_mixture(normalized, n, 10.) >= np.log(1/alpha))
        case = {}
        for method, crossings in crosses.items():
            case[method] = {}
            for start in starts:
                scoped = crossings[:, start-1:]
                hits = scoped.any(axis=1)
                first = start + scoped.argmax(axis=1)
                case[method][str(start)] = summary(hits, first, alpha=alpha)
        results[kind] = case
        print(json.dumps({'case': kind, 'rates_from10': {m: r['10']['crossing_rate'] for m, r in case.items()}}), flush=True)
    return {'schema': 'nav-lifecycle-estimated-variance-falsification-v1',
        'synthetic_only': True, 'production_eligible': False, 'is_e_process': False,
        'method': 'half_normal_curve_with_estimated_long_run_variance',
        'rho': 10, 'hypothesis_alpha': alpha, 'seed': seed, 'trials': trials,
        'last_look': sessions, 'first_look_sensitivities': starts,
        'reuses_all_prior_observations_at_each_look': True, 'results': results,
        'warning': 'Finite-horizon calibration only, not infinite-lifetime validity or a deployment gate.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--trials', type=int, default=5000)
    parser.add_argument('--sessions', type=int, default=250)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = probe(trials=args.trials, sessions=args.sessions)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + '\n', encoding='utf-8')
