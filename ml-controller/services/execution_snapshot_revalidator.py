"""Last-moment authoritative Market Data Hub revalidation before broker submit."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

try:
    import httpx
except ModuleNotFoundError:  # pragma: no cover
    httpx = None

from services.broker_execution_contract import limit_price, order_legs


PostFn = Callable[..., Any]


def revalidate_authoritative_snapshots(
    packet: Mapping[str, Any],
    *,
    env: Mapping[str, str] | None = None,
    post_fn: PostFn | None = None,
) -> dict[str, Any]:
    values = env or os.environ
    base_url = str(values.get("SHIOAJI_PROXY_URL") or "").strip().rstrip("/")
    token = str(values.get("PROXY_SERVICE_TOKEN") or "").strip()
    if not base_url or not token:
        return {"errors": ["authoritative_hub_config_unavailable"], "observations": {}}
    if post_fn is None:
        if httpx is None:
            return {"errors": ["authoritative_hub_http_client_unavailable"], "observations": {}}
        post_fn = httpx.post

    intent = packet.get("intent") if isinstance(packet.get("intent"), Mapping) else {}
    symbol = str(intent.get("symbol") or "").strip()
    side = str(intent.get("side") or "").lower()
    price = limit_price(intent)
    max_age_ms = max(100, int(values.get("LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS") or 500))
    timeout = max(0.1, float(values.get("LIVE_EXECUTION_HUB_TIMEOUT_SECONDS") or 0.75))
    lot_types = []
    for leg in order_legs(intent):
        current = str(leg.get("lotType") or leg.get("lot_type") or "")
        if current and current not in lot_types:
            lot_types.append(current)

    errors: list[str] = []
    observations: dict[str, Any] = {}
    packet_snapshots = packet.get("execution_snapshots") if isinstance(packet.get("execution_snapshots"), Mapping) else {}
    for current_lot in lot_types:
        try:
            response = post_fn(
                f"{base_url}/orderbooks",
                headers={"Authorization": f"Bearer {token}"},
                json={"symbols": [symbol], "lot_type": current_lot},
                timeout=timeout,
            )
            status_code = int(getattr(response, "status_code", 0) or 0)
            if status_code != 200:
                errors.append(f"authoritative_hub_http_{status_code}:{current_lot}")
                continue
            payload = response.json()
        except Exception as exc:
            errors.append(f"authoritative_hub_request_failed:{current_lot}:{exc.__class__.__name__}")
            continue
        data = payload.get("data") if isinstance(payload, Mapping) else {}
        observation = data.get(symbol) if isinstance(data, Mapping) else None
        if not isinstance(observation, Mapping):
            errors.append(f"authoritative_hub_book_missing:{current_lot}")
            continue
        age_ms = observation.get("quote_age_ms")
        try:
            age_ms = int(age_ms)
        except (TypeError, ValueError):
            age_ms = None
        bid_prices = observation.get("bid_prices") or []
        ask_prices = observation.get("ask_prices") or []
        bid = float(bid_prices[0]) if bid_prices else 0.0
        ask = float(ask_prices[0]) if ask_prices else 0.0
        normalized = {
            "lot_type": current_lot,
            "bid": bid,
            "ask": ask,
            "age_ms": age_ms,
            "source_time": observation.get("source_time"),
            "received_at": observation.get("received_at"),
            "session_epoch": observation.get("session_epoch"),
            "bid_prices": bid_prices[:5],
            "ask_prices": ask_prices[:5],
            "bid_volumes": (observation.get("bid_volumes") or [])[:5],
            "ask_volumes": (observation.get("ask_volumes") or [])[:5],
        }
        observations[current_lot] = normalized
        if age_ms is None or age_ms > max_age_ms:
            errors.append(f"authoritative_hub_book_stale:{current_lot}")
        source_time = str(observation.get("source_time") or "").strip()
        try:
            parsed_time = datetime.fromisoformat(source_time.replace("Z", "+00:00"))
            if parsed_time.tzinfo is None:
                parsed_time = parsed_time.replace(tzinfo=timezone.utc)
            if abs((datetime.now(timezone.utc) - parsed_time).total_seconds() * 1000) > max_age_ms + 1000:
                errors.append(f"authoritative_hub_source_time_stale:{current_lot}")
        except (TypeError, ValueError):
            errors.append(f"authoritative_hub_source_time_invalid:{current_lot}")
        try:
            current_epoch = int(observation.get("session_epoch"))
            if current_epoch <= 0:
                raise ValueError
        except (TypeError, ValueError):
            current_epoch = None
            errors.append(f"authoritative_hub_session_epoch_invalid:{current_lot}")
        packet_snapshot = packet_snapshots.get(current_lot) if isinstance(packet_snapshots, Mapping) else None
        packet_epoch = packet_snapshot.get("session_epoch") if isinstance(packet_snapshot, Mapping) else None
        if packet_epoch is not None and current_epoch is not None and int(packet_epoch) != current_epoch:
            errors.append(f"authoritative_hub_session_epoch_changed:{current_lot}")
        if bid <= 0 or ask <= 0 or bid > ask:
            errors.append(f"authoritative_hub_book_invalid:{current_lot}")
        elif side == "buy" and ask > price:
            errors.append(f"authoritative_hub_ask_above_limit:{current_lot}")
        elif side == "sell" and bid < price:
            errors.append(f"authoritative_hub_bid_below_limit:{current_lot}")
    return {"errors": sorted(set(errors)), "observations": observations}
