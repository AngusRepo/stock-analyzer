from __future__ import annotations

import copy
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from services.live_account_snapshot import (  # noqa: E402
    LiveAccountObservations, account_scope, build_observation, capture_observation,
)
from services.finlab_execution_gateway import PersistentFinlabExecutionGateway  # noqa: E402


@pytest.fixture
def store():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript((ROOT.parent / "worker/domain-migrations/execution/0006_live_account_observations.sql").read_text())
    def query(sql, params, timeout):
        return [dict(row) for row in connection.execute(sql, params)]
    def execute(sql, params, timeout):
        cursor = connection.execute(sql, params)
        connection.commit()
        return {"changes": cursor.rowcount}
    yield LiveAccountObservations(query=query, execute=execute), connection
    connection.close()


class Api:
    def __init__(self):
        self.stock_account = SimpleNamespace(account_id="test-live-account", broker_id="test-broker")
        self.reads = []
        self.balance = {"acc_balance": 100_000, "date": "2026-10-21 10:00:00", "errmsg": ""}
        self.positions = [{"id": 1, "code": "2330", "quantity": 1209, "direction": "Buy", "cond": "Cash"}]
        self.pending = [{"date": "2026-10-22", "amount": 30_000, "T": 1},
                        {"date": "2026-10-23", "amount": -10_000, "T": 2}]

    def account_balance(self, *, account):
        assert account is self.stock_account
        self.reads.append("balance")
        return self.balance

    def list_positions(self, account, *, unit):
        assert account is self.stock_account and unit == "Share"
        self.reads.append("positions")
        return self.positions

    def settlements(self, account):
        assert account is self.stock_account
        self.reads.append("settlements")
        return self.pending


def capture(api, repository, request_id="opening-1"):
    return capture_observation(SimpleNamespace(api=api), expected_account_id="test-live-account",
                               request_id=request_id, repository=repository, share_unit="Share")


def test_capture_preserves_share_units_cash_and_signed_settlements_separately(store):
    repository, db = store
    api = Api()
    result = capture(api, repository)
    assert result["bank_balance"] == 100_000
    assert result["positions"][0]["shares"] == 1209
    assert [row["net_amount"] for row in result["settlements"]] == [30_000, -10_000]
    assert result["nav"] is None and result["buying_power"] is None and not result["decision_ready"]
    assert "test-live-account" not in str(result) and "test-broker" not in str(result)
    assert db.execute("SELECT count(*) FROM live_account_observations_v1").fetchone()[0] == 1
    assert api.reads == ["balance", "positions", "settlements"]
    assert capture(api, repository) == result  # ACK retry does not read newer broker data.
    assert len(api.reads) == 3


def test_live_scope_keeps_accounts_and_paper_book_separate(store):
    repository, db = store
    db.executescript("CREATE TABLE paper_accounts(id INTEGER PRIMARY KEY,cash REAL); INSERT INTO paper_accounts VALUES(1,777);")
    api = Api()
    first = capture(api, repository)
    api.stock_account = SimpleNamespace(account_id="another-live-account", broker_id="test-broker")
    second = capture_observation(SimpleNamespace(api=api), expected_account_id="another-live-account",
        request_id="opening-1", repository=repository, share_unit="Share")
    assert first["account_scope"] != second["account_scope"]
    assert db.execute("SELECT cash FROM paper_accounts WHERE id=1").fetchone()[0] == 777
    assert db.execute("SELECT count(*) FROM live_account_observations_v1").fetchone()[0] == 2


def test_immutable_rows_cannot_be_updated_deleted_or_replaced(store):
    repository, db = store
    first = capture(Api(), repository)
    for sql in ["UPDATE live_account_observations_v1 SET payload_json='{}'", "DELETE FROM live_account_observations_v1",
                "INSERT OR REPLACE INTO live_account_observations_v1 SELECT account_scope,request_id,observed_at,'changed',payload_json FROM live_account_observations_v1",
                "INSERT OR REPLACE INTO live_account_observations_v1 SELECT account_scope,request_id,observed_at,sha256,'{}' FROM live_account_observations_v1"]:
        with pytest.raises(sqlite3.IntegrityError, match="immutable|conflict"):
            db.execute(sql)
        db.rollback()
    assert repository.get(first["account_scope"], "opening-1") == first


def test_same_request_with_changed_payload_cannot_overwrite(store):
    repository, _ = store
    api = Api()
    first = capture(api, repository)
    changed = build_observation(scope=first["account_scope"], request_id="opening-1",
        balance={**api.balance, "acc_balance": 10}, positions=api.positions,
        settlements=api.pending, observed_at=first["observed_at"])
    with pytest.raises(sqlite3.IntegrityError, match="conflict"):
        repository.append(changed)
    assert repository.get(first["account_scope"], "opening-1") == first


@pytest.mark.parametrize("failure", ["wrong_account", "missing_positions", "missing_settlements", "nan_cash",
                                    "balance_error", "duplicate_position", "duplicate_settlement", "fractional_shares"])
def test_unverifiable_sources_never_persist_or_fallback(store, failure):
    repository, db = store
    api = Api()
    if failure == "wrong_account":
        api.stock_account.account_id = "wrong"
    elif failure == "missing_positions":
        api.positions = None
    elif failure == "missing_settlements":
        api.pending = None
    elif failure == "nan_cash":
        api.balance["acc_balance"] = float("nan")
    elif failure == "balance_error":
        api.balance["errmsg"] = "not available"
    elif failure == "duplicate_position":
        api.positions *= 2
    elif failure == "duplicate_settlement":
        api.pending *= 2
    else:
        api.positions[0]["quantity"] = 1.1
    with pytest.raises(ValueError):
        capture(api, repository)
    assert db.execute("SELECT count(*) FROM live_account_observations_v1").fetchone()[0] == 0


def test_corrupt_readback_fails_integrity(store):
    repository, _ = store
    first = capture(Api(), repository)
    bad = copy.deepcopy(first)
    bad["bank_balance"] += 1
    repository._query = lambda *args: [{"payload_json": __import__("json").dumps(bad), "sha256": first["sha256"]}]
    with pytest.raises(RuntimeError, match="integrity"):
        repository.get(first["account_scope"], "opening-1")


def test_dedicated_execution_binding_required(monkeypatch):
    monkeypatch.delenv("CF_D1_EXECUTION_DB_ID", raising=False)
    monkeypatch.setenv("CF_D1_DB_ID", "legacy-paper-must-not-be-used")
    with pytest.raises(RuntimeError, match="database id missing: execution"):
        LiveAccountObservations().get("live:sinopac:test", "opening-1")


def test_gateway_read_admission_does_not_login_or_write_when_disabled():
    gateway = PersistentFinlabExecutionGateway(object(), env={"LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED": "0"})
    gateway.ensure_started = lambda: pytest.fail("must not connect")
    with pytest.raises(RuntimeError, match="broker_read_disabled"):
        gateway.capture_account_observation(request_id="opening-1")


def test_gateway_reuses_existing_connection_and_reads_even_when_submission_paused(store, monkeypatch):
    repository, _ = store
    monkeypatch.setitem(sys.modules, "shioaji", SimpleNamespace(Unit=SimpleNamespace(Share="Share")))
    gateway = PersistentFinlabExecutionGateway(object(), env={
        "LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED": "1", "SHIOAJI_ACCOUNT_ID": "test-live-account"})
    gateway._account = SimpleNamespace(api=Api())
    gateway.ensure_started = lambda: None
    gateway.assert_live_submission_allowed = lambda: pytest.fail("observation must not request order admission")
    result = gateway.capture_account_observation(request_id="opening-1", repository=repository)
    assert not result["decision_ready"] and result["positions"][0]["shares"] == 1209


def test_private_endpoint_authenticates_before_broker_read_and_sanitizes_failures(monkeypatch):
    import execution_gateway_app as app
    from fastapi import HTTPException

    monkeypatch.setattr(app, "SERVICE_ROLE", "dedicated_execution_gateway")
    monkeypatch.setattr(app, "SERVICE_TOKEN", "unit-test-observation-token")
    calls = []
    monkeypatch.setattr(app.gateway, "capture_account_observation", lambda **kwargs: calls.append(kwargs) or {"nav": None})
    request = app.AccountObservationRequest(request_id="opening-1")
    with pytest.raises(HTTPException) as error:
        app.capture_account_observation(request, authorization=None)
    assert error.value.status_code == 401 and calls == []
    assert app.capture_account_observation(request, authorization="Bearer unit-test-observation-token") == {"nav": None}
    assert calls == [{"request_id": "opening-1"}]
    def failed(**kwargs):
        raise RuntimeError("broker error containing private account data")
    monkeypatch.setattr(app.gateway, "capture_account_observation", failed)
    with pytest.raises(HTTPException) as error:
        app.capture_account_observation(request, authorization="Bearer unit-test-observation-token")
    assert error.value.status_code == 503
    assert error.value.detail == "live account observation unavailable"
