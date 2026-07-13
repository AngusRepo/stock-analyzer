from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_pipeline_job_async_modal_prediction_is_feature_flagged() -> None:
    source = _read("ml-controller/pipeline_job_main.py")
    assert "PIPELINE_MODAL_PREDICTION_CALLBACK_ENABLED" in source
    assert "run_pipeline_v2_until_modal_prediction_spawn" in source
    assert 'status = "triggered"' in source
    assert "emit_subtasks = False" in source


def test_pipeline_modal_prediction_callback_route_is_service_token_callback() -> None:
    source = _read("ml-controller/routers/pipeline.py")
    main = _read("ml-controller/main.py")
    assert 'callback_router.post("/v2/modal-prediction/callback")' in source
    assert "_check_service_token(request)" in source
    assert "run_pipeline_v2_from_modal_prediction_callback" in source
    assert "run_deferred_snapshot_followup" in source
    assert "pipeline_v2_async_modal_prediction_callback" in source
    assert "pipeline_prediction_bundle" in source
    assert "app.include_router(pipeline.callback_router)" in main


def test_pipeline_modal_prediction_bundle_contract_exists_on_modal() -> None:
    modal_app = _read("ml-service/modal_app.py")
    modal_client = _read("ml-controller/services/modal_client.py")
    graph = _read("ml-controller/graphs/daily_pipeline_v2.py")
    assert "def pipeline_prediction_bundle(payload: dict) -> dict:" in modal_app
    assert "pipeline-modal-prediction-bundle-v1" in modal_app
    assert "predict_batch_v2_chunk_size" in modal_app
    assert "predict_batch_v2 chunk error" in modal_app
    assert '"signal": "NO_SIGNAL"' in modal_app
    assert "predict_batch_v2_contract" in graph
    assert "_post_pipeline_prediction_callback" in modal_app
    assert "def spawn_pipeline_prediction_bundle(payload: dict) -> dict:" in modal_client
    assert "modal_prediction_bundle" in graph
    assert "pipeline_modal_serving_context" in graph
    assert "pipeline-modal-serving-context-v1" in graph
    assert "run_pipeline_v2_from_modal_prediction_callback" in graph
    assert "timeout=3600" in modal_app
    assert "[PipelinePredictionBundle] stage_start" in modal_app
    assert "[PipelinePredictionBundle] stage_end" in modal_app
