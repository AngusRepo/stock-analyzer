from __future__ import annotations

import sys
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import d1_client  # noqa: E402


class _FakeResponse:
    status_code = 200
    text = ""

    def __init__(self, payload: dict):
        self._payload = payload

    def json(self) -> dict:
        return self._payload


def test_query_prefers_worker_read_proxy(monkeypatch):
    calls: list[dict] = []

    def fake_post(url, headers, json, timeout):
        calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return _FakeResponse({
            "ok": True,
            "results": [{"symbol": "2330", "date": "2026-05-22"}],
            "mode": "worker_d1_query",
        })

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=fake_post, RequestError=Exception))

    rows = d1_client.query("SELECT symbol, date FROM daily_recommendations WHERE date=?", ["2026-05-22"])

    assert rows == [{"symbol": "2330", "date": "2026-05-22"}]
    assert calls[0]["url"] == "https://worker.example/api/internal/d1/query"
    assert calls[0]["headers"]["Authorization"] == "Bearer token"
    assert calls[0]["json"] == {
        "sql": "SELECT symbol, date FROM daily_recommendations WHERE date=?",
        "params": ["2026-05-22"],
    }


def test_query_falls_back_to_direct_rest_when_worker_query_unavailable(monkeypatch):
    calls: list[dict] = []

    def fake_worker_query(*args, **kwargs):
        raise RuntimeError("worker route not deployed")

    def fake_post(body, timeout=60.0):
        calls.append({"body": body, "timeout": timeout})
        return {
            "success": True,
            "result": [{"results": [{"ok": 1}], "meta": {}}],
        }

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "_worker_query", fake_worker_query)
    monkeypatch.setattr(d1_client, "_post", fake_post)

    rows = d1_client.query("SELECT 1 AS ok", timeout=12.0)

    assert rows == [{"ok": 1}]
    assert calls == [{"body": {"sql": "SELECT 1 AS ok"}, "timeout": 12.0}]


def test_execute_prefers_worker_single_statement_batch(monkeypatch):
    calls: list[dict] = []

    def fake_worker_batch(statements, timeout=30.0, chunk_size=250):
        calls.append({"statements": statements, "timeout": timeout, "chunk_size": chunk_size})
        return {
            "mode": "worker_d1_batch",
            "total": len(statements),
            "success_count": len(statements),
            "error_count": 0,
            "changes_total": 1,
        }

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "_worker_batch_execute", fake_worker_batch)

    result = d1_client.execute(
        "INSERT OR REPLACE INTO dataset_snapshots(snapshot_id, kind) VALUES(?, ?)",
        ["s1", "backtest_dataset"],
        timeout=42.0,
    )

    assert result["success"] is True
    assert result["mode"] == "worker_d1_batch"
    assert result["meta"]["changes"] == 1
    assert calls == [{
        "statements": [("INSERT OR REPLACE INTO dataset_snapshots(snapshot_id, kind) VALUES(?, ?)", ["s1", "backtest_dataset"])],
        "timeout": 42.0,
        "chunk_size": 1,
    }]


def test_batch_execute_prefers_worker_true_batch(monkeypatch):
    calls: list[dict] = []

    def fake_post(url, headers, json, timeout):
        calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return _FakeResponse({
            "ok": True,
            "total": len(json["statements"]),
            "success_count": len(json["statements"]),
            "error_count": 0,
            "changes_total": 7,
        })

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=fake_post, RequestError=Exception))

    result = d1_client.batch_execute(
        [
            ("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10]),
            ("DELETE FROM concept_buzz WHERE date=?", ["2026-05-03"]),
        ],
        chunk_size=250,
    )

    assert result["mode"] == "worker_d1_batch"
    assert result["total"] == 2
    assert result["changes_total"] == 7
    assert calls[0]["url"] == "https://worker.example/api/internal/d1/batch"
    assert calls[0]["json"]["statements"][0]["sql"].startswith("UPDATE predictions")


def test_batch_execute_falls_back_to_raw_batch_when_worker_unavailable(monkeypatch):
    raw_calls: list[tuple[list[tuple[str, list]], float, int]] = []

    def fake_worker_batch(*args, **kwargs):
        raise RuntimeError("worker down")

    def fake_raw_batch(statements, timeout=30.0, chunk_size=250):
        raw_calls.append((statements, timeout, chunk_size))
        return {
            "mode": "d1_raw_batch",
            "total": len(statements),
            "success_count": len(statements),
            "error_count": 0,
            "changes_total": 1,
        }

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "_worker_batch_execute", fake_worker_batch)
    monkeypatch.setattr(d1_client, "_raw_batch_execute", fake_raw_batch)

    result = d1_client.batch_execute([
        ("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10]),
    ])

    assert result["mode"] == "d1_raw_batch"
    assert result["success_count"] == 1
    assert raw_calls[0][0] == [("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10])]


def test_batch_execute_only_uses_rest_loop_after_raw_batch_failure(monkeypatch):
    execute_calls: list[tuple[str, list]] = []

    def fake_worker_batch(*args, **kwargs):
        raise RuntimeError("worker down")

    def fake_raw_batch(*args, **kwargs):
        raise RuntimeError("raw down")

    def fake_execute(sql, params, timeout=60.0):
        execute_calls.append((sql, params))
        return {"meta": {"changes": 1}}

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "_worker_batch_execute", fake_worker_batch)
    monkeypatch.setattr(d1_client, "_raw_batch_execute", fake_raw_batch)
    monkeypatch.setattr(d1_client, "execute", fake_execute)

    result = d1_client.batch_execute([
        ("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10]),
    ])

    assert result["mode"] == "rest_loop_fallback"
    assert result["success_count"] == 1
    assert execute_calls == [("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10])]


def test_raw_batch_execute_uses_d1_raw_batch_endpoint(monkeypatch):
    calls: list[dict] = []

    def fake_post(url, headers, json, timeout):
        calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return _FakeResponse({
            "success": True,
            "result": [
                {"success": True, "meta": {"changes": 2, "rows_written": 2, "timings": {"sql_duration_ms": 1.5}}},
                {"success": True, "meta": {"changes": 1, "rows_written": 1, "timings": {"sql_duration_ms": 0.5}}},
            ],
        })

    monkeypatch.setattr(d1_client, "CF_API_TOKEN", "token")
    monkeypatch.setattr(d1_client, "CF_ACCOUNT_ID", "account")
    monkeypatch.setattr(d1_client, "CF_D1_DB_ID", "db")
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=fake_post, RequestError=Exception))

    result = d1_client._raw_batch_execute([
        ("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10]),
        ("DELETE FROM concept_buzz WHERE date=?", ["2026-05-03"]),
    ])

    assert result["mode"] == "d1_raw_batch"
    assert result["total"] == 2
    assert result["success_count"] == 2
    assert result["changes_total"] == 3
    assert result["rows_written_total"] == 3
    assert result["sql_duration_ms_total"] == 2.0
    assert calls[0]["url"] == "https://api.cloudflare.com/client/v4/accounts/account/d1/database/db/raw"
    assert calls[0]["json"]["batch"][0]["sql"].startswith("UPDATE predictions")
