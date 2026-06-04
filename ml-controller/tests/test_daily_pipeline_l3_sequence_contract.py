from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent


def test_daily_pipeline_calls_all_l3_sequence_predictors():
    source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "modal_client.dlinear_batch_predict" in source
    assert "modal_client.patchtst_batch_predict" in source
    assert "modal_client.itransformer_batch_predict" in source
    assert "modal_client.timesfm_batch_predict" in source
    assert "iTransformer production predictor missing artifact/endpoint" not in source
    assert "TimesFM production predictor missing artifact/endpoint" not in source


def test_modal_client_exposes_l3_sequence_predictors_and_resources():
    source = (ROOT / "services" / "modal_client.py").read_text(encoding="utf-8")

    for function_name in (
        "dlinear_universal_predict",
        "patchtst_universal_predict",
        "itransformer_universal_predict",
        "timesfm_universal_predict",
    ):
        assert function_name in source

    assert "async def itransformer_batch_predict" in source
    assert "async def timesfm_batch_predict" in source
    assert '"timesfm_universal_predict": {"cpu": 1.0, "memory_mb": 8192, "gpu": "L4"}' in source


def test_modal_app_has_artifact_backed_l3_sequence_endpoints():
    source = (REPO / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "def itransformer_universal_predict" in source
    assert "from app.itransformer_universal import itransformer_batch_predict" in source
    assert "def timesfm_universal_predict" in source
    assert "from app.timesfm_universal import timesfm_batch_predict" in source
