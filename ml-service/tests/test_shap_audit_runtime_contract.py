import numpy as np

from app.universal_training import (
    SHAP_AUDIT_EXCLUDED_MODELS,
    SHAP_AUDIT_REQUIRED_VERSION,
    SHAP_AUDIT_TREE_MODELS,
    _compute_tree_feature_contributions,
    _shap_audit_backend,
)


def test_shap_audit_active_model_policy_excludes_retired_catboost():
    assert SHAP_AUDIT_TREE_MODELS == ("xgboost", "extratrees", "lightgbm")
    assert SHAP_AUDIT_EXCLUDED_MODELS == {
        "catboost": "retired_by_active_model_pool_policy"
    }
    assert SHAP_AUDIT_REQUIRED_VERSION == "0.49.1"
    assert _shap_audit_backend("xgboost") == "xgboost_native_pred_contribs"
    assert _shap_audit_backend("lightgbm") == "shap_tree_explainer"


def test_xgboost_shap_audit_uses_native_pred_contribs_without_shap_loader(
    monkeypatch,
):
    import sys
    from types import SimpleNamespace

    X = np.asarray(
        [[0.0, 1.0], [1.0, 0.0], [2.0, 1.0], [3.0, 0.0]],
        dtype=np.float64,
    )

    class FakeDMatrix:
        def __init__(self, values, feature_names=None):
            self.values = np.asarray(values, dtype=np.float64)
            self.feature_names = feature_names

    class FakeBooster:
        feature_names = None

        def predict(self, dmatrix, *, pred_contribs):
            assert pred_contribs is True
            bias = np.zeros((len(dmatrix.values), 1), dtype=np.float64)
            return np.column_stack((dmatrix.values * 0.25, bias))

    class FakeModel:
        def get_booster(self):
            return FakeBooster()

    monkeypatch.setitem(sys.modules, "xgboost", SimpleNamespace(DMatrix=FakeDMatrix))

    class ForbiddenShap:
        class TreeExplainer:
            def __init__(self, *_args, **_kwargs):
                raise AssertionError("XGBoost must not use SHAP's model loader")

    values = _compute_tree_feature_contributions(
        "xgboost",
        FakeModel(),
        X,
        shap_module=ForbiddenShap,
    )

    assert values.shape == X.shape
    assert np.allclose(values, np.abs(X * 0.25))
