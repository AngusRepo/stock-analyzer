from app import model_pool


def test_alpha_prediction_pool_excludes_state_space_overlays():
    assert tuple(model_pool.ALPHA_PREDICTION_MODELS) == (
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
        "TimesFM",
    )
    assert tuple(model_pool.RETIRED_ALPHA_MODELS) == ("CatBoost", "FT-Transformer", "Chronos")
    assert "KalmanFilter" not in model_pool.ALPHA_PREDICTION_MODELS
    assert "MarkovSwitching" not in model_pool.ALPHA_PREDICTION_MODELS


def test_shadow_and_meta_layers_are_not_active_alpha_models():
    assert tuple(model_pool.STATE_SPACE_OVERLAY_MODELS) == ("KalmanFilter", "MarkovSwitching")
    assert set(model_pool.EXPERIMENTAL_CHALLENGER_MODELS) == {"ResidualMLP"}
    assert "GAOptimizer" in model_pool.META_OPTIMIZERS
    assert model_pool.META_OPTIMIZERS["GAOptimizer"]["status"] == "learning"
    assert "GAOptimizer" not in model_pool.EXPERIMENTAL_CHALLENGER_MODELS
    assert "ResidualMLP" not in model_pool.MANAGED_MODELS
    assert "GNN" in model_pool.MANAGED_MODELS


def test_default_pool_bootstraps_only_active_alpha_models():
    pool = model_pool.init_default_pool()
    assert set(pool["models"]) == set(model_pool.ALPHA_PREDICTION_MODELS)
    assert set(pool["shadow_models"]) == {"ResidualMLP"}
    assert set(pool["meta_optimizers"]) == {"GAOptimizer"}
    assert all(entry["status"] == "active" for entry in pool["models"].values())
    assert all(entry["status"] == "challenger" for entry in pool["shadow_models"].values())
    assert pool["models"]["TabM"]["gcs_path"] == "universal/tabm/v1.pt"
    assert pool["models"]["GNN"]["gcs_path"] == "universal/gnn/v1.pt"


def test_shadow_challenger_registration_excludes_ga_optimizer():
    pool = model_pool.init_default_pool()
    entry = model_pool.register_shadow_challenger("ResidualMLP", "v2", pool=pool, save=False)
    assert entry["status"] == "challenger"
    assert entry["vote_weight"] == 0.0
    assert model_pool.get_shadow_challenger_path("ResidualMLP", pool=pool) == "experimental_shadow/residualmlp/v2.joblib"
    try:
        model_pool.register_shadow_challenger("GAOptimizer", "v2", pool=pool, save=False)
    except ValueError as exc:
        assert "experimental shadow predictor" in str(exc)
    else:
        raise AssertionError("GAOptimizer must not register as shadow predictor")


def test_chronos_is_retired_from_alpha_pool():
    assert "Chronos" in model_pool.RETIRED_ALPHA_MODELS
    assert "Chronos" not in model_pool.ALPHA_PREDICTION_MODELS
    assert "Chronos" not in model_pool.MANAGED_MODELS
