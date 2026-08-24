from __future__ import annotations

import pytest

from services.persona_service import (
    PersonaOpinions,
    RetailOpinion,
    TrustOpinion,
    write_opinions,
)


class FakeBatchClient:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[list[tuple[str, list[object]]], int]] = []

    def batch_execute(self, statements, *, chunk_size: int):
        self.calls.append((statements, chunk_size))
        success_count = len(statements) - (1 if self.fail else 0)
        return {
            "success_count": success_count,
            "error_count": 1 if self.fail else 0,
            "first_error": "forced" if self.fail else None,
        }


def _opinions(count: int) -> list[PersonaOpinions]:
    return [
        PersonaOpinions(
            symbol=f"{index:04d}",
            date="2026-08-24",
            trust=TrustOpinion("BUY", 0.75, "trust", False),
            retail=RetailOpinion("NEUTRAL", 0.25, "retail"),
        )
        for index in range(count)
    ]


def test_write_opinions_uses_one_bounded_batch_submission_for_wide_slate() -> None:
    client = FakeBatchClient()

    assert write_opinions(client, _opinions(416)) == 416
    assert len(client.calls) == 1
    statements, chunk_size = client.calls[0]
    assert chunk_size == 250
    assert len(statements) == 416
    assert all("ON CONFLICT(date, symbol) DO UPDATE" in sql for sql, _params in statements)
    assert statements[0][1][0:2] == ["2026-08-24", "0000"]
    assert statements[-1][1][0:2] == ["2026-08-24", "0415"]


def test_write_opinions_fails_visible_on_incomplete_batch() -> None:
    with pytest.raises(RuntimeError, match=r"success=415/416 errors=1"):
        write_opinions(FakeBatchClient(fail=True), _opinions(416))
