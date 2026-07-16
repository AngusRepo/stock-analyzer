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


def test_strict_batch_execute_rejects_partial_result(monkeypatch):
    monkeypatch.setattr(
        d1_client,
        "atomic_batch_execute",
        lambda statements, timeout=30.0: {
            "total": len(statements),
            "success_count": len(statements) - 1,
            "error_count": 1,
            "partial_failure": True,
            "mode": "worker_d1_batch",
            "atomic": True,
        },
    )
    try:
        d1_client.strict_batch_execute(
            [("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10])],
            operation="prediction_write",
        )
    except d1_client.D1BatchContractError as exc:
        assert "prediction_write did not fully persist" in str(exc)
    else:
        raise AssertionError("strict batch must reject partial persistence")


def test_allocator_guard_never_reports_noop_as_persisted_success(monkeypatch):
    monkeypatch.setattr(d1_client, "allocator_contract_guard_enabled", lambda: True)
    result = d1_client.batch_execute(
        [("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10])]
    )
    assert result["persisted"] is False
    assert result["success_count"] == 0
    assert result["error_count"] == 1
    assert result["changes_total"] == 0


def test_atomic_write_cohort_commits_all_staged_writes_once(monkeypatch):
    commits = []

    def fake_atomic(statements, timeout=30.0):
        commits.append((list(statements), timeout))
        return {
            "total": len(statements),
            "success_count": len(statements),
            "error_count": 0,
            "changes_total": len(statements),
            "partial_failure": False,
            "mode": "worker_d1_batch",
            "atomic": True,
        }

    monkeypatch.setattr(d1_client, "atomic_batch_execute", fake_atomic)
    with d1_client.atomic_write_cohort("daily_pipeline", timeout=90.0) as cohort:
        d1_client.strict_batch_execute(
            [("INSERT INTO predictions(id) VALUES (?)", [1])],
            operation="predictions",
        )
        d1_client.strict_batch_execute(
            [("UPDATE daily_recommendations SET rank=? WHERE stock_id=?", [1, 1])],
            operation="recommendations",
        )

    assert len(commits) == 1
    assert len(commits[0][0]) == 2
    assert commits[0][1] == 90.0
    assert cohort.result["atomic"] is True


def test_atomic_write_cohort_does_not_commit_after_domain_error(monkeypatch):
    commits = []
    monkeypatch.setattr(
        d1_client,
        "atomic_batch_execute",
        lambda statements, timeout=30.0: commits.append(statements),
    )

    try:
        with d1_client.atomic_write_cohort("daily_pipeline"):
            d1_client.strict_batch_execute(
                [("INSERT INTO predictions(id) VALUES (?)", [1])],
                operation="predictions",
            )
            raise ValueError("recommendation closure failed")
    except ValueError:
        pass

    assert commits == []


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
