from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from routers.regime import (  # noqa: E402
    RegimeComputeRunRequest,
    build_regime_compute_modal_payload,
)


def test_regime_compute_modal_payload_preserves_no_downgrade_contract() -> None:
    payload = build_regime_compute_modal_payload(
        RegimeComputeRunRequest(
            run_id="regime-compute-1",
            run_date="2026-05-24",
            force_retrain=False,
            history_days=180,
            callback_task="regime-compute",
            trigger_source="worker_scheduler",
            trigger_id="regime-trigger-1",
            prev_label="sideways",
        )
    )

    assert payload["executor"] == "modal"
    assert payload["source"] == "regime_compute"
    assert payload["run_id"] == "regime-compute-1"
    assert payload["run_date"] == "2026-05-24"
    assert payload["force_retrain"] is False
    assert payload["history_days"] == 180
    assert payload["callback_task"] == "regime-compute"
    assert payload["trigger_source"] == "worker_scheduler"
    assert payload["trigger_id"] == "regime-trigger-1"
    assert payload["prev_label"] == "sideways"
    assert payload["quality_contract"] == {
        "market_env_history_reduced": False,
        "hmm_regime_logic_reduced": False,
        "kv_push_preserved": True,
        "regime_shift_detection_preserved": True,
        "production_config_mutated": False,
    }


def test_regime_compute_modal_wiring_is_async_env_gated_and_full_spec() -> None:
    router_source = (ROOT / "ml-controller" / "routers" / "regime.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert '@router.post("/regime/compute/run")' in router_source
    assert "REGIME_COMPUTE_EXECUTOR=modal" in router_source
    assert "spawn_regime_compute(payload)" in router_source
    assert '"regime_compute": {"cpu": 4.0, "memory_mb": 16384' in modal_client_source
    assert "async def spawn_regime_compute" in modal_client_source
    assert "def regime_compute(payload: dict) -> dict:" in modal_app_source
    assert "load_market_env(run_date)" in modal_app_source
    assert "RegimeDetector.load_from_gcs()" in modal_app_source
    assert 'source="regime"' in modal_app_source
    assert '"task": callback_task' in modal_app_source
    assert '"prev_label": prev_label' in modal_app_source
