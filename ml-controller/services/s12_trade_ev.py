from __future__ import annotations

from collections import Counter
from typing import Any


def _to_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _pct_from_exit(entry_price: float | None, sample: dict[str, Any]) -> float | None:
    direct = _to_float(
        sample.get("return_pct")
        or sample.get("trade_return_pct")
        or sample.get("exit_return_pct")
        or sample.get("pnl_pct")
    )
    if direct is not None:
        return direct
    exit_price = _to_float(sample.get("exit_price") or sample.get("exitPrice"))
    if entry_price is None or entry_price <= 0 or exit_price is None:
        return None
    return (exit_price - entry_price) / entry_price


def build_s12_trade_ev_from_replay(
    *,
    symbol: str | None = None,
    entry_price: float | None = None,
    stop_price: float | None = None,
    samples: list[dict[str, Any]] | None = None,
    min_samples: int = 30,
    roundtrip_cost_bps: float = 18.0,
    source: str = "s12_replay_trade_outcomes",
) -> dict[str, Any]:
    """Build a trade EV contract from S12 replay outcomes.

    The output is intentionally trade-centric: expected return, expected R,
    win/loss distribution, MFE/MAE and exit reasons. A 5-bar close forecast is
    not accepted here; callers must provide realized S12-style trade outcomes.
    """

    entry = _to_float(entry_price)
    stop = _to_float(stop_price)
    risk_pct = None
    if entry is not None and entry > 0 and stop is not None and stop > 0 and stop < entry:
        risk_pct = (entry - stop) / entry

    returns: list[float] = []
    r_values: list[float] = []
    mfe_values: list[float] = []
    mae_values: list[float] = []
    bars_to_exit: list[float] = []
    exit_reasons: Counter[str] = Counter()
    invalid_samples = 0

    for sample in samples or []:
        if not isinstance(sample, dict):
            invalid_samples += 1
            continue
        ret = _pct_from_exit(entry, sample)
        if ret is None:
            invalid_samples += 1
            continue
        returns.append(ret)
        if risk_pct and risk_pct > 0:
            r_values.append(ret / risk_pct)
        mfe = _to_float(sample.get("mfe_pct") or sample.get("max_favorable_excursion_pct"))
        mae = _to_float(sample.get("mae_pct") or sample.get("max_adverse_excursion_pct"))
        bars = _to_float(sample.get("bars_to_exit") or sample.get("holding_bars"))
        if mfe is not None:
            mfe_values.append(mfe)
        if mae is not None:
            mae_values.append(mae)
        if bars is not None:
            bars_to_exit.append(bars)
        reason = str(sample.get("exit_reason") or sample.get("reason") or "unknown").strip() or "unknown"
        exit_reasons[reason] += 1

    sample_count = len(returns)
    cost = max(0.0, float(roundtrip_cost_bps or 0.0)) / 10000.0
    gross = sum(returns) / sample_count if sample_count else None
    net = (gross - cost) if gross is not None else None
    wins = [value for value in returns if value > 0]
    losses = [value for value in returns if value < 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = (gross_win / gross_loss) if gross_loss > 0 else None
    avg_win = sum(wins) / len(wins) if wins else None
    avg_loss = sum(losses) / len(losses) if losses else None
    payoff = (avg_win / abs(avg_loss)) if avg_win is not None and avg_loss and avg_loss < 0 else None
    expected_r = sum(r_values) / len(r_values) if r_values else None

    status = "loaded" if sample_count >= max(1, int(min_samples)) else "insufficient_samples"
    return {
        "schema_version": "s12-trade-ev-v1",
        "symbol": symbol,
        "status": status,
        "source": source,
        "semantic": "trade_expected_return_not_5bar_close_forecast",
        "sampleCount": sample_count,
        "minSamples": max(1, int(min_samples)),
        "invalidSampleCount": invalid_samples,
        "entry_price": entry,
        "stop_price": stop,
        "risk_pct": None if risk_pct is None else round(risk_pct, 10),
        "roundtrip_cost_bps": round(cost * 10000.0, 4),
        "trade_expected_return_gross_pct": None if gross is None else round(gross, 10),
        "trade_expected_return_net_pct": None if net is None else round(net, 10),
        "trade_expected_return_source": source if status == "loaded" else f"{source}_insufficient_samples",
        "expected_R": None if expected_r is None else round(expected_r, 6),
        "win_rate": None if not sample_count else round(len(wins) / sample_count, 6),
        "avg_win_pct": None if avg_win is None else round(avg_win, 10),
        "avg_loss_pct": None if avg_loss is None else round(avg_loss, 10),
        "payoff_ratio": None if payoff is None else round(payoff, 6),
        "profit_factor": None if profit_factor is None else round(profit_factor, 6),
        "avg_mfe_pct": None if not mfe_values else round(sum(mfe_values) / len(mfe_values), 10),
        "avg_mae_pct": None if not mae_values else round(sum(mae_values) / len(mae_values), 10),
        "avg_bars_to_exit": None if not bars_to_exit else round(sum(bars_to_exit) / len(bars_to_exit), 4),
        "exit_reason_distribution": dict(sorted(exit_reasons.items())),
    }


def extract_s12_trade_ev(row: dict[str, Any]) -> tuple[float | None, str, dict[str, Any] | None]:
    payload = row.get("s12_trade_ev") if isinstance(row.get("s12_trade_ev"), dict) else None
    if payload is None:
        forecast_data = row.get("forecast_data")
        if isinstance(forecast_data, str) and forecast_data.strip():
            try:
                import json

                parsed = json.loads(forecast_data)
            except json.JSONDecodeError:
                parsed = {}
            if isinstance(parsed, dict) and isinstance(parsed.get("s12_trade_ev"), dict):
                payload = parsed["s12_trade_ev"]
        elif isinstance(forecast_data, dict) and isinstance(forecast_data.get("s12_trade_ev"), dict):
            payload = forecast_data["s12_trade_ev"]

    direct = _to_float(row.get("trade_expected_return_net_pct"))
    if direct is not None:
        return direct, str(row.get("trade_expected_return_source") or "daily_recommendation.trade_expected_return_net_pct"), payload
    if not payload:
        return None, "s12_trade_ev_missing_no_allocation_edge", None
    status = str(payload.get("status") or "").strip()
    value = _to_float(payload.get("trade_expected_return_net_pct"))
    source = str(payload.get("trade_expected_return_source") or payload.get("source") or "s12_trade_ev")
    if value is None:
        return None, f"{source}_no_trade_expected_return", payload
    if status and status != "loaded":
        return None, f"{source}_{status}", payload
    return value, source, payload
