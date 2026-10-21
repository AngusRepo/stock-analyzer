"""R15/R17 paired statistics, retaining missing trading-calendar positions."""
from __future__ import annotations
import math
import numpy as np

SEED = 20261015

def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def paired_stats(values):
    data = np.asarray([v if finite(v) else np.nan for v in values], float)
    n = len(data); mask = np.isfinite(data)
    if not n or not mask.any():
        return {'n': 0, 'mean': None, 'ci95': None, 'bootstrap_valid': 0}
    rng = np.random.default_rng(SEED)
    starts = rng.integers(0, n, size=(5000, math.ceil(n / 5)))
    indices = ((starts[:, :, None] + np.arange(5)) % n).reshape(5000, -1)[:, :n]
    sampled = data[indices]; counts = np.isfinite(sampled).sum(axis=1)
    means = np.divide(np.nansum(sampled, axis=1), counts,
                      out=np.full(5000, np.nan), where=counts > 0)
    valid = means[np.isfinite(means)]
    return {'n': int(mask.sum()), 'mean': float(data[mask].mean()),
            'ci95': np.quantile(valid, [.025, .975]).tolist(), 'bootstrap_valid': len(valid)}

def difference(left, right):
    return [a - b if finite(a) and finite(b) else None for a, b in zip(left, right, strict=True)]

def primary(weights, returns, pool):
    if not pool or len(pool) != len(set(pool)):
        raise ValueError('candidate_pool_invalid')
    if any(not finite(v) or v < 0 for v in weights.values()):
        raise ValueError('holding_weight_invalid')
    needed = set(pool) | {s for s, w in weights.items() if w > 0}
    if any(s not in returns or not finite(returns[s]) for s in needed):
        raise ValueError('mature_label_missing')
    benchmark = float(np.mean([returns[s] for s in pool]))
    exposure = sum(weights.values())
    value = (sum(w * returns[s] for s, w in weights.items() if w > 0) / exposure - benchmark
             if exposure > 0 else None)
    return {'exposure': exposure, 'primary': value, 'pool_return': benchmark}
