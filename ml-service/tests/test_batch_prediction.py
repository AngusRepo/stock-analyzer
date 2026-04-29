from __future__ import annotations

import pytest

from app import batch_prediction


def test_predict_stock_v2_batch_preserves_order_and_wraps_failures(monkeypatch):
    class Request:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    def fake_predict(req):
        if req.symbol == "FAIL":
            raise ValueError("boom")
        return {"symbol": req.symbol, "stock_id": req.stock_id, "signal": "BUY"}

    monkeypatch.setattr(batch_prediction, "PredictRequest", Request)
    monkeypatch.setattr(batch_prediction, "predict_stock_v2", fake_predict)

    results = batch_prediction.predict_stock_v2_batch([
        {"symbol": "2330", "stock_id": 2330, "prices": [{"close": 1}], "indicators": []},
        {"symbol": "FAIL", "stock_id": 9999, "prices": [{"close": 1}], "indicators": []},
        {"symbol": "2317", "stock_id": 2317, "prices": [{"close": 1}], "indicators": []},
    ])

    assert [r["symbol"] for r in results] == ["2330", "FAIL", "2317"]
    assert results[1]["signal"] == "NO_SIGNAL"
    assert "ValueError: boom" in results[1]["error"]
