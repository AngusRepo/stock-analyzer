"""Bounded synthetic calibration probe; not investment performance or promotion.

Uses independent fixed RNG seeds for data and bootstrap. Output includes Monte
Carlo intervals for observed rejection frequency, never labels synthetic dates
as mature NAV. Run from ml-controller; no network/database/model training.
"""
import argparse
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from scipy.stats import beta
from scripts.nav_bootstrap_prototype import BootstrapPolicy, infer_paired_nav
from services.paired_nav_sequential_state import POLICY, allocation_fraction


def probe(*, trials, resamples, sessions, alpha=None):
    if alpha is None:
        alpha = POLICY['family_alpha'] * allocation_fraction(1) * allocation_fraction(1)
    if type(alpha) not in (int, float) or not math.isfinite(alpha) or not 0 < alpha < 1:
        raise ValueError('invalid_probe_alpha')
    rows = []
    for kind, rho, effect in [('iid_null', 0., 0.), ('ar03_null', .3, 0.), ('ar08_stress', .8, 0.),
                              ('ar095_stress', .95, 0.), ('student5_null', 0., 0.),
                              ('iid_improvement', 0., .5), ('ar03_improvement', .3, .5)]:
        rng = np.random.default_rng(20260908)
        rejected = 0
        for trial in range(trials):
            z = (rng.standard_t(5, sessions + 500) / np.sqrt(5/3) if kind == 'student5_null'
                 else rng.normal(size=sessions + 500))
            x = np.empty_like(z); x[0] = z[0]
            for i in range(1, len(z)):
                x[i] = rho * x[i-1] + np.sqrt(1-rho*rho) * z[i]
            result = infer_paired_nav(((x[-sessions:] + effect) * .01).tolist(), alpha=alpha,
                seed=700000 + trial, policy=BootstrapPolicy(resamples=resamples))
            rejected += result['decision'] == 'PASS'
        interval = [float(beta.ppf(.025, rejected, trials-rejected+1)) if rejected else 0.,
                    float(beta.ppf(.975, rejected+1, trials-rejected)) if rejected < trials else 1.]
        row = {'case':kind, 'sessions':sessions, 'trials':trials, 'passes':rejected,
               'pass_rate':rejected/trials, 'binomial_95_interval':interval, 'reserved_alpha':alpha}
        rows.append(row)
        print(json.dumps(row), flush=True)
    return {'schema':'nav-block-bootstrap-probe-v1', 'synthetic_only':True,
            'validates_daily_family_closure':False, 'resamples':resamples,
            'alpha': alpha, 'data_seed': 20260908, 'bootstrap_seed_start': 700000,
            'production_effect': False, 'rows':rows}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--trials', type=int, default=500)
    parser.add_argument('--resamples', type=int, default=1999)
    parser.add_argument('--sessions', type=int, default=10)
    parser.add_argument('--alpha', type=float,
                        help='Research-only per-look level; default reads the actual first reservation formula.')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.trials < 1 or args.sessions < 10:
        parser.error('invalid simulation size')
    result = probe(trials=args.trials, resamples=args.resamples, sessions=args.sessions, alpha=args.alpha)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
