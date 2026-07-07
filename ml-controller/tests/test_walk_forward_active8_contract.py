from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def test_walk_forward_defaults_to_active8_contract():
    from services.walk_forward_retrain import MODELS_ALL, walk_forward_model_coverage

    expected = [
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
    ]
    assert MODELS_ALL == expected

    coverage = walk_forward_model_coverage()
    assert coverage["requested_models"] == expected
    assert coverage["native_retrain_models"] == ["LightGBM", "XGBoost", "ExtraTrees"]
    assert coverage["artifact_lifecycle_required_models"] == [
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
    ]
    assert coverage["coverage_mode"] == "active8_with_artifact_lifecycle_gaps"


def test_walk_forward_router_exposes_active8_coverage():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert "walk_forward_model_coverage" in source
    assert "\"planned_model_evaluations\"" in source
    assert "\"model_coverage\"" in source
    assert "active-8 coverage" in source
    assert "5 models" not in source


def test_modal_walk_forward_orchestrator_no_longer_defaults_tree_only():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "from app.model_pool import ALPHA_PREDICTION_MODELS" in source
    assert "active8_models = list(ALPHA_PREDICTION_MODELS)" in source
    assert "\"artifact_lifecycle_required_models\"" in source
    assert "payload.get(\"models\") or active8_models" in source
    assert "payload.get(\"models\") or [\"XGBoost\", \"ExtraTrees\", \"LightGBM\"]" not in source
