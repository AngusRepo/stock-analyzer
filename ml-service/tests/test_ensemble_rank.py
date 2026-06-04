from __future__ import annotations


def test_rank_to_signal_uses_equal_weight_when_ic_is_cold_start():
    from app.ensemble import rank_to_signal

    result = rank_to_signal(
        rank_scores={"XGBoost": 0.74, "LightGBM": 0.70, "ExtraTrees": 0.66},
        current_price=100.0,
        atr=2.0,
        ic_weights={"XGBoost": 0.0, "LightGBM": 0.0, "ExtraTrees": 0.0},
        buy_threshold=0.70,
    )

    assert result.signal == "BUY"
    assert result.direction == "up"
    assert result.forecast_pct > 0


def test_rank_to_signal_stays_neutral_when_all_observed_ic_is_negative():
    from app.ensemble import rank_to_signal

    result = rank_to_signal(
        rank_scores={"XGBoost": 0.9, "LightGBM": 0.8},
        current_price=100.0,
        atr=2.0,
        ic_weights={"XGBoost": -0.2, "LightGBM": -0.1},
    )

    assert result.signal == "HOLD"
    assert result.forecast_pct == 0.0


def test_load_ic_weights_uses_model_pool_only(monkeypatch):
    import json

    from app import ensemble

    class FakeBlob:
        def __init__(self, payload):
            self.payload = payload

        def exists(self):
            return self.payload is not None

        def download_as_text(self):
            return json.dumps(self.payload)

    class FakeBucket:
        def blob(self, path):
            payloads = {
                "universal/model_pool.json": {
                    "models": {
                        "XGBoost": {"rolling_ic": 0.12, "weekly_ic": [0.01]},
                        "LightGBM": {"ic_4w_avg": 0.08},
                        "ExtraTrees": {"weekly_ic": [0.03, 0.04]},
                    }
                },
                "universal/ic_tracking.json": {
                    "models": {
                        "XGBoost": {"oos_ic": -0.9},
                        "LightGBM": {"oos_ic": 0.05},
                        "CatBoost": {"oos_ic": 0.99},
                    }
                },
            }
            return FakeBlob(payloads.get(path))

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr("app.model_pool._get_bucket", lambda: FakeBucket())
    monkeypatch.setattr("app.model_pool._POOL_CACHE", None)
    monkeypatch.setattr("app.model_pool._POOL_CACHE_LOADED_AT", 0.0)
    ensemble._IC_WEIGHTS_CACHE = None
    ensemble._IC_WEIGHTS_CACHE_LOADED_AT = 0.0

    weights = ensemble.load_ic_weights()

    assert 0.014 < weights["XGBoost"] < 0.016
    assert weights["LightGBM"] == 0.015
    assert 0.017 < weights["ExtraTrees"] < 0.018
    assert "CatBoost" not in weights


def test_load_ic_weights_prefers_market_segment_ic(monkeypatch):
    import json

    from app import ensemble

    class FakeBlob:
        def exists(self):
            return True

        def download_as_text(self):
            return json.dumps({
                "models": {
                    "LightGBM": {
                        "rolling_ic": -0.03,
                        "weekly_ic": [0.06],
                        "last_ic_by_segment": {"LISTED": 0.19, "OTC": -0.48},
                    },
                    "PatchTST": {
                        "rolling_ic": -0.14,
                        "weekly_ic": [0.24],
                        "last_ic_by_segment": {"LISTED": -0.12, "OTC": -0.28},
                    },
                }
            })

    class FakeBucket:
        def blob(self, path):
            return FakeBlob()

    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr("app.model_pool._get_bucket", lambda: FakeBucket())
    monkeypatch.setattr("app.model_pool._POOL_CACHE", None)
    monkeypatch.setattr("app.model_pool._POOL_CACHE_LOADED_AT", 0.0)
    ensemble._IC_WEIGHTS_CACHE = None
    ensemble._IC_WEIGHTS_CACHE_LOADED_AT = 0.0

    listed_weights = ensemble.load_ic_weights(market_segment="LISTED")
    otc_weights = ensemble.load_ic_weights(market_segment="OTC")

    assert 0.023 < listed_weights["LightGBM"] < 0.024
    assert 0.008 < listed_weights["PatchTST"] < 0.009
    assert otc_weights["LightGBM"] == 0.0
