from __future__ import annotations

import sys
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
    monkeypatch.setattr(d1_client.httpx, "post", fake_post)

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


def test_batch_execute_falls_back_to_rest_loop_when_worker_unavailable(monkeypatch):
    execute_calls: list[tuple[str, list]] = []

    def fake_worker_batch(*args, **kwargs):
        raise RuntimeError("worker down")

    def fake_execute(sql, params, timeout=60.0):
        execute_calls.append((sql, params))
        return {"meta": {"changes": 1}}

    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "token")
    monkeypatch.setattr(d1_client, "_worker_batch_execute", fake_worker_batch)
    monkeypatch.setattr(d1_client, "execute", fake_execute)

    result = d1_client.batch_execute([
        ("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10]),
    ])

    assert result["mode"] == "rest_loop_fallback"
    assert result["success_count"] == 1
    assert execute_calls == [("UPDATE predictions SET direction_correct=? WHERE id=?", [1, 10])]
