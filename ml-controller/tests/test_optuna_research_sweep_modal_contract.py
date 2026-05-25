from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_optuna_research_sweep_modal_job_uses_spawn_and_callback_contract() -> None:
    router_source = (ROOT / "ml-controller" / "routers" / "optuna.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")

    assert "OPTUNA_RESEARCH_SWEEP_EXECUTOR" in router_source
    assert "spawn_optuna_research_sweep" in router_source
    assert "optuna research Modal run spawned; callback expected" in router_source
    assert "def optuna_research_sweep(payload: dict) -> dict:" in modal_app_source
    assert "execute_research_sweep(req)" in modal_app_source
    assert '"task": callback_task' in modal_app_source
    assert '"optuna_research_sweep": {"cpu": 4.0, "memory_mb": 4096' in modal_client_source
    assert "async def spawn_optuna_research_sweep" in modal_client_source


def test_optuna_research_sweep_modal_contract_preserves_quality_knobs() -> None:
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "n_trials=int(payload.get(\"n_trials\") or 200)" in modal_app_source
    assert "subset_size=int(payload.get(\"subset_size\") or 1000)" in modal_app_source
    assert "max_parallel_sources=int(payload.get(\"max_parallel_sources\") or 3)" in modal_app_source
    assert "ga_population_size=int(payload.get(\"ga_population_size\") or 24)" in modal_app_source
    assert "ga_generations=int(payload.get(\"ga_generations\") or 8)" in modal_app_source
    assert "research_data_source=payload.get(\"research_data_source\") or \"snapshot\"" in modal_app_source
