"""Point-in-time weekly backtest evidence and read-only historical comparison replay."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from services.backtest_engine import BacktestDataset, replay_period
from services.backtest_result_store import persist_replay_backtest
from services.backtest_trade_evidence import build_backtest_portfolio_return_evidence
from services.dataset_snapshots import latest_dataset_snapshot, validate_dataset_snapshot_manifest
from services.monte_carlo_service import _run_monte_carlo
from services.pbo_service import _run_cpcv


TAIPEI = ZoneInfo("Asia/Taipei")


def taiwan_today() -> str:
    return datetime.now(TAIPEI).strftime("%Y-%m-%d")


def _stable_checksum(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _snapshot_range(snapshot: dict[str, Any]) -> tuple[str, str]:
    raw = snapshot.get("metadata_json")
    metadata = json.loads(raw) if isinstance(raw, str) and raw.strip() else raw or {}
    start_date = str(metadata.get("start_date") or "")[:10]
    end_date = str(metadata.get("end_date") or snapshot.get("business_date") or "")[:10]
    if not start_date or not end_date:
        raise RuntimeError("weekly_evidence_snapshot_range_missing")
    return start_date, end_date


def _resolve_snapshot(as_of_date: str) -> tuple[dict[str, Any], str, str]:
    snapshot = latest_dataset_snapshot(
        kind="backtest_dataset",
        as_of_business_date=as_of_date,
        access_tier="compute",
    )
    errors = validate_dataset_snapshot_manifest(snapshot) if snapshot else ["manifest_missing"]
    if errors:
        raise RuntimeError(
            "weekly_evidence_snapshot_not_ready:"
            f"as_of={as_of_date}:errors={','.join(errors)}"
        )
    start_date, end_date = _snapshot_range(snapshot)
    snapshot_created_date = str(snapshot.get("created_at") or "")[:10]
    if not snapshot_created_date or snapshot_created_date > as_of_date:
        raise RuntimeError(
            "weekly_evidence_snapshot_availability_lookahead:"
            f"as_of={as_of_date}:created_at={snapshot.get('created_at')}"
        )
    if end_date > as_of_date or str(snapshot.get("business_date") or "")[:10] > as_of_date:
        raise RuntimeError(
            "weekly_evidence_snapshot_lookahead_detected:"
            f"as_of={as_of_date}:snapshot_end={end_date}:"
            f"business_date={snapshot.get('business_date')}"
        )
    return snapshot, start_date, end_date


def _trade_dict(trade: Any) -> dict[str, Any]:
    return {
        "symbol": getattr(trade, "symbol", None),
        "entry_date": getattr(trade, "entry_date", None),
        "exit_date": getattr(trade, "exit_date", None),
        "profit_ratio": float(getattr(trade, "profit_ratio", 0.0) or 0.0),
        "days_held": int(getattr(trade, "days_held", 0) or 0),
        "entry_regime": getattr(trade, "entry_regime", None),
    }


def _portfolio_returns(metrics: Any) -> list[float]:
    evidence = build_backtest_portfolio_return_evidence(
        list(getattr(metrics, "equity_curve", None) or []),
        initial_capital=float(getattr(metrics, "initial_capital", 0.0) or 0.0),
    )
    return [float(row[1]) for row in evidence.get("rows", [])]


def _metric_summary(metrics: Any) -> dict[str, Any]:
    return {
        "timerange": f"{metrics.start_date}~{metrics.end_date}",
        "initial_capital": metrics.initial_capital,
        "final_equity": round(metrics.final_equity, 2),
        "total_return": round(metrics.total_return, 6),
        "cagr": round(metrics.cagr, 6) if metrics.cagr is not None else None,
        "sharpe": round(metrics.sharpe, 6) if metrics.sharpe is not None else None,
        "sortino": round(metrics.sortino, 6) if metrics.sortino is not None else None,
        "calmar": round(metrics.calmar, 6) if metrics.calmar is not None else None,
        "max_drawdown": round(metrics.max_drawdown, 6),
        "total_trades": metrics.total_trades,
        "win_rate": round(metrics.win_rate, 6),
        "profit_factor": round(metrics.profit_factor, 6),
        "expectancy": round(metrics.expectancy, 6),
        "portfolio_return_observations": len(_portfolio_returns(metrics)),
    }


def _replay(
    *,
    as_of_date: str,
    params: dict[str, Any],
    initial_capital: float,
    symbols: list[str] | None,
) -> tuple[Any, dict[str, Any]]:
    snapshot, start_date, end_date = _resolve_snapshot(as_of_date)
    dataset = BacktestDataset.load_from_snapshot_manifest(
        manifest=snapshot,
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
    )
    metrics = replay_period(
        dataset=dataset,
        start_date=start_date,
        end_date=end_date,
        params=params,
        initial_capital=initial_capital,
        mode="B",
    )
    provenance = {
        "schema_version": "weekly-evidence-clock-v1",
        "as_of_date": as_of_date,
        "data_end_date": end_date,
        "snapshot_id": snapshot.get("snapshot_id"),
        "snapshot_business_date": snapshot.get("business_date"),
        "snapshot_checksum": snapshot.get("checksum"),
        "snapshot_created_at": snapshot.get("created_at"),
        "snapshot_producer_run_id": snapshot.get("producer_run_id"),
        "snapshot_availability_check": "PASS",
        "snapshot_start_date": start_date,
        "snapshot_end_date": end_date,
        "research_data_source": "snapshot",
        "mode": "B",
        "config_checksum": _stable_checksum(params),
        "look_ahead_check": "PASS",
    }
    return metrics, provenance


def run_canonical_weekly_backtest(run_date: str | None = None) -> dict[str, Any]:
    """Create immutable current-cycle evidence. Historical dates fail closed."""
    requested_date = run_date or taiwan_today()
    current_date = taiwan_today()
    if requested_date != current_date:
        return {
            "status": "failed",
            "error": "historical_canonical_weekly_rerun_forbidden",
            "requested_run_date": requested_date,
            "current_run_date": current_date,
            "required_path": "/backtest/historical-weekly-replay",
            "production_effect": False,
        }

    from services.trading_config_loader import load_merged_trading_config_with_contract

    config_result = load_merged_trading_config_with_contract()
    metrics, provenance = _replay(
        as_of_date=requested_date,
        params=config_result.config,
        initial_capital=1_000_000,
        symbols=None,
    )
    provenance.update({
        "evidence_scope": "canonical_current",
        "production_effect": True,
        "config_contract": config_result.contract.to_dict(),
    })
    persist_result = persist_replay_backtest(
        metrics,
        run_date=requested_date,
        strategy_lab_record={
            "schema_version": "weekly-canonical-backtest-v1",
            "evidence_clock": provenance,
        },
    )
    return {
        "status": "success",
        "run_date": requested_date,
        "evidence_scope": "canonical_current",
        "production_effect": True,
        "persist_result": persist_result,
        "evidence_clock": provenance,
        **_metric_summary(metrics),
    }


def run_historical_weekly_comparison(
    *,
    as_of_date: str,
    params: dict[str, Any],
    config_version: str,
    config_checksum: str,
    config_effective_at: str,
    initial_capital: float = 1_000_000,
    symbols: list[str] | None = None,
    mc_simulations: int = 1000,
    pbo_partitions: int = 10,
) -> dict[str, Any]:
    """Re-evaluate historical evidence without any D1/KV/promotion writes."""
    if not params or not config_version.strip():
        raise ValueError("historical_replay_requires_frozen_config_and_version")
    computed_config_checksum = _stable_checksum(params)
    if computed_config_checksum != config_checksum.strip().lower():
        raise ValueError("historical_replay_config_checksum_mismatch")
    if config_effective_at > as_of_date:
        raise ValueError("historical_replay_config_lookahead_detected")
    metrics, provenance = _replay(
        as_of_date=as_of_date,
        params=params,
        initial_capital=initial_capital,
        symbols=symbols,
    )
    provenance.update({
        "evidence_scope": "comparison_only",
        "production_effect": False,
        "config_version": config_version,
        "config_effective_at": config_effective_at,
        "config_checksum_verified": True,
    })
    replay_id = _stable_checksum({
        "provenance": provenance,
        "mc_simulations": mc_simulations,
        "pbo_partitions": pbo_partitions,
    })
    returns = _portfolio_returns(metrics)
    mc = _run_monte_carlo(
        returns,
        n_simulations=mc_simulations,
        seed=42,
        method="block_bootstrap",
    )
    trades = [_trade_dict(trade) for trade in (metrics.trades or [])]
    pbo = _run_cpcv(trades, pbo_partitions)
    return {
        "status": "success",
        "replay_id": replay_id,
        "evidence_scope": "comparison_only",
        "production_effect": False,
        "persisted": False,
        "promotion_gate_eligible": False,
        "evidence_clock": provenance,
        "backtest": _metric_summary(metrics),
        "monte_carlo": {
            "method": mc.simulation_method,
            "n_simulations": mc.n_simulations,
            "n_returns": mc.n_trades,
            "mdd_95th": round(mc.mdd_95th, 6),
            "mdd_99th": round(mc.mdd_99th, 6),
            "go_live_verdict": mc.go_live_verdict,
            "tail_risk_status": mc.tail_risk_status,
        },
        "pbo": {
            "method": pbo.method,
            "n_partitions": pbo.n_partitions,
            "n_combinations": pbo.n_combinations,
            "n_trades": pbo.n_trades,
            "pbo": round(pbo.pbo, 6),
            "oos_mean_return": round(pbo.oos_mean_return, 6),
            "go_live_verdict": pbo.go_live_verdict,
            "verdict_reason": pbo.verdict_reason,
        },
    }
