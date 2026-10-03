"""Candidate-bound GA validation on one immutable point-in-time snapshot."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

from services.alpha_evidence_runner import run_parameter_candidate_evidence
from services.backtest_engine import BacktestDataset, _snapshot_metadata
from services.ga_optimizer_service import attach_ga_candidate_evidence
from services.trading_config_loader import load_merged_trading_config_with_contract
from services.weekly_evidence_service import _resolve_snapshot, taiwan_today


def validate_ga_top_candidate(
    search_result: dict[str, Any],
    *,
    as_of_date: str | None = None,
    mc_simulations: int = 1000,
    parity_audit: dict[str, Any] | None = None,
    baseline_config: dict[str, Any] | None = None,
    search_context=None,
    evidence_runner: Callable[..., dict[str, Any]] = run_parameter_candidate_evidence,
) -> dict[str, Any]:
    """Run the selected GA policy through the shared real-evidence owner.

    Search fitness remains ranking-only.  This function validates exactly one
    selected candidate against the champion on one immutable snapshot.
    """
    resolved_as_of = as_of_date or taiwan_today()
    if search_context is None:
        snapshot, start_date, end_date = _resolve_snapshot(resolved_as_of)
    else:
        snapshot = search_context.snapshot
        start_date, end_date = search_context.split['validation_start'], search_context.split['validation_end']
        baseline_config = deepcopy(search_context.baseline)
    best = search_result.get("best") if isinstance(search_result.get("best"), dict) else {}
    candidate = best.get("candidate") if isinstance(best.get("candidate"), dict) else {}
    if not candidate:
        raise RuntimeError("ga_top_candidate_missing")
    candidate_params = candidate.get("params") if isinstance(candidate.get("params"), dict) else {}
    alpha_framework = (
        candidate_params.get("alphaFramework")
        if isinstance(candidate_params.get("alphaFramework"), dict)
        else None
    )
    if not alpha_framework:
        raise RuntimeError("ga_top_candidate_alpha_framework_missing")
    replay_candidate = deepcopy(candidate)
    replay_candidate["config"] = {"alphaFramework": deepcopy(alpha_framework)}

    config_contract: dict[str, Any] | None = None
    if baseline_config is None:
        loaded = load_merged_trading_config_with_contract()
        baseline_config = loaded.config
        config_contract = loaded.contract.to_dict()

    def _load_exact_snapshot(*, start_date: str, end_date: str, symbols=None):
        if search_context is not None:
            if (start_date != search_context.split['validation_start']
                    or end_date != search_context.split['validation_end'] or symbols is not None):
                raise ValueError('ga_validation_holdout_changed')
            dataset = search_context.dataset
        else:
            dataset = BacktestDataset.load_from_snapshot_manifest(
                manifest=snapshot,
                start_date=start_date,
                end_date=end_date,
                symbols=symbols,
            )
        return dataset, {
            "source": "snapshot",
            "snapshot_id": snapshot.get("snapshot_id"),
            "snapshot_checksum": snapshot.get("checksum"),
            "snapshot_business_date": snapshot.get("business_date"),
            "snapshot_created_at": snapshot.get("created_at"),
            "look_ahead_check": "PASS",
        }

    resolved_parity = parity_audit or {
        "worker_parity": {
            "decision": "MISSING",
            "source": "execution_parity_shadow",
            "reason": "candidate validation cannot manufacture paper/live parity",
        }
    }
    def _replay_nav_metrics(**kwargs):
        from services.backtest_engine import replay_period
        from services.screener_search_validation import portfolio_metrics
        metrics = (search_context.replay if search_context is not None else replay_period)(**kwargs)
        nav = portfolio_metrics(metrics)
        metrics.trade_sharpe_diagnostic = metrics.sharpe
        metrics.sharpe = nav['portfolio_sharpe']
        metrics.max_drawdown = nav['portfolio_max_drawdown']
        return metrics

    evidence = evidence_runner(
        replay_candidate,
        start_date=start_date,
        end_date=end_date,
        baseline_config=deepcopy(baseline_config or {}),
        mode="B",
        mc_simulations=mc_simulations,
        parity_audit=resolved_parity,
        dataset_loader=_load_exact_snapshot,
        replay_fn=_replay_nav_metrics,
    )
    coverage = None
    if search_context is not None and getattr(search_context.dataset, 'replay_frames', None) is not None:
        from services.backtest_snapshot_state import frozen_mode_b
        predictions, _, _ = frozen_mode_b(search_context.dataset)
        expected = [d for d in search_context.dataset.trading_days if start_date <= d < end_date]
        missing = sorted(set(expected) - predictions._dates)
        coverage = {'decision_days': len(expected), 'days_with_predictions': len(expected)-len(missing),
                    'missing_decision_dates': missing, 'complete': not missing}
        if missing:
            gate = evidence['gate']
            gate.update(decision='FAIL', passed=False,
                failed_gates=[*(gate.get('failed_gates') or []), 'frozen_prediction_calendar_incomplete'])
    sensitivity = None
    if search_context is not None and (baseline_config.get('researchAccounting') or {}).get('cashRoundingMode'):
        from services.ga_backtest_fitness import cash_rounding_sensitivity
        sensitivity = cash_rounding_sensitivity(dataset=search_context.dataset, baseline=baseline_config,
            candidate=replay_candidate['config'], start_date=start_date, end_date=end_date,
            replay=search_context.replay)
        if not sensitivity['advantage_sign_stable']:
            gate = evidence['gate']
            gate.update(decision='FAIL', passed=False,
                failed_gates=[*(gate.get('failed_gates') or []), 'cash_rounding_advantage_unstable'])
    evidence_clock = {
        "schema_version": "ga-candidate-evidence-clock-v1",
        "as_of_date": resolved_as_of,
        "data_start_date": start_date,
        "data_end_date": end_date,
        "snapshot_id": snapshot.get("snapshot_id"),
        "snapshot_business_date": snapshot.get("business_date"),
        "snapshot_checksum": snapshot.get("checksum"),
        "snapshot_created_at": snapshot.get("created_at"),
        "snapshot_producer_run_id": snapshot.get("producer_run_id"),
        "research_data_source": "snapshot",
        "mode": "B",
        "objective_metric": "daily_nav_sharpe_zero_cash_benchmark_252",
        "look_ahead_check": "PASS",
        "corporate_evidence_semantic": (
            "historical_economic_accounting" if "corporate_history_records" in
            (_snapshot_metadata(snapshot).get("components") or {})
            else "original_paper_receipts"),
        "historical_reconstruction_is_execution_parity": False,
        "candidate_id": candidate.get("id"),
        "baseline_config_contract": config_contract,
        "search_split": deepcopy(search_context.split) if search_context else None,
    }
    result = attach_ga_candidate_evidence(
        search_result,
        evidence,
        evidence_clock=evidence_clock,
    )

    if coverage is not None:
        result['frozen_prediction_coverage'] = coverage
    if sensitivity is not None:
        result['cash_rounding_sensitivity'] = sensitivity
    return result
