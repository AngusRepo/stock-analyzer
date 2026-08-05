from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from pydantic import ValidationError

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


def test_historical_shadow_accepts_optional_bounded_canonical_symbol_list(monkeypatch):
    jobs = _Jobs()
    monkeypatch.setattr(s12_structure, "_jobs", jobs)

    result = asyncio.run(s12_structure.trigger_s12_structure_batch(
        s12_structure.S12StructureRunRequest(
            run_date="2026-07-27",
            chain_run_id="minute-0901",
            source="historical_shadow",
            symbols=["2330", "2330", "006208"],
        )
    ))

    assert result["status"] == "triggered"
    assert jobs.overrides is not None
    assert jobs.overrides["S12_STRUCTURE_RUN_SOURCE"] == "historical_shadow"
    assert jobs.overrides["S12_STRUCTURE_SYMBOLS_JSON"] == '["2330","006208"]'


def test_manual_repair_uses_date_scoped_research_run_without_symbols(monkeypatch):
    jobs = _Jobs()
    monkeypatch.setattr(s12_structure, "_jobs", jobs)

    result = asyncio.run(s12_structure.trigger_s12_structure_batch(
        s12_structure.S12StructureRunRequest(
            run_date="2026-07-31",
            chain_run_id="s12-manual-repair:2026-07-31",
            source="manual_repair",
        )
    ))

    assert result["status"] == "triggered"
    assert jobs.overrides is not None
    assert jobs.overrides["S12_STRUCTURE_RUN_SOURCE"] == "manual_repair"
    assert "S12_STRUCTURE_SYMBOLS_JSON" not in jobs.overrides


@pytest.mark.parametrize("source", ["evening_chain", "intraday_watch", "intraday_session"])
def test_retired_serving_sources_are_rejected_at_validation(source):
    with pytest.raises(ValidationError):
        s12_structure.S12StructureRunRequest(run_date="2026-07-27", source=source)


def test_research_run_rejects_invalid_symbols():
    with pytest.raises(Exception) as exc:
        asyncio.run(s12_structure.trigger_s12_structure_batch(
            s12_structure.S12StructureRunRequest(
                run_date="2026-07-27",
                source="historical_shadow",
                symbols=["bad-symbol"],
            )
        ))
    assert getattr(exc.value, "status_code", None) == 400
