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
    assert tuple(model_pool.RETIRED_ALPHA_MODELS) == (
        "CatBoost",
        "FT-Transformer",
        "FTTransformer",
        "Chronos",
        "Chronos2ZeroShot",
        "Chronos2LoRA",
    )
    assert "ResidualMLP" not in model_pool.RETIRED_ALPHA_MODELS
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


def test_active_path_uses_model_pool_gcs_path_as_source_of_truth():
    pool = model_pool.init_default_pool()
    pool["models"]["XGBoost"]["version"] = "v-custom"
    pool["models"]["XGBoost"]["gcs_path"] = "universal/xgboost/live-reviewed.joblib"

    assert model_pool.get_active_path("XGBoost", pool=pool) == "universal/xgboost/live-reviewed.joblib"


def test_model_pool_bucket_name_reads_runtime_env(monkeypatch):
    monkeypatch.setattr(model_pool, "GCS_BUCKET", "")
    monkeypatch.setenv("GCS_BUCKET_NAME", "runtime-stockvision-models")

    assert model_pool._get_configured_gcs_bucket() == "runtime-stockvision-models"


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


def test_active9_legacy_challenger_registration_is_disabled():
    pool = model_pool.init_default_pool()

    try:
        model_pool.register_challenger("LightGBM", "v2", pool=pool, save=False)
    except ValueError as exc:
        assert "legacy model_pool challenger registration is disabled" in str(exc)
        assert "artifact_registry" in str(exc)
    else:
        raise AssertionError("active-9 models must not register legacy challengers")

    assert "challenger" not in pool["models"]["LightGBM"]


def test_chronos_is_retired_from_alpha_pool():
    assert "Chronos" in model_pool.RETIRED_ALPHA_MODELS
    assert "Chronos" not in model_pool.ALPHA_PREDICTION_MODELS
    assert "Chronos" not in model_pool.MANAGED_MODELS


def test_model_pool_sanitizer_drops_legacy_alpha_residue_but_keeps_meta_layers():
    pool = model_pool.init_default_pool()
    pool["models"]["CatBoost"] = {"status": "degraded", "version": "legacy"}
    pool["models"]["FT-Transformer"] = {"status": "active", "version": "legacy"}
    pool["models"]["Chronos"] = {"status": "degraded", "version": "legacy"}

    sanitized = model_pool.sanitize_pool_active9(pool)

    assert set(sanitized["models"]) == set(model_pool.ALPHA_PREDICTION_MODELS)
    assert "CatBoost" not in sanitized["models"]
    assert "FT-Transformer" not in sanitized["models"]
    assert "Chronos" not in sanitized["models"]
    assert "GAOptimizer" in sanitized["meta_optimizers"]
    assert set(sanitized["state_overlays"]) == {"KalmanFilter", "MarkovSwitching"}
