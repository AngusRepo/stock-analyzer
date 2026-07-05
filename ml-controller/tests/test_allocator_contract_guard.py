from __future__ import annotations

import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.allocator_contract_guard import (
    ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV,
    ALLOCATOR_CONTRACT_GUARD_ENV,
    allocator_contract_guard_enabled,
    assert_allocator_contract_run_date,
)


def _clear_guard_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ALLOCATOR_CONTRACT_GUARD_ENV, raising=False)
    monkeypatch.delenv(ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV, raising=False)
    monkeypatch.delenv("STOCKVISION_" + "SIZING" + "_CANARY", raising=False)
    monkeypatch.delenv("STOCKVISION_" + "CANARY" + "_ALLOWED_RUN_DATE", raising=False)


def test_allocator_contract_guard_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_guard_env(monkeypatch)

    assert allocator_contract_guard_enabled() is False
    assert_allocator_contract_run_date("", label="pipeline-v2")


def test_legacy_sizing_env_does_not_enable_allocator_contract_guard(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_guard_env(monkeypatch)
    monkeypatch.setenv("STOCKVISION_" + "SIZING" + "_CANARY", "1")

    assert allocator_contract_guard_enabled() is False
    assert_allocator_contract_run_date("2026-07-04", label="pipeline-v2")


def test_allocator_contract_guard_requires_allowed_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_guard_env(monkeypatch)
    monkeypatch.setenv(ALLOCATOR_CONTRACT_GUARD_ENV, "1")

    with pytest.raises(RuntimeError, match=ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV):
        assert_allocator_contract_run_date("2026-07-04", label="pipeline-v2")


def test_allocator_contract_guard_blocks_unapproved_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_guard_env(monkeypatch)
    monkeypatch.setenv(ALLOCATOR_CONTRACT_GUARD_ENV, "1")
    monkeypatch.setenv(ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV, "2026-07-04")

    with pytest.raises(RuntimeError, match="blocked; allowed=2026-07-04"):
        assert_allocator_contract_run_date("2026-07-03", label="pipeline-v2")


def test_allocator_contract_guard_allows_exact_date(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_guard_env(monkeypatch)
    monkeypatch.setenv(ALLOCATOR_CONTRACT_GUARD_ENV, "true")
    monkeypatch.setenv(ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV, "2026-07-04")

    assert allocator_contract_guard_enabled() is True
    assert_allocator_contract_run_date("2026-07-04", label="pipeline-v2")
