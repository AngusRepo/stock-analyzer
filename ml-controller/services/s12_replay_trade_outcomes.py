from __future__ import annotations

import json
from typing import Any

from services.s12_trade_ev import build_s12_trade_ev_from_replay


def _to_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _first_float(*values: Any) -> float | None:
    for value in values:
        number = _to_float(value)
        if number is not None:
            return number
    return None


def s12_replay_outcome_to_ev_sample(outcome: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(outcome, dict):
        return None
    if str(outcome.get("status") or "").strip() != "executed":
        return None
    if outcome.get("sample_eligible") is False:
        return None
    pnl = _first_float(outcome.get("pnl_pct"), outcome.get("return_pct"), outcome.get("trade_return_pct"))
    if pnl is None:
        return None
    return {
        "return_pct": pnl,
        "pnl_pct": pnl,
        "trade_pnl_r": _first_float(outcome.get("trade_pnl_r"), outcome.get("pnl_r")),
        "mfe_pct": _first_float(outcome.get("mfe_pct"), outcome.get("max_favorable_pct")),
        "mae_pct": _first_float(outcome.get("mae_pct"), outcome.get("max_adverse_pct")),
        "bars_to_exit": _first_float(outcome.get("bars_to_exit"), outcome.get("holding_bars")),
        "exit_reason": str(outcome.get("exit_reason") or "unknown"),
        "sample_date": str(outcome.get("trade_date") or outcome.get("prediction_date") or "")[:10],
    }


def build_s12_trade_ev_from_replay_outcomes(
    *,
    symbol: str | None = None,
    entry_price: float | None = None,
    stop_price: float | None = None,
    outcomes: list[dict[str, Any]] | None = None,
    min_samples: int = 30,
    roundtrip_cost_bps: float = 18.0,
    source: str = "s12_replay_trade_outcomes",
) -> dict[str, Any]:
    samples = [
        sample
        for outcome in outcomes or []
        if (sample := s12_replay_outcome_to_ev_sample(outcome)) is not None
    ]
    ev = build_s12_trade_ev_from_replay(
        symbol=symbol,
        entry_price=entry_price,
        stop_price=stop_price,
        samples=samples,
        min_samples=min_samples,
        roundtrip_cost_bps=roundtrip_cost_bps,
        source=source,
    )
    ev["replay_outcome_count"] = len(outcomes or [])
    ev["sample_policy"] = "verified_s12_replay_executed_outcomes_only"
    return ev


def s12_replay_outcome_to_bootstrap_row(outcome: dict[str, Any]) -> dict[str, Any] | None:
    sample = s12_replay_outcome_to_ev_sample(outcome)
    if sample is None:
        return None
    symbol = str(outcome.get("symbol") or "").strip()
    signal_date = str(outcome.get("signal_date") or "").strip()[:10]
    trade_date = str(outcome.get("trade_date") or outcome.get("prediction_date") or "").strip()[:10]
    if not symbol or not trade_date:
        return None
    forecast_data = {
        "s12_trade_ev": {
            "schema_version": "s12-trade-ev-v1",
            "status": "loaded",
            "source": "s12_multisession_structure_replay_v3",
            "semantic": "trade_expected_return_not_5bar_close_forecast",
            "trade_expected_return_net_pct": sample["pnl_pct"],
            "trade_expected_return_source": "s12_multisession_structure_replay_v3",
        },
        "s12_replay_outcome": {
            "schema_version": outcome.get("schema_version") or "s12-replay-trade-outcome-v1",
            "source": outcome.get("source") or "s12_multisession_structure_replay_v3",
            "signal_date": signal_date or None,
            "execution_date": trade_date,
            "assessment_state": outcome.get("assessment_state"),
            "setup_id": outcome.get("setup_id"),
            "exit_reason": outcome.get("exit_reason"),
            "conservative_intrabar_order": outcome.get("conservative_intrabar_order"),
        },
    }
    return {
        "symbol": symbol,
        "market": outcome.get("market"),
        "signal_date": signal_date or None,
        "prediction_date": trade_date,
        "trade_signal": "buy",
        "trade_outcome": sample["exit_reason"],
        "trade_pnl_pct": sample["pnl_pct"],
        "trade_pnl_r": sample["trade_pnl_r"],
        "max_favorable_pct": sample["mfe_pct"],
        "max_adverse_pct": sample["mae_pct"],
        "entry_price": _to_float(outcome.get("entry_price")),
        "stop_loss": _to_float(outcome.get("stop_price") or outcome.get("stop_loss")),
        "forecast_data": json.dumps(forecast_data, separators=(",", ":")),
    }
