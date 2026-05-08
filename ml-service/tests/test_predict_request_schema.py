import warnings

from app.schemas import PredictRequest


def test_predict_request_allows_model_stats_without_pydantic_namespace_warning():
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        req = PredictRequest(stock_id=1, symbol="2330", prices=[], model_stats={"XGBoost": {"ic": 0.1}})

    assert req.model_stats["XGBoost"]["ic"] == 0.1
    assert not any("protected namespace" in str(item.message) for item in caught)
