"""Fail-closed contract for StockVision live broker execution packets."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any, Mapping
from zoneinfo import ZoneInfo


SCHEMA_VERSION = "stockvision-live-execution-packet-v1"
SHADOW_SCHEMA_VERSION = "stockvision-execution-shadow-packet-v1"
TERMINAL_LEG_STATES = {"FILLED", "CANCELLED", "REJECTED"}
NON_RETRYABLE_LEG_STATES = TERMINAL_LEG_STATES | {
    "SUBMITTING",
    "ACKNOWLEDGED",
    "PARTIALLY_FILLED",
    "UNKNOWN",
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def packet_hash(packet: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(packet).encode("utf-8")).hexdigest()


def sign_packet(packet: Mapping[str, Any], secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), canonical_json(packet).encode("utf-8"), hashlib.sha256).hexdigest()


def signature_valid(packet: Mapping[str, Any], signature: str | None, secret: str | None) -> bool:
    if not signature or not secret:
        return False
    return hmac.compare_digest(sign_packet(packet, secret), signature.strip().lower())


def parse_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _truthy(value: Any) -> bool:
    return value is True


def _positive(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _integer(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def order_legs(intent: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = intent.get("orderLegs") or intent.get("order_legs") or []
    return [dict(leg) for leg in raw if isinstance(leg, Mapping)]


def lot_type(leg: Mapping[str, Any]) -> str:
    return str(leg.get("lotType") or leg.get("lot_type") or "").strip()


def requested_shares(intent: Mapping[str, Any]) -> int:
    return int(intent.get("requestedShares") or intent.get("requested_shares") or 0)


def limit_price(intent: Mapping[str, Any]) -> float:
    side = str(intent.get("side") or "").lower()
    keys = ("minPrice", "min_price", "limitPrice", "limit_price") if side == "sell" else (
        "maxPrice",
        "max_price",
        "limitPrice",
        "limit_price",
    )
    for key in keys:
        value = _positive(intent.get(key))
        if value is not None:
            return value
    return 0.0


def _snapshot_errors(
    packet: Mapping[str, Any],
    intent: Mapping[str, Any],
    *,
    max_snapshot_age_ms: int,
) -> list[str]:
    errors: list[str] = []
    snapshots = packet.get("execution_snapshots")
    if not isinstance(snapshots, Mapping):
        return ["execution_snapshots_required"]
    side = str(intent.get("side") or "").lower()
    price = limit_price(intent)
    for leg in order_legs(intent):
        current_lot = lot_type(leg)
        snapshot = snapshots.get(current_lot)
        if not isinstance(snapshot, Mapping):
            errors.append(f"execution_snapshot_missing:{current_lot}")
            continue
        if snapshot.get("schema_version") not in {"authoritative_execution_snapshot_v1", "authoritative_execution_snapshot_v2"}:
            errors.append(f"execution_snapshot_schema_invalid:{current_lot}")
        if str(snapshot.get("lot_type") or "") != current_lot:
            errors.append(f"execution_snapshot_lot_type_mismatch:{current_lot}")
        if str(snapshot.get("status") or "").lower() != "ready":
            errors.append(f"execution_snapshot_not_ready:{current_lot}")
        age_ms = _integer(snapshot.get("age_ms"))
        if age_ms is None or age_ms > max_snapshot_age_ms:
            errors.append(f"execution_snapshot_stale:{current_lot}")
        if not str(snapshot.get("selected_source") or "").strip():
            errors.append(f"execution_snapshot_source_missing:{current_lot}")
        bid = _positive(snapshot.get("bid"))
        ask = _positive(snapshot.get("ask"))
        if bid is None or ask is None or bid > ask:
            errors.append(f"execution_snapshot_book_invalid:{current_lot}")
            continue
        if side == "buy" and ask > price:
            errors.append(f"authoritative_ask_above_limit:{current_lot}")
        if side == "sell" and bid < price:
            errors.append(f"authoritative_bid_below_limit:{current_lot}")
    return errors


def validate_execution_packet(
    packet: Mapping[str, Any],
    *,
    signature: str | None,
    env: Mapping[str, str],
    risk_config: Mapping[str, Any] | None,
    daily_side_order_count: int,
    now: datetime | None = None,
) -> list[str]:
    errors: list[str] = []
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if packet.get("schema_version") != SCHEMA_VERSION:
        errors.append("execution_packet_schema_invalid")

    secret = str(env.get("LIVE_EXECUTION_HMAC_SECRET") or "")
    if not signature_valid(packet, signature, secret):
        errors.append("execution_packet_signature_invalid")

    idempotency_key = str(packet.get("idempotency_key") or "").strip()
    if len(idempotency_key) < 16 or len(idempotency_key) > 200:
        errors.append("execution_idempotency_key_invalid")

    generated_at = parse_time(packet.get("generated_at"))
    expires_at = parse_time(packet.get("expires_at"))
    max_packet_age_seconds = max(1, int(env.get("LIVE_EXECUTION_MAX_PACKET_AGE_SECONDS") or 5))
    if generated_at is None or (now - generated_at).total_seconds() < -2 or (now - generated_at).total_seconds() > max_packet_age_seconds:
        errors.append("execution_packet_stale_or_future")
    if expires_at is None or now >= expires_at:
        errors.append("execution_packet_expired")

    approval = packet.get("approval") if isinstance(packet.get("approval"), Mapping) else {}
    approved_scope = str(env.get("LIVE_TRADING_APPROVAL_SCOPE") or "").strip()
    approval_expiry = parse_time(env.get("LIVE_TRADING_APPROVAL_EXPIRES_AT"))
    if str(approval.get("approved_by") or "").strip() != "Wei":
        errors.append("explicit_wei_approval_required")
    if not approved_scope or str(approval.get("scope") or "").strip() != approved_scope:
        errors.append("live_trading_approval_scope_mismatch")
    if approval_expiry is None or now >= approval_expiry:
        errors.append("live_trading_approval_expired")

    controls = packet.get("controls") if isinstance(packet.get("controls"), Mapping) else {}
    required_true = ("risk_checks_passed", "market_session_open", "trading_day_confirmed", "broker_truth_ready")
    for key in required_true:
        if not _truthy(controls.get(key)):
            errors.append(f"execution_control_failed:{key}")
    if controls.get("kill_switch_active") is not False:
        errors.append("kill_switch_active_or_unknown")
    if str(controls.get("market_phase") or "") != "continuous":
        errors.append("unsupported_market_phase")
    tw_now = now.astimezone(ZoneInfo("Asia/Taipei"))
    minutes = tw_now.hour * 60 + tw_now.minute
    if tw_now.weekday() >= 5 or not (9 * 60 <= minutes <= 13 * 60 + 30):
        errors.append("runtime_market_session_closed")
    if str(packet.get("trade_date") or "") != tw_now.date().isoformat():
        errors.append("execution_trade_date_mismatch")

    intent = packet.get("intent") if isinstance(packet.get("intent"), Mapping) else {}
    if not intent:
        errors.append("execution_intent_required")
        return sorted(set(errors))

    broker_truth = packet.get("broker_truth") if isinstance(packet.get("broker_truth"), Mapping) else {}
    if str(broker_truth.get("status") or "").lower() != "ready":
        errors.append("broker_truth_not_ready")
    if str(broker_truth.get("exchange") or "") not in {"TSE", "OTC"}:
        errors.append("broker_contract_exchange_invalid")
    reference = _positive(broker_truth.get("reference_price"))
    limit_up = _positive(broker_truth.get("limit_up"))
    limit_down = _positive(broker_truth.get("limit_down"))
    price = limit_price(intent)
    if reference is None or limit_up is None or limit_down is None or not (limit_down <= price <= limit_up):
        errors.append("broker_price_band_invalid")
    broker_observed_at = parse_time(broker_truth.get("observed_at"))
    max_broker_truth_age_seconds = max(1, int(env.get("LIVE_EXECUTION_MAX_BROKER_TRUTH_AGE_SECONDS") or 5))
    if broker_observed_at is None or (now - broker_observed_at).total_seconds() < -2 or (now - broker_observed_at).total_seconds() > max_broker_truth_age_seconds:
        errors.append("broker_truth_stale")

    if risk_config is None:
        errors.append("risk_config_unavailable")
    else:
        system = risk_config.get("system") if isinstance(risk_config.get("system"), Mapping) else {}
        order = risk_config.get("order") if isinstance(risk_config.get("order"), Mapping) else {}
        if system.get("killSwitch") is not False:
            errors.append("runtime_kill_switch_active_or_unknown")
        max_single_order_value = _positive(order.get("maxSingleOrderValue"))
        total_value = requested_shares(intent) * price
        if max_single_order_value is None or total_value > max_single_order_value:
            errors.append("max_single_order_value_exceeded")
        side = str(intent.get("side") or "").lower()
        daily_limit_key = "maxDailyBuyOrders" if side == "buy" else "maxDailySellOrders"
        daily_limit = _integer(order.get(daily_limit_key))
        if daily_limit is None or daily_side_order_count >= daily_limit:
            errors.append("max_daily_side_orders_reached")
        max_deviation = _positive(order.get("maxPriceDeviationPct"))
        if reference is not None and (max_deviation is None or abs(price - reference) / reference > max_deviation):
            errors.append("max_price_deviation_exceeded")

    side = str(intent.get("side") or "").lower()
    shares = requested_shares(intent)
    if side == "buy":
        cash = _positive(broker_truth.get("available_cash"))
        if cash is None or cash < shares * price * 1.005:
            errors.append("broker_cash_insufficient")
    elif side == "sell":
        position = _integer(broker_truth.get("position_shares"))
        if position is None or position < shares:
            errors.append("broker_position_insufficient")
    else:
        errors.append("execution_side_invalid")

    errors.extend(
        _snapshot_errors(
            packet,
            intent,
            max_snapshot_age_ms=max(100, int(env.get("LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS") or 500)),
        )
    )
    return sorted(set(errors))


def validate_execution_shadow_packet(
    packet: Mapping[str, Any],
    *,
    signature: str | None,
    env: Mapping[str, str],
    risk_config: Mapping[str, Any] | None,
    daily_side_order_count: int,
    now: datetime | None = None,
) -> list[str]:
    """Validate market/risk parity without requiring broker login or live approval.

    This contract intentionally cannot authorize a real order. Broker cash and
    position truth are validated separately only when the read-only broker
    shadow flag is explicitly enabled on the dedicated gateway.
    """
    errors: list[str] = []
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if packet.get("schema_version") != SHADOW_SCHEMA_VERSION:
        errors.append("execution_shadow_packet_schema_invalid")
    if not signature_valid(packet, signature, str(env.get("LIVE_EXECUTION_HMAC_SECRET") or "")):
        errors.append("execution_packet_signature_invalid")

    idempotency_key = str(packet.get("idempotency_key") or "").strip()
    if len(idempotency_key) < 16 or len(idempotency_key) > 200:
        errors.append("execution_idempotency_key_invalid")
    expected_scope = str(env.get("LIVE_EXECUTION_SHADOW_SCOPE") or "").strip()
    if not expected_scope or str(packet.get("shadow_scope") or "").strip() != expected_scope:
        errors.append("execution_shadow_scope_mismatch")

    generated_at = parse_time(packet.get("generated_at"))
    expires_at = parse_time(packet.get("expires_at"))
    max_packet_age_seconds = max(1, int(env.get("LIVE_EXECUTION_MAX_PACKET_AGE_SECONDS") or 5))
    if generated_at is None or (now - generated_at).total_seconds() < -2 or (now - generated_at).total_seconds() > max_packet_age_seconds:
        errors.append("execution_packet_stale_or_future")
    if expires_at is None or now >= expires_at:
        errors.append("execution_packet_expired")

    controls = packet.get("controls") if isinstance(packet.get("controls"), Mapping) else {}
    for key in ("risk_checks_passed", "market_session_open", "trading_day_confirmed"):
        if not _truthy(controls.get(key)):
            errors.append(f"execution_control_failed:{key}")
    if controls.get("kill_switch_active") is not False:
        errors.append("kill_switch_active_or_unknown")
    if str(controls.get("market_phase") or "") != "continuous":
        errors.append("unsupported_market_phase")
    tw_now = now.astimezone(ZoneInfo("Asia/Taipei"))
    minutes = tw_now.hour * 60 + tw_now.minute
    if tw_now.weekday() >= 5 or not (9 * 60 <= minutes <= 13 * 60 + 30):
        errors.append("runtime_market_session_closed")
    if str(packet.get("trade_date") or "") != tw_now.date().isoformat():
        errors.append("execution_trade_date_mismatch")

    intent = packet.get("intent") if isinstance(packet.get("intent"), Mapping) else {}
    if not intent:
        errors.append("execution_intent_required")
        return sorted(set(errors))
    side = str(intent.get("side") or "").lower()
    if side not in {"buy", "sell"}:
        errors.append("execution_side_invalid")
    price = limit_price(intent)
    shares = requested_shares(intent)
    reference_data = packet.get("market_reference") if isinstance(packet.get("market_reference"), Mapping) else {}
    reference = _positive(reference_data.get("reference_price"))
    limit_up = _positive(reference_data.get("limit_up"))
    limit_down = _positive(reference_data.get("limit_down"))
    if reference is None or limit_up is None or limit_down is None or not (limit_down <= price <= limit_up):
        errors.append("market_price_band_invalid")

    if risk_config is None:
        errors.append("risk_config_unavailable")
    else:
        system = risk_config.get("system") if isinstance(risk_config.get("system"), Mapping) else {}
        order = risk_config.get("order") if isinstance(risk_config.get("order"), Mapping) else {}
        if system.get("killSwitch") is not False:
            errors.append("runtime_kill_switch_active_or_unknown")
        max_value = _positive(order.get("maxSingleOrderValue"))
        if max_value is None or shares * price > max_value:
            errors.append("max_single_order_value_exceeded")
        daily_key = "maxDailyBuyOrders" if side == "buy" else "maxDailySellOrders"
        daily_limit = _integer(order.get(daily_key))
        if daily_limit is None or daily_side_order_count >= daily_limit:
            errors.append("max_daily_side_orders_reached")
        max_deviation = _positive(order.get("maxPriceDeviationPct"))
        if reference is not None and (max_deviation is None or abs(price - reference) / reference > max_deviation):
            errors.append("max_price_deviation_exceeded")

    errors.extend(
        _snapshot_errors(
            packet,
            intent,
            max_snapshot_age_ms=max(100, int(env.get("LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS") or 500)),
        )
    )
    return sorted(set(errors))


def reduce_leg_state(
    current_status: str,
    event_type: str,
    *,
    filled_shares: int = 0,
    requested: int = 0,
    callback_success: bool = True,
    broker_status: str | None = None,
) -> str:
    """Deterministic merge for callback/reconciliation events, including deal-before-order."""
    status = str(current_status or "RESERVED").upper()
    event = str(event_type or "").upper()
    broker = str(broker_status or "").replace("OrderStatus.", "").replace("Status.", "").upper()
    if status == "FILLED":
        return status
    if broker in {"CANCELLED", "CANCELED"}:
        return "CANCELLED"
    if broker in {"FAILED", "REJECTED", "INACTIVE"}:
        return "REJECTED"
    if broker in {"FILLED"}:
        return "FILLED"
    if broker in {"PARTFILLED", "PARTIALLY_FILLED", "FILLING"}:
        return "PARTIALLY_FILLED"
    if event in {"DEAL_CALLBACK", "STATUS_RECONCILIATION"} and filled_shares > 0:
        return "FILLED" if requested > 0 and filled_shares >= requested else "PARTIALLY_FILLED"
    if event == "ORDER_CALLBACK":
        if not callback_success:
            return "REJECTED"
        if status in {"PARTIALLY_FILLED", "FILLED"}:
            return status
        return "ACKNOWLEDGED"
    if event == "STATUS_RECONCILIATION" and broker in {"PENDINGSUBMIT", "PRESUBMITTED", "SUBMITTED", "NEW"}:
        return "ACKNOWLEDGED"
    if event == "SUBMIT_ACK":
        return status if status in {"PARTIALLY_FILLED", "FILLED"} else "ACKNOWLEDGED"
    if event == "SUBMIT_UNKNOWN":
        return status if status in {"ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED"} else "UNKNOWN"
    if event == "SUBMIT_REJECTED":
        return status if status in {"PARTIALLY_FILLED", "FILLED"} else "REJECTED"
    return status
