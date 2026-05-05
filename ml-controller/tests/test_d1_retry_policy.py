from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import d1_client  # noqa: E402


class _FakeResponse:
    def __init__(self, status_code: int, text: str = "{}", payload: dict | None = None):
        self.status_code = status_code
        self.text = text
        self._payload = payload or {"success": True, "result": [{"results": [{"ok": 1}]}]}

    def json(self) -> dict:
        return self._payload


def test_d1_post_retries_overloaded_429(monkeypatch):
    calls: list[int] = []

    def fake_post(*_args, **_kwargs):
        calls.append(1)
        if len(calls) == 1:
            return _FakeResponse(429, '{"errors":[{"message":"D1 DB is overloaded"}]}')
        return _FakeResponse(200)

    monkeypatch.setattr(d1_client, "CF_API_TOKEN", "token")
    monkeypatch.setattr(d1_client, "CF_ACCOUNT_ID", "account")
    monkeypatch.setattr(d1_client, "CF_D1_DB_ID", "db")
    monkeypatch.setattr(d1_client.httpx, "post", fake_post)
    monkeypatch.setattr(d1_client, "_sleep_before_retry", lambda *_args, **_kwargs: None)

    rows = d1_client.query("SELECT 1 AS ok")

    assert rows == [{"ok": 1}]
    assert len(calls) == 2
