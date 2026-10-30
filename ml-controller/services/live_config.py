"""KV trading:live_config: the single owner of Live session, freshness, pause lines,
capital source and mode (plan §4.5, Wei D-5).

Unlock switches, approval scope/expiry and secrets stay in env/Secret. The env
LIVE_EXECUTION_MAX_* values remain only as absolute upper bounds: the effective
freshness is the stricter of KV and env. A missing or invalid config is never
replaced by defaults; callers fail closed.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, time
from typing import Any, Mapping

KEY = "trading:live_config"
SCHEMA_VERSION = "live-config-v1"
MODES = {"paper", "live"}
CAPITAL_SOURCES = {"broker_nav_authoritative_marks"}
_HHMM = re.compile(r"([01][0-9]|2[0-3]):[0-5][0-9]")
_TOP = {"schema_version", "mode", "capital_source", "session", "freshness", "pause"}
_SESSION = {"timezone", "continuous_open", "continuous_close", "deferred_sell_release"}
_FRESHNESS = {"max_packet_age_seconds": "LIVE_EXECUTION_MAX_PACKET_AGE_SECONDS",
              "max_snapshot_age_ms": "LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS",
              "max_broker_truth_age_seconds": "LIVE_EXECUTION_MAX_BROKER_TRUTH_AGE_SECONDS"}
_PAUSE = {"enabled", "daily_loss_pct", "cumulative_drawdown_pct"}


class LiveConfigInvalid(ValueError):
    pass


def _exact_keys(value: Any, keys: set[str], name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise LiveConfigInvalid(f"live_config_{name}_not_object")
    if set(value) != keys:
        raise LiveConfigInvalid(f"live_config_{name}_keys_invalid")
    return value


def _clock(value: Any, name: str) -> time:
    if not isinstance(value, str) or not _HHMM.fullmatch(value):
        raise LiveConfigInvalid(f"live_config_session_{name}_invalid")
    return time(int(value[:2]), int(value[3:]))


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise LiveConfigInvalid(f"live_config_freshness_{name}_invalid")
    return value


def _loss_line(value: Any, name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or not -1 < float(value) < 0:
        raise LiveConfigInvalid(f"live_config_pause_{name}_invalid")
    return float(value)


def validate_live_config(value: Any) -> dict[str, Any]:
    """Return the validated config or raise LiveConfigInvalid; no field is defaulted."""
    config = _exact_keys(value, _TOP, "root")
    if not all(isinstance(config[key], str) for key in ("schema_version", "mode", "capital_source")):
        raise LiveConfigInvalid("live_config_text_field_invalid")
    if config["schema_version"] != SCHEMA_VERSION:
        raise LiveConfigInvalid("live_config_schema_invalid")
    if config["mode"] not in MODES:
        raise LiveConfigInvalid("live_config_mode_invalid")
    if config["capital_source"] not in CAPITAL_SOURCES:
        raise LiveConfigInvalid("live_config_capital_source_invalid")
    session = _exact_keys(config["session"], _SESSION, "session")
    if session["timezone"] != "Asia/Taipei":
        raise LiveConfigInvalid("live_config_session_timezone_invalid")
    opens, closes = _clock(session["continuous_open"], "open"), _clock(session["continuous_close"], "close")
    release = _clock(session["deferred_sell_release"], "deferred_sell_release")
    if not opens < closes or not opens <= release < closes:
        raise LiveConfigInvalid("live_config_session_window_invalid")
    freshness = _exact_keys(config["freshness"], set(_FRESHNESS), "freshness")
    for name in _FRESHNESS:
        _positive_int(freshness[name], name)
    pause = _exact_keys(config["pause"], _PAUSE, "pause")
    if not isinstance(pause["enabled"], bool):
        raise LiveConfigInvalid("live_config_pause_enabled_invalid")
    lines = [_loss_line(pause[name], name) for name in ("daily_loss_pct", "cumulative_drawdown_pct")]
    if pause["enabled"] and None in lines:
        # R_PLAN §3: the lines exist but stay off until Wei sets both values.
        raise LiveConfigInvalid("live_config_pause_enabled_without_lines")
    return {key: (dict(config[key]) if isinstance(config[key], Mapping) else config[key]) for key in _TOP}


def effective_freshness(config: Mapping[str, Any], env: Mapping[str, str]) -> dict[str, int]:
    """KV value bounded by the env absolute cap. An unset cap leaves the KV value; a set
    but unreadable or non-positive cap is an error, never ignored."""
    out = {}
    for name, env_name in _FRESHNESS.items():
        value = _positive_int(config["freshness"][name], name)
        raw = str(env.get(env_name) or "").strip()
        if not raw:
            out[name] = value
            continue
        try:
            cap = int(raw)
        except ValueError:
            cap = 0
        if cap <= 0:
            raise LiveConfigInvalid(f"live_config_env_cap_invalid:{env_name}")
        out[name] = min(value, cap)
    return out


def live_limits(value: Any, env: Mapping[str, str]) -> tuple[dict[str, Any], dict[str, int]]:
    """Validated config plus its effective freshness; raises LiveConfigInvalid."""
    if value is None:
        raise LiveConfigInvalid("live_config_unavailable")
    config = validate_live_config(value)
    return config, effective_freshness(config, env)


def load_live_config() -> dict[str, Any] | None:
    """Read KV trading:live_config; None (fail closed) when absent or invalid."""
    from services.kv_client import get_json

    try:
        return validate_live_config(get_json(KEY, default=None, timeout=3.0))
    except LiveConfigInvalid:
        return None


def load_trading_fees() -> Mapping[str, Any] | None:
    """trading:config.fees, the single owner of commission and its NT$ minimum."""
    from services.kv_client import get_json

    config = get_json("trading:config", default=None, timeout=3.0)
    fees = config.get("fees") if isinstance(config, Mapping) else None
    return fees if isinstance(fees, Mapping) else None


def in_continuous_session(config: Mapping[str, Any], tw_time: datetime) -> bool:
    """Weekday and inside [open, close] Taiwan time, exact to the second: 13:30:01 is after the close.

    Used both for when a Paper order was committed and for whether Live may send now.
    Holidays are checked by the caller via holiday KV.
    """
    session = config["session"]
    clock = tw_time.time()
    return tw_time.weekday() < 5 and _clock(session["continuous_open"], "open") <= clock \
        <= _clock(session["continuous_close"], "close")


def session_close_at(config: Mapping[str, Any], tw_time: datetime) -> datetime:
    """The continuous-session close (inclusive, Taiwan time) on tw_time's date."""
    close = _clock(config["session"]["continuous_close"], "close")
    return tw_time.replace(hour=close.hour, minute=close.minute, second=0, microsecond=0)


def buy_cash_required(shares: int, price: float, fees: Mapping[str, Any] | None) -> float | None:
    """Notional plus the buy commission from trading:config.fees, per market leg.

    Each leg (board lots, odd lot) pays max(leg notional x commission, minCommission),
    which is never below the Worker per-leg contract (tw-equity-per-leg-floor-v1).
    Replaces the hardcoded 1.005 buffer. None when the fee owner is unreadable.
    """
    if not isinstance(fees, Mapping):
        return None
    rate, minimum = fees.get("commission"), fees.get("minCommission")
    for value in (rate, minimum):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            return None
    legs = [leg for leg in ((shares // 1000) * 1000, shares % 1000) if leg > 0]
    return shares * price + sum(max(leg * price * float(rate), float(minimum)) for leg in legs)
