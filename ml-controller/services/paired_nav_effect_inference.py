"""Fixed-sample uncertainty for original, reconciled paired NAV returns.

This is the numerical input to decision governance, not serving authority.
Stationary bootstrap assumes approximately stationary, short-memory returns;
it is neither a confidence sequence nor an arbitrary-market error guarantee.
No costs are subtracted again, no dates dropped and no model versions pooled.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import math

import numpy as np

from services.paired_nav_evidence import PairedNavSeries, read_verified_nav_evidence
from services.paired_nav_journal import Query, digest


@dataclass(frozen=True)
class NavEffectPolicy:
    # Explicit inputs: this module does not invent a nomination/look budget.
    policy_id: str
    min_sessions: int
    tail_alpha: float
    block_length: int
    resamples: int

    def __post_init__(self):
        if not isinstance(self.policy_id, str) or not self.policy_id.strip():
            raise ValueError('nav_effect_policy_id_missing')
        for key in ('min_sessions', 'block_length', 'resamples'):
            if type(getattr(self, key)) is not int or getattr(self, key) < 1:
                raise ValueError('nav_effect_invalid_policy:' + key)
        if self.min_sessions < 2 or self.block_length >= self.min_sessions:
            raise ValueError('nav_effect_invalid_block_or_minimum')
        if (type(self.tail_alpha) not in (int, float)
                or not math.isfinite(self.tail_alpha) or not 0 < self.tail_alpha < .5):
            raise ValueError('nav_effect_invalid_tail_alpha')
        if self.resamples < math.ceil(1 / self.tail_alpha):
            raise ValueError('nav_effect_insufficient_tail_resolution')


def _stationary_means(values: np.ndarray, *, block_length: int,
                      resamples: int, seed: int) -> np.ndarray:
    """Politis-Romano geometric blocks with circular continuation, bounded RAM.

    Each replication has n observations. A restart chooses any original date;
    continuation preserves chronological dependence (including negative days).
    """
    rng = np.random.default_rng(seed)
    n = len(values)
    means = np.empty(resamples, dtype=float)
    for offset in range(0, resamples, 256):
        count = min(256, resamples - offset)
        indices = rng.integers(n, size=count)
        total = values[indices].copy()
        for _ in range(1, n):
            restart = rng.random(count) < 1 / block_length
            indices = np.where(restart, rng.integers(n, size=count), (indices + 1) % n)
            total += values[indices]
        means[offset:offset + count] = total / n
    return means


def _evaluate_pair(pair: PairedNavSeries, policy: NavEffectPolicy) -> dict:
    """Internal only: caller must obtain pair through the full source verifier."""
    rows = pair.observations
    summary = pair.summary()
    policy_body = asdict(policy)
    assessment_key = digest(['paired-nav-fixed-sample-effect-v1',
        summary['comparison_evidence_checksum'], policy_body])
    # Retry identity covers outcomes; RNG assignment deliberately does not.
    seed = int(digest(['paired-nav-effect-seed-v1', pair.identity,
        pair.comparison, len(rows), policy_body])[:16], 16)
    result = {**summary, 'schema': 'paired-nav-fixed-sample-effect-v1',
        'assessment_key': assessment_key, 'policy': policy_body, 'seed': seed,
        'policy_provenance': 'caller_supplied_not_preoutcome_attested',
        'endpoint': 'candidate_minus_declared_baseline_costed_daily_nav_return',
        'inference_status': 'unavailable', 'reason': None,
        'uncertainty_scope': 'fixed_sample_not_family_or_repeated_look_adjusted',
        'validity': 'approximate_stationary_short_memory_finite_moments',
        'universal_finite_sample_guarantee': False,
        'mean_delta_lower_one_sided': None, 'mean_delta_upper_one_sided': None,
        'bootstrap_positive_tail_p': None, 'resamples_completed': 0,
        'promotion_allowed': False}
    if any(o.net_return_delta is None for o in rows):
        return {**result, 'reason': 'nav_valuation_or_return_incomplete'}
    if len(rows) < policy.min_sessions:
        return {**result, 'reason': 'nav_sessions_incomplete'}
    x = np.asarray([o.net_return_delta for o in rows], dtype=float)
    if not np.all(np.isfinite(x)):
        raise ValueError('nav_effect_nonfinite_verified_return')
    # Empirical zero variance cannot establish that future variance is zero.
    if np.all(x == x[0]):
        return {**result, 'reason': 'nav_observed_difference_zero' if x[0] == 0
                else 'nav_variance_unidentified'}
    scale = float(np.max(np.abs(x)))
    x = x / scale
    mean = math.fsum(float(v) / len(x) for v in x)
    means = _stationary_means(x, block_length=policy.block_length,
        resamples=policy.resamples, seed=seed)
    # Basic bootstrap: reverse centered sampling errors, not a pathwise bound.
    errors = means - mean
    lower = (mean - float(np.quantile(errors, 1 - policy.tail_alpha, method='higher'))) * scale
    upper = (mean - float(np.quantile(errors, policy.tail_alpha, method='lower'))) * scale
    p_value = (1 + int(np.count_nonzero(errors >= mean))) / (policy.resamples + 1)
    if not all(math.isfinite(v) for v in (lower, upper)):
        raise ValueError('nav_effect_nonfinite_bootstrap')
    return {**result, 'inference_status': 'evaluated_fixed_sample',
        'reason': 'family_and_repeated_assessment_governance_required',
        'mean_delta_lower_one_sided': lower, 'mean_delta_upper_one_sided': upper,
        'bootstrap_positive_tail_p': p_value, 'resamples_completed': policy.resamples}


def evaluate_nav_effects(*, business_date: str, query: Query,
                        policy: NavEffectPolicy, page_size: int = 50, now=None) -> dict:
    """Read-only entry point: verify ALL original journals/receipts before math.

    An input summary/claimed PASS is not accepted. Population failures remain
    visible; unmaterialized candidates are never treated as evaluated losers.
    """
    evidence = read_verified_nav_evidence(business_date=business_date,
        query=query, page_size=page_size, now=now)
    pairs = [_evaluate_pair(pair, policy) for pair in evidence.pairs]
    return {'schema': 'paired-nav-effect-evaluation-v1', 'as_of_date': business_date,
        'chain_checksum': evidence.coverage['chain_checksum'],
        'candidate_population': json.loads(evidence.population_json),
        'pairs': pairs, 'evaluated_pairs': sum(p['inference_status'] == 'evaluated_fixed_sample' for p in pairs),
        'promotion_allowed': False}
