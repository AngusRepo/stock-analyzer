"""Portfolio objectives and a search-independent chronological audit window.

The holdout is independent of selection within ONE invocation. It is not a
claim that this historical period was unseen by prior research or an incumbent.
This module never grants production promotion or prospective maturity credit.
"""
from __future__ import annotations

import hashlib
import json
import math
from statistics import mean, stdev

from scipy.stats import t

SCHEMA = 'screener-search-v3'
OBJECTIVE = 'daily_nav_sharpe_zero_cash_benchmark_252'


def chronological_split(trading_days: list[str], start: str, end: str) -> dict:
    days = sorted(set(day for day in trading_days if start <= day <= end))
    # Replay liquidates at each window end. No position, label, or optimizer
    # state is carried into holdout; retain a five-session temporal gap.
    gap = 5
    validation_count = max(10, math.ceil(len(days) * .30))
    development_count = len(days) - gap - validation_count
    if development_count < 20:
        raise ValueError('insufficient_dates_for_search_and_holdout')
    development = days[:development_count]
    purged = days[development_count:development_count + gap]
    validation = days[development_count + gap:]
    return {
        'schema': 'screener-chronological-split-v1',
        'development': development, 'gap': purged, 'validation': validation,
        'selection_scope': 'development_only',
        'validation_use': 'single_locked_candidate_audit_no_reselection',
        'position_boundary': 'independent_cash_start_forced_end_liquidation',
        'historical_holdout_is_prospective': False,
    }


def portfolio_metrics(metrics) -> dict:
    """Use the costed, marked-to-market NAV, including cash and first-day loss."""
    initial = float(metrics.initial_capital)
    curve = list(metrics.equity_curve)
    if not math.isfinite(initial) or initial <= 0 or len(curve) < 2:
        raise ValueError('portfolio_nav_missing')
    previous = peak = initial
    maximum_drawdown = 0.0
    previous_date = ''
    daily = []
    for day, raw_value in curve:
        value = float(raw_value)
        if not isinstance(day, str) or day <= previous_date:
            raise ValueError('portfolio_nav_dates_not_unique_ordered')
        if not math.isfinite(value) or value <= 0:
            raise ValueError('portfolio_nav_nonpositive_or_nonfinite')
        daily_return = value / previous - 1.0
        if not math.isfinite(daily_return):
            raise ValueError('portfolio_daily_return_nonfinite')
        daily.append({'date': day, 'return': daily_return})
        peak = max(peak, value)
        maximum_drawdown = max(maximum_drawdown, 1.0 - value / peak)
        previous, previous_date = value, day
    if not math.isclose(previous, float(metrics.final_equity), rel_tol=1e-9, abs_tol=.01):
        raise ValueError('portfolio_final_nav_mismatch')
    returns = [item['return'] for item in daily]
    average, volatility = mean(returns), stdev(returns)
    if volatility == 0 and average != 0:
        raise ValueError('portfolio_sharpe_undefined_constant_nonzero_returns')
    sharpe = average / volatility * math.sqrt(252) if volatility else 0.0
    return {
        'portfolio_sharpe': sharpe,
        'portfolio_max_drawdown': maximum_drawdown,
        'portfolio_total_return': previous / initial - 1.0,
        'portfolio_daily_mean': average,
        'portfolio_daily_volatility': volatility,
        'portfolio_dates': len(daily),
        'daily_nav_returns': daily,
        'objective_metric': OBJECTIVE,
        'trade_sharpe_diagnostic': metrics.sharpe,
    }


def freeze_selection(params: dict, split: dict, data_access: dict, symbols: list[str], *,
                     baseline_params: dict) -> dict:
    if not isinstance(baseline_params, dict) or not baseline_params:
        raise ValueError('screener_selection_baseline_required')
    packet = {'params': params, 'baseline_params': baseline_params,
              'split': split, 'data_access': data_access, 'symbols': symbols,
              'objective': OBJECTIVE, 'schema': SCHEMA}
    checksum = hashlib.sha256(json.dumps(packet, sort_keys=True, allow_nan=False,
                                       separators=(',', ':')).encode()).hexdigest()
    return {'checksum': checksum, 'locked_before_validation': True,
            'comparison_identity': 'candidate_and_incumbent_full_configuration_v1',
            'objective': OBJECTIVE, 'schema': SCHEMA}


def paired_holdout(baseline: dict, candidate: dict, expected_dates: list[str]) -> dict:
    """One fixed-window, one-sided 95% paired HAC diagnostic, NOT another gate.

    Student-t with HAC is an approximate finite-sample diagnostic, not an exact
    time-uniform confidence guarantee. No repeated-look PASS is inferred here.
    """
    result = {'schema': 'screener-paired-holdout-v1', 'promotion_eligible': False,
              'prospective_credit': False, 'independence_scope': 'within_search_invocation_only',
              'inference': 'approximate_fixed_window_one_sided_95_hac_t',
              'automatic_reselection_allowed': False,
              'baseline_status': baseline['category'], 'candidate_status': candidate['category']}
    left = baseline.get('metrics', {}).get('daily_nav_returns', [])
    right = candidate.get('metrics', {}).get('daily_nav_returns', [])
    if ([row['date'] for row in left] != expected_dates
            or [row['date'] for row in right] != expected_dates):
        return {**result, 'status': 'invalid', 'reason': 'holdout_date_pairs_incomplete'}
    differences = [b['return'] - a['return'] for a, b in zip(left, right, strict=True)]
    n = len(differences)
    if n < 2:
        return {**result, 'status': 'pending', 'reason': 'holdout_pairs_insufficient'}
    average = mean(differences)
    centered = [value - average for value in differences]
    lag = min(n - 1, max(4, int(4 * (n / 100) ** (2 / 9))))
    gamma0 = sum(value * value for value in centered) / n
    lrv = gamma0 + 2 * sum(
        (1 - offset / (lag + 1)) * sum(centered[i] * centered[i-offset]
                                      for i in range(offset, n)) / n
        for offset in range(1, lag + 1))
    # Preserve the conservative iid variance floor used by existing HAC owners.
    se = math.sqrt(max(gamma0, lrv) / (n - 1))
    lower = average - float(t.ppf(.95, n - 1)) * se
    upper = average + float(t.ppf(.95, n - 1)) * se
    # Zero estimated variance is not permission to claim an infinite t statistic.
    status = ('inconclusive_zero_variance' if se == 0 else
              'positive_increment' if lower > 0 else
              'negative_increment' if upper < 0 else 'inconclusive')
    if baseline['category'] != 'valid' or candidate['category'] != 'valid':
        status = 'insufficient_quality_or_activity'
    return {**result, 'status': status, 'paired_dates': n, 'hac_lag': lag,
            'mean_daily_nav_delta': average, 'standard_error': se,
            'lower_one_sided_95': lower, 'upper_one_sided_95': upper,
            'daily_nav_delta': [{'date': day, 'delta': delta}
                                for day, delta in zip(expected_dates, differences, strict=True)]}
