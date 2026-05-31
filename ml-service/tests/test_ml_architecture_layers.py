from pathlib import Path

from app import model_pool
from app.chronos_universal import CURRENT_CONFIG, _DEFAULT_MODEL_ID


def test_alpha_prediction_pool_excludes_state_space_overlays():
    assert tuple(model_pool.ALPHA_PREDICTION_MODELS) == (
        "XGBoost",
        "CatBoost",
        "ExtraTrees",
        "LightGBM",
        "DLinear",
        "PatchTST",
    )
    assert "FT-Transformer" not in model_pool.ALPHA_PREDICTION_MODELS
    assert "KalmanFilter" not in model_pool.ALPHA_PREDICTION_MODELS
    assert "MarkovSwitching" not in model_pool.ALPHA_PREDICTION_MODELS


def test_formal_layer3_and_meta_layers_are_not_active_alpha_models():
    assert tuple(model_pool.STATE_SPACE_OVERLAY_MODELS) == ("KalmanFilter", "MarkovSwitching")
    assert model_pool.EXPERIMENTAL_CHALLENGER_MODELS == {}
    assert set(model_pool.FORMAL_LAYER3_PENDING_MODELS) == {"TabM", "GNN", "iTransformer", "TimesFM"}
    assert "GAOptimizer" in model_pool.META_OPTIMIZERS
    assert model_pool.META_OPTIMIZERS["GAOptimizer"]["status"] == "learning"
    assert "GAOptimizer" not in model_pool.FORMAL_LAYER3_PENDING_MODELS
    assert "ResidualMLP" not in model_pool.MANAGED_MODELS
    assert "GNN" not in model_pool.MANAGED_MODELS


def test_default_pool_bootstraps_only_active_alpha_models():
    pool = model_pool.init_default_pool()
    active = {
        name for name, entry in pool["models"].items()
        if entry["status"] in {"active", "degraded"}
    }
    assert active == set(model_pool.ALPHA_PREDICTION_MODELS)
    assert pool["models"]["Chronos"]["status"] == "retired"
    assert pool["shadow_models"] == {}
    assert set(pool["formal_layer3_slots"]) == {"TabM", "GNN", "iTransformer", "TimesFM"}
    assert set(pool["meta_optimizers"]) == {"GAOptimizer"}
    assert all(pool["models"][name]["status"] == "active" for name in model_pool.ALPHA_PREDICTION_MODELS)
    assert pool["formal_layer3_slots"]["GNN"]["status"] == "production_adapter_active"
    assert pool["formal_layer3_slots"]["TimesFM"]["status"] == "production_adapter_active"
    assert pool["formal_layer3_slots"]["TabM"]["status"] == "formal_slot_pending_artifact"
    assert pool["formal_layer3_slots"]["iTransformer"]["status"] == "formal_slot_pending_artifact"


def test_formal_slots_have_no_legacy_shadow_registration_api():
    pool = model_pool.init_default_pool()
    assert pool["shadow_models"] == {}
    assert not hasattr(model_pool, "register_" + "shadow" + "_challenger")
    assert not hasattr(model_pool, "get_" + "shadow" + "_challenger_path")


def test_chronos_retired_diagnostic_slot_is_chronos2_not_tiny():
    assert _DEFAULT_MODEL_ID == "amazon/chronos-2"
    assert CURRENT_CONFIG["model_id"] == "amazon/chronos-2"
    assert CURRENT_CONFIG["diagnostic_members"] == ["Chronos2ZeroShot", "Chronos2LoRA"]
    assert "tiny" not in CURRENT_CONFIG["diagnostic_note"].lower()
    assert "production ranking" in CURRENT_CONFIG["strategy"]


def test_modal_image_does_not_install_retired_chronos_package():
    requirements = Path("ml-service/requirements.txt").read_text(encoding="utf-8")
    requirement_rows = [
        row.strip()
        for row in requirements.splitlines()
        if row.strip() and not row.strip().startswith("#")
    ]
    assert not any(row.startswith("chronos-forecasting") for row in requirement_rows)
    assert "scikit-learn==1.5.2" in requirement_rows
