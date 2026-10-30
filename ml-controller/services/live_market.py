"""LiveMarket for the R21 intake: the Live account, deferred-sell quotes and signed packets.

Reads only. The broker account, contract truth and holding marks come from the private execution
gateway (service token plus IAM), order books from the Market Data Hub; nothing here places an
order. Every gap raises LiveMarketUnavailable, so the intake records or sends nothing it cannot verify.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

import httpx

from services.broker_execution_contract import SCHEMA_VERSION, sign_packet
from services.execution_gateway_live_relay import _config, _headers
from services.execution_gateway_shadow_relay import fetch_google_identity_token
from services.execution_snapshot_revalidator import revalidate_authoritative_snapshots
from services.live_config import LiveConfigInvalid, in_continuous_session, live_limits

TW = ZoneInfo("Asia/Taipei")
BOOK_SOURCE = "shioaji_proxy_orderbook"
MARK_SOURCE = "shioaji_snapshot_last_trade"
REFERENCE_MARK_SOURCE = "shioaji_contract_reference_price"  # no trade yet today (Wei 10/30 Q1)
_MARK_SOURCES = {"snapshot_last_trade": MARK_SOURCE, "contract_reference": REFERENCE_MARK_SOURCE}
_TRUTH_KEYS = ("status", "observed_at", "exchange", "reference_price", "limit_up", "limit_down",
               "available_cash", "position_shares")


class LiveMarketUnavailable(RuntimeError):
    pass


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _price(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        return None
    return float(value)


class GatewayLiveMarket:
    """One instance per intake pass; it carries that pass's trading-day and kill-switch inputs."""

    def __init__(self, *, live_config: Mapping[str, Any] | None, risk_config: Mapping[str, Any] | None,
                 trading_day_confirmed: bool, env: Mapping[str, str] | None = None,
                 post_fn: Callable[..., Any] = httpx.post,
                 identity_token_provider: Callable[[str], str] | None = None,
                 now: Callable[[], datetime] | None = None) -> None:
        self._env = env if env is not None else os.environ
        try:
            self._config, self._freshness = live_limits(live_config, self._env)
        except LiveConfigInvalid as exc:
            raise LiveMarketUnavailable(str(exc)) from None
        system = risk_config.get("system") if isinstance(risk_config, Mapping) else None
        self._kill_switch_off = isinstance(system, Mapping) and system.get("killSwitch") is False
        self._trading_day = trading_day_confirmed is True
        self._post = post_fn
        self._identity = identity_token_provider or fetch_google_identity_token
        self._now = now or (lambda: datetime.now(timezone.utc))

    # --- private execution gateway (read routes only) ---

    def _gateway(self, path: str, body: Mapping[str, Any]) -> dict[str, Any]:
        url, token, audience = _config(self._env)
        if not url or not token:
            raise LiveMarketUnavailable("execution_gateway_config_incomplete")
        try:
            response = self._post(f"{url}{path}", headers=_headers(self._identity(audience), token),
                                  json=dict(body), timeout=5.0)
            code = int(getattr(response, "status_code", 0) or 0)
            payload = response.json() if code == 200 else None
        except Exception as exc:
            raise LiveMarketUnavailable(f"execution_gateway_read_failed:{type(exc).__name__}") from None
        if code != 200 or not isinstance(payload, dict):
            raise LiveMarketUnavailable(f"execution_gateway_http_{code}")
        return payload

    def account(self, business_date: str) -> tuple[Mapping[str, Any], Mapping[str, Mapping[str, Any]]]:
        request_id = f"live-intake-{business_date}-{uuid.uuid4().hex}"
        observation = self._gateway("/v1/account/observations", {"request_id": request_id})
        payload = {k: v for k, v in observation.items() if k != "sha256"}
        if (observation.get("request_id") != request_id
                or observation.get("sha256") != hashlib.sha256(_canonical(payload).encode()).hexdigest()):
            raise LiveMarketUnavailable("live_account_observation_unverified")
        try:
            symbols = sorted({str(p["symbol"]) for p in observation.get("positions") or [] if int(p["shares"]) > 0})
        except (KeyError, TypeError, ValueError):
            raise LiveMarketUnavailable("live_account_observation_unverified") from None
        return observation, self._marks(symbols, business_date) if symbols else {}

    def _marks(self, symbols: list[str], business_date: str) -> dict[str, dict[str, Any]]:
        """Each holding's mark from business_date: the last trade, or today's contract reference
        price when it has not traded yet. A holding without one gets no mark; account_nav then
        refuses the valuation and the intake sends exits only (Wei 10/30 Q2)."""
        answer = self._gateway("/v1/marks", {"symbols": symbols}).get("marks")
        marks: dict[str, dict[str, Any]] = {}
        for symbol in symbols:
            mark = answer.get(symbol) if isinstance(answer, Mapping) else None
            price = _price(mark.get("price")) if isinstance(mark, Mapping) else None
            kind = mark.get("source") if isinstance(mark, Mapping) else None
            source = _MARK_SOURCES.get(kind) if isinstance(kind, str) else None
            if price is not None and source is not None and mark.get("date") == business_date:
                marks[symbol] = {"price": price, "date": business_date, "source": source}
        return marks

    # --- Market Data Hub ---

    def _books(self, intent: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
        checked = revalidate_authoritative_snapshots({"intent": dict(intent)}, env=self._env, post_fn=self._post,
                                                     max_snapshot_age_ms=self._freshness["max_snapshot_age_ms"])
        if checked["errors"]:
            raise LiveMarketUnavailable(checked["errors"][0])
        return checked["observations"]

    def _bid(self, symbol: str, lot: str) -> float | None:
        probe = {"symbol": symbol, "side": "sell", "minPrice": 0.01, "orderLegs": [{"lotType": lot}]}
        try:
            return _price(self._books(probe)[lot]["bid"])
        except (LiveMarketUnavailable, KeyError):
            return None

    def deferred_sell_price(self, symbol: str) -> float | None:
        """The lower of the fresh board-lot and odd-lot best bids (exchange quotes, so on legal
        ticks). A sell limit at or below both bids is marketable on either leg; the board bid is
        required, the odd-lot one is used when fresh (a board-only sell fills at its bid anyway).
        The intake prices the release before it re-reads the shares it can sell, so a board-only
        sell may carry the lower odd-lot bid: still marketable, only a wider limit (accepted)."""
        board = self._bid(symbol, "board_lot")
        if board is None:
            return None
        odd = self._bid(symbol, "odd_lot")
        return board if odd is None else min(board, odd)

    def signed_packet(self, intent: Mapping[str, Any], idempotency_key: str,
                      trade_date: str) -> tuple[dict[str, Any], str]:
        if not self._trading_day:
            raise LiveMarketUnavailable("trading_day_not_confirmed")
        if not self._kill_switch_off:
            raise LiveMarketUnavailable("kill_switch_active_or_unknown")
        generated = self._now().astimezone(timezone.utc)
        if not in_continuous_session(self._config, generated.astimezone(TW)):
            raise LiveMarketUnavailable("market_session_closed")
        scope = str(self._env.get("LIVE_TRADING_APPROVAL_SCOPE") or "").strip()
        secret = str(self._env.get("LIVE_EXECUTION_HMAC_SECRET") or "")
        if not scope or not secret:
            raise LiveMarketUnavailable("live_packet_config_incomplete")
        snapshots = {lot: {"schema_version": "authoritative_execution_snapshot_v1", "lot_type": lot,
                           "status": "ready", "selected_source": BOOK_SOURCE,
                           **{k: book.get(k) for k in ("bid", "ask", "age_ms", "source_time", "received_at",
                                                       "confirmed_at", "session_epoch")}}
                     for lot, book in self._books(intent).items()}
        truth = self._gateway("/v1/broker-truth", {"symbol": str(intent.get("symbol") or "")})
        if truth.get("status") != "ready" or any(truth.get(key) is None for key in _TRUTH_KEYS):
            raise LiveMarketUnavailable("broker_truth_incomplete")
        packet = {
            "schema_version": SCHEMA_VERSION, "idempotency_key": idempotency_key, "trade_date": trade_date,
            "generated_at": generated.isoformat(),
            "expires_at": (generated + timedelta(seconds=self._freshness["max_packet_age_seconds"])).isoformat(),
            "approval": {"approved_by": "Wei", "scope": scope},
            "controls": {"risk_checks_passed": True, "kill_switch_active": False, "market_session_open": True,
                         "trading_day_confirmed": True, "market_phase": "continuous", "broker_truth_ready": True},
            "intent": dict(intent), "execution_snapshots": snapshots,
            "broker_truth": {key: truth[key] for key in _TRUTH_KEYS},
        }
        return packet, sign_packet(packet, secret)
