import numpy as np
import polars as pl
from datetime import date, timedelta

import app.features as feature_module
from app.features import (
    FEATURE_COLS,
    _meta_float,
    build_feature_matrix,
    close_or_adjusted,
    close_price,
    get_features,
    safe_float,
    sanitize_feature_frame,
)


def test_get_features_imputes_feature_nulls_and_inf_without_dropping_target_rows(monkeypatch):
    monkeypatch.setattr(feature_module, "FEATURE_COLS", ["return_1d", "rsi14"])
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


def test_get_features_fails_closed_when_formal137_columns_are_missing(monkeypatch):
    monkeypatch.setattr(feature_module, "FEATURE_COLS", ["return_1d", "rsi14", "formal_only_feature"])
    df = pl.DataFrame(
        {
            "return_1d": [0.10],
            "rsi14": [50.0],
            "target_rank": [0.2],
        }
    )

    try:
        get_features(df, target_col="target_rank")
    except RuntimeError as exc:
        assert "formal137_feature_schema_missing:1" in str(exc)
        assert "formal_only_feature" in str(exc)
    else:
        raise AssertionError("formal137 schema mismatch must fail closed")


def test_build_feature_matrix_materializes_formal137_contract():
    start = date(2025, 1, 1)
    prices = []
    for idx in range(320):
        close = 100 + idx * 0.1
        prices.append({
            "date": (start + timedelta(days=idx)).isoformat(),
            "open": close - 0.2,
            "high": close + 1,
            "low": close - 1,
            "close": close,
            "adj_close": close,
            "volume": 1_000_000 + idx * 1_000,
        })

    df = build_feature_matrix(
        prices,
        [],
        [],
        [],
        market_env={
            "eps": 5,
            "roe": 12,
            "pe": 15,
            "pb": 2,
            "dividend_yield": 3,
            "revenue_yoy": 10,
            "revenue_mom": 2,
            "revenue": 1_000_000_000,
            "advance_ratio": 0.55,
            "us_sentiment_score": 0.1,
        },
        stock_meta={"market_cap_bucket": 3, "stock_vs_sector": 0.05},
    )

    missing = [name for name in FEATURE_COLS if name not in df.columns]
    assert missing == []
    X, _y, names = get_features(df, target_col="target_rank", allow_missing_target=True)
    assert X.shape[1] == 137
    assert names == FEATURE_COLS


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
