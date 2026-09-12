"""Historical config replay diagnostics; final candidate evidence owns promotion.

Win rate, trade Sharpe, elapsed time and repeated overlapping replays are not
independent evidence of economic benefit or harm.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from services.screener_search_evidence import assess_metrics
from services.screener_search_validation import paired_holdout, portfolio_metrics


@dataclass(frozen=True)
class ConfigPoolPolicy:
    lookback_days: int = 90

    @classmethod
    def from_config(cls, config: dict[str, Any] | None) -> "ConfigPoolPolicy":
        config = config if isinstance(config, dict) else {}
        alpha = config.get('alphaFramework')
        section = config.get('configPool') or config.get('config_pool') or (
            alpha.get('configPool') if isinstance(alpha, dict) else {})
        try:
            days = int(section.get('lookbackDays', 90)) if isinstance(section, dict) else 90
        except (TypeError, ValueError, OverflowError):
            days = 90
        return cls(lookback_days=max(7, min(days, 180)))

    def evaluate(self, champion: Any, challenger: Any, dates: list[str]) -> dict:
        try:
            assessments = [assess_metrics(metrics, {'min_n_trades': 0},
                                         portfolio=portfolio_metrics(metrics))
                           for metrics in (champion, challenger)]
            if any(item['category'] in {'invalid_metrics', 'data_missing', 'sanity_flag'} for item in assessments):
                return {'status': 'invalid', 'reason': 'paired_replay_quality_invalid',
                        'quality': assessments, 'promotion_eligible': False, 'action': 'hold'}
            evidence = paired_holdout(*assessments, dates)
        except (ValueError, TypeError, AttributeError, OverflowError) as exc:
            return {'status': 'invalid', 'reason': str(exc), 'promotion_eligible': False,
                    'prospective_credit': False, 'action': 'hold'}
        # This rolling historical replay may overlap previous research. Even a
        # positive interval is a diagnostic, NOT permission to promote/retire.
        # Immutable prospective evidence and its final controller own both.
        return {**evidence, 'schema': 'config-pool-paired-nav-v2',
                'independence_scope': 'historical_rolling_replay_not_independent_holdout',
                'candidate_max_drawdown': assessments[1]['metrics']['portfolio_max_drawdown'],
                'champion_max_drawdown': assessments[0]['metrics']['portfolio_max_drawdown'],
                'quality': [item['category'] for item in assessments],
                'action': 'hold', 'action_reason': 'final_candidate_evidence_owner_required'}

    def to_dict(self) -> dict:
        return {'policy_version': 'config-pool-paired-nav-v2', 'lookback_days': self.lookback_days,
                'primary_metric': 'paired_cost_net_daily_nav_delta',
                'inference_role': 'historical_diagnostic_only',
                'win_rate_role': 'diagnostic_only', 'trade_sharpe_role': 'diagnostic_only',
                'stale_age_action': 'hold_not_evidence_of_harm',
                'promotion_owner': 'candidate_specific_final_controller'}


DEFAULT_CONFIG_POOL_POLICY = ConfigPoolPolicy()
