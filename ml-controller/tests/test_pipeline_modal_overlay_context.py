from pathlib import Path


def test_pipeline_modal_payload_has_no_state_space_daily_control_plane() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    pipeline_source = (repo_root / "ml-controller" / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    modal_source = (repo_root / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    deploy_source = (repo_root / "deploy_ml_controller.sh").read_text(encoding="utf-8")

    assert "def _pipeline_modal_context_overlay_mode" not in pipeline_source
    assert "state_space_overlay_mode" not in pipeline_source
    assert "state_space_soft_deadline_sec" not in pipeline_source
    assert "state_space_models" not in pipeline_source
    assert '"state_space_raw"' not in modal_source
    assert "PIPELINE_STATE_SPACE_OVERLAY_MODE" not in deploy_source
    assert "PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS" not in deploy_source
