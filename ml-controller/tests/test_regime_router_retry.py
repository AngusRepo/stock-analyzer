from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi import HTTPException

from routers.regime import _request_regime_current


class _Response:
    def __init__(self, status_code: int, payload: dict[str, Any] | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self) -> dict[str, Any]:
        return self._payload


class _Client:
    def __init__(self, responses: list[_Response]):
        self.responses = list(responses)
        self.calls = 0

    async def post(self, *_args: Any, **_kwargs: Any) -> _Response:
        response = self.responses[self.calls]
        self.calls += 1
        return response


def _run(client: _Client) -> dict[str, Any]:
    return asyncio.run(_request_regime_current(
        client,  # type: ignore[arg-type]
        market_env={"history": {"2026-08-03": {}}},
        force_retrain=False,
        headers={"Content-Type": "application/json"},
        request_id="test-request",
        retry_delay_seconds=0,
    ))


def test_regime_current_retries_modal_408_once_then_closes():
    client = _Client([
        _Response(408, text="request timeout"),
        _Response(200, payload={"regime_label_en": "sideways"}),
    ])

    assert _run(client)["regime_label_en"] == "sideways"
    assert client.calls == 2


def test_regime_current_does_not_retry_non_transient_400():
    client = _Client([_Response(400, text="bad PIT payload")])

    with pytest.raises(HTTPException) as exc_info:
        _run(client)

    assert exc_info.value.status_code == 502
    assert "HTTP 400" in str(exc_info.value.detail)
    assert client.calls == 1
