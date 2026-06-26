"""Production-simulated FinLab / Sinopac L5 market-data adapter.

This module is market-data only. It never constructs orders and always returns
``can_submit_real_order=False``.
"""

from __future__ import annotations

import json
import os
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


SCHEMA_VERSION = "finlab-sinopac-l5-market-data-v1"
REQUIRED_ENV = [
    "SHIOAJI_API_KEY",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_CERT_PATH",
    "SHIOAJI_CERT_PERSON_ID",
]
SENSITIVE_ENV_KEYS = [
    "SHIOAJI_API_KEY",
    "SHIOAJI_SECRET_KEY",
    "SHIOAJI_API_SECRET",
    "SHIOAJI_CERT_PERSON_ID",
    "SHIOAJI_CERT_PASSWORD",
    "SHIOAJI_ACCOUNT_ID",
    "PROXY_SERVICE_TOKEN",
    "SHIOAJI_PROXY_TOKEN",
]


def _has_secret_key(env: dict[str, str]) -> bool:
    return bool(env.get("SHIOAJI_SECRET_KEY") or env.get("SHIOAJI_API_SECRET"))


def l5_market_data_env_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    values = env or os.environ
    missing = [key for key in REQUIRED_ENV if not values.get(key)]
    if not _has_secret_key(values):
        missing.append("SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET")

    cert_path = values.get("SHIOAJI_CERT_PATH")
    cert_exists = bool(cert_path and Path(cert_path).exists())
    if cert_path and not cert_exists and "SHIOAJI_CERT_PATH" not in missing:
        missing.append("SHIOAJI_CERT_PATH_EXISTS")

    return {
        "ready": len(missing) == 0,
        "missing": missing,
        "cert_path_configured": bool(cert_path),
        "cert_path_exists": cert_exists,
        "mode": (values.get("FINLAB_EXECUTION_LANE_ENABLED") or "off").strip().lower(),
    }


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            seconds = float(value)
            if seconds > 10**14:
                seconds = seconds / 1_000_000
            elif seconds > 10**11:
                seconds = seconds / 1000
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00").replace(" ", "T", 1))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _first_number(*values: Any) -> float | None:
    for value in values:
        if isinstance(value, (list, tuple)):
            found = _first_number(*value)
            if found is not None:
                return found
            continue
        if isinstance(value, dict):
            found = _first_number(value.get("price"), value.get("p"), value.get("value"))
            if found is not None:
                return found
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return None


def _number_list(value: Any) -> list[float]:
    out: list[float] = []
    for item in list(value or []):
        found = _first_number(item)
        if found is not None:
            out.append(float(found))
    return out


def _int_list(value: Any) -> list[int]:
    out: list[int] = []
    for item in list(value or []):
        source = item
        if isinstance(item, dict):
            source = item.get("volume") or item.get("v") or item.get("value")
        try:
            number = int(source)
        except (TypeError, ValueError):
            continue
        if number >= 0:
            out.append(number)
    return out


def _round_metric(value: float, decimals: int = 6) -> float:
    return round(value, decimals)


def _quote_time(payload: dict[str, Any]) -> Any:
    for key in ("source_time", "quote_time", "time", "updated_at", "timestamp"):
        if payload.get(key):
            return payload[key]
    return None


def normalize_l5_quote(
    symbol: str,
    payload: dict[str, Any],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    received_at = now or _utc_now()
    bid_prices = _number_list(payload.get("bid_prices") or payload.get("bidPrices") or payload.get("bid_prices_top5") or payload.get("bids"))[:5]
    ask_prices = _number_list(payload.get("ask_prices") or payload.get("askPrices") or payload.get("ask_prices_top5") or payload.get("asks"))[:5]
    bid_volumes = _int_list(payload.get("bid_volumes") or payload.get("bidVolumes") or payload.get("bid_volumes_top5") or payload.get("bids"))[:5]
    ask_volumes = _int_list(payload.get("ask_volumes") or payload.get("askVolumes") or payload.get("ask_volumes_top5") or payload.get("asks"))[:5]
    best_bid = _first_number(payload.get("best_bid"), payload.get("bestBid"), payload.get("bid"), bid_prices)
    best_ask = _first_number(payload.get("best_ask"), payload.get("bestAsk"), payload.get("ask"), ask_prices)
    price = _first_number(payload.get("price"), payload.get("last"), payload.get("last_price"), payload.get("close"))
    mid = ((best_bid + best_ask) / 2) if best_bid is not None and best_ask is not None else None
    spread_pct = _round_metric((best_ask - best_bid) / mid) if mid and best_bid is not None and best_ask is not None else None
    bid_depth = sum(bid_volumes)
    ask_depth = sum(ask_volumes)
    depth_total = bid_depth + ask_depth
    imbalance = _round_metric((bid_depth - ask_depth) / depth_total) if depth_total > 0 else None
    source_time_raw = _quote_time(payload)
    source_time = _parse_time(source_time_raw)
    quote_age_ms = int(max(0, (received_at - source_time).total_seconds() * 1000)) if source_time else None

    return {
        "schema_version": SCHEMA_VERSION,
        "provider": str(payload.get("provider") or "finlab_sinopac"),
        "symbol": str(symbol),
        "price": price,
        "best_bid": best_bid,
        "best_ask": best_ask,
        "bid_prices": bid_prices,
        "ask_prices": ask_prices,
        "bid_volumes": bid_volumes,
        "ask_volumes": ask_volumes,
        "spread_pct": spread_pct,
        "order_book_imbalance": imbalance,
        "l5_depth_levels": min(len(bid_prices), len(ask_prices)),
        "source_time": _iso(source_time) if source_time else (str(source_time_raw) if source_time_raw else None),
        "received_at": _iso(received_at),
        "quote_age_ms": quote_age_ms,
        "live_submit_enabled": False,
    }


def _load_account_factory() -> Callable[[], Any]:
    from finlab.online.brokers.sinopac import SinopacAccount

    return SinopacAccount


def _logout_account(account: Any) -> None:
    for candidate in (
        getattr(account, "logout", None),
        getattr(getattr(account, "api", None), "logout", None),
    ):
        if callable(candidate):
            try:
                candidate()
            except Exception:
                pass
            return


def _sanitize(text: str, env: dict[str, str]) -> str:
    sanitized = text
    for key in SENSITIVE_ENV_KEYS:
        value = env.get(key)
        if value and len(value) >= 3:
            sanitized = sanitized.replace(value, "***")
    return sanitized


def _flag_enabled(env: dict[str, str], key: str, *, default: bool = False) -> bool:
    raw = env.get(key)
    if raw is None or str(raw).strip() == "":
        return default
    normalized = str(raw).strip().lower()
    return normalized in {"1", "true", "yes", "y", "on", "enabled"}


def _proxy_base_url(env: dict[str, str]) -> str:
    return str(env.get("SHIOAJI_PROXY_URL") or env.get("SHIOAJI_PROXY_BASE_URL") or "").strip().rstrip("/")


def _proxy_token(env: dict[str, str]) -> str | None:
    token = str(env.get("PROXY_SERVICE_TOKEN") or env.get("SHIOAJI_PROXY_TOKEN") or "").strip()
    return token or None


def _proxy_fallback_configured(env: dict[str, str]) -> bool:
    return bool(_proxy_base_url(env)) and _flag_enabled(env, "SHIOAJI_L5_PROXY_FALLBACK_ENABLED", default=True)


def _proxy_timeout_seconds(env: dict[str, str]) -> float:
    try:
        value = float(env.get("SHIOAJI_L5_PROXY_TIMEOUT_SECONDS") or 3)
    except (TypeError, ValueError):
        return 3
    return min(max(value, 0.5), 10)


def _read_quotes_from_proxy_orderbook(symbols: list[str], env: dict[str, str]) -> tuple[dict[str, Any], list[str]]:
    proxy_url = _proxy_base_url(env)
    if not proxy_url:
        return {}, ["shioaji_proxy_url_missing"]

    token = _proxy_token(env)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    errors: list[str] = []
    quotes: dict[str, Any] = {}
    timeout_seconds = _proxy_timeout_seconds(env)

    if not token:
        errors.append("proxy_service_token_missing")

    for symbol in symbols:
        request = urllib.request.Request(
            proxy_url + f"/orderbook/{urllib.parse.quote(symbol)}",
            method="GET",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            message = _sanitize(str(exc), env)[:200]
            errors.append(f"{symbol}:{exc.__class__.__name__}:{message}")
            continue

        if not isinstance(body, dict):
            errors.append(f"{symbol}:invalid_proxy_body")
            continue

        bid_prices = _number_list(body.get("bid_prices") or body.get("bidPrices"))[:5]
        ask_prices = _number_list(body.get("ask_prices") or body.get("askPrices"))[:5]
        bid_volumes = _int_list(body.get("bid_volumes") or body.get("bidVolumes"))[:5]
        ask_volumes = _int_list(body.get("ask_volumes") or body.get("askVolumes"))[:5]
        status = str(body.get("status") or "orderbook").strip().lower()
        if not bid_prices or not ask_prices:
            errors.append(f"{symbol}:{status or 'missing_depth'}")
            continue

        quotes[symbol] = {
            "provider": "shioaji_proxy_orderbook",
            "status": status,
            "price": body.get("price"),
            "best_bid": bid_prices[0],
            "best_ask": ask_prices[0],
            "bid_prices": bid_prices,
            "ask_prices": ask_prices,
            "bid_volumes": bid_volumes,
            "ask_volumes": ask_volumes,
            "source_time": body.get("updated_at") or body.get("timestamp"),
            "depth_available": body.get("depth_available"),
            "features": body.get("features"),
        }

    return quotes, errors


def _read_quotes_from_account(account: Any, symbols: list[str]) -> dict[str, Any]:
    get_l5_quotes = getattr(account, "get_l5_quotes", None)
    if callable(get_l5_quotes):
        result = get_l5_quotes(symbols)
        return result if isinstance(result, dict) else {}

    get_orderbook = getattr(account, "get_orderbook", None)
    if callable(get_orderbook):
        return {symbol: get_orderbook(symbol) for symbol in symbols}

    raise RuntimeError("finlab_l5_quote_method_unavailable")


def _normalize_quotes(raw_quotes: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    return {
        symbol: normalize_l5_quote(symbol, payload, now=now)
        for symbol, payload in raw_quotes.items()
        if isinstance(payload, dict)
    }


def _base_response(env_status: dict[str, Any], clean_symbols: list[str]) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "allowed_use": "l5_live_market_data_pretrade",
        "can_submit_real_order": False,
        "live_submit_enabled": False,
        "env_status": env_status,
        "symbols": clean_symbols,
    }


def _fallback_response(
    *,
    env_status: dict[str, Any],
    clean_symbols: list[str],
    raw_quotes: dict[str, Any],
    fallback_errors: list[str],
    fallback_reason: str,
    now: datetime | None = None,
    account_error_type: str | None = None,
    account_error: str | None = None,
) -> dict[str, Any] | None:
    quotes = _normalize_quotes(raw_quotes, now=now)
    if not quotes:
        return None
    payload = {
        **_base_response(env_status, clean_symbols),
        "status": "pass",
        "source": "shioaji_proxy_orderbook_fallback",
        "fallback_used": True,
        "fallback_attempted": True,
        "fallback_reason": fallback_reason,
        "fallback_errors": fallback_errors,
        "quotes": quotes,
    }
    if account_error_type:
        payload["account_error_type"] = account_error_type
    if account_error:
        payload["account_error"] = account_error
    return payload


def run_finlab_l5_market_data(
    *,
    symbols: list[str],
    allow_broker_login: bool = False,
    env: dict[str, str] | None = None,
    account_factory: Callable[[], Any] | None = None,
    proxy_quote_reader: Callable[[list[str], dict[str, str]], tuple[dict[str, Any], list[str]]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    values = dict(env or os.environ)
    clean_symbols = [str(symbol).strip() for symbol in symbols if str(symbol).strip()]
    env_status = l5_market_data_env_status(values)
    fallback_reader = proxy_quote_reader or _read_quotes_from_proxy_orderbook
    fallback_enabled = _proxy_fallback_configured(values)

    if fallback_enabled and (not allow_broker_login or not env_status["ready"]):
        fallback_reason = "broker_login_not_allowed" if not allow_broker_login else "finlab_env_not_ready"
        raw_fallback_quotes, fallback_errors = fallback_reader(clean_symbols, values)
        fallback_payload = _fallback_response(
            env_status=env_status,
            clean_symbols=clean_symbols,
            raw_quotes=raw_fallback_quotes,
            fallback_errors=fallback_errors,
            fallback_reason=fallback_reason,
            now=now,
        )
        if fallback_payload is not None:
            return fallback_payload

    if not allow_broker_login:
        return {
            **_base_response(env_status, clean_symbols),
            "status": "blocked",
            "blocked_reasons": ["broker_login_not_allowed"],
            "fallback_attempted": fallback_enabled,
            "quotes": {},
        }

    if not env_status["ready"]:
        return {
            **_base_response(env_status, clean_symbols),
            "status": "blocked",
            "blocked_reasons": env_status["missing"],
            "fallback_attempted": fallback_enabled,
            "quotes": {},
        }

    account: Any | None = None
    try:
        factory = account_factory or _load_account_factory()
        account = factory()
        raw_quotes = _read_quotes_from_account(account, clean_symbols)
        quotes = _normalize_quotes(raw_quotes, now=now)
        return {
            **_base_response(env_status, clean_symbols),
            "status": "pass",
            "source": "finlab_sinopac_account",
            "fallback_used": False,
            "fallback_attempted": False,
            "quotes": quotes,
        }
    except Exception as exc:
        fallback_errors: list[str] = []
        if fallback_enabled:
            raw_fallback_quotes, fallback_errors = fallback_reader(clean_symbols, values)
            fallback_payload = _fallback_response(
                env_status=env_status,
                clean_symbols=clean_symbols,
                raw_quotes=raw_fallback_quotes,
                fallback_errors=fallback_errors,
                fallback_reason="finlab_account_quote_error",
                now=now,
                account_error_type=exc.__class__.__name__,
                account_error=_sanitize(str(exc), values),
            )
            if fallback_payload is not None:
                return fallback_payload

        return {
            **_base_response(env_status, clean_symbols),
            "status": "error",
            "quotes": {},
            "fallback_attempted": fallback_enabled,
            "fallback_errors": fallback_errors,
            "error_type": exc.__class__.__name__,
            "error": _sanitize(str(exc), values),
            "trace_tail": _sanitize(traceback.format_exc(limit=2), values),
        }
    finally:
        if account is not None:
            _logout_account(account)
