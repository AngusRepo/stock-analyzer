"""R18 / NEW-H1g: Live NAV and drawdown, adjusted for external cash flows.

The Live ledger lives only in execution D1 and never reads Paper cash,
positions or NAV. A daily snapshot is built from one verified broker
observation (live_account_observations_v1), dated official marks for every
holding and the external cash flows Wei recorded for that business date.

Return index (time-weighted, so a deposit is not a gain):
    index_0 = 1
    index_t = index_{t-1} * (nav_t - flow_t) / nav_{t-1}
flow_t is every external flow dated after the previous snapshot's business
date and on or before this one, so a weekend or holiday deposit is not a gain.
A flow cannot be recorded into a day an existing snapshot already closed.
    drawdown_t = index_t / max(index_0..t) - 1
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import date, datetime
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo


SCHEMA_VERSION = "live-daily-snapshot-v1"
TW = ZoneInfo("Asia/Taipei")
_SHA256 = re.compile(r"[0-9a-f]{64}")


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _finite(value: Any, name: str) -> float:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"live_ledger_{name}_missing")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"live_ledger_{name}_not_finite")
    return number


def _iso_day(value: Any, name: str) -> str:
    """Strict YYYY-MM-DD; dates are compared as text in SQL, so no other ISO form is accepted."""
    text = str(value or "")
    try:
        if date.fromisoformat(text).isoformat() == text:  # rejects 20261212, 2026-W50-6
            return text
    except ValueError:
        pass
    raise ValueError(f"live_ledger_{name}_invalid")


def _scope(value: Any) -> str:
    scope = str(value or "")
    if not scope.startswith("live:sinopac:"):
        raise ValueError("live_ledger_scope_invalid")
    return scope


def pending_settlement_total(observation: Mapping[str, Any], business_date: str, *,
                             include_business_date: bool = False) -> float:
    """Net amounts the bank balance does not hold yet: settlement dates after the business date.

    A settlement dated on or before the business date has already moved the
    bank balance that the same post-close observation reports. An intraday
    observation (include_business_date=True) also counts one due that day: the
    bank may debit it after the observation.
    """
    day = date.fromisoformat(_iso_day(business_date, "business_date"))
    return sum(_finite(row.get("net_amount"), "settlement_amount")
               for row in observation.get("settlements") or []
               if (settled := date.fromisoformat(str(row.get("date")))) > day
               or (include_business_date and settled == day))


def account_nav(observation: Mapping[str, Any], business_date: str,
                marks: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Live NAV (Wei 3a): bank balance + holdings at dated authoritative marks + net unsettled.

    Shared by the daily snapshot (R18) and the Live intake ratio (R21); the
    observation must be a verified Live observation taken on business_date (Taiwan time).
    """
    _scope(observation.get("account_scope"))
    if observation.get("schema_version") != "live-account-observation-v1":
        raise ValueError("live_ledger_observation_schema_invalid")
    if not _SHA256.fullmatch(str(observation.get("sha256") or "")):
        raise ValueError("live_ledger_observation_unverified")
    _iso_day(business_date, "business_date")
    observed = datetime.fromisoformat(str(observation.get("observed_at")))
    if observed.tzinfo is None or observed.astimezone(TW).date().isoformat() != business_date:
        raise ValueError("live_ledger_observation_not_on_business_date")
    used_marks: dict[str, dict[str, Any]] = {}
    holdings: dict[str, int] = {}
    positions_value = 0.0
    for position in observation.get("positions") or []:
        shares = int(position.get("shares") or 0)
        if shares == 0:
            continue
        if str(position.get("direction") or "").lower() not in {"action.buy", "buy"}:
            raise ValueError("live_ledger_position_direction_unsupported")
        symbol = str(position.get("symbol") or "")
        mark = marks.get(symbol)
        if not isinstance(mark, Mapping) or str(mark.get("date")) != business_date or not str(mark.get("source") or ""):
            raise ValueError(f"live_ledger_mark_missing:{symbol}")
        price = _finite(mark.get("price"), "mark_price")
        if price <= 0:
            raise ValueError(f"live_ledger_mark_invalid:{symbol}")
        used_marks[symbol] = {"price": price, "date": business_date, "source": str(mark["source"])}
        holdings[symbol] = holdings.get(symbol, 0) + shares
        positions_value += shares * price
    cash = _finite(observation.get("bank_balance"), "cash")
    unsettled = pending_settlement_total(observation, business_date)
    nav = cash + unsettled + positions_value
    if nav < 0:
        raise ValueError("live_ledger_nav_negative")
    return {"cash": cash, "unsettled": unsettled, "positions_value": positions_value, "nav": nav,
            "marks": used_marks, "holdings": holdings}


def build_daily_snapshot(
    *,
    observation: Mapping[str, Any],
    business_date: str,
    marks: Mapping[str, Mapping[str, Any]],
    net_external_flow: float,
    previous: Mapping[str, Any] | None,
) -> dict[str, Any]:
    scope = _scope(observation.get("account_scope"))
    if observation.get("schema_version") != "live-account-observation-v1":
        raise ValueError("live_ledger_observation_schema_invalid")
    observation_sha = str(observation.get("sha256") or "")
    if not _SHA256.fullmatch(observation_sha):
        raise ValueError("live_ledger_observation_unverified")
    valuation = account_nav(observation, business_date, marks)
    cash, unsettled = valuation["cash"], valuation["unsettled"]
    positions_value, used_marks, nav = valuation["positions_value"], valuation["marks"], valuation["nav"]
    flow = _finite(net_external_flow, "flow")

    previous_date = previous_sha = None
    if previous is None:
        if nav <= 0:
            raise ValueError("live_ledger_first_nav_not_positive")
        index, peak = 1.0, 1.0
    else:
        previous_date = _iso_day(previous.get("business_date"), "previous_business_date")
        previous_sha = str(previous.get("payload_sha256") or "")
        if not _SHA256.fullmatch(previous_sha):
            raise ValueError("live_ledger_previous_unverified")
        if _scope(previous.get("account_scope")) != scope:
            raise ValueError("live_ledger_previous_scope_mismatch")
        if previous_date >= business_date:
            raise ValueError("live_ledger_previous_not_earlier")
        previous_nav = _finite(previous.get("nav"), "previous_nav")
        if previous_nav <= 0:
            raise ValueError("live_ledger_previous_nav_not_positive")
        growth = (nav - flow) / previous_nav
        if growth <= 0:
            raise ValueError("live_ledger_return_not_positive")
        index = _finite(previous.get("return_index"), "previous_index") * growth
        peak = max(_finite(previous.get("peak_return_index"), "previous_peak"), index)
    drawdown = min(0.0, index / peak - 1.0)

    payload = {
        "schema_version": SCHEMA_VERSION, "account_scope": scope, "business_date": business_date,
        "observation_sha256": observation_sha, "cash": cash, "unsettled_net": unsettled,
        "positions_value": positions_value, "nav": nav, "net_external_flow": flow,
        "return_index": index, "peak_return_index": peak, "drawdown": drawdown,
        "marks": dict(sorted(used_marks.items())),
        # The chain link: append refuses the row unless this is still the latest
        # earlier snapshot, so a wrong or missing previous cannot reset the index.
        "previous_business_date": previous_date, "previous_payload_sha256": previous_sha,
    }
    return {**payload, "payload_sha256": hashlib.sha256(_canonical(payload).encode()).hexdigest()}


class LiveLedger:
    def __init__(self, *, query: Callable | None = None, execute: Callable | None = None,
                 now: Callable[[], datetime] | None = None):
        if (query is None) != (execute is None):
            raise ValueError("both_live_ledger_transports_required")
        if query is None:
            from services.d1_domain_client import D1DataDomain, DomainD1Client

            client = DomainD1Client(D1DataDomain.EXECUTION, require_specific=True)
            query, execute = client.query, client.execute
        self._query, self._execute = query, execute
        self._now = now or (lambda: datetime.now(TW))

    def record_cash_flow(self, *, flow_id: str, account_scope: str, flow_date: str, kind: str,
                         amount: float, source: str, evidence_sha256: str) -> dict[str, Any]:
        """Idempotent on flow_id; a different payload under the same id is a conflict."""
        flow_id = str(flow_id or "").strip()
        if not flow_id or len(flow_id) > 128:
            raise ValueError("live_cash_flow_id_invalid")
        flow_date = _iso_day(flow_date, "flow_date")
        amount = _finite(amount, "flow_amount")
        if not amount.is_integer():
            raise ValueError("live_cash_flow_amount_not_whole_twd")
        if kind not in {"deposit", "withdrawal"} or (kind == "deposit") != (amount > 0) or amount == 0:
            raise ValueError("live_cash_flow_sign_invalid")
        if source not in {"wei_manual", "broker_statement"} or not _SHA256.fullmatch(str(evidence_sha256 or "")):
            raise ValueError("live_cash_flow_evidence_invalid")
        row = {"flow_id": flow_id, "account_scope": _scope(account_scope), "flow_date": flow_date,
               "kind": kind, "amount": amount, "source": source, "evidence_sha256": evidence_sha256}
        existing = self._flow(flow_id)
        if existing is None:
            # One statement: a flow dated on or before a day whose snapshot already
            # fixed its return would never enter any return index, so it is refused.
            self._execute(
                "INSERT INTO live_cash_flows_v1 (flow_id,account_scope,flow_date,kind,amount,source,"
                "evidence_sha256,recorded_at) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS ("
                "SELECT 1 FROM live_daily_snapshots_v1 WHERE account_scope=? AND business_date>=?) "
                "ON CONFLICT(flow_id) DO NOTHING",
                [*row.values(), self._now().isoformat(), row["account_scope"], flow_date], 5.0)
            existing = self._flow(flow_id)
            latest = self.previous_snapshot(row["account_scope"], "9999-12-31") if existing is None else None
            if latest is not None and str(latest["business_date"]) >= flow_date:
                raise ValueError("live_cash_flow_date_already_closed")
        if existing is None or any(existing[key] != value for key, value in row.items()):
            raise ValueError("live_cash_flow_conflict")
        return existing

    def _flow(self, flow_id: str) -> dict[str, Any] | None:
        rows = self._query("SELECT flow_id,account_scope,flow_date,kind,amount,source,evidence_sha256,recorded_at "
                           "FROM live_cash_flows_v1 WHERE flow_id=?", [flow_id], 5.0)
        return dict(rows[0]) if rows else None

    def net_flow(self, account_scope: str, business_date: str, *, after: str | None) -> float:
        """External flows in (after, business_date]; after is the previous snapshot's date, or None."""
        business_date = _iso_day(business_date, "business_date")
        if after is not None and _iso_day(after, "after") >= business_date:
            raise ValueError("live_ledger_flow_window_invalid")
        rows = self._query("SELECT COALESCE(SUM(amount),0) AS total FROM live_cash_flows_v1 "
                           "WHERE account_scope=? AND flow_date<=? AND flow_date>?",
                           [_scope(account_scope), business_date, after or ""], 5.0)
        return _finite(rows[0]["total"] if rows else 0, "flow_total")

    def previous_snapshot(self, account_scope: str, business_date: str) -> dict[str, Any] | None:
        rows = self._query("SELECT * FROM live_daily_snapshots_v1 WHERE account_scope=? AND business_date<? "
                           "ORDER BY business_date DESC LIMIT 1",
                           [_scope(account_scope), _iso_day(business_date, "business_date")], 5.0)
        return dict(rows[0]) if rows else None

    def append_snapshot(self, snapshot: Mapping[str, Any]) -> dict[str, Any]:
        body = {key: value for key, value in snapshot.items() if key != "payload_sha256"}
        if (snapshot.get("schema_version") != SCHEMA_VERSION
                or hashlib.sha256(_canonical(body).encode()).hexdigest() != snapshot.get("payload_sha256")):
            raise ValueError("live_snapshot_integrity_failed")
        scope, day = snapshot["account_scope"], snapshot["business_date"]
        after = snapshot.get("previous_business_date") or ""
        values = [snapshot["account_scope"], snapshot["business_date"], snapshot["observation_sha256"],
                  snapshot["cash"], snapshot["unsettled_net"], snapshot["positions_value"], snapshot["nav"],
                  snapshot["net_external_flow"], snapshot["return_index"], snapshot["peak_return_index"],
                  snapshot["drawdown"], _canonical(snapshot["marks"]), snapshot["payload_sha256"],
                  self._now().isoformat()]
        self._execute(
            "INSERT INTO live_daily_snapshots_v1 (account_scope,business_date,observation_sha256,cash,unsettled_net,"
            "positions_value,nav,net_external_flow,return_index,peak_return_index,drawdown,marks_json,payload_sha256,"
            "created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(amount),0) "
            "FROM live_cash_flows_v1 WHERE account_scope=? AND flow_date<=? AND flow_date>?)=? "
            "AND NOT EXISTS (SELECT 1 FROM live_daily_snapshots_v1 WHERE account_scope=? AND business_date>?) "
            "AND (SELECT payload_sha256 FROM live_daily_snapshots_v1 WHERE account_scope=? AND business_date<? "
            "ORDER BY business_date DESC LIMIT 1) IS ? "
            "ON CONFLICT(account_scope,business_date) DO NOTHING",
            [*values, scope, day, after, snapshot["net_external_flow"], scope, day, scope, day,
             snapshot.get("previous_payload_sha256")], 5.0)
        rows = self._query("SELECT payload_sha256 FROM live_daily_snapshots_v1 WHERE account_scope=? AND business_date=?",
                           [scope, day], 5.0)
        if rows:
            if rows[0]["payload_sha256"] != snapshot["payload_sha256"]:
                raise RuntimeError("live_snapshot_conflict")
            return dict(snapshot)
        latest = self.previous_snapshot(scope, "9999-12-31")
        if latest is not None and str(latest["business_date"]) > day:
            raise RuntimeError("live_snapshot_out_of_order")
        if (latest or {}).get("payload_sha256") != snapshot.get("previous_payload_sha256"):
            raise RuntimeError("live_snapshot_previous_mismatch")
        # A flow was recorded after this snapshot read its window: rebuild it.
        raise RuntimeError("live_snapshot_flow_changed")
        return dict(snapshot)
