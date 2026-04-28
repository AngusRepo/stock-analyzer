from types import SimpleNamespace

import numpy as np

from app.stacking import (
    MODEL_ORDER,
    apply_rank_stacker,
    build_meta_features,
    build_oos_rank_rows,
    build_rank_meta_features,
    meta_predict,
    rank_meta_predict,
    train_rank_stacker_oof,
)


class _IdentityScaler:
    def transform(self, feat):
        return feat


class _DummyModel:
    def predict_proba(self, feat):
        assert feat.shape == (1, 6)
        return [[0.2, 0.8]]


class _MeanRankModel:
    def predict(self, feat):
        return np.mean(feat, axis=1)


def _pred(model_name: str, direction: str, confidence: float, forecast_pct: float):
    return SimpleNamespace(
        model_name=model_name,
        direction=direction,
        confidence=confidence,
        forecast_pct=forecast_pct,
    )


def test_build_meta_features_respects_bundle_model_order():
    features = build_meta_features(
        [
            _pred("XGBoost", "up", 0.81, 0.03),
            _pred("KalmanFilter", "down", 0.72, -0.02),
        ],
        model_order=["KalmanFilter", "XGBoost"],
    )

    assert features.shape == (6,)
    assert list(features[:3]) == [0.28, 0.4, 0.72]
    assert list(features[3:]) == [0.81, 0.6, 0.81]


def test_meta_predict_uses_bundle_model_order():
    direction, confidence = meta_predict(
        [
            _pred("XGBoost", "up", 0.81, 0.03),
            _pred("KalmanFilter", "down", 0.72, -0.02),
            _pred("Chronos", "up", 0.66, 0.01),
        ],
        {
            "scaler": _IdentityScaler(),
            "model": _DummyModel(),
            "model_order": ["KalmanFilter", "XGBoost"],
        },
    )

    assert direction == "up"
    assert confidence == 0.8


def test_build_rank_meta_features_uses_one_rank_per_model():
    features = build_rank_meta_features(
        {
            "XGBoost": 0.82,
            "CatBoost": 0.74,
            "Chronos": 0.63,
        },
        model_order=["XGBoost", "CatBoost", "Chronos", "DLinear"],
    )

    assert features.shape == (4,)
    assert list(features) == [0.82, 0.74, 0.63, 0.5]


def test_train_rank_stacker_oof_returns_rank_regression_bundle():
    rng = np.random.RandomState(42)
    rows = []
    y = []
    for i in range(120):
        base = i / 119
        xgb = np.clip(base + rng.normal(0, 0.02), 0, 1)
        cat = np.clip(base * 0.9 + 0.05 + rng.normal(0, 0.02), 0, 1)
        rows.append({"XGBoost": xgb, "CatBoost": cat, "Chronos": 1 - xgb})
        y.append(np.clip((xgb + cat) / 2, 0, 1))

    bundle = train_rank_stacker_oof(
        rows,
        np.array(y),
        model_order=["XGBoost", "CatBoost", "Chronos"],
        min_samples=60,
    )

    assert bundle is not None
    assert bundle["target_type"] == "rank"
    assert bundle["model_family"] == "ridge_rank_stacker"
    assert bundle["meta_feature_dim"] == 3
    assert bundle["model_order"] == ["XGBoost", "CatBoost", "Chronos"]
    assert "target_dir" not in bundle

    pred = rank_meta_predict({"XGBoost": 0.9, "CatBoost": 0.86, "Chronos": 0.1}, bundle)
    assert 0.0 <= pred <= 1.0
    assert pred > 0.65


def test_default_v2_rank_model_order_covers_all_10_models():
    assert MODEL_ORDER == [
        "XGBoost",
        "CatBoost",
        "ExtraTrees",
        "LightGBM",
        "FT-Transformer",
        "Chronos",
        "DLinear",
        "PatchTST",
        "KalmanFilter",
        "MarkovSwitching",
    ]


def test_build_oos_rank_rows_aligns_model_predictions():
    rows, model_order = build_oos_rank_rows(
        {
            "XGBoost": np.array([0.1, 0.9]),
            "CatBoost": np.array([0.2, 0.8]),
            "Chronos": np.array([0.3, 0.7]),
        },
        target_len=2,
    )

    assert model_order == ["XGBoost", "CatBoost", "Chronos"]
    assert rows == [
        {"XGBoost": 0.1, "CatBoost": 0.2, "Chronos": 0.3},
        {"XGBoost": 0.9, "CatBoost": 0.8, "Chronos": 0.7},
    ]


def test_apply_rank_stacker_adds_rank_only_when_bundle_is_v2_rank():
    rank_scores = {"XGBoost": 0.8, "CatBoost": 0.7}
    ic_weights = {"XGBoost": 0.03, "CatBoost": 0.02}
    rank_bundle = {
        "target_type": "rank",
        "scaler": _IdentityScaler(),
        "model": _MeanRankModel(),
        "model_order": ["XGBoost", "CatBoost"],
        "eval_ic": 0.04,
    }

    stacked_scores, stacked_weights, info = apply_rank_stacker(rank_scores, rank_bundle, ic_weights)

    assert info["applied"] is True
    assert stacked_scores["StackingRank"] == 0.75
    assert stacked_weights["StackingRank"] == 0.04

    legacy_scores, legacy_weights, legacy_info = apply_rank_stacker(
        rank_scores,
        {"target_type": "direction", "eval_ic": 0.9},
        ic_weights,
    )

    assert legacy_info["applied"] is False
    assert legacy_info["reason"] == "not_v2_rank_bundle"
    assert "StackingRank" not in legacy_scores
    assert legacy_weights == ic_weights
