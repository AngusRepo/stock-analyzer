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


def _r_from_sample(sample: dict[str, Any]) -> float | None:
    return _to_float(
        sample.get("trade_pnl_r")
        or sample.get("pnl_r")
        or sample.get("return_r")
        or sample.get("realized_pnl_r")
    )


def _date_key(value: Any) -> str:
    text = str(value or "").strip()
    return text[:10] if len(text) >= 10 else ""


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _normalized(value: Any, denominator: float = 25.0) -> float | None:
    number = _to_float(value)
    if number is None:
        return None
    return _clamp(number / denominator, 0.0, 1.0)


def _score_tilt(value: Any, denominator: float, scale: float) -> float:
    normalized = _normalized(value, denominator)
    if normalized is None:
        return 0.0
    return (normalized - 0.5) * scale


def _boolish(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return True
    if text in {"false", "0", "no", "n"}:
        return False
    return None


def _listish(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value or "").strip()
    if not text:
        return []
    return [part.strip() for part in text.replace(",", "|").split("|") if part.strip()]


def _s12_context_multiplier(context: dict[str, Any] | None) -> tuple[float, list[str], dict[str, Any]]:
    if not isinstance(context, dict):
        return 1.0, [], {}

    multiplier = 1.0
    reasons: list[str] = []
    hard_block = _boolish(context.get("htf_hard_block"))
    fast_acceptance = _boolish(context.get("vwap_fast_acceptance"))
    slow_context = str(context.get("vwap_slow_context") or "").strip().lower()
    haircuts = _listish(context.get("equity_mutation_risk_haircuts") or context.get("risk_haircuts"))

    for item in haircuts:
        normalized = item.lower()
        if "1h_short" in normalized:
            multiplier *= 0.90
            reasons.append("1h_short_risk_haircut")
        elif "4h_short" in normalized:
            multiplier *= 0.85
            reasons.append("4h_short_risk_haircut")
        elif "slow_vwap_overhead" in normalized:
            multiplier *= 0.90
            reasons.append("slow_vwap_overhead_supply_haircut")

    if fast_acceptance is False:
        multiplier *= 0.85
        reasons.append("missing_fast_vwap_acceptance")
    if slow_context == "overhead_supply":
        multiplier *= 0.90
        if "slow_vwap_overhead_supply_haircut" not in reasons:
            reasons.append("slow_vwap_overhead_supply_haircut")
    elif slow_context == "mixed":
        multiplier *= 0.95
        reasons.append("mixed_slow_vwap_context")

    multiplier = _clamp(multiplier, 0.50, 1.0)
    evidence = {
        "schema_version": "s12-equity-mutation-context-v1",
        "vwap_fast_acceptance": fast_acceptance,
        "vwap_fast_reasons": _listish(context.get("vwap_fast_reasons")),
        "vwap_slow_context": slow_context or None,
        "equity_mutation_risk_haircuts": haircuts,
        "htf_hard_block": hard_block,
        "entry_archetype": context.get("entry_archetype"),
        "multiplier": round(multiplier, 6),
        "reasons": reasons,
        "policy": "worker_s12_entry_context_is_ev_haircut_source",
    }
    return multiplier, reasons, evidence


def build_s12_trade_ev_from_structure(
    *,
    symbol: str | None = None,
    entry_price: float | None = None,
    stop_price: float | None = None,
    target1_price: float | None = None,
    target2_price: float | None = None,
    avg_rank: float | None = None,
    confidence: float | None = None,
    ml_edge_score: float | None = None,
    technical_score: float | None = None,
    chip_score: float | None = None,
    fundamental_score: float | None = None,
    score_v2_final_score: float | None = None,
    market_heat_expected_return: float | None = None,
    reward_confidence_multiplier: float | None = None,
    s12_context: dict[str, Any] | None = None,
    regime: str | None = None,
    roundtrip_cost_bps: float = 18.0,
    source: str = "s12_structural_cold_start_ev",
) -> dict[str, Any]:
    """Build conservative cold-start EV from current S12 structure.

    This is used before verified S12 trade outcomes have enough samples. It is
    not a replay fallback and not a 5-bar close forecast: it prices the current
    S12 risk/reward plan, shrinks the estimated edge, and caps positive EV.
    """

    entry = _to_float(entry_price)
    stop = _to_float(stop_price)
    target1 = _to_float(target1_price)
    target2 = _to_float(target2_price)
    cost = max(0.0, float(roundtrip_cost_bps or 0.0)) / 10000.0
    context_multiplier, context_haircut_reasons, context_evidence = _s12_context_multiplier(s12_context)

    if context_evidence.get("htf_hard_block") is True:
        return {
            "schema_version": "s12-trade-ev-v1",
            "symbol": symbol,
            "status": "invalid_structure",
            "source": source,
            "semantic": "trade_expected_return_not_5bar_close_forecast",
            "trade_expected_return_net_pct": None,
            "trade_expected_return_source": f"{source}_htf_hard_block",
            "sampleCount": 0,
            "minSamples": 0,
            "sample_policy": "s12_structural_cold_start_no_replay",
            "s12_entry_context": context_evidence,
        }

    if entry is None or entry <= 0:
        return {
            "schema_version": "s12-trade-ev-v1",
            "symbol": symbol,
            "status": "missing_structure",
            "source": source,
            "semantic": "trade_expected_return_not_5bar_close_forecast",
            "trade_expected_return_net_pct": None,
            "trade_expected_return_source": f"{source}_missing_entry",
            "sampleCount": 0,
            "minSamples": 0,
            "sample_policy": "s12_structural_cold_start_no_replay",
        }
    if stop is None or stop <= 0 or stop >= entry:
        return {
            "schema_version": "s12-trade-ev-v1",
            "symbol": symbol,
            "status": "missing_structure",
            "source": source,
            "semantic": "trade_expected_return_not_5bar_close_forecast",
            "entry_price": entry,
            "stop_price": stop,
            "trade_expected_return_net_pct": None,
            "trade_expected_return_source": f"{source}_missing_long_structure_stop",
            "sampleCount": 0,
            "minSamples": 0,
            "sample_policy": "s12_structural_cold_start_no_replay",
        }

    risk_pct = (entry - stop) / entry
    if risk_pct <= 0 or risk_pct > 0.18:
        return {
            "schema_version": "s12-trade-ev-v1",
            "symbol": symbol,
            "status": "invalid_structure",
            "source": source,
            "semantic": "trade_expected_return_not_5bar_close_forecast",
            "entry_price": entry,
            "stop_price": stop,
            "risk_pct": round(risk_pct, 10),
            "trade_expected_return_net_pct": None,
            "trade_expected_return_source": f"{source}_invalid_risk_pct",
            "sampleCount": 0,
            "minSamples": 0,
            "sample_policy": "s12_structural_cold_start_no_replay",
        }

    valid_targets = [target for target in (target1, target2) if target is not None and target > entry]
    if not valid_targets:
        return {
            "schema_version": "s12-trade-ev-v1",
            "symbol": symbol,
            "status": "missing_structure",
            "source": source,
            "semantic": "trade_expected_return_not_5bar_close_forecast",
            "entry_price": entry,
            "stop_price": stop,
            "risk_pct": round(risk_pct, 10),
            "trade_expected_return_net_pct": None,
            "trade_expected_return_source": f"{source}_missing_structure_target",
            "sampleCount": 0,
            "minSamples": 0,
            "sample_policy": "s12_structural_cold_start_no_replay",
        }

    target1_gain = (valid_targets[0] - entry) / entry
    target2_gain = (valid_targets[-1] - entry) / entry
    blended_reward_pct = (0.65 * target1_gain) + (0.35 * target2_gain)
    base_reward_confidence = _clamp(_to_float(reward_confidence_multiplier) or 1.0, 0.25, 1.0)
    reward_confidence = _clamp(base_reward_confidence * context_multiplier, 0.25, 1.0)
    confidence_adjusted_reward_pct = blended_reward_pct * reward_confidence
    reward_r = confidence_adjusted_reward_pct / risk_pct if risk_pct > 0 else None
    raw_reward_r = blended_reward_pct / risk_pct if risk_pct > 0 else None

    rank = _to_float(avg_rank)
    if rank is None:
        rank = _to_float(confidence)
    rank = _clamp(rank if rank is not None else 0.5, 0.0, 1.0)
    p_win = 0.5 + ((rank - 0.5) * 0.18)
    p_win += _score_tilt(score_v2_final_score, 100.0, 0.16)
    p_win += _score_tilt(ml_edge_score, 30.0, 0.06)
    p_win += _score_tilt(technical_score, 25.0, 0.04)
    p_win += _score_tilt(chip_score, 40.0, 0.03)
    p_win += _score_tilt(fundamental_score, 25.0, 0.02)
    heat = _to_float(market_heat_expected_return)
    if heat is not None:
        p_win += _clamp(heat, -0.01, 0.01) * 1.5
    regime_text = str(regime or "").strip().lower()
    if "bull" in regime_text:
        p_win += 0.015
    elif "bear" in regime_text:
        p_win -= 0.035
    elif "volatile" in regime_text:
        p_win -= 0.015

    # Cold-start must not pretend to be a calibrated win-rate model.
    p_win = _clamp(p_win, 0.43, 0.58)
    gross = (p_win * confidence_adjusted_reward_pct) - ((1.0 - p_win) * risk_pct)
    raw_net = gross - cost
    shrink = 0.55
    positive_cap = min(0.012, max(0.003, risk_pct * 0.45))
    net = raw_net * shrink if raw_net > 0 else raw_net
    if net > 0:
        net = min(net, positive_cap)
    expected_r = net / risk_pct if risk_pct > 0 else None

    return {
        "schema_version": "s12-trade-ev-v1",
        "symbol": symbol,
        "status": "loaded",
        "source": source,
        "semantic": "trade_expected_return_not_5bar_close_forecast",
        "sampleCount": 0,
        "minSamples": 0,
        "sample_policy": "s12_structural_cold_start_no_replay",
        "entry_price": round(entry, 6),
        "stop_price": round(stop, 6),
        "target1_price": round(valid_targets[0], 6),
        "target2_price": round(valid_targets[-1], 6),
        "risk_pct": round(risk_pct, 10),
        "roundtrip_cost_bps": round(cost * 10000.0, 4),
        "trade_expected_return_gross_pct": round(gross, 10),
        "trade_expected_return_net_pct": round(net, 10),
        "trade_expected_return_source": source,
        "expected_R": None if expected_r is None else round(expected_r, 6),
        "win_rate": round(p_win, 6),
        "payoff_ratio": None if reward_r is None else round(reward_r, 6),
        "raw_structural_payoff_ratio": None if raw_reward_r is None else round(raw_reward_r, 6),
        "reward_confidence_multiplier": round(reward_confidence, 6),
        "base_reward_confidence_multiplier": round(base_reward_confidence, 6),
        "profit_factor": None,
        "cold_start": True,
        "s12_entry_context": context_evidence,
        "cold_start_policy": {
            "formula": "shrunk_structural_R_multiple_ev",
            "win_rate_bounds": [0.43, 0.58],
            "positive_ev_shrink": shrink,
            "positive_ev_cap": round(positive_cap, 10),
            "reward_confidence_multiplier": round(reward_confidence, 6),
            "s12_context_multiplier": round(context_multiplier, 6),
            "s12_context_haircuts": context_haircut_reasons,
            "inputs": {
                "avg_rank": round(rank, 6),
                "ml_edge_score": ml_edge_score,
                "technical_score": technical_score,
                "chip_score": chip_score,
                "fundamental_score": fundamental_score,
                "score_v2_final_score": score_v2_final_score,
                "market_heat_expected_return": heat,
                "regime": regime,
                "s12_entry_context": context_evidence,
            },
        },
        "exit_reason_distribution": {},
    }


def build_s12_trade_ev_from_replay(
    *,
    symbol: str | None = None,
    entry_price: float | None = None,
    stop_price: float | None = None,
    samples: list[dict[str, Any]] | None = None,
    min_samples: int = 30,
    min_sample_dates: int = 8,
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
    sample_dates: set[str] = set()
    invalid_samples = 0

    for sample in samples or []:
        if not isinstance(sample, dict):
            invalid_samples += 1
            continue
        sample_date = _date_key(
            sample.get("sample_date")
            or sample.get("prediction_date")
            or sample.get("trade_date")
            or sample.get("date")
        )
        if sample_date:
            sample_dates.add(sample_date)
        direct_r = _r_from_sample(sample)
        ret = _pct_from_exit(entry, sample)
        if ret is None and direct_r is not None and risk_pct and risk_pct > 0:
            ret = direct_r * risk_pct
        if ret is None:
            invalid_samples += 1
            continue
        returns.append(ret)
        if direct_r is not None:
            r_values.append(direct_r)
        elif risk_pct and risk_pct > 0:
            r_values.append(ret / risk_pct)
        mfe = _to_float(
            sample.get("mfe_pct")
            or sample.get("max_favorable_excursion_pct")
            or sample.get("max_favorable_pct")
        )
        mae = _to_float(
            sample.get("mae_pct")
            or sample.get("max_adverse_excursion_pct")
            or sample.get("max_adverse_pct")
        )
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

    min_sample_count = max(1, int(min_samples))
    min_date_count = max(1, int(min_sample_dates or 1))
    sample_date_count = len(sample_dates)
    status = "loaded" if sample_count >= min_sample_count and sample_date_count >= min_date_count else "insufficient_samples"
    if sample_count < min_sample_count:
        source_suffix = "insufficient_samples"
    elif sample_date_count < min_date_count:
        source_suffix = "insufficient_sample_dates"
    else:
        source_suffix = ""
    return {
        "schema_version": "s12-trade-ev-v1",
        "symbol": symbol,
        "status": status,
        "source": source,
        "semantic": "trade_expected_return_not_5bar_close_forecast",
        "sampleCount": sample_count,
        "minSamples": min_sample_count,
        "sampleDateCount": sample_date_count,
        "minSampleDates": min_date_count,
        "invalidSampleCount": invalid_samples,
        "entry_price": entry,
        "stop_price": stop,
        "risk_pct": None if risk_pct is None else round(risk_pct, 10),
        "roundtrip_cost_bps": round(cost * 10000.0, 4),
        "trade_expected_return_gross_pct": None if gross is None else round(gross, 10),
        "trade_expected_return_net_pct": None if net is None else round(net, 10),
        "trade_expected_return_source": source if status == "loaded" else f"{source}_{source_suffix}",
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
    if status == "setup_only":
        return None, source if source.endswith("_setup_only") else f"{source}_setup_only", payload
    if status and status not in {"loaded", "setup_only"}:
        suffix = f"_{status}"
        return None, source if source.endswith(suffix) else f"{source}{suffix}", payload
    if value is None:
        return None, f"{source}_no_trade_expected_return", payload
    return value, source, payload
