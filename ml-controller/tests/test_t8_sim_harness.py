"""T8 harness: simulation-only clients, local stores, and a receipt with no secrets (fake Shioaji)."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("t8_sim_harness", ROOT / "tools/live/t8_sim_harness.py")
harness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(harness)

SECRETS = {"SHIOAJI_API_KEY": "KEYVALUEzz", "SHIOAJI_SECRET_KEY": "SECRETVALUEzz", "SHIOAJI_CERT_PERSON_ID": "A123456789",
           "SHIOAJI_CERT_PASSWORD": "CERTPASSzz", "SHIOAJI_CERT_PATH": "/nonexistent/cert.pfx",
           "SHIOAJI_ACCOUNT_ID": "0987654"}
TODAY = datetime.now(ZoneInfo("Asia/Taipei")).strftime("%Y/%m/%d")
BANDS = {"2330": ("TSE", 1000.0, 1100.0, 900.0), "6488": ("OTC", 500.0, 550.0, 450.0)}


def _enum(value):
    return SimpleNamespace(value=value)


class FakeApi:
    def __init__(self, world):
        self.world = world
        self.stock_account = SimpleNamespace(account_id=SECRETS["SHIOAJI_ACCOUNT_ID"], broker_id="9A95")
        self.Contracts = SimpleNamespace(Stocks={})
        self.trades = []

    def fetch_contracts(self, contract_download=False, contracts_timeout=None):
        self.world.calls.append("fetch_contracts")
        if self.world.download_error:
            raise self.world.download_error
        self.Contracts = SimpleNamespace(Stocks={code: SimpleNamespace(
            code=code, exchange=_enum(ex), reference=ref, limit_up=up, limit_down=down, update_date=TODAY,
            trading_suspended=False) for code, (ex, ref, up, down) in BANDS.items()})

    def snapshots(self, contracts, timeout=None):
        now = time.time_ns()
        return [SimpleNamespace(code=c.code, close=BANDS[c.code][1], ts=now, total_volume=10) for c in contracts]

    def list_positions(self, account, unit=None):
        return []

    def account_balance(self, account=None):
        if self.world.balance_error:
            raise self.world.balance_error
        return SimpleNamespace(acc_balance=100_000.0, date=datetime.now(ZoneInfo("Asia/Taipei")).isoformat(),
                               errmsg="")

    def settlements(self, account):
        return []

    def Order(self, **kw):
        return SimpleNamespace(**kw)

    def place_order(self, contract, order):
        self.world.calls.append(("place_order", contract.code, order.price, order.order_lot.value))
        filled = order.price == BANDS[contract.code][2]
        order_id = f"o{len(self.trades)}"
        cb_id = order_id if self.world.callback_ids in ("both", "id") else ""
        cb_tag = order.custom_field if self.world.callback_ids in ("both", "tag") else ""
        if self.world.callbacks:
            for cb in self.world.order_cbs:
                cb({"operation": {"op_type": "New", "op_code": "00"},
                    "order": {"id": cb_id, "custom_field": cb_tag, "seqno": f"s{len(self.trades)}"},
                    "status": {"id": cb_id, "status": "PreSubmitted", "exchange_ts": "2026-11-23T01:00:00Z"}})
            if filled and self.world.deals:
                for cb in self.world.fill_cbs:
                    cb({"trade_id": cb_id, "order_lot": order.order_lot.value, "quantity": order.quantity,
                        "price": order.price, "custom_field": cb_tag, "ts": "2026-11-23T01:00:01Z"})
        trade = SimpleNamespace(
            order=SimpleNamespace(id=f"o{len(self.trades)}", custom_field=order.custom_field, order_lot=order.order_lot,
                                  ordno=f"n{len(self.trades)}"),
            status=SimpleNamespace(id=f"o{len(self.trades)}", status=_enum("Filled" if filled else "PreSubmitted"),
                                   status_code="00", deal_quantity=order.quantity if filled else 0,
                                   deals=[SimpleNamespace(quantity=order.quantity, price=order.price)] if filled else [],
                                   modified_time="2026-11-23T01:00:00Z"))
        self.trades.append(trade)
        return trade

    def update_status(self, account=None, timeout=None):
        self.world.calls.append("update_status")

    def list_trades(self):
        return list(self.trades)

    def cancel_order(self, trade):
        self.world.calls.append(("cancel_order", trade.order.id))
        trade.status.status = _enum("Cancelled")

    def logout(self):
        pass


class World:
    def __init__(self):
        self.clients: list[dict] = []
        self.calls: list = []
        self.download_error = None
        self.balance_error = None
        self.login_error = None
        self.callbacks = True
        self.deals = True
        self.callback_ids = "both"  # which identifiers the callbacks carry: both, id or tag
        self.order_cbs, self.fill_cbs = [], []
        world = self

        class Shioaji:
            def __init__(self, simulation=None, proxy=None, vpn=None):
                world.clients.append({"simulation": simulation})
                self._api = FakeApi(world)

            def __getattr__(self, name):
                return getattr(self._api, name)

        self.module = SimpleNamespace(
            Shioaji=Shioaji, Stock=lambda **kw: SimpleNamespace(**kw),
            SecurityType=SimpleNamespace(Stock="STK"), Exchange=SimpleNamespace(TSE="TSE", OTC="OTC"),
            Action=SimpleNamespace(Buy="Buy", Sell="Sell"), StockPriceType=SimpleNamespace(LMT="LMT"),
            OrderType=SimpleNamespace(ROD="ROD"),
            StockOrderLot=SimpleNamespace(Common=_enum("Common"), IntradayOdd=_enum("IntradayOdd")),
            Unit=SimpleNamespace(Share="Share"))
        module = self.module

        class Sinopac:  # finlab SinopacAccount builds its client from the module attribute at call time
            def __init__(self):
                world.calls.append("login")
                if world.login_error:
                    raise world.login_error
                self.api = module.Shioaji()

            def on_order_update(self, cb):
                world.order_cbs.append(cb)

            def on_fill(self, cb):
                world.fill_cbs.append(cb)

            def on_connection(self, cb):
                pass

            def connect_realtime(self):
                pass

            def disconnect_realtime(self):
                pass

            def get_cash(self):
                return 100_000

        self.account_class = Sinopac


def _args(tmp_path, **kw):
    return argparse.Namespace(out_dir=tmp_path / "t8", tse="2330", otc="6488", orders=kw.get("orders", False),
                              fill_test=kw.get("fill_test", False), callback_wait=kw.get("callback_wait", 0.0))


def _run(tmp_path, world=None, env=None, **kw):
    world = world or World()
    return harness.run(_args(tmp_path, **kw), shioaji_module=world.module, account_class=world.account_class,
                       env=env if env is not None else dict(SECRETS), wait=lambda s: None), world


@pytest.fixture(autouse=True)
def _no_cloud(monkeypatch):
    import services.d1_domain_client as d1

    def refuse(*a, **k):
        raise AssertionError("T8 must not build a D1 client")
    monkeypatch.setattr(d1, "client_for_domain", refuse)
    monkeypatch.setattr(d1, "DomainD1Client", refuse)


@pytest.fixture
def fake_sj(monkeypatch):
    world = World()
    monkeypatch.setitem(sys.modules, "shioaji", world.module)
    return world


def _text(receipt):
    return json.dumps(receipt, ensure_ascii=False)


def test_a_full_simulation_run_passes_with_only_simulation_clients(tmp_path, fake_sj):
    receipt, world = _run(tmp_path, world=fake_sj, orders=True, fill_test=True)
    assert receipt["overall"] == "pass", json.dumps(receipt["steps"], indent=1)
    assert world.clients == [{"simulation": True}]
    assert receipt["orders_placed"] == 5 and receipt["simulation"] is True
    places = [c for c in world.calls if isinstance(c, tuple) and c[0] == "place_order"]
    assert places == [("place_order", "2330", 900.0, "Common"), ("place_order", "2330", 900.0, "IntradayOdd"),
                      ("place_order", "6488", 450.0, "Common"), ("place_order", "6488", 450.0, "IntradayOdd"),
                      ("place_order", "2330", 1100.0, "IntradayOdd")]
    cancel = next(s for s in receipt["steps"] if s["step"] == "cancel_open_orders")
    assert cancel["detail"] == {"cancelled": 4}  # the filled marketable buy is not cancelled
    assert world.calls.count("fetch_contracts") == 1  # the empty login table is downloaded once
    events = receipt["broker_events"]
    assert events["ORDER_CALLBACK"] == 5 and events["DEAL_CALLBACK"] == 1 and events["STATUS_RECONCILIATION"] == 9  # 5 placed + 4 cancelled; the repository dedups unchanged rows
    assert next(s for s in receipt["steps"] if s["step"] == "evidence")["detail"] == {"broker_events": events}
    assert set(receipt) == {"schema_version", "simulation", "finished_at", "git_head", "code_dirty", "code_sha256",
                            "versions", "symbols", "orders_requested", "fill_test", "orders_placed",
                            "broker_events", "steps", "overall", "receipt_sha256"}
    observation = next(s for s in receipt["steps"] if s["step"] == "account_observation")["detail"]
    assert observation == {"schema_version": "live-account-observation-v1", "positions": 0, "settlements": 0}
    assert receipt["code_sha256"]["tools/live/t8_sim_harness.py"] == hashlib.sha256(
        (ROOT / "tools/live/t8_sim_harness.py").read_bytes()).hexdigest()
    assert len(receipt["code_sha256"]) == 4
    body = {k: v for k, v in receipt.items() if k != "receipt_sha256"}
    golden = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert receipt["receipt_sha256"] == hashlib.sha256(golden.encode()).hexdigest()
    import sqlite3
    with sqlite3.connect(tmp_path / "t8" / "t8_local.sqlite3") as conn:  # persisted, not only in memory
        assert conn.execute("SELECT COUNT(*) FROM broker_execution_events").fetchone()[0] == sum(events.values())
    text = _text(receipt)
    for value in SECRETS.values():
        assert value not in text
    assert (tmp_path / "t8" / "t8_local.sqlite3").exists()


def test_no_order_is_placed_without_the_orders_flag(tmp_path, fake_sj):
    receipt, world = _run(tmp_path, world=fake_sj)
    assert receipt["overall"] == "pass" and receipt["orders_placed"] == 0
    assert not any(isinstance(c, tuple) for c in world.calls)
    assert [s["step"] for s in receipt["steps"]] == ["connect", "broker_truth:TSE", "broker_truth:OTC", "marks",
                                                     "account_observation", "reconcile", "evidence", "health"]


def test_production_clients_are_refused(fake_sj):
    patched = harness.force_simulation(fake_sj.module)
    assert harness.force_simulation(fake_sj.module) is patched  # idempotent
    with pytest.raises(harness.SimulationOnly):
        fake_sj.module.Shioaji(simulation=False)
    with pytest.raises(harness.SimulationOnly):
        fake_sj.module.Shioaji(False)
    client = fake_sj.module.Shioaji()
    fake_sj.module.Shioaji(simulation=None)
    fake_sj.module.Shioaji(simulation=0)
    assert fake_sj.clients == [{"simulation": True}] * 3
    assert harness.is_simulation_client(client) and not harness.is_simulation_client(object())


def test_missing_credentials_are_named_not_printed(tmp_path, fake_sj):
    env = {k: v for k, v in SECRETS.items() if k != "SHIOAJI_CERT_PASSWORD"}
    with pytest.raises(SystemExit) as error:
        _run(tmp_path, world=fake_sj, env=env)
    assert str(error.value) == "missing environment: SHIOAJI_CERT_PASSWORD"
    assert fake_sj.clients == []


def test_failures_keep_reason_codes_and_drop_free_text(tmp_path, fake_sj):
    fake_sj.download_error = OSError("acct 0987654 secret")
    fake_sj.balance_error = ValueError("0987654")
    receipt, _ = _run(tmp_path, world=fake_sj)
    steps = {s["step"]: s for s in receipt["steps"]}
    assert steps["broker_truth:TSE"]["reason"] == "broker_contract_refresh_failed:OSError"
    assert steps["account_observation"] == {**steps["account_observation"], "status": "fail", "error": "ValueError",
                                            "reason": None}
    assert receipt["overall"] == "fail" and "0987654" not in _text(receipt)


def test_an_identity_mismatch_fails_the_reads(tmp_path, fake_sj):
    env = {**SECRETS, "SHIOAJI_ACCOUNT_ID": "1111111"}
    receipt, _ = _run(tmp_path, world=fake_sj, env=env)
    steps = {s["step"]: s for s in receipt["steps"]}
    assert steps["broker_truth:TSE"]["reason"] == "live_account_identity_mismatch"
    assert steps["account_observation"]["reason"] == "live_account_identity_mismatch"
    assert receipt["overall"] == "fail"


def test_main_drops_cloud_credentials_and_patches_before_finlab(tmp_path, monkeypatch, fake_sj):
    seen = {}
    finlab = SimpleNamespace(SinopacAccount=fake_sj.account_class)
    monkeypatch.setitem(sys.modules, "finlab.online.brokers.sinopac", finlab)
    for key in ("CF_D1_DB_ID", "MULTI_D1_PAPER_DB_ID", "GOOGLE_CLOUD_PROJECT", "SJ_ADMIN_GATEWAY_URL",
                "CLOUDFLARE_API_TOKEN", "EXECUTION_GATEWAY_URL", "GCP_PROJECT", "CF_API_TOKEN"):
        monkeypatch.setenv(key, "cloud-value")
    monkeypatch.setenv("SHIOAJI_API_KEY", "kept")

    def fake_run(args, *, shioaji_module, account_class, env):
        seen.update(env=env, patched=getattr(shioaji_module.Shioaji, "_t8_simulation_only", False),
                    account_class=account_class)
        return {"overall": "pass", "receipt_sha256": "x"}
    monkeypatch.setattr(harness, "run", fake_run)
    out = tmp_path / "t8"
    out.mkdir()
    assert harness.main(["--out-dir", str(out)]) == 0
    assert seen["patched"] and seen["account_class"] is fake_sj.account_class
    assert "cloud-value" not in seen["env"].values() and seen["env"]["SHIOAJI_API_KEY"] == "kept"
    assert json.loads((out / "t8_receipt.json").read_text())["overall"] == "pass"


def test_symbols_on_the_wrong_exchange_fail(tmp_path, fake_sj):
    args = _args(tmp_path)
    args.tse, args.otc = "6488", "2330"
    receipt = harness.run(args, shioaji_module=fake_sj.module, account_class=fake_sj.account_class,
                          env=dict(SECRETS), wait=lambda s: None)
    steps = {s["step"]: s for s in receipt["steps"]}
    assert steps["broker_truth:TSE"]["reason"] == steps["broker_truth:OTC"]["reason"] == "exchange_mismatch"
    assert receipt["overall"] == "fail"


def test_an_unhealthy_gateway_fails_the_run(tmp_path, fake_sj):
    original = FakeApi.list_trades

    def odd_lot_unknown(self):
        return [SimpleNamespace(order=SimpleNamespace(id="x", custom_field="", order_lot=_enum("Weird")),
                                status=SimpleNamespace(id="x", status=_enum("Filled"), deals=[]))]
    FakeApi.list_trades = odd_lot_unknown
    try:
        receipt, _ = _run(tmp_path, world=fake_sj)
    finally:
        FakeApi.list_trades = original
    # ensure_started reconciles once, so the unknown lot type already fails connect and stops the run
    assert [st["step"] for st in receipt["steps"]] == ["connect"]
    assert receipt["steps"][0]["status"] == "fail"
    assert receipt["steps"][0]["reason"] == "broker_fill_lot_type_unrecognized"
    assert receipt["overall"] == "fail"


def test_without_callbacks_the_evidence_step_fails(tmp_path, fake_sj):
    fake_sj.callbacks = False
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True, fill_test=True)
    step = next(s for s in receipt["steps"] if s["step"] == "evidence")
    assert step["status"] == "fail" and step["problems"] == ["order_callback_missing", "deal_callback_missing"]
    assert receipt["overall"] == "fail"


def test_a_missing_deal_callback_fails_the_evidence(tmp_path, fake_sj):
    fake_sj.deals = False
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True, fill_test=True)
    step = next(s for s in receipt["steps"] if s["step"] == "evidence")
    assert step["problems"] == ["deal_callback_missing"]


def test_an_order_left_open_fails_the_evidence(tmp_path, fake_sj, monkeypatch):
    def place_filled_first(self, contract, order, _original=FakeApi.place_order):
        trade = _original(self, contract, order)
        if len(self.trades) == 1:  # the first resting buy fills at limit-down in this simulation
            trade.status.status = _enum("Filled")
        return trade
    monkeypatch.setattr(FakeApi, "place_order", place_filled_first)
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True)
    step = next(s for s in receipt["steps"] if s["step"] == "evidence")
    assert step["problems"] == ["cancel_count_mismatch"]


@pytest.mark.parametrize("keep", [1, 3])  # 3 of 4 is the off-by-one edge
def test_a_short_reconcile_fails_the_evidence(tmp_path, fake_sj, monkeypatch, keep):
    monkeypatch.setattr(FakeApi, "list_trades", lambda self: list(self.trades)[:keep])
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True)
    step = next(s for s in receipt["steps"] if s["step"] == "evidence")
    assert step["problems"] == ["reconcile_trade_count_short", "cancel_count_mismatch"]


def test_fill_test_needs_orders(tmp_path, fake_sj, capsys):
    with pytest.raises(SystemExit):
        _run(tmp_path, world=fake_sj, fill_test=True)
    assert fake_sj.clients == []
    with pytest.raises(SystemExit) as error:
        harness.main(["--out-dir", str(tmp_path), "--fill-test"])
    assert error.value.code == 2 and "--fill-test needs --orders" in capsys.readouterr().err


def test_a_failed_login_stops_the_run(tmp_path, fake_sj):
    fake_sj.login_error = RuntimeError("login refused for 0987654")
    receipt, world = _run(tmp_path, world=fake_sj, orders=True)
    assert [s["step"] for s in receipt["steps"]] == ["connect"]
    assert world.calls.count("login") == 1 and receipt["overall"] == "fail" and receipt["orders_placed"] == 0
    assert receipt["steps"][0]["reason"] is None


def test_a_client_built_outside_the_factory_aborts(tmp_path, fake_sj):
    unpatched = fake_sj.module.Shioaji

    class Direct(fake_sj.account_class):
        def __init__(self):
            self.api = unpatched()  # bound before the patch: a production client in real life
    with pytest.raises(harness.SimulationOnly, match="not_from_simulation_factory"):
        harness.run(_args(tmp_path), shioaji_module=fake_sj.module, account_class=Direct, env=dict(SECRETS),
                    wait=lambda s: None)


def test_async_and_core_clients_are_wrapped_too():
    calls = []

    def maker(name):
        return lambda simulation=None, **kw: calls.append((name, simulation)) or object()
    core = SimpleNamespace(Shioaji=maker("core"), ShioajiAsync=maker("core_async"))
    module = SimpleNamespace(Shioaji=maker("sync"), ShioajiAsync=maker("async"), _core=core)
    harness.force_simulation(module)
    for client in (module.Shioaji, module.ShioajiAsync, core.Shioaji, core.ShioajiAsync):
        client()
        with pytest.raises(harness.SimulationOnly):
            client(simulation=False)
    assert calls == [("sync", True), ("async", True), ("core", True), ("core_async", True)]


@pytest.mark.parametrize("message,reason", [
    ("CERTPASSzz", None),  # a single word can be a password
    ("broker contract missing", None),
    ("broker_contract_missing", "broker_contract_missing"),
    ("broker_contract_refresh_failed:OSError", "broker_contract_refresh_failed:OSError"),
    ("account_0987654", None),
    ("lowercaseword", None),  # one lowercase word can be a password too
    ("certpass_value", None),  # equals a credential value
])
def test_reason_codes(message, reason):
    def boom():
        raise ValueError(message)
    run = harness.Run(["certpass_value"])
    run.step("x", boom)
    assert run.steps[0]["reason"] == reason


def test_main_exits_one_when_the_run_fails(tmp_path, monkeypatch, fake_sj):
    monkeypatch.setitem(sys.modules, "finlab.online.brokers.sinopac", SimpleNamespace(SinopacAccount=object))
    monkeypatch.setattr(harness, "run", lambda *a, **k: {"overall": "fail", "receipt_sha256": "x"})
    out = tmp_path / "t8"
    out.mkdir()
    assert harness.main(["--out-dir", str(out)]) == 1


def test_callbacks_are_waited_for_when_orders_were_placed(tmp_path, fake_sj):
    waits = []
    harness.run(_args(tmp_path, orders=True, callback_wait=3.0), shioaji_module=fake_sj.module,
                account_class=fake_sj.account_class, env=dict(SECRETS), wait=waits.append)
    assert waits == [3.0, 3.0]


def test_no_status_reconciliation_fails_the_evidence(tmp_path, fake_sj, monkeypatch):
    monkeypatch.setattr(FakeApi, "list_trades", lambda self: [])
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True)
    step = next(s for s in receipt["steps"] if s["step"] == "evidence")
    assert step["problems"] == ["status_reconciliation_missing", "reconcile_trade_count_short",
                                "cancel_count_mismatch"]


@pytest.mark.parametrize("porcelain,dirty", [(" M tools/live/t8_sim_harness.py\n", True), ("", False), (None, None)])
def test_provenance_reports_uncommitted_code(monkeypatch, porcelain, dirty):
    monkeypatch.setattr(harness, "_git", lambda *a: "abc123\n" if a[0] == "rev-parse" else porcelain)
    provenance = harness._provenance()
    assert provenance["git_head"] == "abc123" and provenance["code_dirty"] is dirty


def test_a_reused_out_dir_is_refused(tmp_path, fake_sj):
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True, fill_test=True)
    assert receipt["overall"] == "pass"
    fake_sj.callbacks = False  # the second run gets no callbacks; the first run's events must not count
    with pytest.raises(SystemExit, match="already holds a T8 run"):
        _run(tmp_path, world=fake_sj, orders=True, fill_test=True)


def test_each_placed_order_needs_its_own_order_callback(tmp_path, fake_sj, monkeypatch):
    original = FakeApi.place_order

    def first_callback_only(self, contract, order):
        fake_sj.callbacks = not self.trades  # only the first order fires callbacks
        return original(self, contract, order)
    monkeypatch.setattr(FakeApi, "place_order", first_callback_only)
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True)
    assert receipt["broker_events"]["ORDER_CALLBACK"] == 1
    step = next(s for s in receipt["steps"] if s["step"] == "evidence")
    assert step["problems"] == ["order_callback_missing"] and receipt["overall"] == "fail"


def test_a_deal_callback_for_another_order_does_not_count(tmp_path, fake_sj, monkeypatch):
    original = FakeApi.place_order

    def foreign_deal(self, contract, order):
        marketable = order.price == BANDS[contract.code][2]
        fake_sj.deals = not marketable  # the fill's own deal callback never arrives
        trade = original(self, contract, order)
        if marketable:
            for cb in fake_sj.fill_cbs:
                cb({"trade_id": "elsewhere", "order_lot": order.order_lot.value, "quantity": 1,
                    "price": order.price, "custom_field": "zzzzzz", "ts": "2026-11-23T01:00:01Z"})
        return trade
    monkeypatch.setattr(FakeApi, "place_order", foreign_deal)
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True, fill_test=True)
    assert receipt["broker_events"]["DEAL_CALLBACK"] == 1  # recorded, but for an order this run never placed
    step = next(s for s in receipt["steps"] if s["step"] == "evidence")
    assert step["problems"] == ["deal_callback_missing"]


@pytest.mark.parametrize("carried", ["id", "tag"])
def test_callbacks_match_by_either_identifier(tmp_path, fake_sj, carried):
    fake_sj.callback_ids = carried  # the simulation may send only the order id or only custom_field
    receipt, _ = _run(tmp_path, world=fake_sj, orders=True, fill_test=True)
    assert receipt["broker_events"]["ORDER_CALLBACK"] == 5 and receipt["broker_events"]["DEAL_CALLBACK"] == 1
    assert next(s for s in receipt["steps"] if s["step"] == "evidence")["status"] == "pass"
    assert receipt["overall"] == "pass"
