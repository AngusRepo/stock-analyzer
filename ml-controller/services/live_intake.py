"""R21 Live intake: follow Paper's committed orders into the Live account (Wei D-6).

Pull model (L0 B): a non-native caller runs `run_live_intake` after the Paper
intraday/EOD tasks. Live reads only committed Paper orders (`paper_orders`),
never Paper cash, positions or NAV, and never runs its own allocator.

Every Paper order gets one immutable `live_intake_orders_v1` row with the
conversion and its sha. A row is marked UNKNOWN *before* the relay call, so a
crash or an unclear answer can never lead to a second submission; UNKNOWN only
settles to RELAYED or BLOCKED by reconciliation (NEW-37 §1).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Mapping, Protocol
from zoneinfo import ZoneInfo

from services.broker_execution_contract import CLOCK_SKEW_SECONDS
from services.live_config import (
    LiveConfigInvalid,
    buy_cash_required,
    in_continuous_session,
    session_close_at,
    validate_live_config,
)
from services.live_ledger import account_holdings, account_nav, pending_settlement_total
from services.live_paper_reader import PaperDenominatorNotReady

SCHEMA_VERSION = "live-intake-conversion-v1"
TW = ZoneInfo("Asia/Taipei")
IDEMPOTENCY_PREFIX = "live-intake:"
# Every pass summary carries these lists, empty when nothing happened.
SUMMARY_LISTS = ("recorded", "relayed", "blocked", "unknown", "deferred", "waiting", "warnings")
# Any of these means the broker may hold the order, so the intake row can only be RELAYED.
BROKER_REACHED_LEG_STATES = {"SUBMITTING", "ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "UNKNOWN"}


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode()).hexdigest()


def _positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        return None
    return float(value)


def _whole(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def paper_order_ref(order: Mapping[str, Any]) -> str:
    return f"paper_orders:{int(order['id'])}"


def paper_order_time(order: Mapping[str, Any]) -> datetime:
    """paper_orders.created_at is SQLite datetime('now'): UTC without an offset."""
    text = str(order.get("created_at") or "")
    stamp = datetime.fromisoformat(text.replace(" ", "T"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(TW)


def tw_order_legs(shares: int) -> list[dict[str, Any]]:
    """Board lots plus one odd-lot leg, the same split as Worker buildTwOrderLegs."""
    board, odd = (shares // 1000) * 1000, shares % 1000
    legs = []
    if board:
        legs.append({"lotType": "board_lot", "shares": board, "finlabQuantity": board // 1000, "oddLot": False})
    if odd:
        legs.append({"lotType": "odd_lot", "shares": odd, "finlabQuantity": odd, "oddLot": True})
    return legs


def _max_affordable_shares(cash: float, price: float, fees: Mapping[str, Any]) -> int | None:
    """Largest share count whose notional plus per-leg buy commission fits in cash.

    The requirement is not monotone across a board-lot boundary, so this walks down
    from an upper bound that ignores the minimums (at most ~2 x minCommission / price steps).
    """
    if buy_cash_required(1, price, fees) is None:
        return None
    shares = max(0, math.floor(cash / (price * (1 + float(fees["commission"])))))
    while shares > 0 and buy_cash_required(shares, price, fees) > cash:
        shares -= 1
    return shares


def convert_paper_order(
    *,
    order: Mapping[str, Any],
    paper_position_before: int,
    paper_portfolio_value: float | None,
    live_nav: float,
    live_position_shares: int,
    live_available_cash: float,
    fees: Mapping[str, Any] | None,
    risk_config: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Scale one committed Paper order (Wei D-6). Pure; returns status, shares and the record.

    Buy (3a/3b): floor(Paper shares x Live NAV / Paper portfolioValue), cut by broker cash
    (per-leg fees from trading:config) and trading:risk_config.order.maxSingleOrderValue.
    Sell (3e, Wei 10/29): min(floor(Paper sold / Paper held before x Live shares), Live shares);
    a Paper flatten sells every Live share. Paper holdings come from committed orders only.
    """
    side = str(order.get("side") or "")
    paper_shares = _whole(order.get("shares"))
    price = _positive(order.get("price"))
    inputs = {"paper_order_ref": paper_order_ref(order), "side": side, "symbol": str(order.get("symbol") or ""),
              "paper_shares": paper_shares, "paper_price": price, "paper_position_before": paper_position_before,
              "paper_portfolio_value": paper_portfolio_value, "live_nav": live_nav,
              "live_position_shares": live_position_shares, "live_available_cash": live_available_cash}
    record: dict[str, Any] = {"schema_version": SCHEMA_VERSION, "inputs": inputs, "truncations": []}

    def done(status: str, shares: int, reason: str | None) -> dict[str, Any]:
        record.update(status=status, live_shares=shares, reason=reason)
        return {"status": status, "live_shares": shares, "reason": reason, "conversion": record,
                "conversion_sha256": _sha(record)}

    if side not in {"buy", "sell"} or not paper_shares or price is None or not inputs["symbol"]:
        return done("BLOCKED", 0, "paper_order_invalid")
    if _whole(live_position_shares) is None:
        return done("BLOCKED", 0, "live_account_invalid")
    if side == "sell":  # converts from Live shares only: no NAV needed (Wei 10/30 Q2)
        if _whole(paper_position_before) is None or paper_shares > paper_position_before:
            return done("BLOCKED", 0, "paper_position_inconsistent")
        flatten = paper_shares == paper_position_before
        record["paper_flattened"] = flatten
        record["sell_fraction"] = [paper_shares, paper_position_before]
        # Integer arithmetic: floor(sold / held x Live shares) never exceeds Live shares.
        shares = live_position_shares if flatten else paper_shares * live_position_shares // paper_position_before
        if shares:
            return done("RECEIVED", shares, None)
        return done("SKIPPED", 0, "live_position_empty" if not live_position_shares else "live_shares_zero")

    if _positive(live_nav) is None:
        return done("BLOCKED", 0, "live_account_invalid")
    denominator = _positive(paper_portfolio_value)
    if denominator is None:
        return done("BLOCKED", 0, "paper_denominator_unavailable")
    ratio = live_nav / denominator
    record["ratio"] = ratio
    shares = math.floor(paper_shares * ratio)
    affordable = _max_affordable_shares(live_available_cash, price, fees) if fees is not None else None
    if affordable is None:
        return done("BLOCKED", 0, "trading_fees_unavailable")
    order_cfg = risk_config.get("order") if isinstance(risk_config, Mapping) else None
    cap_value = _positive(order_cfg.get("maxSingleOrderValue")) if isinstance(order_cfg, Mapping) else None
    if cap_value is None:
        return done("BLOCKED", 0, "risk_config_unavailable")
    for by, limit in (("broker_cash", affordable), ("max_single_order_value", math.floor(cap_value / price))):
        if shares > limit:
            record["truncations"].append({"by": by, "from": shares, "to": limit})
            shares = limit
    return done("RECEIVED" if shares else "SKIPPED", shares, None if shares else "live_shares_zero")


def live_intent(order: Mapping[str, Any], shares: int, limit_price: float) -> dict[str, Any]:
    """The Live order intent the gateway validates; no Paper sizing authority is carried over."""
    return {
        "schemaVersion": "stockvision-order-intent-v1",
        "tradeDate": None,  # set by the packet builder to the Live trade date
        "symbol": str(order["symbol"]),
        "side": str(order["side"]),
        "liveSubmitRequested": False,
        "requestedShares": shares,
        "limitPrice": limit_price,
        "minPrice": limit_price,
        "maxPrice": limit_price,
        "orderLegs": tw_order_legs(shares),
        "source": "live_intake_r21",
        "paperOrderRef": paper_order_ref(order),
    }


class IntakeRepository(Protocol):
    def get(self, ref: str) -> dict[str, Any] | None: ...
    def insert(self, row: Mapping[str, Any]) -> dict[str, Any]: ...
    def transition(self, ref: str, *, expected: str, status: str, reason: str | None,
                   idempotency_key: str | None = None, sent_on: str | None = None) -> bool: ...
    def pending(self) -> list[dict[str, Any]]: ...
    def day_rows(self, trade_date: str) -> list[dict[str, Any]]: ...
    def sent_rows(self, sent_on: str) -> list[dict[str, Any]]: ...
    def first_trade_date(self) -> str | None: ...
    def symbol_rows(self, symbol: str) -> list[dict[str, Any]]: ...
    def raise_alert(self, alert: str, day: str, reason: str) -> bool: ...
    def clear_alert(self, alert: str) -> None: ...


class D1IntakeRepository:
    """live_intake_orders_v1 on the execution D1; the 0008 trigger keeps conversions immutable."""

    _COLUMNS = ("paper_order_ref", "trade_date", "symbol", "side", "paper_shares", "live_shares",
                "idempotency_key", "conversion_json", "conversion_sha256", "status", "status_reason",
                "sent_on", "created_at", "updated_at")

    def __init__(self, *, query: Callable | None = None, execute: Callable | None = None,
                 now: Callable[[], datetime] | None = None) -> None:
        if (query is None) != (execute is None):
            raise ValueError("both_live_intake_transports_required")
        if query is None:
            from services.d1_domain_client import D1DataDomain, DomainD1Client

            client = DomainD1Client(D1DataDomain.EXECUTION, require_specific=True)
            query, execute = client.query, client.execute
        self._query, self._execute = query, execute
        self._now = now or (lambda: datetime.now(timezone.utc))

    def raise_alert(self, alert: str, day: str, reason: str) -> bool:
        """Record that the alert holds on day for reason; True only for the pass that added the
        (day, reason) row, so the ops log gets each reason once a day even if reasons alternate."""
        token, reason = uuid.uuid4().hex, reason[:300]
        self._execute(
            "INSERT INTO live_intake_alert_state_v1 (alert,alert_day,reason,token,updated_at) VALUES (?,?,?,?,?) "
            "ON CONFLICT(alert,alert_day,reason) DO NOTHING",  # a CHECK failure still raises: then logged
            [alert, day, reason, token, self._now().isoformat()], 5.0)
        rows = self._query("SELECT token FROM live_intake_alert_state_v1 WHERE alert=? AND alert_day=? AND reason=?",
                           [alert, day, reason], 5.0)
        added = bool(rows) and rows[0]["token"] == token
        if added:  # earlier days are over; keep the table to the current condition
            self._execute("DELETE FROM live_intake_alert_state_v1 WHERE alert=? AND alert_day<?", [alert, day], 5.0)
        return added

    def clear_alert(self, alert: str) -> None:
        """The condition is over: the next failure is logged again. Reads first, so a healthy
        pass writes nothing."""
        if self._query("SELECT 1 FROM live_intake_alert_state_v1 WHERE alert=?", [alert], 5.0):
            self._execute("DELETE FROM live_intake_alert_state_v1 WHERE alert=?", [alert], 5.0)

    def get(self, ref: str) -> dict[str, Any] | None:
        rows = self._query(f"SELECT {','.join(self._COLUMNS)} FROM live_intake_orders_v1 WHERE paper_order_ref=?",
                           [ref], 5.0)
        return dict(rows[0]) if rows else None

    def insert(self, row: Mapping[str, Any]) -> dict[str, Any]:
        stamp = self._now().isoformat()
        values = {**row, "created_at": stamp, "updated_at": stamp}
        self._execute(
            f"INSERT INTO live_intake_orders_v1 ({','.join(self._COLUMNS)}) VALUES ({','.join('?' * len(self._COLUMNS))}) "
            "ON CONFLICT(paper_order_ref) DO NOTHING", [values.get(c) for c in self._COLUMNS], 5.0)
        saved = self.get(str(row["paper_order_ref"]))
        if saved is None or saved["conversion_sha256"] != row["conversion_sha256"]:
            raise RuntimeError("live_intake_conversion_conflict")
        return saved

    def transition(self, ref: str, *, expected: str, status: str, reason: str | None,
                   idempotency_key: str | None = None, sent_on: str | None = None) -> bool:
        self._execute(
            "UPDATE live_intake_orders_v1 SET status=?, status_reason=?, updated_at=?, "
            "idempotency_key=COALESCE(idempotency_key, ?), sent_on=COALESCE(?, sent_on) "
            "WHERE paper_order_ref=? AND status=?",
            [status, reason, self._now().isoformat(), idempotency_key, sent_on, ref, expected], 5.0)
        saved = self.get(ref)
        return saved is not None and saved["status"] == status and saved["status_reason"] == reason

    def pending(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self._query(
            f"SELECT {','.join(self._COLUMNS)} FROM live_intake_orders_v1 "
            "WHERE status IN ('RECEIVED','DEFERRED','UNKNOWN') ORDER BY created_at, paper_order_ref", [], 5.0)]

    def day_rows(self, trade_date: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self._query(
            f"SELECT {','.join(self._COLUMNS)} FROM live_intake_orders_v1 WHERE trade_date=? "
            "ORDER BY created_at, paper_order_ref", [trade_date], 5.0)]

    def sent_rows(self, sent_on: str) -> list[dict[str, Any]]:
        """Rows relayed on a Taiwan date, whatever day the Paper order was (released DEFERRED exits)."""
        return [dict(r) for r in self._query(
            f"SELECT {','.join(self._COLUMNS)} FROM live_intake_orders_v1 WHERE sent_on=? "
            "ORDER BY created_at, paper_order_ref", [sent_on], 5.0)]

    def first_trade_date(self) -> str | None:
        rows = self._query("SELECT MIN(trade_date) AS first FROM live_intake_orders_v1", [], 5.0)
        return rows[0]["first"] if rows and rows[0]["first"] else None

    def symbol_rows(self, symbol: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self._query(
            f"SELECT {','.join(self._COLUMNS)} FROM live_intake_orders_v1 WHERE symbol=? "
            "ORDER BY created_at, paper_order_ref", [symbol], 5.0)]


class LiveMarket(Protocol):
    """Read side of the Live account and market used by the intake (fake broker in tests)."""

    def account(self, business_date: str) -> tuple[Mapping[str, Any], Mapping[str, Mapping[str, Any]]]:
        """A live-account-observation-v1 taken now, and dated authoritative marks for its holdings."""

    def deferred_sell_price(self, symbol: str) -> float | None:
        """A fresh authoritative bid on a legal tick for releasing a DEFERRED sell; None if unavailable."""

    def signed_packet(self, intent: Mapping[str, Any], idempotency_key: str,
                      trade_date: str) -> tuple[dict[str, Any], str]:
        """A stockvision-live-execution-packet-v1 with fresh snapshots and broker truth, and its signature."""


def paper_positions_before(orders: Iterable[Mapping[str, Any]]) -> dict[int, int]:
    """Paper shares held in each symbol just before each order, from committed orders only (T3)."""
    held: dict[str, int] = {}
    before: dict[int, int] = {}
    for order in sorted(orders, key=lambda row: int(row["id"])):
        symbol, shares = str(order["symbol"]), int(order["shares"])
        before[int(order["id"])] = held.get(symbol, 0)
        held[symbol] = held.get(symbol, 0) + (shares if order["side"] == "buy" else -shares)
    return before


def _reason(**fields: Any) -> str:
    return _canonical({k: v for k, v in fields.items() if v is not None})


def _row_order(row: Mapping[str, Any]) -> tuple[int, float]:
    """Shares and limit price a row was sent with, else its conversion (not sent yet)."""
    try:
        marked = json.loads(row.get("status_reason") or "{}")
        return int(marked["shares"]), float(marked["limit_price"])
    except (TypeError, ValueError, KeyError, AttributeError):
        conversion = json.loads(row["conversion_json"])
        return int(row["live_shares"]), float(conversion["inputs"]["paper_price"])


def reservations(rows: Iterable[Mapping[str, Any]], today: str, fees: Mapping[str, Any] | None,
                 before: Mapping[str, Any] | None = None) -> tuple[float, dict[str, float]]:
    """Cash and shares that earlier passes already committed; the broker observation shows no open orders.

    Buys: today's RECEIVED rows (held by a temporary closure) and rows sent today (RELAYED, UNKNOWN).
    Sells: RECEIVED and DEFERRED rows (sent later), every UNKNOWN row, and rows relayed today
    (sent_on, not trade_date: a DEFERRED exit is released on a later day).
    Counting a fill twice only under-trades; never counting an open order would over-trade.

    before: the row about to be sent. It is left out, and so are unsent rows recorded after
    it (first in, first out): a younger unsent row always reserves for an older one, so the
    oldest can always go and two exits never hold each other's shares forever.
    """
    cash, shares = 0.0, {}
    for row in rows:
        if before is not None and (row["paper_order_ref"] == before["paper_order_ref"]
                                   or (row["status"] in {"RECEIVED", "DEFERRED"}
                                       and _fifo(row) > _fifo(before))):
            continue
        status, side, sent_today = row["status"], row["side"], row.get("sent_on") == today
        if side == "buy" and ((status == "RECEIVED" and row["trade_date"] == today)
                              or (status in {"RELAYED", "UNKNOWN"} and sent_today)):
            count, price = _row_order(row)
            cash += buy_cash_required(count, price, fees) or math.inf
        elif side == "sell" and (status in {"RECEIVED", "DEFERRED", "UNKNOWN"}
                                 or (status == "RELAYED" and sent_today)):
            symbol = str(row["symbol"])
            # An unsent DEFERRED flatten sells whatever is free when it is released, so it
            # holds every share of its symbol until then (younger rows wait behind it).
            flatten = status == "DEFERRED" and json.loads(row["conversion_json"]).get("paper_flattened")
            shares[symbol] = shares.get(symbol, 0) + (math.inf if flatten else _row_order(row)[0])
    return cash, shares


def _fifo(row: Mapping[str, Any]) -> tuple[str, str]:
    return str(row.get("created_at") or ""), str(row["paper_order_ref"])


class _Account:
    """One broker observation per pass; later decisions see what earlier ones used."""

    def __init__(self, market: LiveMarket, today: str,
                 reserved: Callable[[], tuple[float, dict[str, int]]]) -> None:
        self._market, self._today, self._reserved = market, today, reserved
        self.observation: Mapping[str, Any] | None = None
        self.nav: float | None = None  # None with nav_error set: no NAV, so no buys (Wei 10/30 Q2)
        self.nav_error: str | None = None
        self.spendable = 0.0  # broker cash net of payables, before any reservation
        self.held: dict[str, int] = {}  # broker holdings, before any reservation
        self.cash_left = 0.0
        self.holdings_left: dict[str, int] = {}

    def load(self) -> None:
        if self.observation is not None:
            return
        observation, marks = self._market.account(self._today)
        valuation = account_holdings(observation, self._today)  # an unverified observation stops everything
        try:
            nav, nav_error = account_nav(observation, self._today, marks)["nav"], None
        except (ValueError, TypeError) as exc:  # a holding without a usable mark: exits still go
            nav, nav_error = None, (str(exc) if str(exc).startswith("live_ledger_")
                                    else f"live_ledger_nav_invalid:{type(exc).__name__}")
            marks_error = getattr(self._market, "marks_error", None)
            if marks_error:  # the marks route failed: say so, not which holding came first
                nav_error = f"live_marks_unavailable:{marks_error}"
        cash_reserved, shares_reserved = self._reserved()
        self.observation, self.nav, self.nav_error = observation, nav, nav_error
        # Spendable cash: the bank balance net of every payable not yet debited, including one
        # due today (the bank may debit it after this observation). NAV keeps the R18 rule.
        due = pending_settlement_total(observation, self._today, include_business_date=True)
        self.spendable = min(valuation["cash"], valuation["cash"] + due)
        self.held = dict(valuation["holdings"])
        # What the next conversion may use: the above net of what earlier passes committed.
        self.cash_left = self.spendable - cash_reserved
        self.holdings_left = dict(valuation["holdings"])
        for symbol, count in shares_reserved.items():
            self.holdings_left[symbol] = self.holdings_left.get(symbol, 0) - count


def run_live_intake(
    *,
    paper_orders: list[Mapping[str, Any]],
    live_config: Mapping[str, Any] | None,
    trading_day_confirmed: bool,
    submission_state: Callable[[], Mapping[str, Any]],
    market: LiveMarket,
    repository: IntakeRepository,
    relay: Callable[[Mapping[str, Any], str], Mapping[str, Any]],
    status: Callable[[str], Mapping[str, Any]],
    fees: Mapping[str, Any] | None,
    risk_config: Mapping[str, Any] | None,
    paper_portfolio_value: Callable[[Mapping[str, Any]], float | None],
    now: datetime,
    clock: Callable[[], datetime] | None = None,
    warn: Callable[[str, Mapping[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """One pull pass over every committed Paper order (full history, for Paper holdings).

    Order of work: reconcile UNKNOWN, roll over yesterday's unsent rows, release DEFERRED
    exits, record new Paper orders, then send them. Releasing first means new conversions
    see the shares the released exits will use. Each send re-reads the submission control
    and the clock (`clock`, default the system clock) just before it is marked UNKNOWN.

    A buy whose Paper sizing row is not readable yet (PaperDenominatorNotReady) is not
    recorded until that order's day closes (Wei 10/30 A: session.continuous_close of
    trading:live_config); after that it is BLOCKED paper_denominator_unavailable and `warn`
    gets an event, also listed in summary["warnings"] for the caller's ops log.
    """
    now_tw = now.astimezone(TW)
    today = now_tw.date().isoformat()
    summary: dict[str, Any] = {key: [] for key in SUMMARY_LISTS}

    def emit(event: str, detail: Mapping[str, Any]) -> None:
        summary["warnings"].append({"event": event, **detail})
        try:
            (warn or _log_warning)(event, detail)
        except Exception:  # an alert sink failure must never stop exits; the event stays in the summary
            pass
    try:
        live_config = validate_live_config(live_config) if live_config is not None else None
    except LiveConfigInvalid as exc:
        return {**summary, "status": "blocked", "reason": str(exc)}
    if live_config is None:
        return {**summary, "status": "blocked", "reason": "live_config_unavailable"}
    if live_config["mode"] != "live":
        return {**summary, "status": "idle", "reason": "live_config_mode_paper"}

    for row in repository.pending():  # 1. never resend; settle only from the gateway lifecycle
        if row["status"] == "UNKNOWN":
            _reconcile(row, repository, status, now, summary)

    def read_control() -> dict[str, Any]:
        try:
            return dict(submission_state())
        except Exception:
            return {"status": "unavailable", "reason": "live_submission_control_unavailable", "durable_pause": False}

    control = read_control()
    open_ = control.get("status") == "live_submission_open"
    in_session = trading_day_confirmed and in_continuous_session(live_config, now_tw)
    can_release = in_session and now_tw.strftime("%H:%M") >= live_config["session"]["deferred_sell_release"]

    for row in repository.pending():  # 2. an earlier day's unsent order: exits carry over, buys never
        if row["status"] == "RECEIVED" and row["trade_date"] != today:
            paused = paused_before_send(row, control)
            if paused:
                _block(repository, row, summary, reason="live_paused_before_send", control=control.get("reason"))
            elif paused is None:  # control unreadable: a rollover would hide an earlier pause (D-7)
                summary["deferred"].append(row["paper_order_ref"])
            elif row["side"] == "sell":
                repository.transition(row["paper_order_ref"], expected="RECEIVED", status="DEFERRED",
                                      reason="received_exit_not_sent_on_its_day")
            else:
                _block(repository, row, summary, reason="received_buy_not_sent_on_its_day")

    def reserved(before: Mapping[str, Any] | None = None) -> tuple[float, dict[str, int]]:
        rows = {row["paper_order_ref"]: row for row in repository.day_rows(today)}
        rows.update((row["paper_order_ref"], row) for row in repository.sent_rows(today))
        rows.update((row["paper_order_ref"], row) for row in repository.pending())
        return reservations(rows.values(), today, fees, before=before)

    read_clock = clock or (lambda: datetime.now(timezone.utc))

    def hold_reason(row: Mapping[str, Any]) -> str | None:
        """Checked again just before each send: None, or why this order must wait (or is paused)."""
        fresh = read_control()
        paused = paused_before_send(row, fresh)
        if paused:
            return "paused"
        if paused is None:
            return "live_submission_control_incomplete"
        if fresh.get("status") != "live_submission_open":
            return str(fresh.get("reason") or "live_submission_not_open")
        moment = read_clock().astimezone(TW)
        if moment.date().isoformat() != today or not in_continuous_session(live_config, moment):
            return "outside_continuous_session_at_send"
        return None

    account = _Account(market, today, reserved)
    ctx = {"market": market, "repository": repository, "relay": relay, "today": today, "account": account,
           "summary": summary, "hold_reason": hold_reason, "reserved": reserved, "fees": fees,
           "read_control": read_control}

    if open_ and can_release and control.get("last_pause_at") is not None:
        _liquidation_topups(paper_orders, repository, account, today, summary, control)

    for row in repository.pending():  # 3. DEFERRED exits (Wei 3c); a pause first means never sent (D-7)
        if row["status"] != "DEFERRED":
            continue
        paused = paused_before_send(row, control)
        if paused:
            _block(repository, row, summary, reason="live_paused_before_send", control=control.get("reason"))
        elif paused is None or not open_ or row["trade_date"] == today or not can_release:
            summary["deferred"].append(row["paper_order_ref"])
        else:
            _send(row, **ctx)

    # 4. record Paper orders not seen yet: today's, plus any day the intake missed since Live began.
    # Wei 10/29 (E): days spent in mode=paper after Live began count as missed days too:
    # their exits are DEFERRED and re-validated, their buys SKIPPED.
    first = repository.first_trade_date() or today
    config_gap = sizing_config_gap(fees, risk_config)
    before = paper_positions_before(paper_orders)
    for order in sorted(paper_orders, key=lambda row: int(row["id"])):
        ref = paper_order_ref(order)
        placed = paper_order_time(order)
        day = placed.date().isoformat()
        if day < first or day > today or repository.get(ref) is not None:
            continue
        try:
            account.load()
        except Exception as exc:  # no Live NAV: record nothing more, send nothing
            return {**summary, "status": "blocked", "reason": f"live_account_unavailable:{type(exc).__name__}"}
        symbol = str(order["symbol"])
        if order["side"] == "buy" and account.nav is None:  # no Live NAV: record no buy yet; sells go on
            summary["nav_unavailable"] = account.nav_error  # alerted once, at the end of the pass
            _hold(ref, summary, "live_nav_unavailable")
            continue
        not_ready, timed_out = None, None  # timed_out: the alert for a sendable buy whose day closed
        try:
            denominator = paper_portfolio_value(order)
        except PaperDenominatorNotReady as exc:
            not_ready, denominator = str(exc), None
        # Sells need neither owner to convert; a buy without a usable sizing value is blocked at
        # once (it will never get one), so only a buy that could otherwise be sized waits on a gap.
        gap = config_gap if order["side"] == "buy" and _positive(denominator) is not None else None
        if (not_ready or gap) and in_continuous_session(live_config, placed):  # outside it: skipped anyway
            deadline = session_close_at(live_config, placed)
            if now_tw <= deadline:  # the input may still appear: record nothing yet, retry next pass
                summary["waiting"].append(ref)
                continue
            timed_out = {"paper_order_ref": ref, "cause": not_ready or gap, "deadline": deadline.isoformat()}

        def convert(live_position: int) -> dict[str, Any]:
            return convert_paper_order(
                order=order, paper_position_before=before[int(order["id"])],
                paper_portfolio_value=denominator, live_nav=account.nav,
                live_position_shares=max(0, live_position),
                live_available_cash=max(0.0, account.cash_left), fees=fees, risk_config=risk_config)

        result = convert(account.holdings_left.get(symbol, 0))
        status_value, reason = result["status"], result["reason"]
        if (order["side"] == "sell" and status_value == "SKIPPED"
                and account.held.get(symbol, 0) > max(0, account.holdings_left.get(symbol, 0))):
            # Open sells sent earlier hold every free share, but the broker still holds some
            # (an earlier sell may fill): never drop the exit; convert against the broker's
            # holdings and re-validate it on the next trading day.
            result = convert(account.held.get(symbol, 0))
            status_value, reason = result["status"], result["reason"]
            if status_value == "RECEIVED":
                status_value, reason = "DEFERRED", "exit_waits_for_open_sells"
        superseded = order["side"] == "buy" and any(
            row["side"] == "sell" and _later_than(row["paper_order_ref"], int(order["id"]))
            for row in repository.symbol_rows(symbol))
        if superseded:
            # A buy that waited for its sizing row while a later Paper sell of the symbol was
            # recorded: sending it now could open a position Paper has already left.
            status_value, reason = "BLOCKED", "paper_buy_superseded_while_waiting"
        elif day != today and order["side"] == "buy" and timed_out is None:
            status_value, reason = "SKIPPED", "paper_buy_missed_by_intake"  # never sent a day late
        elif (not_ready or gap) and timed_out is None and reason in _WAITED_BUY_INPUTS:
            status_value, reason = "SKIPPED", "paper_buy_outside_session"  # never sendable: no wait, no alert
        elif status_value == "RECEIVED":
            if day != today:
                status_value, reason = "DEFERRED", "paper_exit_missed_by_intake"
            elif not in_continuous_session(live_config, placed):
                status_value, reason = (("DEFERRED", "paper_exit_outside_session") if order["side"] == "sell"
                                        else ("SKIPPED", "paper_buy_outside_session"))
        if status_value == "RECEIVED" and order["side"] == "buy":
            account.cash_left -= buy_cash_required(result["live_shares"], float(order["price"]), fees) or 0.0
        elif status_value in {"RECEIVED", "DEFERRED"} and order["side"] == "sell":
            account.holdings_left[symbol] = account.holdings_left.get(symbol, 0) - result["live_shares"]
        conversion = {**result["conversion"], "observation_sha256": (account.observation or {}).get("sha256"),
                      "paper_order_time_tw": placed.isoformat()}
        if not_ready is not None:
            conversion["paper_denominator_not_ready"] = not_ready
        repository.insert({
            "paper_order_ref": ref, "trade_date": day, "symbol": symbol, "side": str(order["side"]),
            "paper_shares": int(order["shares"]), "live_shares": result["live_shares"], "idempotency_key": None,
            "conversion_json": _canonical(conversion), "conversion_sha256": _sha(conversion),
            "status": status_value, "status_reason": reason})
        summary["recorded"].append(ref)
        if timed_out is not None and reason == "paper_denominator_unavailable":
            emit("live_intake_paper_denominator_unavailable", timed_out)  # after the insert: once per order
        elif timed_out is not None and reason in _WAITED_BUY_INPUTS:
            emit("live_intake_trading_config_unavailable", {**timed_out, "cause": reason})
        elif superseded:
            emit("live_intake_paper_buy_superseded", {"paper_order_ref": ref, "cause": not_ready or gap})

    for row in repository.pending():  # 5. send today's RECEIVED orders
        if row["status"] != "RECEIVED" or row["trade_date"] != today:
            continue
        paused = paused_before_send(row, control)
        if paused:
            _block(repository, row, summary, reason="live_paused_before_send", control=control.get("reason"))
        elif paused is False and open_ and in_session:
            _send(row, **ctx)
    _nav_alert(account, repository, today, summary, emit)
    return {**summary, "status": "ok", "control": control.get("reason")}


NAV_ALERT = "live_intake_nav_unavailable"


def _nav_alert(account: _Account, repository: IntakeRepository, today: str, summary: Mapping[str, Any],
               emit: Callable[[str, Mapping[str, Any]], None]) -> None:
    """Wei 10/30: the NAV alert goes to the console every pass, to the ops log once per day and
    reason (ops_log); a pass that valued the account again ends it, so a later failure is logged."""
    reason = summary.get("nav_unavailable")
    if reason:
        try:
            ops_log = repository.raise_alert(NAV_ALERT, today, reason)
        except Exception:  # unknown alert state: log it rather than stay silent
            ops_log = True
        emit(NAV_ALERT, {"reason": reason, "ops_log": ops_log})
    elif account.nav is not None:  # set only by a load that valued the account
        try:
            repository.clear_alert(NAV_ALERT)
        except Exception as exc:  # the next failure may then go unlogged until another day or reason
            _LOG.warning("live_intake_alert_state_unavailable:%s", type(exc).__name__)


_LOG = logging.getLogger(__name__)


_WAITED_BUY_INPUTS = frozenset({"paper_denominator_unavailable", "trading_fees_unavailable",
                                 "risk_config_unavailable"})


def sizing_config_gap(fees: Mapping[str, Any] | None, risk_config: Mapping[str, Any] | None) -> str | None:
    """Why a buy cannot be sized from the KV owners now (the reason convert_paper_order would give),
    or None. A gap is waited out like a missing sizing row (Wei 10/30 m-4): no row until that
    day's continuous_close, then BLOCKED with an alert."""
    if buy_cash_required(1, 1.0, fees) is None:
        return "trading_fees_unavailable"
    order_cfg = risk_config.get("order") if isinstance(risk_config, Mapping) else None
    if not isinstance(order_cfg, Mapping) or _positive(order_cfg.get("maxSingleOrderValue")) is None:
        return "risk_config_unavailable"
    return None


def _later_than(ref: str, paper_order_id: int) -> bool:
    """Whether an intake row (paper_orders:<id>, or paper_orders:<id>:topup:<day> for a liquidation
    top-up) follows that Paper order; a ref it cannot read counts as later (fail-closed)."""
    try:
        return int(str(ref).split(":")[1]) > paper_order_id
    except (IndexError, ValueError):
        return True


def _log_warning(event: str, detail: Mapping[str, Any]) -> None:
    _LOG.warning("%s %s", event, _canonical(dict(detail)))


TOPUP_MARK = ":topup:"


def _liquidation_topups(paper_orders: list[Mapping[str, Any]], repository: IntakeRepository, account: _Account,
                        today: str, summary: dict[str, Any], control: Mapping[str, Any]) -> None:
    """Wei 10/29 (m2): Paper is flat in a symbol, its last Paper order there was a flatten the
    intake sent on an earlier day, yet Live still holds shares (an earlier same-day sell held
    some of them and did not fill). Record one DEFERRED sell of the whole Live residual; step 3
    releases and re-validates it like any other deferred exit (Paper flat => Live sells all)."""
    paper_held: dict[str, int] = {}
    last_order: dict[str, Mapping[str, Any]] = {}
    for order in sorted(paper_orders, key=lambda row: int(row["id"])):
        symbol, shares = str(order["symbol"]), int(order["shares"])
        paper_held[symbol] = paper_held.get(symbol, 0) + (shares if order["side"] == "buy" else -shares)
        last_order[symbol] = order
    try:
        account.load()
    except Exception:
        return  # no broker read: nothing to top up this pass
    for symbol, held in sorted(account.held.items()):
        if held <= 0 or symbol not in last_order or paper_held[symbol] != 0:
            continue
        rows = repository.symbol_rows(symbol)
        if any(row["status"] in {"RECEIVED", "DEFERRED", "UNKNOWN"} or row.get("sent_on") == today for row in rows):
            continue  # an unsent, unsettled or same-day order may still sell these shares
        flattens = [row for row in rows if row["side"] == "sell"
                    and json.loads(row["conversion_json"]).get("paper_flattened")]
        if not flattens:
            continue
        last = max(flattens, key=_fifo)
        base = str(last["paper_order_ref"]).split(TOPUP_MARK)[0]
        if (base != paper_order_ref(last_order[symbol]) or last["status"] != "RELAYED"
                or not last.get("sent_on") or last["sent_on"] >= today
                or paused_since_sent_on(last, control) is not False):
            continue  # Paper traded after it, it was not sent, or a pause came since (D-7)
        source = json.loads(last["conversion_json"])
        conversion = {"schema_version": SCHEMA_VERSION, "kind": "paper_flat_live_residual",
                      "paper_flattened": True, "source_ref": last["paper_order_ref"],
                      "inputs": {"live_position_shares": held, "paper_position_after": 0,
                                 "paper_price": source["inputs"]["paper_price"]},
                      "observation_sha256": (account.observation or {}).get("sha256")}
        ref = f"{base}{TOPUP_MARK}{today}"
        try:
            repository.insert({
                "paper_order_ref": ref, "trade_date": last["trade_date"], "symbol": symbol, "side": "sell",
                "paper_shares": int(last["paper_shares"]), "live_shares": held, "idempotency_key": None,
                "conversion_json": _canonical(conversion), "conversion_sha256": _sha(conversion),
                "status": "DEFERRED", "status_reason": "paper_flat_live_residual_topup"})
        except Exception as exc:  # an overlapping pass recorded it first: nothing more to do
            summary.setdefault("errors", []).append(f"{ref}:topup_not_recorded:{type(exc).__name__}")
            continue
        account.holdings_left[symbol] = account.holdings_left.get(symbol, 0) - held
        summary["recorded"].append(ref)


def _time(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo is not None else None


def paused_before_send(row: Mapping[str, Any], state: Mapping[str, Any]) -> bool | None:
    """D-7: a durable pause now, or any pause since this row last became sendable (its updated_at),
    means the order is never sent, even if Live was resumed before this pass ran.

    None: unknown. A readable chain always has a pause (its genesis row), so a state without
    last_pause_at was not read; callers then neither send nor make any transition that
    would refresh updated_at and hide an earlier pause.
    """
    if state.get("durable_pause") is True:
        return True
    last_pause = state.get("last_pause_at")
    if last_pause is None:
        return None
    paused_at, since = _time(last_pause), _time(row.get("updated_at"))
    return paused_at is None or since is None or paused_at >= since


def paused_since_sent_on(row: Mapping[str, Any], state: Mapping[str, Any]) -> bool | None:
    """Any pause on or after the (Taipei) day a sent row was sent. A later reconcile refreshes
    updated_at, so updated_at cannot date the send; the whole send day counts instead, which
    can only withhold a top-up, never add one. None: control unknown (see paused_before_send)."""
    if state.get("durable_pause") is True:
        return True
    last_pause = state.get("last_pause_at")
    if last_pause is None:
        return None
    try:
        day_start = datetime.fromisoformat(str(row["sent_on"])).replace(tzinfo=TW)
    except (KeyError, TypeError, ValueError):
        return True
    paused_at = _time(last_pause)
    return paused_at is None or paused_at >= day_start


def paused_since_marked(repository: IntakeRepository, ref: str, state: Mapping[str, Any]) -> bool | None:
    """A pause written at or after this send was marked: the exit is not carried over (D-7).
    An unreadable row counts as paused; an unreadable control is unknown (None)."""
    try:
        marked = repository.get(ref)
    except Exception:
        return True
    return marked is None or paused_before_send(marked, state)


def _block(repository: IntakeRepository, row: Mapping[str, Any], summary: dict[str, Any], **reason: Any) -> None:
    repository.transition(row["paper_order_ref"], expected=row["status"], status="BLOCKED", reason=_reason(**reason))
    summary["blocked"].append(row["paper_order_ref"])


def _hold(ref: str, summary: dict[str, Any], error: str) -> None:
    """Leave the row as it is (RECEIVED or DEFERRED, still unsent) for a later pass."""
    summary["deferred"].append(ref)
    summary.setdefault("errors", []).append(f"{ref}:{error}")


def explicit_block_before_reservation(result: Mapping[str, Any]) -> bool:
    """Wei 10/29: only an explicit pre-reserve_intent block proves no broker order exists.

    The gateway and the relay mark those answers blocked_before_reservation=True. Anything
    else (timeout, transport error, partial or post-reservation answer, a missing or unknown
    code, an idempotency conflict) is uncertain and stays UNKNOWN for reconciliation.
    """
    reasons = " ".join([str(result.get("reason") or "")] + [str(r) for r in result.get("blocked_reasons") or []])
    return (str(result.get("status") or "") == "blocked"
            and result.get("blocked_before_reservation") is True
            and not result.get("submitted_orders") and not result.get("intent_id")
            and not result.get("broker_order_id")
            and "execution_idempotency_conflict" not in reasons
            and "execution_reservation_failed" not in reasons)


def _send(row: Mapping[str, Any], *, market: LiveMarket, repository: IntakeRepository,
          relay: Callable[[Mapping[str, Any], str], Mapping[str, Any]], today: str, account: _Account,
          summary: dict[str, Any], hold_reason: Callable[[Mapping[str, Any]], str | None],
          reserved: Callable[..., tuple[float, dict[str, int]]], fees: Mapping[str, Any] | None,
          read_control: Callable[[], dict[str, Any]]) -> None:
    ref, expected, symbol = row["paper_order_ref"], row["status"], str(row["symbol"])
    conversion = json.loads(row["conversion_json"])
    converted = shares = int(row["live_shares"])
    try:
        account.load()
        # Fresh from D1: what every other row commits now, so overlapping passes and fills
        # since this pass loaded cannot make two orders use the same cash or shares.
        other_cash, other_shares = reserved(before=row)
        price = (market.deferred_sell_price(symbol) if expected == "DEFERRED"
                 else float(conversion["inputs"]["paper_price"]))
    except Exception as exc:
        return _hold(ref, summary, f"revalidation_failed:{type(exc).__name__}")
    if row["side"] == "buy" and account.nav is None:
        return _hold(ref, summary, "live_nav_unavailable")
    if row["side"] == "sell":
        free = account.held.get(symbol, 0) - other_shares.get(symbol, 0)
        # Wei 3c: a released exit sells what the broker holds now; a flatten sells all of it.
        shares = free if expected == "DEFERRED" and conversion.get("paper_flattened") else min(shares, free)
        if shares <= 0:
            if expected == "DEFERRED" and account.held.get(symbol, 0) <= 0:
                account.holdings_left[symbol] = account.holdings_left.get(symbol, 0) + converted
                return _block(repository, row, summary, reason="deferred_nothing_to_sell",
                              held=account.held.get(symbol, 0))
            return _hold(ref, summary, "exit_waits_for_open_sells")
    elif account.spendable - other_cash < (buy_cash_required(shares, price, fees) or math.inf):
        return _hold(ref, summary, "cash_committed_elsewhere")
    if _positive(price) is None:
        return _hold(ref, summary, "deferred_quote_unavailable")
    key = IDEMPOTENCY_PREFIX + ref
    order = {"id": int(ref.split(":")[1]), "symbol": symbol, "side": row["side"]}
    intent = {**live_intent(order, shares, price), "tradeDate": today, "paperOrderRef": ref}
    try:
        packet, signature = market.signed_packet(intent, key, today)
    except Exception as exc:  # nothing sent: a later pass retries; an exit not sent today rolls to DEFERRED
        return _hold(ref, summary, f"packet_unavailable:{type(exc).__name__}")
    waiting = hold_reason(row)
    if waiting == "paused":
        return _block(repository, row, summary, reason="live_paused_before_send")
    if waiting:
        return _hold(ref, summary, f"held:{waiting}")
    # Mark UNKNOWN before the call: from here on this order can only be reconciled. The
    # attempt nonce makes the marker unique, so two overlapping passes cannot both claim it.
    marked = _reason(reason="relay_in_flight", packet_expires_at=packet.get("expires_at"), shares=shares,
                     limit_price=price, attempt=uuid.uuid4().hex)
    if not repository.transition(ref, expected=expected, status="UNKNOWN", reason=marked, idempotency_key=key,
                                 sent_on=today):
        summary["unknown"].append(ref)
        return
    if row["side"] == "sell":  # swap the reservation for the shares actually sent
        account.holdings_left[symbol] = account.holdings_left.get(symbol, 0) + converted - shares
    try:
        result = dict(relay(packet, signature))
    except Exception as exc:
        result = {"status": "unknown", "reason": f"relay_exception:{type(exc).__name__}"}
    outcome = str(result.get("status") or "").lower()
    if outcome in {"submitted", "partial", "idempotent_replay"}:
        repository.transition(ref, expected="UNKNOWN", status="RELAYED",
                              reason=_reason(reason=f"gateway_{outcome}", shares=shares, limit_price=price))
        summary["relayed"].append(ref)
    elif explicit_block_before_reservation(result):
        detail = str(result.get("reason") or "")[:200]
        paused = paused_since_marked(repository, ref, read_control()) if row["side"] == "sell" else True
        if paused is None:  # cannot tell whether a pause came first: reconcile only
            summary["unknown"].append(ref)
        elif paused is False:
            # No broker order exists. An exit is never dropped: it is re-validated and sent
            # on the next trading day (Wei 3c, the narrow 0008 exception Wei approved 10/29).
            repository.transition(ref, expected="UNKNOWN", status="DEFERRED",
                                  reason=_reason(reason="gateway_blocked_exit_deferred", detail=detail))
            account.holdings_left[symbol] = account.holdings_left.get(symbol, 0) + shares - converted
            summary["deferred"].append(ref)
        else:
            repository.transition(ref, expected="UNKNOWN", status="BLOCKED",
                                  reason=_reason(reason="gateway_blocked", detail=detail, shares=shares,
                                                 limit_price=price))
            summary["blocked"].append(ref)
    else:
        summary["unknown"].append(ref)  # stays UNKNOWN until reconciliation settles it


def _reconcile(row: Mapping[str, Any], repository: IntakeRepository, status: Callable[[str], Mapping[str, Any]],
               now: datetime, summary: dict[str, Any]) -> None:
    ref, key = row["paper_order_ref"], row.get("idempotency_key")
    try:
        marked = json.loads(row.get("status_reason") or "{}")
        expires = datetime.fromisoformat(str(marked.get("packet_expires_at")))
    except (TypeError, ValueError):
        marked, expires = {}, None
    if not key:
        summary["unknown"].append(ref)
        return
    try:
        lifecycle = dict(status(key))
    except Exception:
        lifecycle = {"status": "unknown", "reason": "status_read_failed"}
    expired = (expires is not None and expires.tzinfo is not None
               and now > expires + timedelta(seconds=CLOCK_SKEW_SECONDS))
    legs = lifecycle.get("legs")
    reserved = str(lifecycle.get("status") or "") == "ok" and isinstance(legs, list)
    statuses = {str(leg.get("status")) if isinstance(leg, Mapping) else "" for leg in legs or []}
    keep = {"shares": marked.get("shares"), "limit_price": marked.get("limit_price")}
    if reserved and statuses & BROKER_REACHED_LEG_STATES:
        repository.transition(ref, expected="UNKNOWN", status="RELAYED",
                              reason=_reason(reason="reconciled_from_gateway_lifecycle", **keep))
        summary["relayed"].append(ref)
    elif expired and ((reserved and legs and statuses <= {"REJECTED", "RESERVED"})
                      or lifecycle.get("reason") == "execution_gateway_status_http_404"):
        # The gateway checks packet expiry before every leg: after expiry, no reached leg means no order.
        repository.transition(ref, expected="UNKNOWN", status="BLOCKED",
                              reason=_reason(reason="reconciled_no_broker_order_after_expiry", **keep))
        summary["blocked"].append(ref)
    else:
        summary["unknown"].append(ref)
