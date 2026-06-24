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


def test_timesfm_default_sequence_contract_matches_25_artifact_context():
    source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    timesfm_runtime = (REPO / "ml-service" / "app" / "timesfm_universal.py").read_text(encoding="utf-8")

    assert "DEFAULT_TIMESFM_SEQUENCE_CONTRACT_POINTS = daily_sequence_target_points()" in source
    assert "DEFAULT_SEQ_LEN = 1024" in timesfm_runtime
    assert "_timesfm_artifact_sequence_contract_points(pool)" in source


def test_l2_cheap_ml_node_does_not_call_l3_models():
    source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    l2_body = source[
        source.index("async def node_l2_cheap_ml_predict"):
        source.index("def _timesfm_l175_registry_release_policy")
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


def test_l2_split_routes_through_timesfm_l175_sidecar_before_l2():
    source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert 'g.add_node("timesfm_l175_enrich"' in source
    assert 'g.add_edge("build_payloads",      "timesfm_l175_enrich")' in source
    assert 'g.add_edge("timesfm_l175_enrich", "l2_cheap_ml_predict")' in source
    assert 'build_timesfm_l175_sidecar' in source
    assert '"ml:timesfm_l175_l2_feature_release"' in source
    assert "_timesfm_l175_registry_release_policy" in source
    assert "candidate_type = 'timesfm_l175_l2_feature_release'" in source


def test_timesfm_l175_release_retrain_path_materializes_l2_features():
    retrain = (ROOT / "routers" / "retrain_trigger.py").read_text(encoding="utf-8")
    followup = (ROOT / "routers" / "retrain_followup.py").read_text(encoding="utf-8")
    features = (REPO / "ml-service" / "app" / "features" / "__init__.py").read_text(encoding="utf-8")
    batch_prediction = (REPO / "ml-service" / "app" / "batch_prediction.py").read_text(encoding="utf-8")

    assert 'TIMESFM_L175_L2_FEATURE_RELEASE_CANDIDATE_TYPE = "timesfm_l175_l2_feature_release"' in retrain
    assert "predictions.forecast_data.timesfm_sidecar.features" in retrain
    assert '"timesfm_l175_history"' in retrain
    assert '"timesfm_l175_l2_feature_input_active"' in retrain
    assert "timesfm_l175_feature_release" in retrain
    assert 'source_key = name.replace("timesfm_l175_", "", 1)' in retrain
    assert "raw = features.get(source_key)" in retrain
    assert "cleaned[source_key] = value" in retrain
    assert 'sidecar.get("l2_feature_values")' in retrain
    assert "candidate_type: str | None = None" in followup
    assert "TIMESFM_L175_FEATURE_COLS" in features
    assert 'feature_schema": "formal137+timesfm_l175"' in batch_prediction


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
