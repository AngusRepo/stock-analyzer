"""10-second FinLab production-simulated execution loop primitives.

The real loop mode triggers StockVision Worker intraday execution, which writes
paper orders only. This module never submits broker orders.
"""

from __future__ import annotations

import asyncio
import math
import time
from typing import Any, Awaitable, Callable


SCHEMA_VERSION = "finlab-production-simulated-loop-v1"

AsyncSleep = Callable[[float], Awaitable[None]]
WorkerTrigger = Callable[[int], Awaitable[dict[str, Any]]]


def build_execution_loop_plan(
    *,
    duration_seconds: int,
    poll_seconds: int = 10,
    rolling_bar_seconds: int = 30,
    max_symbols: int = 5,
) -> dict[str, Any]:
    safe_poll = max(10, int(poll_seconds or 10))
    safe_duration = max(0, int(duration_seconds or 0))
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "real_loop_simulated_order",
        "poll_seconds": safe_poll,
        "rolling_bar_seconds": max(30, int(rolling_bar_seconds or 30)),
        "duration_seconds": safe_duration,
        "max_cycles": max(1, math.ceil(safe_duration / safe_poll)) if safe_duration else 1,
        "max_symbols": max(1, int(max_symbols or 5)),
        "paper_order_mode": "worker_intraday_check",
        "live_submit_enabled": False,
    }


def _event(event_type: str, symbol: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "event_type": event_type,
        "symbol": symbol,
        "status": str(payload.get("status") or "unknown"),
        "reason": str(payload.get("visible_reason") or payload.get("reason") or payload.get("status") or "unknown"),
        "detail": payload,
        "live_submit_enabled": False,
    }


def run_production_simulated_loop_once(
    *,
    pending_provider: Callable[[], list[dict[str, Any]]],
    l5_provider: Callable[[list[str]], dict[str, dict[str, Any]]],
    preview_provider: Callable[[dict[str, Any]], dict[str, Any]],
    event_sink: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    pending = pending_provider()
    symbols = [str(item.get("symbol") or item.get("intent", {}).get("symbol") or "") for item in pending]
    symbols = [symbol for symbol in symbols if symbol]
    l5_quotes = l5_provider(symbols) if symbols else {}
    processed = 0
    for item in pending:
        intent = item.get("intent") if isinstance(item.get("intent"), dict) else item
        symbol = str(intent.get("symbol") or item.get("symbol") or "")
        if not symbol:
            continue
        l5 = l5_quotes.get(symbol) or {"status": "missing", "reason": "l5_market_data_missing"}
        event_sink(_event("finlab_l5_market_data", symbol, l5))
        preview = preview_provider(intent)
        event_sink(_event("finlab_execution_preview", symbol, preview))
        reconciliation = {
            "status": "matched" if str(preview.get("status")) == "pass" else "blocked_by_preview",
            "intent": intent,
            "l5": l5,
            "finlab_preview": preview,
            "can_submit_real_order": False,
        }
        event_sink(_event("paper_broker_reconciliation", symbol, reconciliation))
        processed += 1
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "completed",
        "symbols": symbols,
        "processed": processed,
        "live_submit_enabled": False,
    }


def _blocked(reason: str, plan: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "blocked",
        "reason": reason,
        "plan": plan,
        "paper_order_mode": "worker_intraday_check",
        "live_submit_enabled": False,
        "can_submit_real_order": False,
    }


def _worker_trigger_ok(result: dict[str, Any]) -> bool:
    if result.get("ok") is False or result.get("success") is False:
        return False
    body = result.get("body")
    if isinstance(body, dict) and body.get("success") is False:
        return False
    return bool(result.get("ok", result.get("success", False)))


async def _trigger_worker_intraday_check(
    *,
    worker_url: str,
    worker_auth_token: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    import httpx

    url = f"{worker_url.rstrip('/')}/api/internal/execution/intraday-check"
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.post(
            url,
            headers={"Authorization": f"Bearer {worker_auth_token}"},
        )
    try:
        body: Any = response.json()
    except ValueError:
        body = response.text[:500]
    result = {
        "ok": response.is_success,
        "status_code": response.status_code,
        "body": body,
    }
    result["ok"] = _worker_trigger_ok(result)
    return result


async def run_production_simulated_execution_loop(
    *,
    duration_seconds: int,
    poll_seconds: int = 10,
    rolling_bar_seconds: int = 30,
    max_symbols: int = 5,
    worker_url: str = "",
    worker_auth_token: str = "",
    timeout_seconds: float = 45.0,
    worker_trigger: WorkerTrigger | None = None,
    sleep_fn: AsyncSleep = asyncio.sleep,
) -> dict[str, Any]:
    plan = build_execution_loop_plan(
        duration_seconds=duration_seconds,
        poll_seconds=poll_seconds,
        rolling_bar_seconds=rolling_bar_seconds,
        max_symbols=max_symbols,
    )
    if not worker_trigger:
        if not worker_url.strip():
            return _blocked("stockvision_worker_url_missing", plan)
        if not worker_auth_token.strip():
            return _blocked("stockvision_auth_token_missing", plan)

    cycles: list[dict[str, Any]] = []
    for cycle_idx in range(int(plan["max_cycles"])):
        started = time.monotonic()
        try:
            result = await (
                worker_trigger(cycle_idx)
                if worker_trigger
                else _trigger_worker_intraday_check(
                    worker_url=worker_url,
                    worker_auth_token=worker_auth_token,
                    timeout_seconds=timeout_seconds,
                )
            )
            ok = _worker_trigger_ok(result)
            cycles.append({
                "cycle": cycle_idx + 1,
                "status": "success" if ok else "error",
                "worker_status_code": result.get("status_code"),
                "worker_result": result.get("body", result),
                "duration_ms": round((time.monotonic() - started) * 1000),
            })
        except Exception as exc:  # pragma: no cover - network/runtime surface
            cycles.append({
                "cycle": cycle_idx + 1,
                "status": "error",
                "reason": f"worker_intraday_check_exception:{exc.__class__.__name__}",
                "duration_ms": round((time.monotonic() - started) * 1000),
            })

        if cycle_idx < int(plan["max_cycles"]) - 1:
            elapsed = time.monotonic() - started
            await sleep_fn(max(0.0, float(plan["poll_seconds"]) - elapsed))

    error_count = sum(1 for cycle in cycles if cycle["status"] != "success")
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "completed_with_errors" if error_count else "completed",
        "mode": "real_loop_simulated_order",
        "plan": plan,
        "cycles_attempted": len(cycles),
        "cycles_failed": error_count,
        "cycles": cycles,
        "paper_order_mode": "worker_intraday_check",
        "live_submit_enabled": False,
        "can_submit_real_order": False,
    }
