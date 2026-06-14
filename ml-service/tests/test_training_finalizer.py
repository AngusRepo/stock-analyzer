import numpy as np

from app.training_finalizer import (
    build_oos_artifact_path,
    combine_oos_rank_payloads,
    build_retrain_followup_payload,
    build_suppressed_legacy_challenger_registrations,
    derive_oos_artifact_group,
    expected_oos_artifact_groups,
    missing_expected_oos_groups,
    merge_oos_rank_payloads,
    reduce_training_group_results,
    reduce_tree_model_child_results,
    summarize_training_stage_status,
    validate_sequence_series,
)


def test_derive_oos_artifact_group_for_split_training_filters():
    assert derive_oos_artifact_group(["LightGBM", "XGBoost", "ExtraTrees"]) == "tree"
    assert derive_oos_artifact_group(["PatchTST"]) == "custom_patchtst"
    assert derive_oos_artifact_group(None) == "full"
    assert derive_oos_artifact_group(["XGBoost"]) == "custom_xgboost"


def test_build_oos_artifact_path_is_versioned_and_grouped():
    assert (
        build_oos_artifact_path("universal", "v20260426090000", "tree")
        == "universal/oos/v20260426090000/tree.npz"
    )


def test_merge_oos_rank_payloads_aligns_tree_predictions():
    rows, y, model_order = merge_oos_rank_payloads(
        [
            {
                "group": "tree",
                "y_test": np.array([0.1, 0.9]),
                "predictions": {
                    "LightGBM": np.array([0.2, 0.8]),
                    "XGBoost": np.array([0.3, 0.7]),
                },
            },
        ]
    )

    assert model_order == ["LightGBM", "XGBoost"]
    assert y.tolist() == [0.1, 0.9]
    assert rows == [
        {"LightGBM": 0.2, "XGBoost": 0.3},
        {"LightGBM": 0.8, "XGBoost": 0.7},
    ]


def test_summarize_training_stage_status_marks_sequence_skip_degraded():
    status = summarize_training_stage_status(
        {
            "tree": {"status": "ok"},
            "dlinear": {"status": "skipped", "reason": "missing_series_close_artifact"},
        }
    )

    assert status == "degraded"


def test_missing_expected_oos_groups_blocks_partial_stacker_overwrite():
    expected = expected_oos_artifact_groups(["tree", "retired_ft", "dlinear"])

    assert expected == ["tree"]
    assert missing_expected_oos_groups(expected, [{"group": "tree"}]) == []
    assert missing_expected_oos_groups(expected_oos_artifact_groups(["tree"]), [{"group": "tree"}]) == []


def test_validate_sequence_series_filters_short_and_non_finite_rows():
    valid, report = validate_sequence_series(
        [
            [1.0] * 65,
            [1.0] * 64,
            [1.0, float("nan")] + [1.0] * 63,
        ],
        min_len=65,
    )

    assert valid == [[1.0] * 65]
    assert report == {
        "input_series": 3,
        "valid_series": 1,
        "dropped_short": 1,
        "dropped_non_finite": 1,
        "min_len": 65,
    }


def test_reduce_training_group_results_merges_ic_and_candidate_models():
    reduced = reduce_training_group_results(
        {
            "total_samples": 100,
            "results": {
                "XGBoost": {"oos_ic": 0.03},
                "LightGBM": {"skipped": True},
            },
            "ic_tracking": {
                "XGBoost": {"passed": True, "oos_ic": 0.03},
            },
        },
        {
            "dlinear": {
                "training_run_id": "run-dl",
                "ic_tracking": {"DLinear": {"passed": True, "oos_ic": 0.02}},
            },
            "patchtst": {
                "training_run_id": "run-pt",
                "ic_tracking": {"PatchTST": {"passed": True, "oos_ic": 0.01}},
            },
        },
    )

    assert reduced["total_samples"] == 100
    assert sorted(reduced["merged_results"]) == ["XGBoost"]
    assert sorted(reduced["merged_ic"]) == ["DLinear", "PatchTST", "XGBoost"]
    assert reduced["circuit_breaker"] is False
    assert reduced["candidate_models"] == ["DLinear", "PatchTST", "XGBoost"]
    assert reduced["sequence_candidate_models"] == {"dlinear": "DLinear", "patchtst": "PatchTST"}


def test_legacy_challenger_suppression_stays_outside_registry_candidates():
    suppressed = build_suppressed_legacy_challenger_registrations(
        register_challengers=True,
        candidate_models=["DLinear", "XGBoost", "XGBoost"],
        existing_registrations={"XGBoost": {"status": "registered"}},
        candidate_version="v20260614010101",
    )

    assert suppressed == {
        "DLinear": {
            "status": "disabled",
            "version": "v20260614010101",
            "reason": "legacy_model_pool_challenger_disabled_for_active9_artifact_registry_flow",
        }
    }
    assert build_suppressed_legacy_challenger_registrations(
        register_challengers=False,
        candidate_models=["DLinear"],
        existing_registrations={},
        candidate_version="v20260614010101",
    ) == {}


def test_reduce_training_group_results_records_partial_errors():
    reduced = reduce_training_group_results(
        {"error": "tree failed"},
        {"patchtst": {"error": "missing sequence"}},
    )

    assert reduced["merged_results"] == {}
    assert reduced["merged_ic"] == {}
    assert reduced["candidate_models"] == []
    assert reduced["partial_errors"] == [
        {"group": "tree", "error": "tree failed"},
        {"group": "patchtst", "error": "missing sequence"},
    ]


def test_reduce_tree_model_child_results_merges_children_as_tree_group():
    reduced = reduce_tree_model_child_results(
        {
            "XGBoost": {
                "total_samples": 100,
                "train_samples": 80,
                "test_samples": 20,
                "feature_count": 106,
                "elapsed_s": 12.0,
                "results": {"XGBoost": {"oos_ic": 0.03, "saved": True}},
                "ic_tracking": {"XGBoost": {"passed": True, "oos_ic": 0.03}},
                "training_manifest_path": "universal/manifests/v1-xgboost.json",
            },
            "LightGBM": {
                "total_samples": 100,
                "train_samples": 80,
                "test_samples": 20,
                "feature_count": 106,
                "elapsed_s": 8.0,
                "results": {"LightGBM": {"oos_ic": -0.01, "saved": True}},
                "ic_tracking": {"LightGBM": {"passed": False, "oos_ic": -0.01}},
                "training_manifest_path": "universal/manifests/v1-lightgbm.json",
            },
        },
        combined_oos_artifact={"path": "universal/oos/v1/tree.npz", "group": "tree"},
    )

    assert reduced["type"] == "tree_models_split"
    assert reduced["split_mode"] == "per_tree_model"
    assert sorted(reduced["results"]) == ["LightGBM", "XGBoost"]
    assert reduced["ic_tracking"]["LightGBM"]["passed"] is False
    assert reduced["circuit_breaker"] is True
    assert reduced["elapsed_s"] == 12.0
    assert reduced["train_samples"] == 80
    assert reduced["feature_count"] == 106
    assert reduced["oos_artifact"]["group"] == "tree"
    assert reduced["child_manifests"] == {
        "LightGBM": "universal/manifests/v1-lightgbm.json",
        "XGBoost": "universal/manifests/v1-xgboost.json",
    }


def test_combine_oos_rank_payloads_preserves_shared_test_axis_and_model_order():
    combined = combine_oos_rank_payloads(
        [
            {
                "group": "custom_lightgbm",
                "version": "v1",
                "predictions": {"LightGBM": np.array([0.8, 0.2])},
                "y_test": np.array([1.0, 0.0]),
                "dates_test": np.array(["2026-05-01", "2026-05-02"]),
                "feature_names": np.array(["f1", "f2"]),
            },
            {
                "group": "custom_xgboost",
                "version": "v1",
                "predictions": {"XGBoost": np.array([0.7, 0.3])},
                "y_test": np.array([1.0, 0.0]),
                "dates_test": np.array(["2026-05-01", "2026-05-02"]),
                "feature_names": np.array(["f1", "f2"]),
            },
        ],
        group="tree",
        version="v1",
    )

    assert combined["group"] == "tree"
    assert combined["version"] == "v1"
    assert combined["model_order"] == ["LightGBM", "XGBoost"]
    assert combined["samples"] == 2
    assert combined["feature_names"].tolist() == ["f1", "f2"]
    assert combined["dates_test"].tolist() == ["2026-05-01", "2026-05-02"]


def test_build_retrain_followup_payload_preserves_callback_schema():
    payload = build_retrain_followup_payload(
        run_id="universal-1",
        lock_key="lock:monthly",
        run_date="2026-05-18",
        is_monthly=True,
        batch_count=5,
        gcs_prefix="universal",
        candidate_version="v20260518010101",
        window_id=None,
        elapsed_s=123.4,
        partial_results={
            "tree": {"train_samples": 100, "feature_count": 80, "trained_at": "2026-05-18T01:00:00Z"},
        },
        result={
            "stages": {
                "train": {
                    "status": "ok",
                    "candidate_version": "v20260518020202",
                    "total_samples": 120,
                    "circuit_breaker": True,
                    "challenger_registrations": {"XGBoost": {"status": "registered"}},
                    "ic_tracking": {
                        "XGBoost": {"oos_ic": 0.03, "passed": True},
                        "LightGBM": {"ic_4w_avg": 0.02, "passed": True},
                    },
                }
            }
        },
    )

    assert payload["run_id"] == "universal-1"
    assert payload["trained_at"] == "2026-05-18T01:00:00Z"
    assert payload["status"] == "completed"
    assert payload["candidate_version"] == "v20260518020202"
    assert payload["total_samples"] == 120
    assert payload["train_samples"] == 100
    assert payload["feature_count"] == 80
    assert payload["circuit_breaker"] is True
    assert payload["ic_summary"] == {"XGBoost": 0.03, "LightGBM": 0.02}
    assert payload["modal_telemetry"][0]["meta"]["run_id"] == "universal-1"
    assert payload["modal_telemetry"][0]["function_name"] == "retrain_orchestrator"


def test_build_retrain_followup_payload_adds_artifact_scope_to_modal_telemetry():
    payload = build_retrain_followup_payload(
        run_id="universal-telemetry",
        lock_key="lock:monthly",
        run_date="2026-05-18",
        is_monthly=True,
        batch_count=5,
        gcs_prefix="universal",
        candidate_version="v20260518010101",
        window_id=None,
        elapsed_s=500.0,
        partial_results={
            "tree": {
                "results": {
                    "LightGBM": {"saved": True},
                    "XGBoost": {"saved": True},
                    "ExtraTrees": {"saved": True},
                },
                "train_samples": 1000,
                "test_samples": 250,
                "feature_count": 106,
            },
        },
        result={
            "stages": {
                "train": {
                    "status": "ok",
                    "group_coverage": {
                        "tree": {"status": "ok", "elapsed_s": 120.0},
                    },
                }
            }
        },
    )

    tree_event = next(e for e in payload["modal_telemetry"] if e["function_name"] == "train_tree_models")

    assert tree_event["meta"]["artifact_count"] == 3
    assert tree_event["meta"]["model_artifacts"] == ["LightGBM", "XGBoost", "ExtraTrees"]
    assert tree_event["meta"]["feature_count"] == 106
