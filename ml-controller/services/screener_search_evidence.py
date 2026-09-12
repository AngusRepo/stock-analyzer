"""Versioned, JSON-safe evidence for relative screener parameter research."""
from __future__ import annotations

import math


class ScreenerSearchBlocked(RuntimeError):
    def __init__(self, diagnostics: dict):
        self.diagnostics = diagnostics
        super().__init__(
            f"Screener research blocked ({diagnostics.get('reason', 'no_feasible_pareto')}); "
            f"rejects={diagnostics['reject_summary']}; "
            f"evidence_id={diagnostics['evidence_id']}"
        )


def assess_metrics(metrics, config: dict, *, portfolio: dict | None = None) -> dict:
    """The incumbent and every candidate use exactly the same evaluator."""
    fields = (
        'sharpe', 'max_drawdown', 'total_return', 'total_trades', 'win_rate',
        'profit_factor', 'entry_attempts', 'entries_filled', 'fill_rate',
        'candidate_conversion_rate', 'execution_attempts', 'execution_fill_rate',
        'execution_data_missing',
    )
    observed = {name: getattr(metrics, name, None) for name in fields}
    if portfolio is not None:
        observed.update(portfolio)
    invalid = [name for name, value in observed.items()
               if isinstance(value, (float, int)) and not math.isfinite(value)]
    for name in invalid:
        observed[name] = None
    # Legacy per-trade Sharpe/PF can be undefined while a valid NAV objective
    # exists. Keep them visible as missing diagnostics, not portfolio failures.
    blocking_invalid = [name for name in invalid if portfolio is None or name not in {
        'sharpe', 'trade_sharpe_diagnostic', 'profit_factor',
    }]
    diagnostics_only = [flag for flag in metrics.sanity_flags if portfolio is not None and (
        (flag.startswith('sharpe=') and flag.endswith('likely overfit, reject for Optuna'))
        or (flag.startswith('max_dd=') and flag.endswith('< 2% — unrealistically low, check data'))
    )]
    blocking_flags = [flag for flag in metrics.sanity_flags if flag not in diagnostics_only]
    observed['skip_reasons'] = dict(metrics.skip_reasons)
    issues = getattr(metrics, 'execution_data_issues', None)
    observed['execution_data_issues'] = issues
    observed['execution_issue_coverage'] = (
        'complete' if isinstance(issues, list) and len(issues) == observed['execution_data_missing']
        else 'legacy_missing_event_details'
    )
    observed['sanity_flags'] = list(metrics.sanity_flags)
    observed['diagnostic_only_flags'] = diagnostics_only
    observed['nonfinite_diagnostics'] = [name for name in invalid if name not in blocking_invalid]
    reason = None
    category = 'valid'
    required = ('portfolio_sharpe', 'portfolio_max_drawdown') if portfolio is not None else ('sharpe', 'max_drawdown')
    if blocking_invalid or any(observed.get(name) is None for name in required):
        category, reason = 'invalid_metrics', 'non_finite_or_missing_objective'
    elif observed['execution_data_missing'] is None or observed['execution_data_missing'] > 0:
        category, reason = 'data_missing', 'execution_data_unavailable'
    elif blocking_flags:
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
                 'portfolio_sharpe', 'portfolio_max_drawdown', 'portfolio_total_return',
                 'candidate_conversion_rate', 'total_trades'):
        a, b = left.get(name), right.get(name)
        deltas[name] = b - a if a is not None and b is not None else None
    return {'baseline_status': baseline['category'], 'candidate_status': candidate['category'],
            'delta_candidate_minus_baseline': deltas, 'promotion_eligible': False,
            'scope': 'same_dataset_mode_a_relative_only'}
