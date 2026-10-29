"""T8: drive the Live execution gateway against the Shioaji simulation environment.

Wei runs this on his own machine with his own credentials in the environment
(docs/live/T8_SHIOAJI_SIMULATION_RUNBOOK.md). Every Shioaji client created in this
process is forced to simulation=True; there is no option to turn that off.

Nothing here reads or writes D1, KV or GCS: the gateway repository and the
account-observation store are local SQLite files in --out-dir, and the R17
submission chain is a local always-open stub (T9 exercises the real one).
The receipt holds step outcomes, versions and counts only: no credential, no
account number, no raw broker payload, no error message text.

Usage:
    python tools/live/t8_sim_harness.py --out-dir t8-YYYYMMDD --tse 2330 --otc 6488 [--orders [--fill-test]]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sqlite3
import string
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
CONTROLLER = ROOT / "ml-controller"
GATEWAY_MIGRATION = ROOT / "worker/migration_broker_execution_gateway_2026_07_13.sql"
OBSERVATION_MIGRATION = ROOT / "worker/domain-migrations/execution/0006_live_account_observations.sql"
REQUIRED_ENV = ("SHIOAJI_API_KEY", "SHIOAJI_SECRET_KEY", "SHIOAJI_CERT_PERSON_ID", "SHIOAJI_CERT_PASSWORD",
                "SHIOAJI_CERT_PATH", "SHIOAJI_ACCOUNT_ID")
# Removed from this process so no client can reach Cloudflare, GCP or a non-default Shioaji host.
CLOUD_ENV_PREFIXES = ("CF_", "CLOUDFLARE_", "MULTI_D1_", "EXECUTION_GATEWAY_", "GOOGLE_", "GCP_", "GCLOUD_",
                      "SJ_ADMIN_")
CLIENT_CLASSES = ("Shioaji", "ShioajiAsync")
CODE_FILES = ("tools/live/t8_sim_harness.py", "ml-controller/services/finlab_execution_gateway.py",
              "ml-controller/services/broker_execution_repository.py", "ml-controller/services/live_account_snapshot.py")
GATEWAY_ENV = {"LIVE_EXECUTION_GATEWAY_MODE": "persistent_singleton",
               "LIVE_EXECUTION_SINGLE_INSTANCE_CONFIRMED": "1",
               "LIVE_EXECUTION_CONTINUOUS_CPU_CONFIRMED": "1",
               "LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED": "1"}
_SIMULATION_CLIENTS: list[Any] = []  # every client the wrappers built (strong references)


class SimulationOnly(RuntimeError):
    pass


class EvidenceIncomplete(RuntimeError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("t8_evidence_incomplete")
        self.problems = problems


def _simulation_only(original: Callable[..., Any]) -> Callable[..., Any]:
    def simulation_client(*args: Any, **kwargs: Any) -> Any:
        if args or kwargs.get("simulation") is False:
            raise SimulationOnly("t8_production_client_refused")
        client = original(**{**kwargs, "simulation": True})
        _SIMULATION_CLIENTS.append(client)
        return client

    simulation_client._t8_simulation_only = True  # type: ignore[attr-defined]
    return simulation_client


def force_simulation(shioaji_module: Any) -> Callable[..., Any]:
    """Wrap every Shioaji client class (module and _core, sync and async) to always pass simulation=True."""
    for owner in (shioaji_module, getattr(shioaji_module, "_core", None)):
        for name in CLIENT_CLASSES:
            original = getattr(owner, name, None) if owner is not None else None
            if original is not None and not getattr(original, "_t8_simulation_only", False):
                setattr(owner, name, _simulation_only(original))
    return shioaji_module.Shioaji


def is_simulation_client(client: Any) -> bool:
    return any(client is built for built in _SIMULATION_CLIENTS)


class LocalSqlite:
    """query/execute callables in the D1 client shape, backed by one local file."""

    def __init__(self, path: Path, *migrations: Path) -> None:
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        for migration in migrations:
            self.conn.executescript(migration.read_text(encoding="utf-8"))

    def query(self, sql: str, params: list[Any] | None = None, timeout: float | None = None) -> list[dict]:
        with self.lock:
            return [dict(row) for row in self.conn.execute(sql, params or []).fetchall()]

    def execute(self, sql: str, params: list[Any] | None = None, timeout: float | None = None) -> dict:
        with self.lock:
            cursor = self.conn.execute(sql, params or [])
            rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
            self.conn.commit()
            return {"success": True, "results": rows, "meta": {"changes": cursor.rowcount}}


class OpenControl:
    """Local stand-in for the R17 chain: always open. The real chain is T9's job."""

    def closed_reason(self) -> None:
        return None


def _tag() -> str:
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(6))


def _version(module: str) -> str | None:
    try:
        from importlib.metadata import version
        return version(module)
    except Exception:
        return None


def _git(*args: str) -> str | None:
    try:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=True).stdout
    except Exception:
        return None


def _provenance() -> dict[str, Any]:
    head, status = _git("rev-parse", "HEAD"), _git("status", "--porcelain", "--", *CODE_FILES)
    return {"git_head": head.strip() if head else None,
            "code_dirty": None if status is None else bool(status.strip()),
            "code_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in CODE_FILES}}


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


# A reason code: lower snake_case words, optionally ":ExceptionType". No digits, no single words.
_REASON = re.compile(r"[a-z]+(?:_[a-z]+)+(?::[A-Za-z]+)?")


class Run:
    def __init__(self, secret_values: list[str]) -> None:
        self.steps: list[dict[str, Any]] = []
        self._secrets = [value for value in secret_values if value]

    def _reason(self, exc: Exception) -> str | None:
        text = str(exc)
        if not _REASON.fullmatch(text) or any(value in text for value in self._secrets):
            return None
        return text

    def step(self, name: str, fn: Callable[[], dict[str, Any] | None]) -> dict[str, Any] | None:
        started = time.monotonic()
        try:
            detail = fn() or {}
            self.steps.append({"step": name, "status": "pass", "detail": detail,
                               "seconds": round(time.monotonic() - started, 3)})
            return detail
        except SimulationOnly:
            raise
        except Exception as exc:  # a reason code only: free text can carry account data
            failed = {"step": name, "status": "fail", "error": type(exc).__name__, "reason": self._reason(exc),
                      "seconds": round(time.monotonic() - started, 3)}
            if isinstance(exc, EvidenceIncomplete):
                failed["problems"] = exc.problems
            self.steps.append(failed)
            return None

    def passed(self, name: str) -> bool:
        return any(s["step"] == name and s["status"] == "pass" for s in self.steps)


def build_gateway(out_dir: Path, env: dict[str, str], account_factory: Callable[[], Any]) -> tuple[Any, LocalSqlite]:
    from services.broker_execution_repository import D1BrokerExecutionRepository
    from services.finlab_execution_gateway import PersistentFinlabExecutionGateway

    store = LocalSqlite(out_dir / "t8_local.sqlite3", GATEWAY_MIGRATION, OBSERVATION_MIGRATION)
    repository = D1BrokerExecutionRepository(store.query, store.execute)
    gateway = PersistentFinlabExecutionGateway(repository, env={**env, **GATEWAY_ENV},
                                               account_factory=account_factory, submission_control=OpenControl())
    return gateway, store


def _healthy(gateway: Any) -> dict[str, Any]:
    health = gateway.health()
    if not health["healthy"]:
        raise RuntimeError(str(health["unhealthy_reason"] or "execution_gateway_unhealthy"))
    return {k: v for k, v in health.items() if k != "unhealthy_reason"}


def _drain(gateway: Any, seconds: float) -> None:
    """Wait (bounded) until the gateway's callback writer has stored every queued event."""
    deadline = time.monotonic() + seconds
    while gateway._events.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.05)


def _truth_detail(truth: dict[str, Any]) -> dict[str, Any]:
    return {k: truth[k] for k in ("status", "exchange", "reference_price", "limit_up", "limit_down")}


def run(args: argparse.Namespace, *, shioaji_module: Any, account_class: Callable[[], Any],
        env: dict[str, str], wait: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    force_simulation(shioaji_module)
    if not getattr(shioaji_module.Shioaji, "_t8_simulation_only", False):
        raise SimulationOnly("t8_simulation_patch_missing")
    if args.fill_test and not args.orders:
        raise SystemExit("--fill-test needs --orders")
    missing = [key for key in REQUIRED_ENV if not env.get(key)]
    if missing:
        raise SystemExit("missing environment: " + ",".join(missing))  # names only, never values
    if (args.out_dir / "t8_local.sqlite3").exists():
        # the evidence counts the whole local store, so an earlier run's events would count as this run's
        raise SystemExit("--out-dir already holds a T8 run; use a new directory")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    gateway, store = build_gateway(args.out_dir, env, account_class)
    from services.live_account_snapshot import LiveAccountObservations

    record = Run([env.get(key, "") for key in REQUIRED_ENV])
    truths: dict[str, dict[str, Any]] = {}
    placed: list[str] = []
    resting: list[str] = []
    filled: list[str] = []
    tags: dict[str, str] = {}  # broker order id -> client tag of every order this run placed
    seen: dict[str, Any] = {}

    def connect() -> dict[str, Any]:
        gateway.ensure_started()
        if not is_simulation_client(gateway._account.api):
            raise SimulationOnly("t8_client_not_from_simulation_factory")
        return _healthy(gateway)
    record.step("connect", connect)
    if record.passed("connect"):  # without a session every later step would log in again
        for symbol, expected in ((args.tse, "TSE"), (args.otc, "OTC")):
            def truth(symbol: str = symbol, expected: str = expected) -> dict[str, Any]:
                got = gateway.broker_truth(symbol=symbol)
                if got["exchange"] != expected:
                    raise ValueError("exchange_mismatch")
                truths[symbol] = got
                return {"symbol": symbol, **_truth_detail(got),
                        "contracts_refreshed": gateway._contracts_refreshed_at is not None}
            record.step(f"broker_truth:{expected}", truth)
        record.step("marks", lambda: {"marks": gateway.marks(symbols=[args.tse, args.otc])["marks"]})
        observations = LiveAccountObservations(query=store.query, execute=store.execute)

        def observe() -> dict[str, Any]:
            got = gateway.capture_account_observation(request_id=f"t8-{_tag()}", repository=observations)
            if got.get("schema_version") != "live-account-observation-v1" or not got.get("sha256"):
                raise ValueError("account_observation_unsealed")
            return {"schema_version": got["schema_version"], "positions": len(got.get("positions") or []),
                    "settlements": len(got.get("settlements") or [])}
        record.step("account_observation", observe)

        if args.orders:
            for symbol in (args.tse, args.otc):
                if symbol not in truths:
                    continue
                low = truths[symbol]["limit_down"]  # a resting buy at the limit-down price
                for odd_lot in (False, True):
                    def order(symbol: str = symbol, odd_lot: bool = odd_lot) -> dict[str, Any]:
                        tag = _tag()
                        order_id = gateway.submit_leg(symbol=symbol, side="buy", quantity=1, price=low,
                                                      odd_lot=odd_lot, exchange=truths[symbol]["exchange"],
                                                      client_tag=tag)
                        tags[order_id] = tag
                        placed.append(order_id)
                        resting.append(order_id)
                        return {"symbol": symbol, "odd_lot": odd_lot, "order_id_present": bool(order_id)}
                    record.step(f"resting_buy:{symbol}:{'odd' if odd_lot else 'board'}", order)
        if args.fill_test and args.tse in truths:
            high = truths[args.tse]["limit_up"]  # a marketable odd-lot buy; the share stays in the simulation account

            def fill() -> dict[str, Any]:
                tag = _tag()
                order_id = gateway.submit_leg(symbol=args.tse, side="buy", quantity=1, price=high, odd_lot=True,
                                              exchange=truths[args.tse]["exchange"], client_tag=tag)
                tags[order_id] = tag
                placed.append(order_id)
                filled.append(order_id)
                return {"symbol": args.tse}
            record.step("marketable_odd_buy", fill)
        if placed:
            wait(args.callback_wait)  # let order and deal callbacks arrive

        def reconcile(key: str) -> dict[str, Any]:
            seen[key] = gateway.reconcile_once()
            return seen[key]
        record.step("reconcile", lambda: reconcile("reconcile"))

        def cancel_open() -> dict[str, Any]:
            api = gateway._account.api
            cancelled = 0
            with gateway._lock:
                api.update_status(api.stock_account)
                for trade in list(api.list_trades() or []):
                    status = str(getattr(trade.status.status, "value", trade.status.status)).lower()
                    if status in {"pendingsubmit", "presubmitted", "submitted", "partfilled"}:
                        api.cancel_order(trade)
                        cancelled += 1
            seen["cancelled"] = cancelled
            return {"cancelled": cancelled}
        if placed:
            record.step("cancel_open_orders", cancel_open)
            wait(args.callback_wait)
            record.step("reconcile_after_cancel", lambda: reconcile("reconcile_after_cancel"))
        _drain(gateway, max(args.callback_wait, 1.0))

        def evidence() -> dict[str, Any]:
            """The broker behaviour only T8 can show; a pass without it would be empty."""
            events = _event_counts(store)
            problems = []
            if placed:
                if _orders_with(store, "ORDER_CALLBACK", placed, tags) < len(placed):
                    problems.append("order_callback_missing")  # every placed order needs its own callback
                if not events.get("STATUS_RECONCILIATION"):
                    problems.append("status_reconciliation_missing")
                if int((seen.get("reconcile") or {}).get("trade_count") or 0) < len(placed):
                    problems.append("reconcile_trade_count_short")
                if seen.get("cancelled") != len(resting):
                    problems.append("cancel_count_mismatch")
            if filled and _orders_with(store, "DEAL_CALLBACK", filled, tags) < len(filled):
                problems.append("deal_callback_missing")
            if problems:
                raise EvidenceIncomplete(problems)
            return {"broker_events": events}
        record.step("evidence", evidence)
        record.step("health", lambda: _healthy(gateway))
    gateway.close()
    receipt = {
        "schema_version": "t8-simulation-receipt-v1",
        "simulation": True,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        **_provenance(),
        "versions": {"shioaji": _version("shioaji"), "finlab": _version("finlab")},
        "symbols": {"TSE": args.tse, "OTC": args.otc},
        "orders_requested": bool(args.orders), "fill_test": bool(args.fill_test),
        "orders_placed": len(placed),
        "broker_events": _event_counts(store),
        "steps": record.steps,
        "overall": "pass" if record.steps and all(s["status"] == "pass" for s in record.steps) else "fail",
    }
    return {**receipt, "receipt_sha256": hashlib.sha256(canonical(receipt).encode()).hexdigest()}


def _orders_with(store: LocalSqlite, event_type: str, order_ids: list[str], tags: dict[str, str]) -> int:
    """How many of these orders have at least one event of this type, by broker order id or client tag."""
    rows = store.query("SELECT broker_order_id, client_tag FROM broker_execution_events WHERE event_type=?",
                       [event_type])
    ids = {row["broker_order_id"] for row in rows} - {None}
    seen_tags = {row["client_tag"] for row in rows} - {None}
    return sum(1 for order_id in order_ids if order_id in ids or tags.get(order_id) in seen_tags)


def _event_counts(store: LocalSqlite) -> dict[str, int]:
    return {row["event_type"]: row["n"] for row in store.query(
        "SELECT event_type, COUNT(*) AS n FROM broker_execution_events GROUP BY event_type")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--tse", default="2330")
    parser.add_argument("--otc", default="6488")
    parser.add_argument("--orders", action="store_true", help="place resting limit-down buys, then cancel them")
    parser.add_argument("--fill-test", action="store_true", help="with --orders: one marketable odd-lot buy")
    parser.add_argument("--callback-wait", type=float, default=5.0)
    args = parser.parse_args(argv)
    if args.fill_test and not args.orders:
        parser.error("--fill-test needs --orders")
    for key in [key for key in os.environ if key.startswith(CLOUD_ENV_PREFIXES)]:
        os.environ.pop(key)
    sys.path.insert(0, str(CONTROLLER))
    import shioaji

    force_simulation(shioaji)  # before finlab builds any client
    from finlab.online.brokers.sinopac import SinopacAccount

    receipt = run(args, shioaji_module=shioaji, account_class=SinopacAccount, env=dict(os.environ))
    text = json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True)
    (args.out_dir / "t8_receipt.json").write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if receipt["overall"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
