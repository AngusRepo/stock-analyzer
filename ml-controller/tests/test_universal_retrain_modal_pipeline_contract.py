from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from routers.retrain_trigger import (  # noqa: E402
    UniversalRetrainRunRequest,
    build_universal_retrain_modal_payload,
)


def test_universal_retrain_default_groups_retire_ft_transformer() -> None:
    assert UniversalRetrainRunRequest().train_model_groups == ["tree", "dlinear", "patchtst"]


def test_universal_retrain_modal_payload_preserves_no_downgrade_contract() -> None:
    payload = build_universal_retrain_modal_payload(
        UniversalRetrainRunRequest(
            limit=2500,
            force_monthly=True,
            run_date="2026-05-24",
            candidate_type="monthly_release",
            train_model_groups=["tree", "dlinear", "patchtst"],
            trigger_source="unit-test",
            trigger_id="trigger-1",
        ),
        run_id="universal-run-1",
        run_date="2026-05-24",
        lock_key="retrain:2026-05-24",
        followup_webhook_url="https://controller/retrain/followup",
    )

    assert payload["executor"] == "modal"
    assert payload["source"] == "universal_retrain_pipeline"
    assert payload["run_id"] == "universal-run-1"
    assert payload["run_date"] == "2026-05-24"
    assert payload["lock_key"] == "retrain:2026-05-24"
    assert payload["followup_webhook_url"] == "https://controller/retrain/followup"
    assert payload["trigger_source"] == "unit-test"
    assert payload["trigger_id"] == "trigger-1"

    request = payload["request"]
    assert request["limit"] == 2500
    assert request["force_monthly"] is True
    assert request["candidate_type"] == "monthly_release"
    assert request["train_model_groups"] == ["tree", "dlinear", "patchtst"]
    assert all(not key.startswith("ftt_") for key in request)

    assert payload["quality_contract"] == {
        "stock_universe_reduced": False,
        "training_groups_reduced": False,
        "feature_count_reduced": False,
        "prep_window_reduced": False,
        "model_hyperparams_reduced": False,
        "promotion_gate_weakened": False,
        "production_config_mutated": False,
    }


def test_universal_retrain_modal_pipeline_wiring_is_env_gated_and_callback_safe() -> None:
    router_source = (ROOT / "ml-controller" / "routers" / "retrain_trigger.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert '@router.post("/universal/run")' in router_source
    assert "UNIVERSAL_RETRAIN_EXECUTOR=modal" in router_source
    assert "retrain_lock.acquire(" in router_source
    assert "spawn_universal_retrain_pipeline(payload)" in router_source
    assert "retrain_lock.release(lock_key)" in router_source

    assert '"universal_retrain_pipeline": {"cpu": 4.0, "memory_mb": 16384' in modal_client_source
    assert "async def spawn_universal_retrain_pipeline" in modal_client_source

    assert ".add_local_dir(str(_LOCAL_CONTROLLER_ROUTERS_DIR), remote_path=\"/root/routers\")" in modal_app_source
    assert "def universal_retrain_pipeline(payload: dict) -> dict:" in modal_app_source
    assert "load_market_env(run_date)" in modal_app_source
    assert "_load_training_maps_from_snapshot(" in modal_app_source
    assert "prep_universal_batch.spawn(prep_payload)" in modal_app_source
    assert "retrain_orchestrator.spawn(orchestrator_payload)" in modal_app_source
    assert "retrain_lock.release(lock_key)" in modal_app_source
    assert "_post_worker_scheduler_callback({" in modal_app_source
    assert '"quality_contract": payload.get("quality_contract")' in modal_app_source
