from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.training_policy import (  # noqa: E402
    FeatureSelectionPolicy,
    FEATURE_SELECTION_GOVERNANCE,
    MODEL_FEATURE_POLICIES,
    UniversalTrainingPolicy,
    build_feature_selection_run_kwargs,
    build_model_feature_policy_metadata,
    build_group_train_payload,
    build_tree_model_child_payloads,
    dedupe_train_groups_for_artifact_lifecycle,
    feature_policy_for_model,
    generated_model_pool_version,
    models_for_training_group,
    should_force_artifact_candidate_version,
    should_force_full_feature_pool,
    ValidationGovernancePolicy,
    training_group_feature_policy,
)
from app import universal_training  # noqa: E402
from app import model_pool  # noqa: E402
from app.universal_training import (  # noqa: E402
    UniversalTrainRequest,
    build_non_tree_model_cpcv_gap_evidence,
    model_cpcv_family_adapter_enabled,
)


def test_feature_selection_policy_uses_candidate_v2_default_profile():
    policy = FeatureSelectionPolicy.from_env()

    assert policy.to_selection_params() == {
        "max_rounds": 100,
        "alpha": 0.01,
        "required_power": 0.99,
        "icir_weight": 0.1,
        "permutation_mode": "within_date_sector",
        "signal_sanity_max_workers": 2,
        "target_permutation_max_workers": 2,
        "k_sweep_n_jobs": 2,
        "algorithm_profile": "candidate_v2",
        "cluster_linkage": "ward",
        "k_sweep_sampler": "nsga2",
        "k_sweep_objective": "single_val_ic",
        "k_sweep_knee_policy": "kneedle_080",
        "k_sweep_bootstrap_rounds": 0,
        "embargo_mode": "dynamic",
        "label_horizon_days": 5,
    }


def test_feature_selection_policy_reads_env_overrides(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_MAX_ROUNDS", "55")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ALPHA", "0.02")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_REQUIRED_POWER", "0.95")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ICIR_WEIGHT", "0.2")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_SIGNAL_SANITY_WORKERS", "3")

    policy = FeatureSelectionPolicy.from_env()

    assert policy.to_selection_params() == {
        "max_rounds": 55,
        "alpha": 0.02,
        "required_power": 0.95,
        "icir_weight": 0.2,
        "permutation_mode": "within_date_sector",
        "signal_sanity_max_workers": 3,
        "target_permutation_max_workers": 2,
        "k_sweep_n_jobs": 2,
        "algorithm_profile": "candidate_v2",
        "cluster_linkage": "ward",
        "k_sweep_sampler": "nsga2",
        "k_sweep_objective": "single_val_ic",
        "k_sweep_knee_policy": "kneedle_080",
        "k_sweep_bootstrap_rounds": 0,
        "embargo_mode": "dynamic",
        "label_horizon_days": 5,
    }


def test_feature_selection_policy_merges_payload_overrides():
    policy = FeatureSelectionPolicy()

    assert policy.to_selection_params({"max_rounds": "40", "alpha": "0.03"}) == {
        "max_rounds": 40,
        "alpha": 0.03,
        "required_power": 0.99,
        "icir_weight": 0.1,
        "permutation_mode": "within_date_sector",
        "signal_sanity_max_workers": 2,
        "target_permutation_max_workers": 2,
        "k_sweep_n_jobs": 2,
        "algorithm_profile": "candidate_v2",
        "cluster_linkage": "ward",
        "k_sweep_sampler": "nsga2",
        "k_sweep_objective": "single_val_ic",
        "k_sweep_knee_policy": "kneedle_080",
        "k_sweep_bootstrap_rounds": 0,
        "embargo_mode": "dynamic",
        "label_horizon_days": 5,
    }


def test_feature_selection_policy_exposes_algorithm_profile_knobs(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ALGO_PROFILE", "candidate_v2")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_CLUSTER_LINKAGE", "average")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_K_SWEEP_SAMPLER", "motpe")

    policy = FeatureSelectionPolicy.from_env()
    params = policy.to_selection_params({"k_sweep_knee_policy": "bootstrap_ci"})

    assert params["algorithm_profile"] == "candidate_v2"
    assert params["cluster_linkage"] == "average"
    assert params["k_sweep_sampler"] == "motpe"
    assert params["k_sweep_knee_policy"] == "bootstrap_ci"


def test_feature_selection_run_kwargs_include_algorithm_knobs():
    params = FeatureSelectionPolicy().to_selection_params({
        "algorithm_profile": "candidate_v2",
        "cluster_linkage": "average",
        "k_sweep_sampler": "motpe",
        "k_sweep_objective": "purged_rolling_ic",
        "k_sweep_knee_policy": "bootstrap_ci",
        "k_sweep_bootstrap_rounds": 25,
        "embargo_mode": "label_horizon",
        "label_horizon_days": 7,
    })

    kwargs = build_feature_selection_run_kwargs(params)

    assert kwargs["algorithm_profile"] == "candidate_v2"
    assert kwargs["cluster_linkage"] == "average"
    assert kwargs["k_sweep_sampler"] == "motpe"
    assert kwargs["k_sweep_objective"] == "purged_rolling_ic"
    assert kwargs["k_sweep_knee_policy"] == "bootstrap_ci"
    assert kwargs["k_sweep_bootstrap_rounds"] == 25
    assert kwargs["embargo_mode"] == "label_horizon"
    assert kwargs["label_horizon_days"] == 7
    assert kwargs["permutation_mode"] == "within_date_sector"
    assert "train_end_date" not in kwargs


def test_feature_selection_policy_window_params_keep_lighter_default():
    policy = FeatureSelectionPolicy()

    assert policy.to_window_selection_params() == {
        "max_rounds": 60,
        "alpha": 0.01,
        "required_power": 0.99,
        "icir_weight": 0.1,
        "permutation_mode": "within_date_sector",
        "signal_sanity_max_workers": 2,
        "target_permutation_max_workers": 2,
        "k_sweep_n_jobs": 2,
        "algorithm_profile": "candidate_v2",
        "cluster_linkage": "ward",
        "k_sweep_sampler": "nsga2",
        "k_sweep_objective": "single_val_ic",
        "k_sweep_knee_policy": "kneedle_080",
        "k_sweep_bootstrap_rounds": 0,
        "embargo_mode": "dynamic",
        "label_horizon_days": 5,
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
    assert metadata["model_cpcv_cost_estimate"]["additional_fit_count"] == 45
    assert metadata["model_cpcv_cost_estimate"]["tree_fit_multiplier"] == 16
    assert metadata["model_cpcv_cost_estimate"]["supported_models"] == [
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
    ]
    assert metadata["model_cpcv_cost_estimate"]["optional_family_adapters"] == {}
    assert set(metadata["model_cpcv_cost_estimate"]["artifact_required_targets"]) == {
        "TabM",
        "GNN",
        "iTransformer",
        "TimesFM",
    }
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
        ["LightGBM", "TabM", "DLinear", "PatchTST", "TimesFM"],
        validation_split_metadata={
            "model_cpcv_cost_estimate": {
                "cpcv_split_count": 15,
                "additional_fit_count": 60,
            }
        },
    )

    assert "LightGBM" not in evidence
    assert "TabM" not in evidence
    assert "DLinear" not in evidence
    assert "PatchTST" not in evidence
    assert "TimesFM" not in evidence


def test_retired_ft_model_cpcv_adapter_is_not_enabled():
    assert model_cpcv_family_adapter_enabled("FT-Transformer", None) is False
    assert model_cpcv_family_adapter_enabled(
        "FT-Transformer",
        {"family_adapters": {"FT-Transformer": {"enabled": True}}},
    ) is False
    assert model_cpcv_family_adapter_enabled(
        "DLinear",
        {"family_adapters": {"FT-Transformer": {"enabled": True}}},
    ) is False


def test_universal_training_policy_keeps_current_defaults():
    policy = UniversalTrainingPolicy.from_env()

    assert policy.requested_groups({}) == ["tree", "dlinear", "patchtst"]
    assert policy.sequence_min_length({}) == 65
    assert policy.to_base_train_payload({}, candidate_version="v-test") == {
        "batch_count": 5,
        "output_model_version": "v-test",
        "register_challengers": False,
        "model_cpcv_policy": {"family_adapters": {}},
        "label_horizon_days": 5,
        "tree_model_split": True,
    }


def test_universal_lifecycle_normalization_does_not_register_legacy_challengers():
    req = UniversalTrainRequest(gcs_prefix="universal")

    normalized = universal_training.normalize_universal_lifecycle_request(
        req,
        gcs_prefix="universal",
        walk_forward_mode=False,
        now_fn=lambda: "2026-06-14T00:00:00Z",
    )

    assert normalized.output_model_version == "v20260614T000000"
    assert normalized.register_challengers is False


def test_universal_training_policy_supports_artifact_lifecycle_only():
    policy = UniversalTrainingPolicy()

    assert policy.requested_groups({"artifact_lifecycle_only": True, "train_model_groups": []}) == []


def test_universal_training_policy_reads_env_and_payload_overrides(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_TRAIN_MODEL_GROUPS", "tree,retired_ft")
    monkeypatch.setenv("UNIVERSAL_SEQUENCE_MIN_LEN", "88")

    policy = UniversalTrainingPolicy.from_env()

    assert policy.requested_groups({}) == ["tree"]
    assert policy.sequence_min_length({}) == 88
    assert policy.to_base_train_payload({"batch_count": "7"}, candidate_version="v-env")["batch_count"] == 7


def test_universal_training_policy_accepts_payload_group_string():
    policy = UniversalTrainingPolicy(default_train_groups=("tree",))

    assert policy.requested_groups({"train_model_groups": "tree,patchtst"}) == ["tree", "patchtst"]


def test_artifact_lifecycle_targets_suppress_duplicate_train_groups():
    groups, suppressed = dedupe_train_groups_for_artifact_lifecycle(
        ["tree", "dlinear", "patchtst"],
        ["GNN", "PatchTST", "iTransformer", "TimesFM"],
    )

    assert groups == ["tree", "dlinear"]
    assert suppressed == [
        {
            "group": "patchtst",
            "model": "PatchTST",
            "reason": "artifact_lifecycle_target_owns_training",
        }
    ]


def test_artifact_lifecycle_duplicate_train_groups_can_be_explicitly_allowed():
    groups, suppressed = dedupe_train_groups_for_artifact_lifecycle(
        ["patchtst"],
        ["PatchTST"],
        allow_duplicate=True,
    )

    assert groups == ["patchtst"]
    assert suppressed == []


def test_universal_train_without_version_should_get_artifact_candidate_version():
    assert should_force_artifact_candidate_version(
        gcs_prefix="universal",
        walk_forward_mode=False,
        output_model_version=None,
    ) is True
    assert generated_model_pool_version("2026-04-30T01:02:03.123456+00:00") == "v20260430T010203"


def test_universal_train_walk_forward_keeps_explicit_storage_scope():
    assert should_force_artifact_candidate_version(
        gcs_prefix="walk_forward/w0",
        walk_forward_mode=True,
        output_model_version=None,
    ) is False


def test_training_group_feature_policies_are_single_source_of_truth():
    tree = training_group_feature_policy("tree")
    dlinear = training_group_feature_policy("dlinear")
    patchtst = training_group_feature_policy("patchtst")

    assert tree.feature_source == "feature_pool.tree_active"
    assert tree.skip_feature_pool is False
    assert tree.mergeable_oos is True
    assert models_for_training_group("tree") == ["LightGBM", "XGBoost", "ExtraTrees"]
    assert training_group_feature_policy("retired_ft") is None
    assert models_for_training_group("retired_ft") == []

    assert dlinear.feature_source == "sequence_records.close_only"
    assert dlinear.skip_feature_pool is True
    assert dlinear.mergeable_oos is False
    assert patchtst.feature_source == "sequence_records.close_only"
    assert patchtst.skip_feature_pool is True
    assert patchtst.mergeable_oos is False


def test_group_train_payload_enforces_tree_feature_policy():
    base = {"batch_count": 5, "skip_feature_pool": True, "models_filter": ["Legacy"]}

    tree_payload = build_group_train_payload(base, "tree")

    assert tree_payload["models_filter"] == ["LightGBM", "XGBoost", "ExtraTrees"]
    assert tree_payload["skip_feature_pool"] is False
    assert tree_payload["feature_policy"]["feature_source"] == "feature_pool.tree_active"


def test_tree_model_child_payloads_keep_tree_policy_and_unique_manifest_suffixes():
    base = {"batch_count": 5, "skip_feature_pool": True, "output_model_version": "v20260518010101"}

    payloads = build_tree_model_child_payloads(base)

    assert list(payloads) == ["LightGBM", "XGBoost", "ExtraTrees"]
    for model_name, payload in payloads.items():
        assert payload["models_filter"] == [model_name]
        assert payload["skip_feature_pool"] is False
        assert payload["feature_policy"]["feature_source"] == "feature_pool.tree_active"
        assert payload["tree_split_parent_models"] == ["LightGBM", "XGBoost", "ExtraTrees"]
        assert payload["tree_split_model"] == model_name
        assert payload["training_run_suffix"] == model_name.lower()


def test_retired_ft_transformer_filter_does_not_force_full_feature_pool():
    assert should_force_full_feature_pool(["FT-Transformer"]) is False
    assert should_force_full_feature_pool(["XGBoost", "LightGBM"]) is False
    assert should_force_full_feature_pool(["FT-Transformer", "XGBoost"]) is False
    assert should_force_full_feature_pool(None) is False


def test_model_feature_policy_contract_covers_refactored_alpha_slots():
    expected = {
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
        "TimesFM",
    }

    assert expected.issubset(set(MODEL_FEATURE_POLICIES))
    assert feature_policy_for_model("LightGBM").feature_source == "feature_pool.tree_active"
    assert feature_policy_for_model("TabM").feature_policy_type == "selected_tabular_artifact_required"
    assert feature_policy_for_model("GNN").feature_policy_type == "graph_artifact_required"
    assert feature_policy_for_model("DLinear").feature_source == "sequence_records.close_only"
    assert feature_policy_for_model("PatchTST").feature_source == "sequence_records.close_only"
    assert feature_policy_for_model("iTransformer").feature_source == "sequence_records.close_only"
    assert feature_policy_for_model("TimesFM").feature_source == "sequence_records.close_only"


def test_feature_selection_governance_has_no_planned_p3_methods_left():
    methods = FEATURE_SELECTION_GOVERNANCE["methods"]

    assert methods["mutual_information"]["status"] == "active"
    assert methods["stability_selection"]["status"] == "active"
    assert methods["cur"]["status"] == "active"
    assert methods["target_permutation_block_date_sector"]["status"] == "active"


def test_model_feature_policy_metadata_records_feature_count_and_evidence():
    meta = build_model_feature_policy_metadata(
        "TabM",
        ["rsi14", "macd", "bias20"],
        selection_evidence={"feature_pool_path": "universal/feature_pool.json"},
    )

    assert meta["feature_policy_schema_version"] == "model-feature-policy-v1"
    assert meta["feature_count"] == 3
    assert meta["feature_policy"]["model"] == "TabM"
    assert meta["feature_policy"]["requires_schema_parity"] is True
    assert meta["selection_evidence"]["feature_pool_path"] == "universal/feature_pool.json"


def test_register_challenger_safe_is_disabled_but_preserves_feature_policy_metadata():
    result = universal_training._register_challenger_safe(
        "LightGBM",
        "v20260517170259",
        model_cpcv={"decision": "PASS"},
        feature_policy_version="model-feature-policy-v1",
        feature_policy={"model": "LightGBM", "feature_policy_type": "selected_tabular"},
    )

    assert result["status"] == "disabled"
    assert "legacy_model_pool_challenger_disabled" in result["reason"]
    assert result["feature_policy_version"] == "model-feature-policy-v1"
    assert result["feature_policy"]["feature_policy_type"] == "selected_tabular"
