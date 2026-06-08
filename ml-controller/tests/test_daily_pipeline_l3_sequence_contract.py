from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent


def test_daily_pipeline_calls_all_l3_sequence_predictors():
    source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert "modal_client.gnn_graphsage_batch_predict" in source
    assert "modal_client.dlinear_batch_predict" in source
    assert "modal_client.patchtst_batch_predict" in source
    assert "modal_client.itransformer_batch_predict" in source
    assert "modal_client.timesfm_batch_predict" in source
    assert "sequence_contract_points=timesfm_gate.get(\"sequence_contract_points\")" in source
    assert "iTransformer production predictor missing artifact/endpoint" not in source
    assert "TimesFM production predictor missing artifact/endpoint" not in source


def test_l2_cheap_ml_node_does_not_call_l3_models():
    source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    l2_body = source[
        source.index("async def node_l2_cheap_ml_predict"):
        source.index("async def node_l2_core_gate")
    ]

    assert "modal_client.l2_tree_batch_predict" in l2_body
    for forbidden in (
        "gnn_graphsage_batch_predict",
        "dlinear_batch_predict",
        "patchtst_batch_predict",
        "itransformer_batch_predict",
        "timesfm_batch_predict",
        "state_space_overlays_batch_predict",
    ):
        assert forbidden not in l2_body


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
    assert "async def l2_tree_batch_predict" in source
    assert '"predict_l2_tree_batch": {"cpu": 2.0, "memory_mb": 4096, "gpu": None}' in source


def test_modal_app_has_artifact_backed_l3_sequence_endpoints():
    source = (REPO / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "def gnn_graphsage_universal_predict" in source
    assert "from app.batch_prediction import predict_gnn_graphsage_batch" in source
    assert "def itransformer_universal_predict" in source
    assert "from app.itransformer_universal import itransformer_batch_predict" in source
    assert "def timesfm_universal_predict" in source
    assert "from app.timesfm_universal import timesfm_batch_predict" in source
    assert "def predict_l2_tree_batch" in source
    assert "from app.batch_prediction import predict_l2_tree_batch" in source


def test_retired_layer3_formal_predictor_is_not_in_hot_path():
    sources = "\n".join([
        (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8"),
        (ROOT / "services" / "modal_client.py").read_text(encoding="utf-8"),
        (REPO / "ml-service" / "modal_app.py").read_text(encoding="utf-8"),
    ])

    assert "layer3_formal_universal_predict" not in sources
