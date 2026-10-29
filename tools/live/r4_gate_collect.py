"""M12 evidence collector: build an r4-gate-evidence-v1 bundle from read-only sources.

Reads D1 through the SELECT-only shadow clients and KV through strict GETs; writes
only the local evidence file. Fields that no stored source defines yet come from
the manual file (Wei/parent-filled, cited) or are left out, and every one of them
is listed in collector.gaps, so r4_gate_check fails closed on them.

Usage:
    python tools/live/r4_gate_collect.py --calendar-start 2026-11-09 \
        --manual manual.json [--signal signal.json] --out evidence.json
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("r4_gate_check", Path(__file__).with_name("r4_gate_check.py"))
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)
TW = gate.TW

Query = Callable[[str, str, list[Any]], list[Mapping[str, Any]]]  # (domain, sql, params) -> rows
KvGet = Callable[[str], Any]  # key -> raw text or None (strict: raises on transport errors)

PAPER_ACCOUNT_ID = 1
# Manual fields copied verbatim; r4_gate_check validates each one.
MANUAL_FIELDS = ("slice_a_identity", "allocator_decisions", "live_tests", "slippage_band")
# G2 counters with no stored source or agreed definition yet (left out: G2 fails on them).
UNDEFINED_HEALTH = ("ledger_cross_write",)
SCOPE_ERROR_MARKERS = ("paper_execution_scope", "paper_execution_unscoped_database", "clock_regression")


def _day_minus(day: str, days: int) -> str:
    return (date.fromisoformat(day) - timedelta(days=days)).isoformat()


def _utc_window(day: str) -> tuple[str, str]:
    """[start, end) in D1 'YYYY-MM-DD HH:MM:SS' UTC text for the Taiwan calendar date day."""
    start = datetime.fromisoformat(day).replace(tzinfo=TW).astimezone(timezone.utc)
    fmt = "%Y-%m-%d %H:%M:%S"
    return start.strftime(fmt), (start + timedelta(days=1)).strftime(fmt)


def _positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        return None
    return float(value)


def _iso_day(value: Any) -> str | None:
    try:
        return gate._day(value, "effective_from")
    except gate.EvidenceError:
        return None


class Collector:
    def __init__(self, *, policy: Mapping[str, Any], manual: Mapping[str, Any], query: Query, kv_get: KvGet,
                 now: datetime, signal: Mapping[str, Any] | None = None) -> None:
        self.policy, self.manual, self.signal = policy, manual, signal
        self._query, self._kv, self.now = query, kv_get, now
        self.gaps: list[str] = []

    def q(self, domain: str, sql: str, params: list[Any]) -> list[Mapping[str, Any]]:
        return self._query(domain, sql, params)

    # --- calendar ---------------------------------------------------------

    def calendar(self, start: str) -> tuple[str, list[dict[str, Any]], list[str], set[str]]:
        """as_of, the ad hoc closures to emit, the trading days [start-lookback, as_of], all closures."""
        today = self.now.astimezone(TW).date().isoformat()
        official = set(self.policy["calendar"]["official_closures"])
        confirmed = {row["date"]: row for row in self.manual.get("ad_hoc_closures_confirmed") or []
                     if isinstance(row, Mapping) and isinstance(row.get("date"), str)}
        kv_closed: dict[str, str] = {}
        day = date.fromisoformat(_day_minus(start, 14))
        while day.isoformat() <= today:
            if day.weekday() < 5:
                raw = self._kv(f"holiday:{day.isoformat()}")
                if raw:
                    kv_closed[day.isoformat()] = str(raw)
            day += timedelta(days=1)
        ad_hoc: list[dict[str, Any]] = []
        closed_all = set(official)
        for closed in sorted((set(kv_closed) - official) | set(confirmed)):
            closed_all.add(closed)
            if closed < start:
                continue  # only the lookback for the first day's previous session; not in the gate window
            row = confirmed.get(closed)
            if row is not None and row.get("wei_confirmed") is True:
                ad_hoc.append({"date": closed, "wei_confirmed": True, "reason": row.get("reason")})
                if closed not in kv_closed:
                    self.gaps.append(f"ad_hoc_closure_not_in_holiday_kv:{closed}")
            else:
                # Listed so the calendar matches holiday KV; G1 fails until Wei confirms it.
                ad_hoc.append({"date": closed, "wei_confirmed": False, "reason": kv_closed.get(closed, "")[:200]})
                self.gaps.append(f"ad_hoc_closure_unconfirmed:{closed}")
        days = gate.trading_days(_day_minus(start, 14), today, closed_all)
        if not days:
            raise RuntimeError("no_trading_day_before_today")
        return days[-1], ad_hoc, days, closed_all

    # --- paper days ---------------------------------------------------------

    def _release(self, day: str) -> Mapping[str, Any] | str:
        """The release live on day, or why there is none. One malformed row voids the timeline:
        skipping it could hide a later identity change behind an earlier release."""
        timeline = self.manual.get("release_timeline")
        if not isinstance(timeline, list) or any(
                not isinstance(r, Mapping) or _iso_day(r.get("effective_from")) is None for r in timeline):
            return "release_timeline_malformed"
        rows = [r for r in timeline if r["effective_from"] <= day]
        if not rows:
            return "no_release"
        latest = max(r["effective_from"] for r in rows)
        current = [r for r in rows if r["effective_from"] == latest]
        if len(current) != 1:
            return "release_ambiguous"
        if any(not isinstance(current[0].get(k), str) or not current[0][k].strip()
               for k in ("grant_key", "execution_owner_version")):
            return "release_incomplete"
        return current[0]

    def identity(self, day: str, signal_date: str) -> dict[str, str] | None:
        """grant_key/execution_owner_version from the cited release timeline (no per-day store exists);
        l3/allocator identity from the activated L4 plan of the previous trading day."""
        plans = self.q("paper", "SELECT plan_id,policy_identity,payload_json FROM l4_portfolio_plans_v1 "
                                "WHERE account_id=? AND activated=1 AND signal_date=? ORDER BY created_at",
                       [PAPER_ACCOUNT_ID, signal_date])
        identities = set()
        for plan in plans:
            l3 = json.loads(plan["payload_json"]).get("l3_identity")
            if not isinstance(l3, Mapping) or not l3:
                identities.add(None)
            else:
                identities.add((gate.sha256_of(dict(l3)), str(plan["policy_identity"])))
        release = self._release(day)
        if len(identities) != 1 or None in identities or isinstance(release, str):
            self.gaps.append(f"paper_day_identity_unavailable:{day}:"
                             + (release if isinstance(release, str) else f"plans={len(plans)}"))
            return None
        (l3_sha, policy_identity), = identities
        return {"grant_key": release["grant_key"], "execution_owner_version": release["execution_owner_version"],
                "l3_identity": l3_sha, "allocator_identity": policy_identity}

    def pending_buys_after_0845(self, day: str) -> int:
        cutoff = datetime.fromisoformat(f"{day}T08:45:00").replace(tzinfo=TW).astimezone(timezone.utc)
        rows = self.q("paper", "SELECT COUNT(*) AS n FROM pending_buy_items i JOIN pending_buy_runs r ON r.id=i.run_id "
                               "WHERE r.trade_date=? AND r.status!='superseded' AND i.created_at>?",
                      [day, cutoff.strftime("%Y-%m-%d %H:%M:%S")])
        return int(rows[0]["n"])

    def nav_quote_date_mismatch(self, day: str) -> int:
        """Marks not dated the valuation session, unfinished valuations, or no verified valuation."""
        rows = self.q("paper", "SELECT status,reason,detail_json FROM paper_execution_events "
                               "WHERE account_id=? AND trade_date=? AND event_type='snapshot_audit' ORDER BY id",
                      [PAPER_ACCOUNT_ID, day])
        count = sum(1 for r in rows if r["status"] == "pending_valuation")
        verified = [r for r in rows if r["status"] == "verified" and r["reason"] == "dated_marks_complete"]
        if not verified:
            return count + 1
        detail = json.loads(verified[-1]["detail_json"] or "{}")  # the latest re-valuation
        evidence = detail.get("mark_evidence") or {}
        held = detail.get("positions") or {}
        if not isinstance(held, Mapping) or not isinstance(evidence, Mapping):
            return count + 1  # unreadable valuation receipt
        count += sum(1 for symbol, shares in held.items() if shares and symbol not in evidence)
        for mark in evidence.values():
            if not isinstance(mark, Mapping) or mark.get("price_date") != day:
                count += 1
                continue
            stamp = mark.get("quote_time") if mark.get("quote_time") is not None else mark.get("observed_at")
            if stamp is not None:
                try:
                    at = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
                    # Naive broker times are Taiwan local time (Worker quoteBelongsToSession).
                    at = at if at.tzinfo else at.replace(tzinfo=TW)
                    count += at.astimezone(TW).date().isoformat() != day
                except ValueError:
                    count += 1
        return count

    def scope_violations(self, day: str) -> int:
        """Proxy: no store records scope violations; count stage/ticket errors that name one."""
        like = " OR ".join("last_error LIKE ?" for _ in SCOPE_ERROR_MARKERS)
        params = [day, *(f"%{m}%" for m in SCOPE_ERROR_MARKERS)]
        stages = self.q("ops", f"SELECT COUNT(*) AS n FROM pipeline_stage_runs WHERE business_date=? AND ({like})",
                        params)
        tickets = self.q("ops", f"SELECT COUNT(*) AS n FROM scheduler_execution_tickets_v1 "
                                f"WHERE business_date=? AND ({like})", params)
        return int(stages[0]["n"]) + int(tickets[0]["n"])

    def evening_chain_incomplete(self, day: str) -> int:
        """The latest evening-chain root ticket is success only after closeEveningChainRootIfComplete."""
        rows = self.q("ops", "SELECT status FROM scheduler_execution_tickets_v1 WHERE scheduler_job_id='evening-chain' "
                             "AND business_date=? AND ticket_kind='physical_root' "
                             "ORDER BY updated_at DESC, ticket_id DESC LIMIT 1", [day])
        return 0 if rows and rows[0]["status"] == "success" else 1

    def paper_days(self, window: list[str], previous: Mapping[str, str]) -> list[dict[str, Any]]:
        out = []
        for day in window:
            identity = self.identity(day, previous[day])
            if identity is None:
                continue  # no Paper record for this day: G1's streak ends here
            out.append({"date": day, "identity": identity, "health": {
                "pending_buys_after_0845": self.pending_buys_after_0845(day),
                "nav_quote_date_mismatch": self.nav_quote_date_mismatch(day),
                "paper_execution_scope_violation": self.scope_violations(day),
                "evening_chain_incomplete": self.evening_chain_incomplete(day)}})
        if out:
            self.gaps.extend(f"health_undefined:{field}" for field in UNDEFINED_HEALTH)
        return out

    # --- returns and turnover -------------------------------------------------

    def net_excess_days(self, window: list[str], previous: Mapping[str, str]) -> list[dict[str, Any]]:
        benchmark = self.manual.get("net_excess_benchmark")
        if benchmark not in ("benchmark_value", "twii_value"):
            benchmark = None
            self.gaps.append("net_excess_benchmark_undecided")
        days = sorted(set(window) | {previous[d] for d in window})
        marks = ",".join("?" for _ in days)
        snaps = {r["date"]: r for r in self.q(
            "paper", f"SELECT date,total_value,benchmark_value,twii_value FROM paper_daily_snapshots "
                     f"WHERE account_id=? AND date IN ({marks})", [PAPER_ACCOUNT_ID, *days])}
        out = []
        for day in window:
            today, before = snaps.get(day), snaps.get(previous[day])
            nav, prev_nav = (_positive(today and today["total_value"]), _positive(before and before["total_value"]))
            if nav is None or prev_nav is None:
                self.gaps.append(f"paper_nav_missing:{day}")
                continue
            start, end = _utc_window(day)
            orders = self.q("paper", "SELECT shares,price,commission,tax FROM paper_orders "
                                     "WHERE account_id=? AND created_at>=? AND created_at<?", [PAPER_ACCOUNT_ID, start, end])
            traded = sum(abs(float(o["shares"]) * float(o["price"])) for o in orders)
            costs = sum(float(o["commission"] or 0) + float(o["tax"] or 0) for o in orders)
            account_return = nav / prev_nav - 1
            row: dict[str, Any] = {"date": day, "one_way_turnover": traded / prev_nav,
                                   "paper_account_return": account_return}
            if benchmark is not None:
                bench, prev_bench = _positive(today[benchmark]), _positive(before[benchmark])
                if bench is None or prev_bench is None:
                    self.gaps.append(f"benchmark_missing:{day}")
                else:
                    # Gross of the costs Paper paid that day; G4 charges the fee-table cost on turnover.
                    row["gross_excess"] = account_return + costs / prev_nav - (bench / prev_bench - 1)
            out.append(row)
        return out

    # --- KV and execution reads -------------------------------------------------

    def kv_json(self, key: str) -> Any:
        raw = self._kv(key)
        return None if raw is None else json.loads(str(raw).lstrip("﻿"))

    def fees(self) -> dict[str, Any] | None:
        config = self.kv_json("trading:config")
        fees = config.get("fees") if isinstance(config, Mapping) else None
        if not isinstance(fees, Mapping) or "commission" not in fees or "tax" not in fees:
            self.gaps.append("trading_config_fees_missing")  # never the Worker defaults
            return None
        return {"commission": fees["commission"], "tax": fees["tax"]}

    def account_observation(self) -> dict[str, Any] | None:
        from services.live_account_snapshot import LiveAccountObservations

        rows = self.q("execution", "SELECT account_scope,request_id FROM live_account_observations_v1 "
                                   "ORDER BY observed_at DESC LIMIT 1", [])
        if not rows:
            self.gaps.append("live_account_observation_missing")
            return None

        def refuse_write(*_: Any) -> Any:
            raise RuntimeError("collector_is_read_only")

        store = LiveAccountObservations(query=lambda sql, params, timeout=None: self.q("execution", sql, params),
                                        execute=refuse_write)
        return store.get(rows[0]["account_scope"], rows[0]["request_id"])  # integrity re-checked

    # --- bundle -------------------------------------------------------------

    def collect(self, calendar_start: str) -> dict[str, Any]:
        as_of, ad_hoc, days, _ = self.calendar(calendar_start)
        window = [d for d in days if calendar_start <= d <= as_of]
        previous = {d: days[days.index(d) - 1] for d in window if days.index(d) > 0}
        if len(previous) != len(window):
            raise RuntimeError("calendar_lookback_too_short")
        evidence: dict[str, Any] = {"schema_version": "r4-gate-evidence-v1", "as_of": as_of,
                                    "calendar_start": calendar_start, "ad_hoc_closures": ad_hoc}
        for field in MANUAL_FIELDS:
            if field in self.manual:
                evidence[field] = self.manual[field]
            else:
                self.gaps.append(f"manual_missing:{field}")
        evidence["d12_replay_receipts"] = self.manual.get("d12_replay_receipts", [])  # none is a valid answer
        evidence["paper_days"] = self.paper_days(window, previous)
        evidence["net_excess_days"] = self.net_excess_days(window, previous)
        if isinstance(self.signal, Mapping) and {"oos_days", "oof"} <= set(self.signal):
            evidence["signal"] = {"oos_days": self.signal["oos_days"], "oof": self.signal["oof"]}
        else:
            self.gaps.append("signal_artifact_missing")
        for key, value in (("trading_config_fees", self.fees()), ("live_config", self.kv_json("trading:live_config")),
                           ("account_observation", self.account_observation())):
            if value is not None:
                evidence[key] = value
            elif key == "live_config":
                self.gaps.append("live_config_missing")
        evidence["collector"] = {
            "generated_at": self.now.astimezone(timezone.utc).isoformat(),
            "manual_sha256": gate.sha256_of(self.manual),
            "signal_sha256": gate.sha256_of(self.signal) if self.signal is not None else None,
            "manual_fields": [f for f in MANUAL_FIELDS if f in self.manual] + ["release_timeline (grant/owner)"],
            "gaps": self.gaps,
        }
        return evidence


def _live_sources() -> tuple[Query, KvGet]:
    sys.path.insert(0, str(ROOT / "ml-controller"))
    from services import kv_client
    from services.d1_domain_client import shadow_client_for_domain

    clients: dict[str, Any] = {}

    def query(domain: str, sql: str, params: list[Any]) -> list[Mapping[str, Any]]:
        client = clients.setdefault(domain, shadow_client_for_domain(domain))  # SELECT-only guard
        return client.query(sql, params, 30.0)

    return query, lambda key: kv_client.get(key, strict=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--calendar-start", required=True)
    parser.add_argument("--manual", required=True, type=Path)
    parser.add_argument("--signal", type=Path)
    parser.add_argument("--policy", default=gate.DEFAULT_POLICY, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    policy = gate.validate_policy(gate._strict_json(args.policy.read_text(encoding="utf-8")))
    manual = gate._strict_json(args.manual.read_text(encoding="utf-8"))
    signal = gate._strict_json(args.signal.read_text(encoding="utf-8")) if args.signal else None
    query, kv_get = _live_sources()
    collector = Collector(policy=policy, manual=manual, signal=signal, query=query, kv_get=kv_get,
                          now=datetime.now(timezone.utc))
    evidence = collector.collect(gate._day(args.calendar_start, "calendar_start"))
    text = json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
    args.out.write_text(text + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "sha256": hashlib.sha256(text.encode()).hexdigest(),
                      "gaps": collector.gaps}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
