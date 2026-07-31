from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
run_v2_stub = ModuleType("google.cloud.run_v2")
sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)


from routers import s12_structure  # noqa: E402


class _Jobs:
    def __init__(self) -> None:
        self.overrides: dict[str, str] | None = None

    def run_job(self, *, env_overrides):
        self.overrides = env_overrides
        return SimpleNamespace(execution_id="exec-1", execution_name="projects/p/locations/r/executions/exec-1")


def test_intraday_watch_requires_bounded_canonical_symbol_list(monkeypatch):
    jobs = _Jobs()
    monkeypatch.setattr(s12_structure, "_jobs", jobs)

    result = asyncio.run(s12_structure.trigger_s12_structure_batch(
        s12_structure.S12StructureRunRequest(
            run_date="2026-07-27",
            chain_run_id="minute-0901",
            source="intraday_watch",
            symbols=["2330", "2330", "006208"],
        )
    ))

    assert result["status"] == "triggered"
    assert jobs.overrides is not None
    assert jobs.overrides["S12_STRUCTURE_RUN_SOURCE"] == "intraday_watch"
    assert jobs.overrides["S12_STRUCTURE_SYMBOLS_JSON"] == '["2330","006208"]'


def test_intraday_session_uses_date_scoped_run_without_symbols(monkeypatch):
    jobs = _Jobs()
    monkeypatch.setattr(s12_structure, "_jobs", jobs)

    result = asyncio.run(s12_structure.trigger_s12_structure_batch(
        s12_structure.S12StructureRunRequest(
            run_date="2026-07-31",
            chain_run_id="s12-intraday-session:2026-07-31",
            source="intraday_session",
        )
    ))

    assert result["status"] == "triggered"
    assert jobs.overrides is not None
    assert jobs.overrides["S12_STRUCTURE_RUN_SOURCE"] == "intraday_session"
    assert "S12_STRUCTURE_SYMBOLS_JSON" not in jobs.overrides


@pytest.mark.parametrize("symbols", [None, [], ["bad-symbol"]])
def test_intraday_watch_rejects_missing_or_invalid_symbols(symbols):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(s12_structure.trigger_s12_structure_batch(
            s12_structure.S12StructureRunRequest(
                run_date="2026-07-27",
                source="intraday_watch",
                symbols=symbols,
            )
        ))
    assert exc.value.status_code == 400
