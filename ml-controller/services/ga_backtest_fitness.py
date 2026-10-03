"""Generation fitness on one frozen training interval; holdout is never ranked.

Mode A is deliberate: evolution uses snapshot-only rule replay, with costs and
corporate accounting. Mode B/OOS promotion evidence consumes the same sealed snapshot in the separate validator.
"""
from copy import deepcopy
import math
import json

from services.alpha_evidence_runner import _deep_merge
from services.paired_nav_journal import digest


def split_dates(days, *, purge_sessions=5):
    days = sorted(set(days))
    holdout = max(20, len(days) // 4)
    cut = len(days) - holdout - purge_sessions
    if cut < 60:
        raise ValueError('ga_insufficient_train_purge_holdout_sessions')
    return {'train_start': days[0], 'train_end': days[cut-1],
            'purge_dates': days[cut:cut+purge_sessions],
            'validation_start': days[cut+purge_sessions], 'validation_end': days[-1]}


class BacktestFitness:
    def __init__(self, *, dataset, baseline, split, snapshot, replay):
        self.dataset, self.baseline = dataset, deepcopy(baseline)
        if any(s.get('schema_version') == 'research-corporate-history-v1'
               for s in getattr(dataset, 'corporate_sources', {}).values()):
            self.baseline.setdefault('researchAccounting', {}).setdefault('cashRoundingMode', 'exact_accrual')
            self.baseline['researchAccounting'].setdefault('subscriptionPolicy', 'do_not_subscribe_zero_value')
        self.split, self.snapshot, self.replay = split, deepcopy(snapshot), replay
        self.cache = {}
        self.replays = 0

    def __call__(self, candidate):
        params = _deep_merge(self.baseline, candidate['config'])
        key = digest(params)
        if key not in self.cache:
            from services.research_corporate_history import CorporateHistoryGap
            try:
                metrics = self.replay(dataset=self.dataset, params=params, mode='A',
                    start_date=self.split['train_start'], end_date=self.split['train_end'])
            except CorporateHistoryGap as exc:
                exc.requirements.update(candidate_id=candidate.get('id'),
                    snapshot_id=self.snapshot['snapshot_id'], snapshot_checksum=self.snapshot['checksum'],
                    stage='training', completed_fitness_count=self.replays)
                raise
            self.replays += 1
            from services.screener_search_validation import portfolio_metrics
            nav = portfolio_metrics(metrics)
            expected_days = [d for d in self.dataset.trading_days
                             if self.split['train_start'] <= d <= self.split['train_end']]
            if [day for day, _ in metrics.equity_curve] != expected_days:
                raise ValueError('ga_training_nav_calendar_incomplete')
            sharpe = nav['portfolio_sharpe']
            # No-trade/undefined scores cannot beat measured performance.
            score = float(sharpe) if sharpe is not None and math.isfinite(sharpe) and metrics.total_trades else -999.
            self.cache[key] = {'score': score, 'sharpe': sharpe,
                'max_drawdown': nav['portfolio_max_drawdown'], 'trade_count': metrics.total_trades,
                'total_return': nav['portfolio_total_return'],
                'objective_metric': nav['objective_metric'],
                'trade_sharpe_diagnostic': metrics.sharpe, 'parameter_checksum': key,
                'corporate_rounding_assumptions': getattr(metrics, 'corporate_rounding_assumptions', []),
                'corporate_subscription_assumptions': getattr(metrics, 'corporate_subscription_assumptions', []),
                'cash_rounding_mode': (params.get('researchAccounting') or {}).get('cashRoundingMode'),
                'evidence_semantic': 'candidate_specific_training_mode_a_replay',
                'promotion_eligible': False, 'oos_applied': False,
                'pbo_applied': False, 'monte_carlo_applied': False,
                'snapshot_id': self.snapshot['snapshot_id'],
                'snapshot_checksum': self.snapshot['checksum'],
                'data_start_date': self.split['train_start'], 'data_end_date': self.split['train_end']}
        return deepcopy(self.cache[key])


def prepare_ga_backtest(*, as_of_date=None):
    from services.weekly_evidence_service import _resolve_snapshot, taiwan_today, _with_formal_position_risk
    from services.trading_config_loader import load_merged_trading_config_with_contract
    from services.backtest_engine import BacktestDataset, replay_period, _snapshot_component_uris
    snapshot, start, end = _resolve_snapshot(as_of_date or taiwan_today(), prefer_corporate_history=True)
    # Fail before downloading multi-GB market frames or starting any generation.
    components = _snapshot_component_uris(snapshot)
    corporate_component = 'corporate_history_records' if 'corporate_history_records' in components else 'corporate_source_records'
    if corporate_component not in components:
        raise ValueError('ga_corporate_source_component_missing:' + snapshot['snapshot_id'])
    meta = snapshot.get('metadata_json') or {}
    if isinstance(meta, str): meta = json.loads(meta)
    source_meta = (meta.get('component_meta') or {}).get(corporate_component) or {}
    if source_meta.get('row_count') == 0:
        raise ValueError('ga_corporate_source_component_empty:' + snapshot['snapshot_id'])
    from services.backtest_snapshot_state import COMPONENTS
    missing_inputs = sorted(set(COMPONENTS) - set(_snapshot_component_uris(snapshot)))
    if missing_inputs:
        raise ValueError('ga_frozen_validation_components_missing:' + ','.join(missing_inputs))
    preflight_corporate_tape(components[corporate_component], historical=corporate_component == 'corporate_history_records')
    dataset = BacktestDataset.load_from_snapshot_manifest(manifest=snapshot, start_date=start, end_date=end,
        allow_corporate_history=corporate_component == 'corporate_history_records')
    missing = [day for day in dataset.trading_days if day not in dataset.corporate_sources]
    if missing:
        raise ValueError('ga_corporate_source_sessions_missing:' + ','.join(missing[:10]))
    if corporate_component == 'corporate_source_records':
        for day in dataset.trading_days:
            uncovered = sorted(dataset.get_universe_at(day) - set(dataset.corporate_sources[day]['covered_symbols']))
            if uncovered:
                raise ValueError('ga_corporate_universe_incomplete:' + json.dumps(
                    {'date':day, 'missing_count':len(uncovered), 'symbols':uncovered[:20]}))
    from services.backtest_snapshot_state import frozen_mode_b
    frozen_mode_b(dataset)  # Validate holdout inputs before any expensive generation.
    split = split_dates(evaluation_days(dataset))
    baseline = _with_formal_position_risk(load_merged_trading_config_with_contract().config)
    evaluator = BacktestFitness(dataset=dataset, baseline=baseline, split=split, snapshot=snapshot, replay=replay_period)
    return evaluator


def preflight_corporate_tape(uri, *, historical=False):
    """Reject known-impossible evidence before loading multi-GB price history."""
    from services.backtest_engine import _read_snapshot_parquet
    from services.backtest_corporate_accounting import load_corporate_tape
    from services.research_corporate_history import load_history_tape
    tape = (load_history_tape if historical else load_corporate_tape)(_read_snapshot_parquet(uri))
    # The actual split still validates session counts and the entire universe.
    # 60 training + 5 purge + >=20 holdout is the immutable lower bound.
    if len(tape) < 85:
        raise ValueError('ga_corporate_source_history_insufficient:' + str(len(tape)))
    if any(not record['covered_symbols'] for record in tape.values()):
        raise ValueError('ga_corporate_source_empty_universe')



def evaluation_days(dataset):
    """Start at shared input inception, keep earlier prices only as warmup.

    Internal missing sessions are never removed. All candidates share this
    availability-based interval, selected before their performance is known.
    """
    frames = dataset.replay_frames
    starts = [min(str(d) for d in frames['signals']['prediction_date'])]
    for frame in (dataset.market_risk, frames['market_breadth'], frames['us_market_signals']):
        if frame.is_empty():
            raise ValueError('ga_evaluation_input_empty')
        starts.append(min(str(d) for d in frame['date']))
    first = max(starts)
    return [d for d in dataset.trading_days if d >= first]


def cash_rounding_sensitivity(*, dataset, baseline, candidate, start_date, end_date, replay):
    """Locked candidate vs baseline, full replays including changed cash/sizing."""
    from services.screener_search_validation import portfolio_metrics
    rows = {}
    for mode in ('exact_accrual', 'minus_one_twd'):
        results = {}
        for label, config in (('baseline', baseline), ('candidate', _deep_merge(baseline, candidate))):
            params = deepcopy(config)
            params.setdefault('researchAccounting', {})['cashRoundingMode'] = mode
            metrics = replay(dataset=dataset, params=params, mode='B', start_date=start_date, end_date=end_date)
            expected = [d for d in dataset.trading_days if start_date <= d <= end_date]
            if [d for d, _ in metrics.equity_curve] != expected:
                raise ValueError('ga_cash_sensitivity_calendar_incomplete')
            results[label] = {**portfolio_metrics(metrics), 'trade_count': metrics.total_trades,
                'parameter_checksum': digest(params),
                'assumptions': deepcopy(metrics.corporate_rounding_assumptions)}
        results['candidate_advantage'] = (results['candidate']['portfolio_total_return'] -
                                           results['baseline']['portfolio_total_return'])
        rows[mode] = results
    sign = lambda v: (v > 0) - (v < 0)
    return {'status': 'completed', 'candidate_locked': True, 'reselection_allowed': False,
        'source_semantic': 'research_cash_accrual_not_live_reconciliation',
        'start_date': start_date, 'end_date': end_date, 'scenarios': rows,
        'advantage_sign_stable': sign(rows['exact_accrual']['candidate_advantage']) ==
                                 sign(rows['minus_one_twd']['candidate_advantage'])}
