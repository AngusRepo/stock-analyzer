import numpy as np

from app.training_finalizer import (
    build_oos_artifact_path,
    derive_oos_artifact_group,
    expected_oos_artifact_groups,
    missing_expected_oos_groups,
    merge_oos_rank_payloads,
    summarize_training_stage_status,
    validate_sequence_series,
)


def test_derive_oos_artifact_group_for_split_training_filters():
    assert derive_oos_artifact_group(["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]) == "tree"
    assert derive_oos_artifact_group(["FT-Transformer"]) == "ftt"
    assert derive_oos_artifact_group(None) == "full"
    assert derive_oos_artifact_group(["XGBoost"]) == "custom_xgboost"


def test_build_oos_artifact_path_is_versioned_and_grouped():
    assert (
        build_oos_artifact_path("universal", "v20260426090000", "tree")
        == "universal/oos/v20260426090000/tree.npz"
    )


def test_merge_oos_rank_payloads_aligns_tree_and_ft_predictions():
    rows, y, model_order = merge_oos_rank_payloads(
        [
            {
                "group": "tree",
                "y_test": np.array([0.1, 0.9]),
                "predictions": {
                    "XGBoost": np.array([0.2, 0.8]),
                    "CatBoost": np.array([0.3, 0.7]),
                },
            },
            {
                "group": "ftt",
                "y_test": np.array([0.1, 0.9]),
                "predictions": {
                    "FT-Transformer": np.array([0.4, 0.6]),
                },
            },
        ]
    )

    assert model_order == ["XGBoost", "CatBoost", "FT-Transformer"]
    assert y.tolist() == [0.1, 0.9]
    assert rows == [
        {"XGBoost": 0.2, "CatBoost": 0.3, "FT-Transformer": 0.4},
        {"XGBoost": 0.8, "CatBoost": 0.7, "FT-Transformer": 0.6},
    ]


def test_summarize_training_stage_status_marks_sequence_skip_degraded():
    status = summarize_training_stage_status(
        {
            "tree": {"status": "ok"},
            "ftt": {"status": "ok"},
            "dlinear": {"status": "skipped", "reason": "missing_series_close_artifact"},
        }
    )

    assert status == "degraded"


def test_missing_expected_oos_groups_blocks_partial_stacker_overwrite():
    expected = expected_oos_artifact_groups(["tree", "ftt", "dlinear"])

    assert expected == ["tree", "ftt"]
    assert missing_expected_oos_groups(expected, [{"group": "tree"}]) == ["ftt"]
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
