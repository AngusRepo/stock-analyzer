"""One Live intake pass with the production readers (R21, L0 B pull).

Composes run_live_intake from: committed Paper orders and their sizing rows (D1PaperReader,
deadline per Wei 10/30 A), KV trading:live_config / trading:config fees / trading:risk_config /
holiday:<date>, the R17 submission-control chain, the gateway read routes (GatewayLiveMarket)
and the live relay. The caller (the L0 cron seam, after W-REL) passes allow_live_submit and
turns summary["warnings"] into ops logs. Without allow_live_submit, or with an empty env, the
pass reads nothing and records no row; once it runs, rows are recorded under the R21 rules
even when the locks keep them from being sent.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

from services.live_intake import SUMMARY_LISTS, run_live_intake

TW = ZoneInfo("Asia/Taipei")


def _kv_json(key: str) -> Any:
    from services import kv_client

    return kv_client.get_json(key, default=None, timeout=3.0, strict=True)


def _holiday(key: str) -> Any:
    from services import kv_client

    return kv_client.get(key, timeout=3.0, strict=True)


def _early(status: str, reason: str) -> dict[str, Any]:
    """A pass that stopped before run_live_intake: the same summary keys, all empty."""
    return {**{key: [] for key in SUMMARY_LISTS}, "status": status, "reason": reason}


def trading_day_confirmed(now: datetime, read_holiday: Callable[[str], Any]) -> bool:
    """Weekday and no truthy holiday:<date> KV value (the Worker owner); a failed read is not a trading day."""
    day = now.astimezone(TW)
    if day.weekday() >= 5:
        return False
    try:
        return not read_holiday("holiday:" + day.date().isoformat())
    except Exception:
        return False


def run_live_intake_pass(
    *,
    allow_live_submit: bool,
    now: datetime | None = None,
    clock: Callable[[], datetime] | None = None,
    env: Mapping[str, str] | None = None,
    kv_json: Callable[[str], Any] = _kv_json,
    read_holiday: Callable[[str], Any] = _holiday,
    reader: Any = None,
    repository: Any = None,
    control: Any = None,
    market_factory: Callable[..., Any] | None = None,
    relay: Callable[[Mapping[str, Any], str], Mapping[str, Any]] | None = None,
    status: Callable[[str], Mapping[str, Any]] | None = None,
    warn: Callable[[str, Mapping[str, Any]], None] | None = None,
) -> dict[str, Any]:
    if allow_live_submit is not True:
        return _early("idle", "allow_live_submit_required")
    env = env if env is not None else os.environ
    if not env:  # the relay would fall back to os.environ: one pass reads one env or none
        return _early("blocked", "live_intake_env_missing")
    now = now or datetime.now(timezone.utc)
    try:
        live_config, trading_config, risk_config = (kv_json(key) for key in (
            "trading:live_config", "trading:config", "trading:risk_config"))
    except Exception as exc:
        return _early("blocked", f"live_intake_kv_unavailable:{type(exc).__name__}")
    fees = trading_config.get("fees") if isinstance(trading_config, Mapping) else None
    trading_day = trading_day_confirmed(now, read_holiday)

    from services.execution_gateway_live_relay import relay_execution_live_submit, relay_execution_live_status
    from services.execution_submission_control import D1SubmissionControl, order_path_read_timeout
    from services.live_intake import D1IntakeRepository
    from services.live_market import GatewayLiveMarket, LiveMarketUnavailable
    from services.live_paper_reader import D1PaperReader

    try:
        market = (market_factory or GatewayLiveMarket)(
            live_config=live_config, risk_config=risk_config, trading_day_confirmed=trading_day, env=env)
    except LiveMarketUnavailable as exc:
        return _early("blocked", str(exc))
    try:
        reader = reader or D1PaperReader()
        # The same control reaches the relay: its chain read keeps the order-path bound (R17).
        control = control or D1SubmissionControl(env=env, read_timeout=order_path_read_timeout(env))
        repository = repository or D1IntakeRepository()
    except Exception as exc:
        return _early("blocked", f"live_intake_d1_unavailable:{type(exc).__name__}")
    try:
        paper_orders = reader.orders()
    except Exception as exc:
        return _early("blocked", f"paper_orders_unavailable:{type(exc).__name__}")
    return run_live_intake(
        paper_orders=paper_orders, live_config=live_config, trading_day_confirmed=trading_day,
        submission_state=control.state, market=market, repository=repository,
        relay=relay or (lambda packet, signature: relay_execution_live_submit(
            packet=packet, signature=signature, allow_live_submit=True, env=env, submission_control=control)),
        status=status or (lambda key: relay_execution_live_status(key, env=env)),
        fees=fees if isinstance(fees, Mapping) else None, risk_config=risk_config,
        paper_portfolio_value=reader.portfolio_value, now=now, clock=clock, warn=warn)
