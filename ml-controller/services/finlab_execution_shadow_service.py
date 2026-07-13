"""Non-mutating paper-to-live execution parity validation."""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Callable, Mapping

from services.broker_execution_contract import limit_price, validate_execution_shadow_packet
from services.broker_execution_repository import BrokerExecutionRepository, D1BrokerExecutionRepository
from services.execution_snapshot_revalidator import revalidate_authoritative_snapshots
from services.finlab_execution_gateway import PersistentFinlabExecutionGateway
from services.finlab_execution_preview_service import validate_stockvision_execution_intent


SCHEMA_VERSION = "finlab-execution-shadow-result-v1"


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "enabled", "on"}


def _result(packet: Mapping[str, Any] | None, status: str, reasons: list[str], **extra: Any) -> dict[str, Any]:
    intent = packet.get("intent") if isinstance(packet, Mapping) and isinstance(packet.get("intent"), Mapping) else {}
    return {
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "reason": reasons[0] if reasons else "execution_shadow_validated",
        "blocked_reasons": sorted(set(reasons)),
        "symbol": str(intent.get("symbol") or ""),
        "side": str(intent.get("side") or ""),
        "can_submit_real_order": False,
        "live_submit_enabled": False,
        "ledger_mutation": False,
        **extra,
    }


def _default_risk_loader() -> Mapping[str, Any] | None:
    from services.kv_client import get_json

    value = get_json("trading:risk_config", default=None, timeout=3.0)
    return value if isinstance(value, Mapping) else None


def run_finlab_execution_shadow(
    *,
    packet: Mapping[str, Any] | None,
    signature: str | None,
    env: Mapping[str, str] | None = None,
    repository: BrokerExecutionRepository | None = None,
    gateway: PersistentFinlabExecutionGateway | None = None,
    risk_loader: Callable[[], Mapping[str, Any] | None] | None = None,
    snapshot_revalidator: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    values = env or os.environ
    if not _truthy(values.get("LIVE_EXECUTION_SHADOW_ENABLED")):
        return _result(packet, "blocked", ["execution_shadow_disabled"])
    if str(values.get("EXECUTION_GATEWAY_SERVICE_ROLE") or "") != "dedicated_execution_gateway":
        return _result(packet, "blocked", ["dedicated_execution_gateway_service_required"])
    if packet is None:
        return _result(None, "blocked", ["signed_execution_shadow_packet_required"])

    intent = packet.get("intent") if isinstance(packet.get("intent"), Mapping) else {}
    intent_error = validate_stockvision_execution_intent(dict(intent))
    if intent_error:
        return _result(packet, "blocked", [intent_error])
    repo = repository or D1BrokerExecutionRepository()
    try:
        trade_date = str(packet.get("trade_date") or intent.get("tradeDate") or "")
        side = str(intent.get("side") or "").lower()
        daily_count = repo.daily_side_order_count(trade_date, side)
        risk_config = (risk_loader or _default_risk_loader)()
    except Exception as exc:
        return _result(packet, "blocked", [f"execution_control_plane_unavailable:{exc.__class__.__name__}"])

    errors = validate_execution_shadow_packet(
        packet,
        signature=signature,
        env=values,
        risk_config=risk_config,
        daily_side_order_count=daily_count,
        now=now,
    )
    if errors:
        return _result(packet, "blocked", errors, broker_login_used=False)
    try:
        hub = snapshot_revalidator(packet) if snapshot_revalidator else revalidate_authoritative_snapshots(packet, env=values)
    except Exception as exc:
        return _result(packet, "blocked", [f"authoritative_hub_revalidation_failed:{exc.__class__.__name__}"], broker_login_used=False)
    hub_errors = list(hub.get("errors") or [])
    if hub_errors:
        return _result(packet, "blocked", hub_errors, broker_login_used=False, hub_observations=hub.get("observations") or {})

    if not _truthy(values.get("LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED")):
        return _result(
            packet,
            "partial",
            ["broker_truth_shadow_disabled"],
            broker_login_used=False,
            market_risk_snapshot_passed=True,
            hub_observations=hub.get("observations") or {},
        )
    if gateway is None:
        return _result(packet, "blocked", ["persistent_execution_gateway_instance_required"], broker_login_used=False)
    try:
        broker = gateway.revalidate_broker_truth(symbol=str(intent.get("symbol") or ""))
        broker_errors: list[str] = []
        if broker.get("account_match") is not True:
            broker_errors.append("broker_account_mismatch")
        shares = int(intent.get("requestedShares") or 0)
        price = limit_price(intent)
        if side == "buy" and float(broker.get("available_cash") or 0) < shares * price * 1.005:
            broker_errors.append("broker_cash_insufficient_at_shadow")
        if side == "sell" and int(broker.get("position_shares") or 0) < shares:
            broker_errors.append("broker_position_insufficient_at_shadow")
        if broker_errors:
            return _result(packet, "blocked", broker_errors, broker_login_used=True, market_risk_snapshot_passed=True)
    except Exception as exc:
        return _result(packet, "blocked", [f"broker_truth_shadow_failed:{exc.__class__.__name__}"], broker_login_used=True)
    return _result(
        packet,
        "pass",
        [],
        broker_login_used=True,
        market_risk_snapshot_passed=True,
        broker_truth_passed=True,
    )
