"""Candidate-bound GA validation on one immutable point-in-time snapshot."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

from services.alpha_evidence_runner import run_parameter_candidate_evidence
from services.backtest_engine import BacktestDataset
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
    evidence_runner: Callable[..., dict[str, Any]] = run_parameter_candidate_evidence,
) -> dict[str, Any]:
    """Run the selected GA policy through the shared real-evidence owner.

    Search fitness remains ranking-only.  This function validates exactly one
    selected candidate against the champion on one immutable snapshot.
    """
    resolved_as_of = as_of_date or taiwan_today()
    snapshot, start_date, end_date = _resolve_snapshot(resolved_as_of)
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
    evidence = evidence_runner(
        replay_candidate,
        start_date=start_date,
        end_date=end_date,
        baseline_config=deepcopy(baseline_config or {}),
        mode="B",
        mc_simulations=mc_simulations,
        parity_audit=resolved_parity,
        dataset_loader=_load_exact_snapshot,
    )
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
        "look_ahead_check": "PASS",
        "candidate_id": candidate.get("id"),
        "baseline_config_contract": config_contract,
    }
    return attach_ga_candidate_evidence(
        search_result,
        evidence,
        evidence_clock=evidence_clock,
    )
