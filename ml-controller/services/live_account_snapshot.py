"""Broker observations in the dedicated Live ledger, never a Paper projection.

Bank balance and settlements are separate observations. Neither broker last_price
nor buying power establishes a dated NAV. Consumers must supply a separately
verified valuation before using this observation for allocation or risk.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timezone
from typing import Any, Callable, Mapping


def _field(value: Any, name: str) -> Any:
    return value.get(name) if isinstance(value, Mapping) else getattr(value, name, None)


def _enum(value: Any) -> str:
    return str(getattr(value, "value", value) or "")


def _number(value: Any) -> float:
    if isinstance(value, bool) or value is None:
        raise ValueError("live_account_number_missing")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("live_account_number_not_finite")
    return number


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def account_scope(stock_account: Any, expected_account_id: str) -> str:
    actual = str(_field(stock_account, "account_id") or "")
    broker = str(_field(stock_account, "broker_id") or "")
    if not expected_account_id or actual != expected_account_id or not broker:
        raise ValueError("live_account_identity_mismatch")
    # Keep account/person IDs out of persisted payloads and HTTP responses.
    digest = hashlib.sha256(_canonical([broker, actual]).encode()).hexdigest()
    return f"live:sinopac:{digest}"


def build_observation(*, scope: str, request_id: str, balance: Any,
                      positions: list[Any], settlements: list[Any],
                      observed_at: str) -> dict[str, Any]:
    if not scope.startswith("live:sinopac:") or not request_id.strip():
        raise ValueError("live_account_scope_and_request_required")
    stamp = datetime.fromisoformat(observed_at)
    if stamp.tzinfo is None:
        raise ValueError("live_account_observation_timezone_required")
    if _field(balance, "errmsg"):
        raise ValueError("live_account_balance_failed")
    balance_time = str(_field(balance, "date") or "")
    if not balance_time:
        raise ValueError("live_account_balance_timestamp_missing")
    # Preserve the official query timestamp, not an inferred trading date.
    datetime.fromisoformat(balance_time)
    cash = _number(_field(balance, "acc_balance"))
    holdings = []
    identifiers: set[str] = set()
    for item in positions:
        identifier = str(_field(item, "id"))
        code = str(_field(item, "code") or "")
        quantity = _number(_field(item, "quantity"))
        if identifier == "None" or identifier in identifiers or not code or quantity < 0 or quantity != int(quantity):
            raise ValueError("live_account_position_invalid")
        identifiers.add(identifier)
        holdings.append({"position_id": identifier, "symbol": code, "shares": int(quantity),
                         "direction": _enum(_field(item, "direction")),
                         "condition": _enum(_field(item, "cond"))})
    pending = []
    dates: set[str] = set()
    for item in settlements:
        day = str(_field(item, "date") or "")
        date.fromisoformat(day)
        if day in dates:
            raise ValueError("live_account_duplicate_settlement_date")
        dates.add(day)
        pending.append({"date": day, "net_amount": _number(_field(item, "amount")),
                        "T": _field(item, "T")})
    payload = {
        "schema_version": "live-account-observation-v1", "account_scope": scope,
        "request_id": request_id, "observed_at": observed_at,
        "sources": {"cash": "shioaji.account_balance", "positions": "shioaji.list_positions:Share",
                    "settlements": "shioaji.settlements"},
        "bank_balance": cash, "bank_balance_queried_at": balance_time,
        "positions": sorted(holdings, key=lambda row: row["position_id"]),
        "settlements": sorted(pending, key=lambda row: row["date"]),
        # Do not guess the same-day settlement boundary, corporate entitlements,
        # cash available for orders, or a date for StockPosition.last_price.
        "nav": None, "buying_power": None, "decision_ready": False,
        "valuation_missing": ["dated_marks", "settlement_reconciliation", "corporate_entitlements"],
    }
    return {**payload, "sha256": hashlib.sha256(_canonical(payload).encode()).hexdigest()}


class LiveAccountObservations:
    def __init__(self, *, query: Callable | None = None, execute: Callable | None = None):
        if (query is None) != (execute is None):
            raise ValueError("both_live_account_transports_required")
        if query is None:
            from services.d1_domain_client import D1DataDomain, DomainD1Client

            client = DomainD1Client(D1DataDomain.EXECUTION, require_specific=True)
            query, execute = client.query, client.execute
        self._query, self._execute = query, execute

    def get(self, scope: str, request_id: str) -> dict[str, Any] | None:
        rows = self._query("SELECT payload_json,sha256 FROM live_account_observations_v1 "
                           "WHERE account_scope=? AND request_id=?", [scope, request_id], 5.0)
        if not rows:
            return None
        payload = json.loads(rows[0]["payload_json"])
        digest = payload.pop("sha256")
        if (digest != rows[0]["sha256"] or digest != hashlib.sha256(_canonical(payload).encode()).hexdigest()
                or payload.get("account_scope") != scope or payload.get("request_id") != request_id):
            raise RuntimeError("live_account_observation_integrity_failed")
        return {**payload, "sha256": digest}

    def append(self, observation: dict[str, Any]) -> dict[str, Any]:
        payload = dict(observation)
        digest = payload.pop("sha256")
        if (not str(payload.get("account_scope", "")).startswith("live:sinopac:")
                or payload.get("schema_version") != "live-account-observation-v1"
                or payload.get("decision_ready") is not False or payload.get("nav") is not None
                or digest != hashlib.sha256(_canonical(payload).encode()).hexdigest()):
            raise ValueError("live_account_observation_integrity_failed")
        self._execute("INSERT INTO live_account_observations_v1 "
                      "(account_scope,request_id,observed_at,sha256,payload_json) VALUES(?,?,?,?,?) "
                      "ON CONFLICT(account_scope,request_id) DO NOTHING",
                      [payload["account_scope"], payload["request_id"], payload["observed_at"],
                       digest, _canonical(observation)], 5.0)
        saved = self.get(payload["account_scope"], payload["request_id"])
        if saved is None or saved["sha256"] != digest:
            raise RuntimeError("live_account_observation_conflict")
        return saved


def capture_observation(account: Any, *, expected_account_id: str, request_id: str,
                        repository: LiveAccountObservations, share_unit: Any) -> dict[str, Any]:
    """Caller holds the gateway lock; no new login, order or Paper DB access."""
    api = account.api
    scope = account_scope(api.stock_account, expected_account_id)
    saved = repository.get(scope, request_id)
    if saved is not None:
        return saved
    balance = api.account_balance(account=api.stock_account)
    positions = api.list_positions(api.stock_account, unit=share_unit)
    settlements = api.settlements(api.stock_account)
    if positions is None or settlements is None:
        raise ValueError("live_account_source_incomplete")
    if account_scope(api.stock_account, expected_account_id) != scope:
        raise ValueError("live_account_identity_changed_during_read")
    return repository.append(build_observation(
        scope=scope, request_id=request_id, balance=balance, positions=list(positions),
        settlements=list(settlements), observed_at=datetime.now(timezone.utc).isoformat()))
