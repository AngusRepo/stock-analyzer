from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable

from services import d1_client
from services.market_segment_policy import normalize_segment
from services.s12_replay_trade_outcomes import s12_replay_outcome_to_bootstrap_row
from services.s12_trade_ev import build_s12_trade_ev_from_replay, build_s12_trade_ev_from_structure


QueryFn = Callable[[str, list[Any] | None], list[dict[str, Any]]]


def _to_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _first_number(*values: Any) -> float | None:
    for value in values:
        out = _to_float(value)
        if out is not None:
            return out
    return None


def _boolish(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return True
    if text in {"false", "0", "no", "n"}:
        return False
    return None


def _nested(obj: dict[str, Any], *path: str) -> Any:
    cur: Any = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _date_key(value: Any) -> str:
    text = str(value or "").strip()
    return text[:10] if len(text) >= 10 else ""


def _fallback_start_date(run_date: str, lookback_days: int) -> str:
    try:
        base = date.fromisoformat(str(run_date)[:10])
    except ValueError:
        base = date.today()
    return (base - timedelta(days=max(1, int(lookback_days)))).isoformat()


def _symbol_from_row(row: dict[str, Any]) -> str:
    return str(row.get("symbol") or row.get("stock_id") or "").strip()


def _is_buy_trade_signal(row: dict[str, Any]) -> bool:
    signal = str(row.get("trade_signal") or "").strip().lower()
    return signal in {"buy", "strong_buy"}


def _s12_trade_ev_payload(row: dict[str, Any]) -> dict[str, Any]:
    forecast_data = _json_obj(row.get("forecast_data"))
    payload = forecast_data.get("s12_trade_ev")
    if isinstance(payload, dict):
        return payload
    allocation = forecast_data.get("alpha_allocation")
    if isinstance(allocation, dict) and isinstance(allocation.get("s12_trade_ev"), dict):
        return allocation["s12_trade_ev"]
    return {}


def _has_verified_s12_trade_ev_provenance(row: dict[str, Any]) -> bool:
    if not _is_buy_trade_signal(row):
        return False
    payload = _s12_trade_ev_payload(row)
    if not payload:
        return False
    if str(payload.get("status") or "").strip().lower() != "loaded":
        return False
    if str(payload.get("semantic") or "").strip() != "trade_expected_return_not_5bar_close_forecast":
        return False
    if _to_float(payload.get("trade_expected_return_net_pct")) is None:
        return False
    return True


def _market_segment_from_payloads(*payloads: dict[str, Any]) -> str:
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        fd = _json_obj(payload.get("forecast_data"))
        meta = (
            payload.get("stock_meta")
            or fd.get("stock_meta")
            or _nested(fd, "alpha_context", "stock_meta")
            or {}
        )
        raw = (
            payload.get("market_segment")
            or payload.get("market")
            or (meta.get("market_segment") if isinstance(meta, dict) else None)
            or (meta.get("market") if isinstance(meta, dict) else None)
        )
        segment = normalize_segment(raw)
        if segment != "UNKNOWN":
            return segment
    return "UNKNOWN"


def _alpha_bucket_from_payloads(*payloads: dict[str, Any]) -> str:
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        fd = _json_obj(payload.get("forecast_data"))
        for source in (
            payload.get("alpha_context"),
            payload.get("alpha_allocation"),
            fd.get("alpha_context"),
            fd.get("alpha_allocation"),
        ):
            if not isinstance(source, dict):
                continue
            value = str(source.get("edge_bucket") or source.get("bucket") or "").strip()
            if value:
                return value
    return "UNKNOWN"


def _entry_stop_from_row(row: dict[str, Any], prediction: dict[str, Any] | None) -> tuple[float | None, float | None]:
    pred = prediction if isinstance(prediction, dict) else {}
    entry = _first_number(
        row.get("entry_price"),
        row.get("current_price"),
        pred.get("entry_price"),
        pred.get("current_price"),
    )
    stop = _first_number(
        row.get("s12_structure_stop"),
        pred.get("s12_structure_stop"),
        _nested(pred, "s12_defense", "stop_loss"),
        _nested(pred, "s12_exit", "structure_stop"),
        _nested(pred, "s12_exit", "trailingStop", "initial"),
        _nested(pred, "s12_exit", "trailing_stop", "initial"),
        _nested(pred, "s12_structure", "exitPlan", "trailingStop", "initial"),
        _nested(pred, "s12Structure", "exitPlan", "trailingStop", "initial"),
        row.get("stop_loss"),
        pred.get("stop_loss"),
    )
    return entry, stop


def _payload_dicts(row: dict[str, Any], prediction: dict[str, Any] | None) -> list[dict[str, Any]]:
    pred = prediction if isinstance(prediction, dict) else {}
    payloads: list[dict[str, Any]] = []
    for root in (row, pred):
        if not isinstance(root, dict):
            continue
        payloads.append(root)
        fd = _json_obj(root.get("forecast_data"))
        if fd:
            payloads.append(fd)
        for key in ("alpha_context", "alpha_allocation", "ensemble_v2"):
            direct = root.get(key)
            if isinstance(direct, dict):
                payloads.append(direct)
            nested = fd.get(key) if fd else None
            if isinstance(nested, dict):
                payloads.append(nested)
    return payloads


def _number_from_paths(payloads: list[dict[str, Any]], paths: list[tuple[str, ...]]) -> tuple[float | None, str | None]:
    for payload in payloads:
        for path in paths:
            value = _nested(payload, *path) if len(path) > 1 else payload.get(path[0])
            number = _first_number(value)
            if number is None and isinstance(value, dict):
                number = _first_number(value.get("price"), value.get("value"))
            if number is not None:
                return number, ".".join(path)
    return None, None


def _string_from_paths(payloads: list[dict[str, Any]], paths: list[tuple[str, ...]]) -> str | None:
    for payload in payloads:
        for path in paths:
            value = _nested(payload, *path) if len(path) > 1 else payload.get(path[0])
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _parse_detail_pairs(detail: Any) -> dict[str, str]:
    text = str(detail or "").strip()
    if not text:
        return {}
    out: dict[str, str] = {}
    for part in text.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key:
            out[key] = value
    return out


def _value_from_paths(payloads: list[dict[str, Any]], paths: list[tuple[str, ...]]) -> Any:
    for payload in payloads:
        for path in paths:
            value = _nested(payload, *path) if len(path) > 1 else payload.get(path[0])
            if value is not None:
                return value
    return None


def _s12_entry_context_from_row(row: dict[str, Any], prediction: dict[str, Any] | None) -> dict[str, Any]:
    payloads = _payload_dicts(row, prediction)
    detail: str | None = None
    for payload in payloads:
        for path in (
            ("s12_detail",),
            ("s12", "detail"),
            ("s12_structure", "detail"),
            ("s12Structure", "detail"),
            ("canonical_trade_lifecycle", "entry", "s12", "detail"),
            ("canonicalTradeLifecycle", "entry", "s12", "detail"),
            ("canonical_trade_lifecycle", "entry", "s12Assessment", "detail"),
        ):
            value = _nested(payload, *path) if len(path) > 1 else payload.get(path[0])
            if isinstance(value, str) and value.strip():
                detail = value.strip()
                break
        if detail:
            break
    parsed = _parse_detail_pairs(detail)

    context = {
        "schema_version": "s12-equity-mutation-context-v1",
        "source": "worker_s12_intraday_structure_detail",
        "state": (
            _string_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "state"),
                ("canonicalTradeLifecycle", "entry", "s12", "state"),
                ("s12", "state"),
                ("s12_structure", "state"),
                ("s12Structure", "state"),
                ("s12_state",),
            ])
            or parsed.get("state")
        ),
        "ready": (
            _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "ready"),
                ("canonicalTradeLifecycle", "entry", "s12", "ready"),
                ("s12", "ready"),
                ("s12_structure", "ready"),
                ("s12Structure", "ready"),
                ("s12_ready",),
            ])
            if _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "ready"),
                ("canonicalTradeLifecycle", "entry", "s12", "ready"),
                ("s12", "ready"),
                ("s12_structure", "ready"),
                ("s12Structure", "ready"),
                ("s12_ready",),
            ]) is not None
            else parsed.get("ready")
        ),
        "entry_archetype": (
            _string_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "entryArchetype"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "entryArchetype"),
                ("s12_entry_context", "entry_archetype"),
                ("s12_entry_context", "entryArchetype"),
                ("s12_context", "entry_archetype"),
                ("s12_context", "entryArchetype"),
                ("entry_archetype",),
            ])
            or parsed.get("entry_archetype")
        ),
        "vwap_fast_acceptance": (
            _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "vwapFastAcceptance"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "vwapFastAcceptance"),
                ("s12_entry_context", "vwap_fast_acceptance"),
                ("s12_entry_context", "vwapFastAcceptance"),
                ("s12_context", "vwap_fast_acceptance"),
                ("s12_context", "vwapFastAcceptance"),
                ("vwap_fast_acceptance",),
            ])
            if _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "vwapFastAcceptance"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "vwapFastAcceptance"),
                ("s12_entry_context", "vwap_fast_acceptance"),
                ("s12_entry_context", "vwapFastAcceptance"),
                ("s12_context", "vwap_fast_acceptance"),
                ("s12_context", "vwapFastAcceptance"),
                ("vwap_fast_acceptance",),
            ]) is not None
            else parsed.get("vwap_fast_acceptance")
        ),
        "vwap_fast_reasons": (
            _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "vwapFastReasons"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "vwapFastReasons"),
                ("s12_entry_context", "vwap_fast_reasons"),
                ("s12_entry_context", "vwapFastReasons"),
                ("s12_context", "vwap_fast_reasons"),
                ("s12_context", "vwapFastReasons"),
                ("vwap_fast_reasons",),
            ])
            or parsed.get("vwap_fast_reasons")
        ),
        "vwap_slow_context": (
            _string_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "vwapSlowContext"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "vwapSlowContext"),
                ("s12_entry_context", "vwap_slow_context"),
                ("s12_entry_context", "vwapSlowContext"),
                ("s12_context", "vwap_slow_context"),
                ("s12_context", "vwapSlowContext"),
                ("vwap_slow_context",),
            ])
            or parsed.get("vwap_slow_context")
        ),
        "equity_mutation_risk_haircuts": (
            _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "equityMutationRiskHaircuts"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "equityMutationRiskHaircuts"),
                ("s12_entry_context", "equity_mutation_risk_haircuts"),
                ("s12_entry_context", "equityMutationRiskHaircuts"),
                ("s12_context", "equity_mutation_risk_haircuts"),
                ("s12_context", "equityMutationRiskHaircuts"),
                ("equity_mutation_risk_haircuts",),
            ])
            or parsed.get("equity_mutation_risk_haircuts")
        ),
        "htf_hard_block": (
            _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "htfHardBlock"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "htfHardBlock"),
                ("s12_entry_context", "htf_hard_block"),
                ("s12_entry_context", "htfHardBlock"),
                ("s12_context", "htf_hard_block"),
                ("s12_context", "htfHardBlock"),
                ("htf_hard_block",),
            ])
            if _value_from_paths(payloads, [
                ("canonical_trade_lifecycle", "entry", "s12", "entryContext", "htfHardBlock"),
                ("canonicalTradeLifecycle", "entry", "s12", "entryContext", "htfHardBlock"),
                ("s12_entry_context", "htf_hard_block"),
                ("s12_entry_context", "htfHardBlock"),
                ("s12_context", "htf_hard_block"),
                ("s12_context", "htfHardBlock"),
                ("htf_hard_block",),
            ]) is not None
            else parsed.get("htf_hard_block")
        ),
        "detail_available": bool(detail),
    }
    return {key: value for key, value in context.items() if value not in (None, "")}


def _s12_context_not_ready_reason(context: dict[str, Any]) -> str | None:
    ready = _boolish(context.get("ready"))
    state = str(context.get("state") or "").strip().lower()
    if ready is False:
        return "s12_ready_false"
    if state and state != "reaction_ready":
        return f"s12_state_{state}"
    return None


def _mark_setup_only_ev(ev: dict[str, Any], *, reason: str, context: dict[str, Any]) -> dict[str, Any]:
    out = dict(ev)
    if out.get("status") == "loaded":
        out["status"] = "setup_only"
        out["trade_expected_return_source"] = "s12_structural_setup_cold_start_ev"
        out["sample_policy"] = "s12_structural_setup_cold_start_no_replay"
    out["execution_ready"] = False
    out["execution_gate_required"] = "s12_reaction_ready"
    out["execution_blocked_reason"] = reason
    out["candidate_s12_entry_context"] = context
    out["s12_entry_context"] = context
    return out


def _first_above(entry: float | None, *values: Any) -> float | None:
    if entry is None:
        return None
    for value in values:
        number = _to_float(value)
        if number is not None and number > entry:
            return number
    return None


def _s12_reward_confidence_multiplier(evidence: dict[str, Any]) -> float:
    target1_source = str(evidence.get("target1_source") or "")
    target2_source = str(evidence.get("target2_source") or "")
    target1_fallback = "r_multiple_fallback" in target1_source
    target2_fallback = "r_multiple_fallback" in target2_source
    if target1_fallback and target2_fallback:
        return 0.65
    if target2_fallback:
        return 0.8
    return 1.0


def _targets_from_row(
    row: dict[str, Any],
    prediction: dict[str, Any] | None,
) -> tuple[float | None, float | None]:
    entry, stop = _entry_stop_from_row(row, prediction)
    target1, target2, _ = _s12_structural_targets_from_row(row, prediction, entry_price=entry, stop_price=stop)
    return target1, target2


def _s12_structural_targets_from_row(
    row: dict[str, Any],
    prediction: dict[str, Any] | None,
    *,
    entry_price: float | None,
    stop_price: float | None,
) -> tuple[float | None, float | None, dict[str, Any]]:
    payloads = _payload_dicts(row, prediction)
    target1, target1_path = _number_from_paths(
        payloads,
        [
            ("s12_exit", "tp1", "price"),
            ("s12Exit", "tp1", "price"),
            ("s12_exit", "exitPlan", "tp1", "price"),
            ("s12_structure", "exitPlan", "tp1", "price"),
            ("s12Structure", "exitPlan", "tp1", "price"),
            ("s12", "exitPlan", "tp1", "price"),
            ("canonical_trade_lifecycle", "entry", "s12", "exitPlan", "tp1"),
            ("canonicalTradeLifecycle", "entry", "s12", "exitPlan", "tp1"),
            ("exitPlan", "tp1", "price"),
            ("s12_target1",),
            ("s12Target1",),
            ("structural_tp1",),
            ("s12_trade_plan", "target1"),
            ("s12TradePlan", "target1"),
        ],
    )
    target2, target2_path = _number_from_paths(
        payloads,
        [
            ("s12_exit", "mainExit", "price"),
            ("s12Exit", "mainExit", "price"),
            ("s12_exit", "exitPlan", "mainExit", "price"),
            ("s12_structure", "exitPlan", "mainExit", "price"),
            ("s12Structure", "exitPlan", "mainExit", "price"),
            ("s12", "exitPlan", "mainExit", "price"),
            ("canonical_trade_lifecycle", "entry", "s12", "exitPlan", "mainExit"),
            ("canonicalTradeLifecycle", "entry", "s12", "exitPlan", "mainExit"),
            ("exitPlan", "mainExit", "price"),
            ("s12_target2",),
            ("s12Target2",),
            ("structural_main_exit",),
            ("s12_trade_plan", "target2"),
            ("s12TradePlan", "target2"),
        ],
    )
    supply_low, supply_low_path = _number_from_paths(
        payloads,
        [
            ("s12_exit", "mainExit", "zoneLow"),
            ("s12Exit", "mainExit", "zoneLow"),
            ("s12_structure", "exitPlan", "mainExit", "zoneLow"),
            ("s12Structure", "exitPlan", "mainExit", "zoneLow"),
            ("s12", "exitPlan", "mainExit", "zoneLow"),
            ("canonical_trade_lifecycle", "entry", "s12", "supplyZoneLow"),
            ("canonicalTradeLifecycle", "entry", "s12", "supplyZoneLow"),
            ("supplyZone1h", "low"),
            ("supply_zone_1h", "low"),
            ("supply_zone_low",),
        ],
    )
    supply_high, supply_high_path = _number_from_paths(
        payloads,
        [
            ("s12_exit", "mainExit", "zoneHigh"),
            ("s12Exit", "mainExit", "zoneHigh"),
            ("s12_structure", "exitPlan", "mainExit", "zoneHigh"),
            ("s12Structure", "exitPlan", "mainExit", "zoneHigh"),
            ("s12", "exitPlan", "mainExit", "zoneHigh"),
            ("canonical_trade_lifecycle", "entry", "s12", "supplyZoneHigh"),
            ("canonicalTradeLifecycle", "entry", "s12", "supplyZoneHigh"),
            ("supplyZone1h", "high"),
            ("supply_zone_1h", "high"),
            ("supply_zone_high",),
        ],
    )
    prior_high, prior_high_path = _number_from_paths(
        payloads,
        [
            ("s12_exit", "tp1", "priorHigh"),
            ("s12Exit", "tp1", "priorHigh"),
            ("priorHigh15m",),
            ("prior_high_15m",),
            ("nearest_prior_high_15m",),
        ],
    )
    target1_declared_source = _string_from_paths(
        payloads,
        [
            ("s12_exit", "tp1", "source"),
            ("s12Exit", "tp1", "source"),
            ("s12_exit", "exitPlan", "tp1", "source"),
            ("s12_structure", "exitPlan", "tp1", "source"),
            ("s12Structure", "exitPlan", "tp1", "source"),
            ("s12", "exitPlan", "tp1", "source"),
            ("canonical_trade_lifecycle", "entry", "s12", "exitPlan", "tp1Source"),
            ("canonicalTradeLifecycle", "entry", "s12", "exitPlan", "tp1Source"),
            ("exitPlan", "tp1", "source"),
        ],
    )
    target2_declared_source = _string_from_paths(
        payloads,
        [
            ("s12_exit", "mainExit", "source"),
            ("s12Exit", "mainExit", "source"),
            ("s12_exit", "exitPlan", "mainExit", "source"),
            ("s12_structure", "exitPlan", "mainExit", "source"),
            ("s12Structure", "exitPlan", "mainExit", "source"),
            ("s12", "exitPlan", "mainExit", "source"),
            ("canonical_trade_lifecycle", "entry", "s12", "exitPlan", "mainExitSource"),
            ("canonicalTradeLifecycle", "entry", "s12", "exitPlan", "mainExitSource"),
            ("exitPlan", "mainExit", "source"),
        ],
    )

    entry = _to_float(entry_price)
    stop = _to_float(stop_price)
    risk = entry - stop if entry is not None and stop is not None and stop < entry else None

    structural_tp1 = _first_above(entry, target1, prior_high)
    target1_source = (
        f"{target1_path}.source={target1_declared_source}"
        if target1_path and target1_declared_source
        else target1_path
    )
    if structural_tp1 is None and risk is not None:
        structural_tp1 = entry + risk
        target1_source = "s12_structure_exit_plan.r_multiple_fallback_1r"
    elif structural_tp1 == prior_high and target1_path is None:
        target1_source = prior_high_path or "15m_previous_high"

    structural_main_exit = _first_above(entry, target2, supply_low, supply_high)
    target2_source = (
        f"{target2_path}.source={target2_declared_source}"
        if target2_path and target2_declared_source
        else target2_path
    )
    if structural_main_exit is None and risk is not None:
        structural_main_exit = entry + (risk * 2.0)
        target2_source = "s12_structure_exit_plan.r_multiple_fallback_2r"
    elif structural_main_exit == supply_low and target2_path is None:
        target2_source = supply_low_path or "1h_supply_zone.low"
    elif structural_main_exit == supply_high and target2_path is None:
        target2_source = supply_high_path or "1h_supply_zone.high"

    pred = prediction if isinstance(prediction, dict) else {}
    legacy_target1 = _first_number(row.get("target1"), pred.get("target1"))
    legacy_target2 = _first_number(row.get("target2"), pred.get("target2"))
    evidence = {
        "schema_version": "s12-structural-targets-v1",
        "mode": "structure_first_trailing_v1",
        "contract_ref": "worker/src/lib/s12IntradayStructure.ts::buildS12StructureExitPlan",
        "target1_source": target1_source or "unavailable",
        "target2_source": target2_source or "unavailable",
        "target1_policy": "15m_previous_high_or_vwap_fair_value_else_1r_fallback",
        "target2_policy": "1h_supply_zone_or_vwap_fair_value_else_2r_fallback",
        "target1_declared_source": target1_declared_source,
        "target2_declared_source": target2_declared_source,
        "supply_zone_low": supply_low,
        "supply_zone_high": supply_high,
        "legacy_target1_ignored": legacy_target1 is not None and (
            structural_tp1 is not None and round(float(legacy_target1), 6) != round(float(structural_tp1), 6)
        ),
        "legacy_target2_ignored": legacy_target2 is not None and (
            structural_main_exit is not None and round(float(legacy_target2), 6) != round(float(structural_main_exit), 6)
        ),
    }
    evidence["reward_confidence_multiplier"] = _s12_reward_confidence_multiplier(evidence)
    return structural_tp1, structural_main_exit, evidence


def _score_component(row: dict[str, Any], *path: str) -> float | None:
    cur: Any = row.get("score_components")
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return _to_float(cur)


def _score_v2_final_score(row: dict[str, Any]) -> float | None:
    score = _to_float(row.get("score"))
    if score is not None:
        return score
    payload = row.get("score_components")
    if isinstance(payload, dict):
        return (
            _to_float(payload.get("finalScore"))
            or _to_float(payload.get("final_score"))
            or _to_float(payload.get("total"))
        )
    return None


def load_s12_replay_trade_rows(
    *,
    run_date: str,
    lookback_days: int = 180,
    limit: int = 5000,
    query_fn: QueryFn | None = None,
) -> list[dict[str, Any]]:
    """Load historical verified S12-style trade outcomes strictly before run_date."""

    safe_limit = max(1, min(int(limit or 5000), 20000))
    start_date = _fallback_start_date(run_date, lookback_days)
    query = query_fn or d1_client.query
    dedicated_rows = _load_dedicated_s12_replay_trade_rows(
        run_date=run_date,
        start_date=start_date,
        limit=safe_limit,
        query_fn=query,
    )
    rows = query(
        """
        SELECT p.stock_id,
               s.symbol,
               s.market,
               p.prediction_date,
               p.trade_signal,
               p.trade_outcome,
               p.trade_pnl_pct,
               p.trade_pnl_r,
               p.max_favorable_pct,
               p.max_adverse_pct,
               p.entry_price,
               p.stop_loss,
               p.forecast_data
          FROM predictions p
          LEFT JOIN stocks s ON s.id = p.stock_id
         WHERE p.model_name = 'ensemble'
           AND p.prediction_date IS NOT NULL
           AND date(p.prediction_date) < date(?)
           AND date(p.prediction_date) >= date(?)
           AND lower(COALESCE(p.trade_signal, '')) IN ('buy', 'strong_buy')
           AND p.forecast_data LIKE '%"s12_trade_ev"%'
           AND (p.trade_pnl_pct IS NOT NULL OR p.trade_pnl_r IS NOT NULL)
         ORDER BY date(p.prediction_date) DESC, p.id DESC
         LIMIT ?
        """.strip(),
        [run_date, start_date, safe_limit],
    )
    prediction_rows = [
        dict(row)
        for row in rows or []
        if _has_verified_s12_trade_ev_provenance(dict(row))
    ]
    return dedicated_rows + prediction_rows


def _load_dedicated_s12_replay_trade_rows(
    *,
    run_date: str,
    start_date: str,
    limit: int,
    query_fn: QueryFn,
) -> list[dict[str, Any]]:
    """Load replay-generated S12 outcomes when the dedicated evidence table exists."""

    try:
        rows = query_fn(
            """
            SELECT symbol,
                   market,
                   trade_date,
                   assessment_state,
                   setup_id,
                   entry_price,
                   stop_price,
                   target1_price,
                   target2_price,
                   target3_price,
                   exit_price,
                   pnl_pct,
                   trade_pnl_r,
                   max_favorable_pct,
                   max_adverse_pct,
                   bars_to_exit,
                   exit_reason,
                   sample_eligible,
                   source,
                   detail_json
              FROM s12_replay_trade_outcomes
             WHERE trade_date IS NOT NULL
               AND date(trade_date) < date(?)
               AND date(trade_date) >= date(?)
               AND COALESCE(sample_eligible, 0) = 1
               AND pnl_pct IS NOT NULL
             ORDER BY date(trade_date) DESC, symbol
             LIMIT ?
            """.strip(),
            [run_date, start_date, limit],
        )
    except Exception:
        return []

    out: list[dict[str, Any]] = []
    for row in rows or []:
        raw = dict(row)
        detail = _json_obj(raw.get("detail_json"))
        outcome = {
            "schema_version": "s12-replay-trade-outcome-v1",
            "symbol": raw.get("symbol"),
            "market": raw.get("market"),
            "trade_date": raw.get("trade_date"),
            "status": "executed",
            "sample_eligible": True,
            "source": raw.get("source") or "s12_intraday_structure_replay_v1",
            "assessment_state": raw.get("assessment_state"),
            "setup_id": raw.get("setup_id"),
            "entry_price": raw.get("entry_price"),
            "stop_price": raw.get("stop_price"),
            "target1_price": raw.get("target1_price"),
            "target2_price": raw.get("target2_price"),
            "target3_price": raw.get("target3_price"),
            "exit_price": raw.get("exit_price"),
            "pnl_pct": raw.get("pnl_pct"),
            "trade_pnl_r": raw.get("trade_pnl_r"),
            "mfe_pct": raw.get("max_favorable_pct"),
            "mae_pct": raw.get("max_adverse_pct"),
            "bars_to_exit": raw.get("bars_to_exit"),
            "exit_reason": raw.get("exit_reason"),
            "conservative_intrabar_order": detail.get("conservative_intrabar_order") or "stop_before_target",
        }
        converted = s12_replay_outcome_to_bootstrap_row(outcome)
        if converted is not None:
            out.append(converted)
    return out


@dataclass(frozen=True)
class _ReplayBucket:
    scope: str
    key: str
    rows: list[dict[str, Any]]


class S12TradeEvBootstrapProvider:
    """Build per-candidate S12 trade EV from historical trade outcomes.

    This is intentionally a producer for allocator expected edge, not a forecast
    calibration fallback. It only uses rows dated before the requested run_date.
    """

    def __init__(
        self,
        rows: list[dict[str, Any]],
        *,
        run_date: str,
        min_samples: int = 30,
        roundtrip_cost_bps: float = 18.0,
    ) -> None:
        self.run_date = str(run_date)[:10]
        self.min_samples = max(1, int(min_samples or 30))
        self.roundtrip_cost_bps = max(0.0, float(roundtrip_cost_bps or 0.0))
        raw_rows = [dict(row) for row in rows or [] if _date_key(row.get("prediction_date")) < self.run_date]
        self.input_rows = len(raw_rows)
        self.rows = [row for row in raw_rows if _has_verified_s12_trade_ev_provenance(row)]
        self.excluded_non_s12_rows = self.input_rows - len(self.rows)
        self.by_symbol: dict[str, list[dict[str, Any]]] = {}
        self.by_market_bucket: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self.by_market: dict[str, list[dict[str, Any]]] = {}
        self._index_rows()

    @classmethod
    def for_run_date(
        cls,
        run_date: str,
        *,
        query_fn: QueryFn | None = None,
        lookback_days: int | None = None,
        limit: int | None = None,
        min_samples: int | None = None,
        roundtrip_cost_bps: float | None = None,
    ) -> "S12TradeEvBootstrapProvider":
        rows = load_s12_replay_trade_rows(
            run_date=run_date,
            lookback_days=int(lookback_days or os.getenv("S12_TRADE_EV_BOOTSTRAP_LOOKBACK_DAYS", "180")),
            limit=int(limit or os.getenv("S12_TRADE_EV_BOOTSTRAP_LIMIT", "5000")),
            query_fn=query_fn,
        )
        return cls(
            rows,
            run_date=run_date,
            min_samples=int(min_samples or os.getenv("S12_TRADE_EV_BOOTSTRAP_MIN_SAMPLES", "30")),
            roundtrip_cost_bps=float(roundtrip_cost_bps or os.getenv("S12_TRADE_EV_ROUNDTRIP_COST_BPS", "18")),
        )

    def _index_rows(self) -> None:
        for row in self.rows:
            symbol = _symbol_from_row(row)
            fd = _json_obj(row.get("forecast_data"))
            segment = _market_segment_from_payloads(row, fd)
            bucket = _alpha_bucket_from_payloads(row, fd)
            if symbol:
                self.by_symbol.setdefault(symbol, []).append(row)
            if segment != "UNKNOWN" and bucket != "UNKNOWN":
                self.by_market_bucket.setdefault((segment, bucket), []).append(row)
            if segment != "UNKNOWN":
                self.by_market.setdefault(segment, []).append(row)

    def _candidate_buckets(
        self,
        row: dict[str, Any],
        prediction: dict[str, Any] | None,
    ) -> list[_ReplayBucket]:
        pred = prediction if isinstance(prediction, dict) else {}
        symbol = _symbol_from_row(row) or _symbol_from_row(pred)
        segment = _market_segment_from_payloads(row, pred)
        bucket = _alpha_bucket_from_payloads(row, pred)
        buckets: list[_ReplayBucket] = []
        if symbol:
            buckets.append(_ReplayBucket("symbol", symbol, self.by_symbol.get(symbol) or []))
        if segment != "UNKNOWN" and bucket != "UNKNOWN":
            buckets.append(_ReplayBucket("market_segment_alpha_bucket", f"{segment}:{bucket}", self.by_market_bucket.get((segment, bucket)) or []))
        if segment != "UNKNOWN":
            buckets.append(_ReplayBucket("market_segment", segment, self.by_market.get(segment) or []))
        buckets.append(_ReplayBucket("global", "ALL", self.rows))
        return buckets

    def _select_bucket(
        self,
        row: dict[str, Any],
        prediction: dict[str, Any] | None,
    ) -> _ReplayBucket:
        buckets = self._candidate_buckets(row, prediction)
        for bucket in buckets:
            if len(bucket.rows) >= self.min_samples:
                return bucket
        return max(buckets, key=lambda bucket: len(bucket.rows))

    def build_for_row(
        self,
        row: dict[str, Any],
        *,
        prediction: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        pred = prediction if isinstance(prediction, dict) else {}
        bucket = self._select_bucket(row, prediction)
        entry, stop = _entry_stop_from_row(row, prediction)
        target1, target2, target_evidence = _s12_structural_targets_from_row(
            row,
            prediction,
            entry_price=entry,
            stop_price=stop,
        )
        symbol = _symbol_from_row(row) or _symbol_from_row(prediction or {})
        source = f"s12_replay_trade_outcomes:{bucket.scope}"
        samples = [
            {
                "return_pct": item.get("trade_pnl_pct"),
                "trade_pnl_r": item.get("trade_pnl_r"),
                "mfe_pct": item.get("max_favorable_pct"),
                "mae_pct": item.get("max_adverse_pct"),
                "exit_reason": item.get("trade_outcome") or "unknown",
            }
            for item in bucket.rows
        ]
        ev = build_s12_trade_ev_from_replay(
            symbol=symbol or None,
            entry_price=entry,
            stop_price=stop,
            samples=samples,
            min_samples=self.min_samples,
            roundtrip_cost_bps=self.roundtrip_cost_bps,
            source=source,
        )
        dates = sorted({_date_key(item.get("prediction_date")) for item in bucket.rows if _date_key(item.get("prediction_date"))})
        replay_meta = {
            "bootstrap_scope": bucket.scope,
            "bootstrap_key": bucket.key,
            "bootstrap_run_date": self.run_date,
            "as_of_guard": "prediction_date_strictly_before_run_date",
            "sample_policy": "verified_s12_buy_trade_outcomes_only",
            "sample_date_min": dates[0] if dates else None,
            "sample_date_max": dates[-1] if dates else None,
            "candidate_market_segment": _market_segment_from_payloads(row, prediction or {}),
            "candidate_alpha_bucket": _alpha_bucket_from_payloads(row, prediction or {}),
        }
        ev.update(replay_meta)
        s12_entry_context = _s12_entry_context_from_row(row, prediction)
        not_ready_reason = _s12_context_not_ready_reason(s12_entry_context) if s12_entry_context else None
        if s12_entry_context:
            ev["candidate_s12_entry_context"] = s12_entry_context
        if ev.get("status") == "loaded" and not not_ready_reason:
            return ev

        ev2 = pred.get("ensemble_v2") if isinstance(pred.get("ensemble_v2"), dict) else {}
        alpha_ctx = row.get("alpha_context") if isinstance(row.get("alpha_context"), dict) else {}
        cold = build_s12_trade_ev_from_structure(
            symbol=symbol or None,
            entry_price=entry,
            stop_price=stop,
            target1_price=target1,
            target2_price=target2,
            avg_rank=ev2.get("avg_rank"),
            confidence=row.get("confidence") or ev2.get("confidence"),
            ml_edge_score=row.get("ml_score") or _score_component(row, "components", "mlEdge"),
            technical_score=row.get("tech_score") or _score_component(row, "components", "technicalStructure"),
            chip_score=row.get("chip_score") or _score_component(row, "components", "chipFlow"),
            fundamental_score=_score_component(row, "components", "fundamentalQuality"),
            score_v2_final_score=_score_v2_final_score(row),
            market_heat_expected_return=(
                row.get("market_heat_expected_return")
                or alpha_ctx.get("market_heat_expected_return")
            ),
            reward_confidence_multiplier=target_evidence.get("reward_confidence_multiplier"),
            s12_context=s12_entry_context,
            regime=(
                row.get("regime")
                or row.get("alpha_regime")
                or alpha_ctx.get("regime")
                or alpha_ctx.get("alpha_regime")
            ),
            roundtrip_cost_bps=self.roundtrip_cost_bps,
        )
        cold.update({
            "bootstrap_run_date": self.run_date,
            "as_of_guard": "run_date_current_structure_no_future_outcomes",
            "s12_structural_targets": target_evidence,
            "candidate_s12_entry_context": s12_entry_context,
            "candidate_market_segment": _market_segment_from_payloads(row, prediction or {}),
            "candidate_alpha_bucket": _alpha_bucket_from_payloads(row, prediction or {}),
            "replay_bootstrap": {
                **replay_meta,
                "status": ev.get("status"),
                "source": ev.get("source"),
                "sampleCount": ev.get("sampleCount"),
                "trade_expected_return_source": ev.get("trade_expected_return_source"),
            },
        })
        if not_ready_reason:
            cold = _mark_setup_only_ev(cold, reason=not_ready_reason, context=s12_entry_context)
        return cold

    def summary(self) -> dict[str, Any]:
        return {
            "schema_version": "s12-trade-ev-bootstrap-summary-v1",
            "run_date": self.run_date,
            "sample_rows": len(self.rows),
            "input_rows": self.input_rows,
            "excluded_non_s12_rows": self.excluded_non_s12_rows,
            "min_samples": self.min_samples,
            "sample_policy": "verified_s12_buy_trade_outcomes_only",
            "symbol_buckets": len(self.by_symbol),
            "market_segment_buckets": len(self.by_market),
            "market_segment_alpha_buckets": len(self.by_market_bucket),
        }
