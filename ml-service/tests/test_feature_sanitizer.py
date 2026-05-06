import numpy as np
import polars as pl

from app.features import _meta_float, close_or_adjusted, close_price, get_features, safe_float, sanitize_feature_frame


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


def test_meta_float_defaults_none_and_invalid_stock_meta_values():
    meta = {
        "sector_encoded": None,
        "market_cap_bucket": "3",
        "avg_volume_bucket": "bad",
    }

    assert _meta_float(meta, "sector_encoded", 0.0) == 0.0
    assert _meta_float(meta, "market_cap_bucket", 2.0) == 3.0
    assert _meta_float(meta, "avg_volume_bucket", 2.0) == 2.0
    assert safe_float(None, 7.0) == 7.0
    assert safe_float("bad", 7.0) == 7.0


def test_close_or_adjusted_falls_back_when_adj_close_key_is_null():
    assert close_or_adjusted({"close": 58.6, "adj_close": None}) == 58.6
    assert close_or_adjusted({"close": 58.6, "adj_close": 57.9}) == 57.9


def test_close_price_falls_back_when_close_key_is_null():
    assert close_price({"close": None, "adj_close": 57.9}) == 57.9
    assert close_price({"close": 58.6, "adj_close": 57.9}) == 58.6
