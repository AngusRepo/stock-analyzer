"""Versioned, JSON-safe evidence for relative screener parameter research."""
from __future__ import annotations

import math


class ScreenerSearchBlocked(RuntimeError):
    def __init__(self, diagnostics: dict):
        self.diagnostics = diagnostics
        super().__init__(
            f"No feasible Pareto trials; rejects={diagnostics['reject_summary']}; "
            f"evidence_id={diagnostics['evidence_id']}"
        )


def assess_metrics(metrics, config: dict) -> dict:
    """The incumbent and every candidate use exactly the same evaluator."""
    fields = (
        'sharpe', 'max_drawdown', 'total_return', 'total_trades', 'win_rate',
        'profit_factor', 'entry_attempts', 'entries_filled', 'fill_rate',
        'candidate_conversion_rate', 'execution_attempts', 'execution_fill_rate',
        'execution_data_missing',
    )
    observed = {name: getattr(metrics, name, None) for name in fields}
    invalid = [name for name, value in observed.items()
               if isinstance(value, (float, int)) and not math.isfinite(value)]
    for name in invalid:
        observed[name] = None
    observed['skip_reasons'] = dict(metrics.skip_reasons)
    observed['sanity_flags'] = list(metrics.sanity_flags)
    reason = None
    category = 'valid'
    if invalid or observed['sharpe'] is None or observed['max_drawdown'] is None:
        category, reason = 'invalid_metrics', 'non_finite_or_missing_objective'
    elif observed['execution_data_missing'] is None or observed['execution_data_missing'] > 0:
        category, reason = 'data_missing', 'execution_data_unavailable'
    elif any(any(k in flag for k in ('overfit', 'unrealistically', 'No trading days'))
             for flag in metrics.sanity_flags):
        category, reason = 'sanity_flag', 'sanity_check_failed'
    elif metrics.total_trades < int(config.get('min_n_trades', 30)):
        category, reason = 'n_trades', 'insufficient_completed_trades'
    elif observed['execution_fill_rate'] is None or not observed['execution_attempts']:
        category, reason = 'no_execution', 'no_evaluable_execution_attempts'
    elif observed['execution_fill_rate'] < float(config.get('min_fill_rate', 0.30)):
        category, reason = 'fill_rate', 'execution_fill_rate_below_floor'
    return {'category': category, 'reject_reason': reason, 'metrics': observed}


def relative_comparison(baseline: dict, candidate: dict) -> dict:
    """Descriptive in-sample differences, never a promotion verdict."""
    left, right = baseline.get('metrics', {}), candidate.get('metrics', {})
    deltas = {}
    for name in ('sharpe', 'max_drawdown', 'total_return', 'execution_fill_rate',
                 'candidate_conversion_rate', 'total_trades'):
        a, b = left.get(name), right.get(name)
        deltas[name] = b - a if a is not None and b is not None else None
    return {'baseline_status': baseline['category'], 'candidate_status': candidate['category'],
            'delta_candidate_minus_baseline': deltas, 'promotion_eligible': False,
            'scope': 'same_dataset_mode_a_relative_only'}
