"""Fail-closed StockVision execution packet -> persistent Shioaji gateway."""

from __future__ import annotations

import os
import threading
import traceback
from datetime import datetime
from typing import Any, Callable, Mapping

from services.broker_execution_contract import (
    NON_RETRYABLE_LEG_STATES,
    limit_price,
    order_legs,
    validate_execution_packet,
)
from services.broker_execution_repository import BrokerExecutionRepository, D1BrokerExecutionRepository
from services.finlab_execution_gateway import PersistentFinlabExecutionGateway
from services.execution_snapshot_revalidator import revalidate_authoritative_snapshots
from services.finlab_execution_preview_service import validate_stockvision_execution_intent
from services.finlab_sinopac_l5_market_data import l5_market_data_env_status


SCHEMA_VERSION = "finlab-live-submit-service-v2"
SENSITIVE_ENV_KEYS = [
    "SHIOAJI_API_KEY",
    "SHIOAJI_SECRET_KEY",
    "SHIOAJI_API_SECRET",
    "SHIOAJI_CERT_PERSON_ID",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_ACCOUNT_ID",
    "LIVE_EXECUTION_HMAC_SECRET",
]
_SUBMIT_LOCK = threading.RLock()


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "enabled", "on"}


def _sanitize(text: str, env: Mapping[str, str]) -> str:
    sanitized = text
    for key in SENSITIVE_ENV_KEYS:
        value = env.get(key)
        if value and len(value) >= 3:
            sanitized = sanitized.replace(value, "***")
    return sanitized


def _blocked(
    packet: Mapping[str, Any] | None,
    reasons: str | list[str],
    *,
    env_status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    blocked_reasons = [reasons] if isinstance(reasons, str) else sorted(set(reasons))
    intent = packet.get("intent") if isinstance(packet, Mapping) and isinstance(packet.get("intent"), Mapping) else {}
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "blocked",
        "reason": blocked_reasons[0] if blocked_reasons else "live_submit_blocked",
        "blocked_reasons": blocked_reasons,
        "symbol": str(intent.get("symbol") or ""),
        "side": str(intent.get("side") or ""),
        "intent_id": None,
        "submitted_orders": [],
        "can_submit_real_order": False,
        "live_submit_enabled": False,
        "env_status": env_status,
    }


def _default_risk_loader() -> Mapping[str, Any] | None:
    from services.kv_client import get_json

    value = get_json("trading:risk_config", default=None, timeout=3.0)
    return value if isinstance(value, Mapping) else None


def _leg_map(intent: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for index, leg in enumerate(order_legs(intent)):
        current_lot = str(leg.get("lotType") or leg.get("lot_type") or "")
        result[f"{index}:{current_lot}"] = leg
    return result


def run_finlab_live_submit(
    *,
    packet: Mapping[str, Any] | None = None,
    signature: str | None = None,
    allow_live_submit: bool = False,
    env: Mapping[str, str] | None = None,
    repository: BrokerExecutionRepository | None = None,
    gateway: PersistentFinlabExecutionGateway | None = None,
    risk_loader: Callable[[], Mapping[str, Any] | None] | None = None,
    snapshot_revalidator: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    now: datetime | None = None,
    # Legacy input is retained only to return an explicit fail-closed reason.
    intent: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    values = env or os.environ
    if packet is None:
        return _blocked(None, "signed_execution_packet_required")
    if intent is not None:
        return _blocked(packet, "legacy_live_submit_intent_not_allowed")

    live_submit_enabled = _truthy(values.get("FINLAB_LIVE_SUBMIT_ENABLED"))
    env_status = l5_market_data_env_status(values)
    if not live_submit_enabled:
        return _blocked(packet, "finlab_live_submit_disabled", env_status=env_status)
    if not allow_live_submit:
        return _blocked(packet, "allow_live_submit_required", env_status=env_status)
    if not env_status.get("ready"):
        return _blocked(packet, "broker_env_not_ready", env_status=env_status)
    if str(values.get("EXECUTION_GATEWAY_SERVICE_ROLE") or "") != "dedicated_execution_gateway":
        return _blocked(packet, "dedicated_execution_gateway_service_required", env_status=env_status)
    if gateway is None:
        return _blocked(packet, "persistent_execution_gateway_instance_required", env_status=env_status)

    packet_intent = packet.get("intent") if isinstance(packet.get("intent"), Mapping) else {}
    intent_error = validate_stockvision_execution_intent(dict(packet_intent))
    if intent_error:
        return _blocked(packet, intent_error, env_status=env_status)

    repo = repository or D1BrokerExecutionRepository()
    try:
        existing = repo.find_intent(str(packet.get("idempotency_key") or ""))
        trade_date = str(packet.get("trade_date") or packet_intent.get("tradeDate") or "")
        side = str(packet_intent.get("side") or "").lower()
        daily_count = repo.daily_side_order_count(trade_date, side)
        if existing is not None:
            daily_count = max(0, daily_count - 1)
        execution_control = repo.execution_control_state()
        risk_config = (risk_loader or _default_risk_loader)()
    except Exception as exc:
        return _blocked(packet, f"execution_control_plane_unavailable:{exc.__class__.__name__}", env_status=env_status)
    if not execution_control or int(execution_control.get("kill_switch_active", 1)) != 0:
        return _blocked(packet, "execution_d1_kill_switch_active_or_unknown", env_status=env_status)

    packet_errors = validate_execution_packet(
        packet,
        signature=signature,
        env=values,
        risk_config=risk_config,
        daily_side_order_count=daily_count,
        now=now,
    )
    if packet_errors:
        return _blocked(packet, packet_errors, env_status=env_status)

    execution_gateway = gateway
    symbol = str(packet_intent.get("symbol") or "")
    side = str(packet_intent.get("side") or "").lower()
    price = limit_price(packet_intent)
    broker_truth = packet.get("broker_truth") if isinstance(packet.get("broker_truth"), Mapping) else {}
    exchange = str(broker_truth.get("exchange") or "")
    submitted: list[dict[str, Any]] = []

    try:
        hub_revalidation = (
            snapshot_revalidator(packet)
            if snapshot_revalidator is not None
            else revalidate_authoritative_snapshots(packet, env=values)
        )
        hub_errors = list(hub_revalidation.get("errors") or [])
        if hub_errors:
            return _blocked(packet, hub_errors, env_status=env_status)
        actual_broker_truth = execution_gateway.revalidate_broker_truth(symbol=symbol)
        broker_errors: list[str] = []
        if actual_broker_truth.get("account_match") is not True:
            broker_errors.append("broker_account_mismatch")
        if side == "buy" and float(actual_broker_truth.get("available_cash") or 0) < int(packet_intent.get("requestedShares") or 0) * price * 1.005:
            broker_errors.append("broker_cash_insufficient_at_submit")
        if side == "sell" and int(actual_broker_truth.get("position_shares") or 0) < int(packet_intent.get("requestedShares") or 0):
            broker_errors.append("broker_position_insufficient_at_submit")
        if broker_errors:
            return _blocked(packet, broker_errors, env_status=env_status)
    except Exception as exc:
        return _blocked(packet, f"pre_submit_revalidation_failed:{exc.__class__.__name__}", env_status=env_status)

    with _SUBMIT_LOCK:
        try:
            latest_existing = repo.find_intent(str(packet.get("idempotency_key") or ""))
            latest_daily_count = repo.daily_side_order_count(trade_date, side)
            if latest_existing is not None:
                latest_daily_count = max(0, latest_daily_count - 1)
            latest_control = repo.execution_control_state()
            latest_risk_config = (risk_loader or _default_risk_loader)()
            if not latest_control or int(latest_control.get("kill_switch_active", 1)) != 0:
                return _blocked(packet, "execution_d1_kill_switch_active_or_unknown", env_status=env_status)
            latest_packet_errors = validate_execution_packet(
                packet,
                signature=signature,
                env=values,
                risk_config=latest_risk_config,
                daily_side_order_count=latest_daily_count,
                now=now,
            )
            if latest_packet_errors:
                return _blocked(packet, latest_packet_errors, env_status=env_status)
            reservation = repo.reserve_intent(
                packet,
                risk_decision={
                    "schema_version": "stockvision-execution-risk-decision-v1",
                    "risk_config": latest_risk_config,
                    "broker_truth": actual_broker_truth,
                    "execution_snapshots": packet.get("execution_snapshots") or {},
                    "hub_observations": hub_revalidation.get("observations") or {},
                },
            )
        except Exception as exc:
            return _blocked(packet, f"execution_reservation_failed:{exc.__class__.__name__}", env_status=env_status)
        if reservation.get("status") == "conflict":
            return _blocked(packet, "execution_idempotency_conflict", env_status=env_status)

        intent_id = str(reservation.get("intent_id") or "")
        source_legs = _leg_map(packet_intent)
        existing_legs = repo.list_legs(intent_id)
        if existing_legs and all(str(leg.get("status") or "") in NON_RETRYABLE_LEG_STATES for leg in existing_legs):
            return {
                "schema_version": SCHEMA_VERSION,
                "status": "idempotent_replay",
                "reason": "existing_broker_lifecycle_returned_without_resubmit",
                "symbol": symbol,
                "side": side,
                "intent_id": intent_id,
                "submitted_orders": [],
                "legs": existing_legs,
                "can_submit_real_order": True,
                "live_submit_enabled": True,
                "env_status": env_status,
            }

        for stored_leg in repo.list_legs(intent_id):
            leg_key = str(stored_leg.get("leg_key") or "")
            current_status = str(stored_leg.get("status") or "")
            if current_status in NON_RETRYABLE_LEG_STATES:
                continue
            claimed = repo.claim_leg(intent_id, leg_key)
            if claimed is None:
                continue
            leg = source_legs.get(leg_key)
            if leg is None:
                repo.mark_submit_rejected(str(claimed.get("leg_id") or ""), "execution_leg_payload_missing", {"intent_id": intent_id})
                break
            quantity = int(leg.get("finlabQuantity") or leg.get("finlab_quantity") or 0)
            odd_lot = bool(leg.get("oddLot") if "oddLot" in leg else leg.get("odd_lot"))
            try:
                order_id = execution_gateway.submit_leg(
                    symbol=symbol,
                    side=side,
                    quantity=quantity,
                    price=price,
                    odd_lot=odd_lot,
                    exchange=exchange,
                    client_tag=str(claimed.get("client_tag") or ""),
                )
                ack = repo.mark_submit_ack(
                    str(claimed.get("leg_id") or ""),
                    order_id,
                    {
                        "intent_id": intent_id,
                        "leg_id": claimed.get("leg_id"),
                        "leg_key": leg_key,
                        "lot_type": claimed.get("lot_type"),
                    },
                )
                submitted.append(
                    {
                        "leg_id": claimed.get("leg_id"),
                        "lot_type": claimed.get("lot_type"),
                        "shares": claimed.get("requested_shares"),
                        "broker_quantity": quantity,
                        "odd_lot": odd_lot,
                        "broker_order_id": order_id,
                        "status": ack.get("status"),
                    }
                )
            except Exception as exc:
                error = _sanitize(f"{exc.__class__.__name__}:{exc}", values)
                unknown_persistence_error: str | None = None
                try:
                    repo.mark_submit_unknown(
                        str(claimed.get("leg_id") or ""),
                        error,
                        {"intent_id": intent_id, "leg_key": leg_key},
                    )
                except Exception as persistence_exc:
                    unknown_persistence_error = persistence_exc.__class__.__name__
                try:
                    lifecycle_legs = repo.list_legs(intent_id)
                except Exception:
                    lifecycle_legs = []
                return {
                    "schema_version": SCHEMA_VERSION,
                    "status": "unknown",
                    "reason": (
                        "broker_submit_and_ledger_outcome_unknown_reconciliation_required"
                        if unknown_persistence_error
                        else "broker_submit_outcome_unknown_reconciliation_required"
                    ),
                    "symbol": symbol,
                    "side": side,
                    "intent_id": intent_id,
                    "submitted_orders": submitted,
                    "legs": lifecycle_legs,
                    "can_submit_real_order": True,
                    "live_submit_enabled": True,
                    "env_status": env_status,
                    "error_type": exc.__class__.__name__,
                    "error": error,
                    "ledger_error_type": unknown_persistence_error,
                    "trace_tail": _sanitize(traceback.format_exc(limit=2), values),
                }

        final_legs = repo.list_legs(intent_id)
        reserved_legs = [leg for leg in final_legs if str(leg.get("status") or "") == "RESERVED"]
        if reserved_legs:
            return {
                "schema_version": SCHEMA_VERSION,
                "status": "partial" if submitted else "blocked",
                "reason": "execution_leg_claim_incomplete_no_automatic_resubmit",
                "symbol": symbol,
                "side": side,
                "intent_id": intent_id,
                "submitted_orders": submitted,
                "legs": final_legs,
                "can_submit_real_order": False,
                "live_submit_enabled": bool(submitted),
                "env_status": env_status,
            }

        return {
            "schema_version": SCHEMA_VERSION,
            "status": "submitted",
            "reason": "broker_orders_acknowledged",
            "symbol": symbol,
            "side": side,
            "price": price,
            "intent_id": intent_id,
            "submitted_orders": submitted,
            "legs": final_legs,
            "can_submit_real_order": True,
            "live_submit_enabled": True,
            "env_status": env_status,
            "gateway_health": execution_gateway.health(),
        }
