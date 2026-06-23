from app.ensemble import score_to_signal


def test_score_to_signal_uses_symmetric_bearish_confidence():
    result = score_to_signal(
        {"XGBoost": 0.12, "DLinear": 0.14, "LightGBM": 0.16, "ExtraTrees": 0.18},
        current_price=100.0,
        atr=2.0,
        ic_weights={"XGBoost": 0.1, "DLinear": 0.1, "LightGBM": 0.1, "ExtraTrees": 0.1},
    )

    assert result.signal == "STRONG_SELL"
    assert result.direction == "down"
    assert result.confidence >= 0.65
