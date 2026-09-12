"""Local null stress tests. No market data, model training or promotion.

Compare proposed daily-look repairs before selecting an inference policy.
These rejection rates do not prove validity outside the stated generators.
"""
from __future__ import annotations

import json
import numpy as np
from scipy.stats import t


def rejection_rates(values: np.ndarray) -> dict:
    hits = {key: np.zeros(len(values), dtype=bool) for key in (
        'legacy_fixed_window_t', 'lifetime_hac_t', 'lifetime_hac_effective_df',
        'lifetime_hac_block_df')}
    for n in range(10, values.shape[1] + 1):
        x = values[:, :n]
        average = x.mean(axis=1)
        centered = x - average[:, None]
        gamma0 = np.mean(centered ** 2, axis=1)
        lrv = gamma0.copy()
        for lag in range(1, min(5, n)):
            lrv += 2 * (1 - lag / 5) * np.sum(centered[:, lag:] * centered[:, :-lag], axis=1) / n
        lrv = np.maximum(gamma0, lrv)
        se = np.sqrt(lrv / (n - 1))
        look = n - 9
        alpha = .05 / (look * (look + 1))
        effective_df = np.maximum(1, n * gamma0 / np.maximum(lrv, 1e-30) - 1)
        block_df = max(1, n // 5 - 1)
        hits['legacy_fixed_window_t'] |= average > t.ppf(.95, n - 1) * np.sqrt(gamma0 / (n - 1))
        hits['lifetime_hac_t'] |= average > t.ppf(1 - alpha, n - 1) * se
        hits['lifetime_hac_effective_df'] |= average > t.ppf(1 - alpha, effective_df) * se
        hits['lifetime_hac_block_df'] |= average > t.ppf(1 - alpha, block_df) * se
    return {key: {'ever_rejected_null': float(hit.mean()),
                  'mc_se': float(np.sqrt(hit.mean() * (1 - hit.mean()) / len(hit)))}
            for key, hit in hits.items()}


def main() -> None:
    rng = np.random.default_rng(20260908)
    count, days = 20000, 60
    streams = {'iid_normal': rng.normal(size=(count, days)),
               'iid_student_t3': rng.standard_t(3, size=(count, days)) / np.sqrt(3)}
    shocks = rng.normal(size=(count, days + 4))
    streams['overlapping_T5_MA4'] = sum(shocks[:, lag:lag + days] for lag in range(5)) / np.sqrt(5)
    for rho in (.5, .8, .95):
        x = np.empty((count, days))
        x[:, 0] = rng.normal(size=count)
        for day in range(1, days):
            x[:, day] = rho * x[:, day - 1] + np.sqrt(1 - rho ** 2) * rng.normal(size=count)
        streams[f'stationary_AR1_{rho}'] = x
    x = np.zeros((count, days))
    variance = np.ones(count)
    for day in range(days):
        x[:, day] = np.sqrt(variance) * rng.normal(size=count)
        variance = .05 + .1 * x[:, day] ** 2 + .85 * variance
    streams['GARCH_heteroskedastic_zero_conditional_mean'] = x
    print(json.dumps({'class': 'synthetic_null_stress_not_market_performance',
        'repetitions': count, 'seed': 20260908, 'first_look': 10, 'last_look': days,
        'family': 'one_directional_hypothesis', 'null_unconditional_mean': 0,
        'production_effect': False, 'results': {name: rejection_rates(x) for name, x in streams.items()}},
        indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
