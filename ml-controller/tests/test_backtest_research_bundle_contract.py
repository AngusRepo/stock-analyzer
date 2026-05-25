from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from routers.backtest import (  # noqa: E402
    BacktestFullRunRequest,
    BacktestMonteCarloRunRequest,
    BacktestPboRunRequest,
    BacktestReplayRunRequest,
    BacktestResearchBundleRunRequest,
    build_backtest_full_run_modal_payload,
    build_backtest_monte_carlo_modal_payload,
    build_backtest_pbo_modal_payload,
    build_backtest_replay_modal_payload,
    build_backtest_research_bundle_modal_payload,
)
from services.backtest_research_bundle import (  # noqa: E402
    build_backtest_research_bundle,
    validate_backtest_research_bundle,
)


def _ok(status: str = "ok") -> dict:
    return {"status": status, "value": 1}


def test_backtest_research_bundle_requires_all_validation_steps() -> None:
    bundle = build_backtest_research_bundle(
        run_id="bt-bundle-1",
        generated_at="2026-05-24T00:00:00Z",
        params={"monte_carlo_n": 1000, "pbo_partitions": 10},
        steps={
            "backtest": _ok("completed"),
            "monte_carlo_paper": _ok(),
            "monte_carlo_backtest": _ok(),
            "pbo_backtest": _ok(),
        },
    )

    assert bundle["schema_version"] == "backtest-research-bundle-v1"
    assert bundle["status"] == "success"
    assert bundle["failed_steps"] == []
    assert bundle["quality_contract"] == {
        "backtest_universe_reduced": False,
        "monte_carlo_simulations_reduced": False,
        "pbo_partitions_reduced": False,
        "production_config_mutated": False,
    }
    assert validate_backtest_research_bundle(bundle) == []


def test_backtest_research_bundle_fails_closed_on_missing_step() -> None:
    bundle = build_backtest_research_bundle(
        run_id="bt-bundle-2",
        steps={
            "backtest": _ok(),
            "monte_carlo_paper": _ok(),
            "monte_carlo_backtest": _ok(),
        },
    )

    assert bundle["status"] == "error"
    assert "pbo_backtest" in bundle["failed_steps"]
    assert validate_backtest_research_bundle(bundle) == []


def test_backtest_research_bundle_route_payload_preserves_quality_knobs() -> None:
    payload = build_backtest_research_bundle_modal_payload(
        BacktestResearchBundleRunRequest(
            run_id="bt-bundle-3",
            monte_carlo_n=1000,
            pbo_partitions=10,
            trigger_source="unit-test",
        )
    )

    assert payload["executor"] == "modal"
    assert payload["source"] == "backtest_research_bundle"
    assert payload["run_id"] == "bt-bundle-3"
    assert payload["monte_carlo_n"] == 1000
    assert payload["pbo_partitions"] == 10
    assert payload["pbo_source"] == "backtest"
    assert payload["callback_task"] == "weekly-backtest"


def test_backtest_replay_route_payload_preserves_replay_request_contract() -> None:
    payload = build_backtest_replay_modal_payload(
        BacktestReplayRunRequest(
            run_id="bt-replay-1",
            start_date="2024-01-01",
            end_date="2024-03-31",
            params={"screener": {"min_score": 72}},
            initial_capital=2_000_000,
            mode="B",
            symbols=["2330", "2454"],
            persist_results=True,
            persist_confirm=True,
            trigger_source="unit-test",
        )
    )

    assert payload["executor"] == "modal"
    assert payload["source"] == "backtest_replay"
    assert payload["run_id"] == "bt-replay-1"
    assert payload["callback_task"] == "backtest-replay"
    assert payload["request"]["start_date"] == "2024-01-01"
    assert payload["request"]["end_date"] == "2024-03-31"
    assert payload["request"]["initial_capital"] == 2_000_000
    assert payload["request"]["mode"] == "B"
    assert payload["request"]["symbols"] == ["2330", "2454"]
    assert payload["request"]["persist_results"] is True
    assert payload["request"]["persist_confirm"] is True


def test_backtest_mc_and_pbo_payloads_preserve_quality_knobs() -> None:
    mc_payload = build_backtest_monte_carlo_modal_payload(
        BacktestMonteCarloRunRequest(
            run_id="bt-mc-1",
            n=1000,
            source="backtest",
            method="regime_block_bootstrap",
            block_size=20,
            trigger_source="unit-test",
        )
    )
    pbo_payload = build_backtest_pbo_modal_payload(
        BacktestPboRunRequest(
            run_id="bt-pbo-1",
            partitions=10,
            source="backtest",
            trigger_source="unit-test",
        )
    )

    assert mc_payload["executor"] == "modal"
    assert mc_payload["source_kind"] == "backtest_monte_carlo"
    assert mc_payload["run_id"] == "bt-mc-1"
    assert mc_payload["n"] == 1000
    assert mc_payload["source"] == "backtest"
    assert mc_payload["method"] == "regime_block_bootstrap"
    assert mc_payload["block_size"] == 20
    assert mc_payload["callback_task"] == "monte-carlo"
    assert pbo_payload["executor"] == "modal"
    assert pbo_payload["source_kind"] == "backtest_pbo"
    assert pbo_payload["run_id"] == "bt-pbo-1"
    assert pbo_payload["partitions"] == 10
    assert pbo_payload["source"] == "backtest"
    assert pbo_payload["callback_task"] == "pbo"


def test_backtest_full_run_payload_preserves_sync_owner_contract() -> None:
    payload = build_backtest_full_run_modal_payload(
        BacktestFullRunRequest(
            run_id="bt-full-1",
            trigger_source="unit-test",
        )
    )

    assert payload["executor"] == "modal"
    assert payload["source"] == "backtest_full_run"
    assert payload["run_id"] == "bt-full-1"
    assert payload["callback_task"] == "backtest"
    assert payload["trigger_source"] == "unit-test"


def test_modal_backtest_bundle_spawn_contract_exists() -> None:
    router_source = (ROOT / "ml-controller" / "routers" / "backtest.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")

    assert '@router.post("/research-bundle/run")' in router_source
    assert "BACKTEST_RESEARCH_BUNDLE_EXECUTOR=modal" in router_source
    assert "spawn_backtest_research_bundle" in router_source
    assert "def backtest_research_bundle(payload: dict) -> dict:" in modal_app_source
    assert "run_full_backtest()" in modal_app_source
    assert 'source="paper"' in modal_app_source
    assert 'source="backtest"' in modal_app_source
    assert "run_pbo_analysis(" in modal_app_source
    assert '"backtest_research_bundle": {"cpu": 4.0, "memory_mb": 4096' in modal_client_source
    assert "async def spawn_backtest_research_bundle" in modal_client_source


def test_modal_backtest_replay_spawn_contract_exists() -> None:
    router_source = (ROOT / "ml-controller" / "routers" / "backtest.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    admin_control_source = (ROOT / "worker" / "src" / "routes" / "adminControlRoutes.ts").read_text(encoding="utf-8")
    scheduler_logger_source = (ROOT / "worker" / "src" / "lib" / "schedulerRunLogger.ts").read_text(encoding="utf-8")

    assert '@router.post("/replay/run")' in router_source
    assert "BACKTEST_REPLAY_EXECUTOR=modal" in router_source
    assert "spawn_backtest_replay(payload)" in router_source
    assert "def backtest_replay(payload: dict) -> dict:" in modal_app_source
    assert "ReplayRequest(**request_payload)" in modal_app_source
    assert "trigger_replay(req)" in modal_app_source
    assert '"backtest_replay": {"cpu": 4.0, "memory_mb": 4096' in modal_client_source
    assert "async def spawn_backtest_replay" in modal_client_source
    assert "'backtest-replay'" in admin_control_source
    assert "'backtest-replay': 'Backtest Replay'" in scheduler_logger_source


def test_modal_backtest_mc_and_pbo_spawn_contracts_exist() -> None:
    router_source = (ROOT / "ml-controller" / "routers" / "backtest.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    admin_control_source = (ROOT / "worker" / "src" / "routes" / "adminControlRoutes.ts").read_text(encoding="utf-8")

    assert '@router.post("/monte-carlo/run")' in router_source
    assert '@router.post("/pbo/run")' in router_source
    assert "BACKTEST_MONTE_CARLO_EXECUTOR=modal" in router_source
    assert "BACKTEST_PBO_EXECUTOR=modal" in router_source
    assert "spawn_backtest_monte_carlo(payload)" in router_source
    assert "spawn_backtest_pbo(payload)" in router_source
    assert "def backtest_monte_carlo(payload: dict) -> dict:" in modal_app_source
    assert "def backtest_pbo(payload: dict) -> dict:" in modal_app_source
    assert "run_monte_carlo_mdd(" in modal_app_source
    assert "run_pbo_analysis(" in modal_app_source
    assert '"backtest_monte_carlo": {"cpu": 4.0, "memory_mb": 4096' in modal_client_source
    assert '"backtest_pbo": {"cpu": 4.0, "memory_mb": 4096' in modal_client_source
    assert "async def spawn_backtest_monte_carlo" in modal_client_source
    assert "async def spawn_backtest_pbo" in modal_client_source
    assert "'monte-carlo'" in admin_control_source
    assert "'pbo'" in admin_control_source


def test_modal_backtest_full_run_spawn_contract_exists() -> None:
    router_source = (ROOT / "ml-controller" / "routers" / "backtest.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    admin_control_source = (ROOT / "worker" / "src" / "routes" / "adminControlRoutes.ts").read_text(encoding="utf-8")

    assert '@router.post("/run/async")' in router_source
    assert "BACKTEST_RUN_EXECUTOR=modal" in router_source
    assert "spawn_backtest_full_run(payload)" in router_source
    assert "def backtest_full_run(payload: dict) -> dict:" in modal_app_source
    assert "run_full_backtest()" in modal_app_source
    assert '"backtest_full_run": {"cpu": 4.0, "memory_mb": 4096' in modal_client_source
    assert "async def spawn_backtest_full_run" in modal_client_source
    assert "'backtest'" in admin_control_source
