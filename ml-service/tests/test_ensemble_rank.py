from __future__ import annotations


def test_rank_to_signal_uses_equal_weight_when_ic_is_cold_start():
    from app.ensemble import rank_to_signal

    result = rank_to_signal(
        rank_scores={"XGBoost": 0.74, "CatBoost": 0.70, "ExtraTrees": 0.66},
        current_price=100.0,
        atr=2.0,
        ic_weights={"XGBoost": 0.0, "CatBoost": 0.0, "ExtraTrees": 0.0},
        buy_threshold=0.70,
    )

    assert result.signal == "BUY"
    assert result.direction == "up"
    assert result.forecast_pct > 0


def test_rank_to_signal_stays_neutral_when_all_observed_ic_is_negative():
    from app.ensemble import rank_to_signal

    result = rank_to_signal(
        rank_scores={"XGBoost": 0.9, "CatBoost": 0.8},
        current_price=100.0,
        atr=2.0,
        ic_weights={"XGBoost": -0.2, "CatBoost": -0.1},
    )

    assert result.signal == "HOLD"
    assert result.forecast_pct == 0.0


def test_load_ic_weights_prefers_model_pool_over_legacy_sidecar(monkeypatch):
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
                        "CatBoost": {"ic_4w_avg": 0.08},
                        "ExtraTrees": {"weekly_ic": [0.03, 0.04]},
                    }
                },
                "universal/ic_tracking.json": {
                    "models": {
                        "XGBoost": {"oos_ic": -0.9},
                        "LightGBM": {"oos_ic": 0.05},
                    }
                },
            }
            return FakeBlob(payloads.get(path))

    monkeypatch.setattr("app.model_store._get_bucket", lambda: FakeBucket())

    weights = ensemble.load_ic_weights()

    assert weights["XGBoost"] == 0.12
    assert weights["CatBoost"] == 0.08
    assert weights["ExtraTrees"] == 0.04
    assert weights["LightGBM"] == 0.05
