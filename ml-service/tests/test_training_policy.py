from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.training_policy import (  # noqa: E402
    FeatureSelectionPolicy,
    FEATURE_SELECTION_GOVERNANCE,
    MODEL_FEATURE_POLICIES,
    UniversalTrainingPolicy,
    build_model_feature_policy_metadata,
    build_group_train_payload,
    feature_policy_for_model,
    generated_model_pool_version,
    models_for_training_group,
    should_force_full_feature_pool,
    should_force_model_pool_challenger,
    ValidationGovernancePolicy,
    training_group_feature_policy,
)
from app.universal_training import (  # noqa: E402
    UniversalTrainRequest,
    build_ft_model_cpcv_params,
    build_non_tree_model_cpcv_gap_evidence,
    model_cpcv_family_adapter_enabled,
)


def test_feature_selection_policy_keeps_current_defaults():
    policy = FeatureSelectionPolicy.from_env()

    assert policy.to_selection_params() == {
        "max_rounds": 100,
        "alpha": 0.01,
        "required_power": 0.99,
        "icir_weight": 0.1,
        "permutation_mode": "within_date_sector",
    }


def test_feature_selection_policy_reads_env_overrides(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_MAX_ROUNDS", "55")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ALPHA", "0.02")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_REQUIRED_POWER", "0.95")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ICIR_WEIGHT", "0.2")

    policy = FeatureSelectionPolicy.from_env()

    assert policy.to_selection_params() == {
        "max_rounds": 55,
        "alpha": 0.02,
        "required_power": 0.95,
        "icir_weight": 0.2,
        "permutation_mode": "within_date_sector",
    }


def test_feature_selection_policy_merges_payload_overrides():
    policy = FeatureSelectionPolicy()

    assert policy.to_selection_params({"max_rounds": "40", "alpha": "0.03"}) == {
        "max_rounds": 40,
        "alpha": 0.03,
        "required_power": 0.99,
        "icir_weight": 0.1,
        "permutation_mode": "within_date_sector",
    }


def test_feature_selection_policy_window_params_keep_lighter_default():
    policy = FeatureSelectionPolicy()

    assert policy.to_window_selection_params() == {
        "max_rounds": 60,
        "alpha": 0.01,
        "required_power": 0.99,
        "icir_weight": 0.1,
        "permutation_mode": "within_date_sector",
    }


def test_validation_governance_policy_keeps_cpcv_defaults():
    policy = ValidationGovernancePolicy.from_env()

    assert policy.to_split_params() == {
        "embargo_base_days": 10,
        "embargo_pct": 0.015,
        "max_embargo_days": 20,
        "cpcv_n_groups": 6,
        "cpcv_n_test_groups": 2,
        "cpcv_min_train_groups": 2,
    }


def test_validation_governance_policy_reads_env_and_payload_overrides(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_VALIDATION_CPCV_N_GROUPS", "8")
    monkeypatch.setenv("UNIVERSAL_VALIDATION_CPCV_N_TEST_GROUPS", "3")
    monkeypatch.setenv("UNIVERSAL_VALIDATION_EMBARGO_PCT", "0.02")

    policy = ValidationGovernancePolicy.from_env()

    assert policy.to_split_params({"cpcv_n_groups": "10", "max_embargo_days": "30"}) == {
        "embargo_base_days": 10,
        "embargo_pct": 0.02,
        "max_embargo_days": 30,
        "cpcv_n_groups": 10,
        "cpcv_n_test_groups": 3,
        "cpcv_min_train_groups": 2,
    }


def test_universal_train_request_runs_model_cpcv_by_default():
    req = UniversalTrainRequest()

    assert req.enable_model_cpcv is True


def test_model_cpcv_cost_multiplier_is_visible_in_validation_metadata():
    from app.universal_training import build_validation_split_metadata

    metadata = build_validation_split_metadata(
        {
            "embargo_base_days": 10,
            "embargo_pct": 0.015,
            "max_embargo_days": 20,
            "cpcv_n_groups": 6,
            "cpcv_n_test_groups": 2,
            "cpcv_min_train_groups": 2,
        },
        enable_model_cpcv=True,
    )

    assert metadata["model_cpcv_cost_estimate"]["cpcv_split_count"] == 15
    assert metadata["model_cpcv_cost_estimate"]["additional_fit_count"] == 60
    assert metadata["model_cpcv_cost_estimate"]["tree_fit_multiplier"] == 16
    assert metadata["model_cpcv_cost_estimate"]["supported_models"] == [
        "XGBoost",
        "CatBoost",
        "ExtraTrees",
        "LightGBM",
    ]
    assert "FT-Transformer" in metadata["model_cpcv_cost_estimate"]["optional_family_adapters"]
    assert metadata["model_cpcv_cost_estimate"]["forecast_validation_models"]["Chronos"]["method"] == (
        "chronos_forecast_rank_ic"
    )
    assert metadata["model_cpcv_cost_estimate"]["sequence_models"]["DLinear"]["default_method"] == (
        "sequence_oos_fold_rank_ic"
    )
    assert metadata["model_cpcv_cost_estimate"]["sequence_models"]["PatchTST"]["full_cpcv_method"] == (
        "purged_cpcv_sequence_rank_ic"
    )
    assert metadata["model_cpcv_cost_estimate"]["unsupported_until_family_adapter"]["sequence_models"] == []
    assert "foundation_time_series" not in metadata["model_cpcv_cost_estimate"]["unsupported_until_family_adapter"]


def test_non_tree_model_cpcv_gap_evidence_is_fail_visible():
    evidence = build_non_tree_model_cpcv_gap_evidence(
        ["XGBoost", "FT-Transformer", "DLinear", "PatchTST", "Chronos"],
        validation_split_metadata={
            "model_cpcv_cost_estimate": {
                "cpcv_split_count": 15,
                "additional_fit_count": 60,
            }
        },
    )

    assert "XGBoost" not in evidence
    assert evidence["FT-Transformer"]["decision"] == "FAIL"
    assert evidence["FT-Transformer"]["family"] == "tabular_deep"
    assert "DLinear" not in evidence
    assert "PatchTST" not in evidence
    assert "Chronos" not in evidence


def test_ft_model_cpcv_adapter_requires_explicit_policy_enable():
    assert model_cpcv_family_adapter_enabled("FT-Transformer", None) is False
    assert model_cpcv_family_adapter_enabled(
        "FT-Transformer",
        {"family_adapters": {"FT-Transformer": {"enabled": True}}},
    ) is True
    assert model_cpcv_family_adapter_enabled(
        "DLinear",
        {"family_adapters": {"FT-Transformer": {"enabled": True}}},
    ) is False


def test_build_ft_model_cpcv_params_uses_request_and_policy_overrides():
    req = UniversalTrainRequest(
        ftt_d_model=64,
        ftt_n_heads=4,
        ftt_n_layers=2,
        ftt_dropout=0.2,
        ftt_lr=0.0003,
        ftt_batch_size=256,
        ftt_margin=0.1,
        model_cpcv_policy={
            "family_adapters": {
                "FT-Transformer": {
                    "max_epochs": 3,
                    "batch_size": 128,
                    "seed": 99,
                }
            }
        },
    )

    params = build_ft_model_cpcv_params(req)

    assert params["d_model"] == 64
    assert params["n_heads"] == 4
    assert params["max_epochs"] == 3
    assert params["batch_size"] == 128
    assert params["seed"] == 99


def test_universal_training_policy_keeps_current_defaults():
    policy = UniversalTrainingPolicy.from_env()

    assert policy.requested_groups({}) == ["tree", "ftt", "dlinear", "patchtst"]
    assert policy.sequence_min_length({}) == 65
    assert policy.to_base_train_payload({}, candidate_version="v-test") == {
        "batch_count": 5,
        "ftt_d_model": 128,
        "ftt_n_heads": 8,
        "ftt_n_layers": 3,
        "ftt_dropout": 0.12,
        "ftt_max_epochs": 120,
        "ftt_lr": 2e-4,
        "ftt_patience": 16,
        "ftt_batch_size": 1024,
        "ftt_margin": 0.0,
        "output_model_version": "v-test",
        "register_challengers": False,
    }


def test_universal_training_policy_reads_env_and_payload_overrides(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_TRAIN_MODEL_GROUPS", "tree,ftt")
    monkeypatch.setenv("UNIVERSAL_SEQUENCE_MIN_LEN", "88")
    monkeypatch.setenv("UNIVERSAL_FTT_D_MODEL", "256")
    monkeypatch.setenv("UNIVERSAL_FTT_LR", "0.0003")

    policy = UniversalTrainingPolicy.from_env()

    assert policy.requested_groups({}) == ["tree", "ftt"]
    assert policy.sequence_min_length({}) == 88
    assert policy.to_base_train_payload(
        {
            "batch_count": "7",
            "ftt_lr": "0.0001",
            "ftt_dropout": "0.2",
        },
        candidate_version="v-env",
    )["ftt_lr"] == 0.0001
    assert policy.to_base_train_payload({"ftt_dropout": "0.2"}, candidate_version="v-env")[
        "ftt_d_model"
    ] == 256


def test_universal_training_policy_accepts_payload_group_string():
    policy = UniversalTrainingPolicy(default_train_groups=("tree", "ftt"))

    assert policy.requested_groups({"train_model_groups": "tree,patchtst"}) == ["tree", "patchtst"]


def test_universal_train_without_version_should_become_model_pool_challenger():
    assert should_force_model_pool_challenger(
        gcs_prefix="universal",
        walk_forward_mode=False,
        output_model_version=None,
    ) is True
    assert generated_model_pool_version("2026-04-30T01:02:03.123456+00:00") == "v20260430T010203"


def test_universal_train_walk_forward_keeps_explicit_storage_scope():
    assert should_force_model_pool_challenger(
        gcs_prefix="walk_forward/w0",
        walk_forward_mode=True,
        output_model_version=None,
    ) is False


def test_training_group_feature_policies_are_single_source_of_truth():
    tree = training_group_feature_policy("tree")
    ftt = training_group_feature_policy("ftt")
    dlinear = training_group_feature_policy("dlinear")
    patchtst = training_group_feature_policy("patchtst")

    assert tree.feature_source == "feature_pool.tree_active"
    assert tree.skip_feature_pool is False
    assert tree.mergeable_oos is True
    assert models_for_training_group("tree") == ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]

    assert ftt.feature_source == "feature_pool.ft_active"
    assert ftt.skip_feature_pool is True
    assert ftt.mergeable_oos is True
    assert models_for_training_group("ftt") == ["FT-Transformer"]

    assert dlinear.feature_source == "sequence_records.close_only"
    assert dlinear.skip_feature_pool is True
    assert dlinear.mergeable_oos is False
    assert patchtst.feature_source == "sequence_records.close_only"
    assert patchtst.skip_feature_pool is True
    assert patchtst.mergeable_oos is False


def test_group_train_payload_enforces_tree_vs_ft_feature_policy():
    base = {"batch_count": 5, "skip_feature_pool": True, "models_filter": ["Legacy"]}

    tree_payload = build_group_train_payload(base, "tree")
    ftt_payload = build_group_train_payload(base, "ftt")

    assert tree_payload["models_filter"] == ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]
    assert tree_payload["skip_feature_pool"] is False
    assert tree_payload["feature_policy"]["feature_source"] == "feature_pool.tree_active"

    assert ftt_payload["models_filter"] == ["FT-Transformer"]
    assert ftt_payload["skip_feature_pool"] is True
    assert ftt_payload["feature_policy"]["feature_source"] == "feature_pool.ft_active"


def test_ft_transformer_filter_forces_full_feature_pool_defensively():
    assert should_force_full_feature_pool(["FT-Transformer"]) is True
    assert should_force_full_feature_pool(["XGBoost", "LightGBM"]) is False
    assert should_force_full_feature_pool(["FT-Transformer", "XGBoost"]) is False
    assert should_force_full_feature_pool(None) is False


def test_model_feature_policy_contract_covers_eight_alpha_slots():
    expected = {
        "XGBoost",
        "CatBoost",
        "ExtraTrees",
        "LightGBM",
        "FT-Transformer",
        "Chronos",
        "DLinear",
        "PatchTST",
    }

    assert expected.issubset(set(MODEL_FEATURE_POLICIES))
    assert feature_policy_for_model("XGBoost").feature_source == "feature_pool.tree_active"
    assert feature_policy_for_model("FT-Transformer").uses_missingness_mask is True
    assert feature_policy_for_model("DLinear").feature_source == "sequence_records.close_only"
    assert feature_policy_for_model("PatchTST").feature_source == "sequence_records.close_only"
    assert feature_policy_for_model("Chronos").feature_source == "chronos2.context.close_series"


def test_feature_selection_governance_has_no_planned_p3_methods_left():
    methods = FEATURE_SELECTION_GOVERNANCE["methods"]

    assert methods["mutual_information"]["status"] == "active"
    assert methods["stability_selection"]["status"] == "active"
    assert methods["cur"]["status"] == "active"
    assert methods["target_permutation_block_date_sector"]["status"] == "active"


def test_model_feature_policy_metadata_records_feature_count_and_evidence():
    meta = build_model_feature_policy_metadata(
        "FT-Transformer",
        ["rsi14", "macd", "bias20"],
        selection_evidence={"feature_pool_path": "universal/feature_pool.json"},
    )

    assert meta["feature_policy_schema_version"] == "model-feature-policy-v1"
    assert meta["feature_count"] == 3
    assert meta["feature_policy"]["model"] == "FT-Transformer"
    assert meta["feature_policy"]["requires_schema_parity"] is True
    assert meta["selection_evidence"]["feature_pool_path"] == "universal/feature_pool.json"
