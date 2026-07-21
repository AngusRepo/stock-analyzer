from __future__ import annotations

import sys
from types import SimpleNamespace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import d1_client  # noqa: E402


class _FakeResponse:
    status_code = 200
    text = ""

    def __init__(self, payload: dict):
        self._payload = payload

    def json(self) -> dict:
        return self._payload


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


def test_worker_batch_preserves_explicit_zero_success(monkeypatch):
    def fake_post(url, headers, json, timeout):
        return _FakeResponse({
            "ok": True,
            "total": 1,
            "success_count": 0,
            "error_count": 1,
            "changes_total": 0,
            "first_error": "rejected",
        })

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "httpx", SimpleNamespace(post=fake_post, RequestError=Exception))

    result = d1_client._worker_batch_execute([("INSERT INTO sample VALUES (?)", [1])])

    assert result["success_count"] == 0
    assert result["error_count"] == 1


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


def test_batch_execute_does_not_bypass_worker_validation_with_raw_batch(monkeypatch):
    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(
        d1_client,
        "_worker_batch_execute",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            d1_client.WorkerD1BatchValidationError("multiple SQL statements")
        ),
    )
    monkeypatch.setattr(
        d1_client,
        "_raw_batch_execute",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("raw bypass must not run")),
    )

    with pytest.raises(d1_client.WorkerD1BatchValidationError, match="multiple SQL statements"):
        d1_client.batch_execute([("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10])])


def test_batch_execute_requires_durable_retry_after_both_batch_transports_fail(monkeypatch):
    def fake_worker_batch(*args, **kwargs):
        raise RuntimeError("worker down")

    def fake_raw_batch(*args, **kwargs):
        raise RuntimeError("raw down")

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "_worker_batch_execute", fake_worker_batch)
    monkeypatch.setattr(d1_client, "_raw_batch_execute", fake_raw_batch)
    monkeypatch.setattr(
        d1_client,
        "execute",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("per-statement fallback must never run")
        ),
    )

    with pytest.raises(d1_client.D1DurableBatchRetryRequired, match="worker down.*raw down"):
        d1_client.batch_execute([
            ("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10]),
        ])


def test_atomic_batch_execute_is_fail_closed_without_worker(monkeypatch):
    monkeypatch.setattr(d1_client, "WORKER_URL", "")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "")

    try:
        d1_client.atomic_batch_execute([("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10])])
    except RuntimeError as exc:
        assert "requires the Worker D1 binding endpoint" in str(exc)
    else:
        raise AssertionError("atomic batch must not fall back to independent writes")


def test_atomic_batch_execute_uses_exactly_one_worker_batch(monkeypatch):
    captured: list[tuple[list[tuple[str, list]], float, int]] = []

    def fake_worker_batch(statements, timeout=30.0, chunk_size=250):
        captured.append((statements, timeout, chunk_size))
        return {
            "mode": "worker_d1_batch",
            "total": len(statements),
            "success_count": len(statements),
            "error_count": 0,
            "changes_total": len(statements),
        }

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "_worker_batch_execute", fake_worker_batch)
    statements = [
        ("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10]),
        ("DELETE FROM concept_buzz WHERE date=?", ["2026-05-03"]),
    ]

    result = d1_client.atomic_batch_execute(statements, timeout=60.0)

    assert result["atomic"] is True
    assert captured == [(statements, 60.0, 2)]


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
