import numpy as np
import polars as pl

from app.features import get_features, sanitize_feature_frame


def test_get_features_imputes_feature_nulls_and_inf_without_dropping_target_rows():
    df = pl.DataFrame(
        {
            "return_1d": [0.10, None, float("inf"), 0.40],
            "rsi14": [50.0, 60.0, 70.0, 80.0],
            "target_rank": [0.2, 0.4, 0.6, None],
            "target_5d": [0.01, 0.02, 0.03, None],
        }
    )

    X, y, feature_names = get_features(df, target_col="target_rank")

    assert feature_names == ["return_1d", "rsi14"]
    assert len(X) == 3
    assert y.tolist() == [0.2, 0.4, 0.6]
    assert np.isfinite(X).all()


def test_sanitize_feature_frame_reports_imputed_features_and_target_drops():
    df = pl.DataFrame(
        {
            "return_1d": [0.10, None, float("inf"), 0.40],
            "rsi14": [50.0, 60.0, 70.0, 80.0],
            "target_rank": [0.2, 0.4, 0.6, None],
            "target_5d": [0.01, 0.02, 0.03, None],
        }
    )

    clean, report = sanitize_feature_frame(
        df,
        feature_cols=["return_1d", "rsi14"],
        required_target_cols=["target_rank", "target_5d"],
    )

    assert clean.height == 3
    assert report["input_rows"] == 4
    assert report["output_rows"] == 3
    assert report["target_rows_dropped"] == 1
    assert report["features"]["return_1d"]["imputed_values"] == 2
