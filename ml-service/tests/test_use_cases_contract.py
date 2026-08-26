from __future__ import annotations


def test_use_cases_imports_after_legacy_prediction_owner_retirement() -> None:
    from app import use_cases

    assert callable(use_cases.prep_universal_batch)
    assert callable(use_cases.predict_stock_v2)
    assert "predict_stock" not in use_cases.__all__
    assert not hasattr(use_cases, "predict_stock")
    assert "retrain_stock" not in use_cases.__all__
    assert not hasattr(use_cases, "retrain_stock")
