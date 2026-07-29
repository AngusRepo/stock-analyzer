from __future__ import annotations

import numpy as np

from app.regime import (
    RegimeDetector,
    build_market_feature_matrix,
    latest_market_feature_date,
)


def _market_row(ret: float) -> dict:
    return {
        "market_return_1d": ret,
        "market_return_5d": ret * 3,
        "risk_score": 35,
        "market_bias_20d": ret * 2,
    }


def test_feature_builder_excludes_non_taiwan_and_incomplete_dates():
    history = {f"2026-06-{day:02d}": _market_row(day / 10_000) for day in range(1, 21)}
    history["2026-06-21"] = {"us_gspc_return": 0.01, "us_vix": 18}
    history["2026-06-22"] = {**_market_row(0.0022), "risk_score": None}

    matrix = build_market_feature_matrix({"history": history})

    assert matrix is not None
    assert matrix.shape == (20, 6)
    assert latest_market_feature_date({"history": history}) == "2026-06-20"


class _PosteriorModel:
    def predict_proba(self, sequence: np.ndarray) -> np.ndarray:
        assert len(sequence) == 3
        return np.asarray([[0.8, 0.2], [0.5, 0.5], [0.1, 0.9]])


def test_predict_regime_uses_latest_sequence_posterior_surface():
    detector = RegimeDetector()
    detector._trained = True
    detector.model = _PosteriorModel()
    detector.feature_means = np.zeros(6)
    detector.feature_stds = np.ones(6)
    detector.regime_map = {0: 0, 1: 3}

    result = detector.predict_regime(np.zeros((3, 6)))

    assert result["hmm_state"] == 1
    assert result["sequence_length"] == 3
    assert result["regime_surface"]["bear_market"] == 0.9
    assert result["regime_surface"]["bull_market"] == 0.1
    assert set(result["regime_surface"]) == {"bull_market", "volatile", "sideways", "bear_market"}


def test_semantic_mapping_uses_realized_volatility_not_risk_score_column():
    detector = RegimeDetector()
    detector.n_components = 4
    rows = []
    states = []
    for state, daily_return, risk, realized_vol in (
        (0, -0.03, 0.2, 0.02),
        (1, -0.002, 0.95, 0.01),
        (2, 0.002, 0.1, 0.08),
        (3, 0.03, 0.3, 0.02),
    ):
        for _ in range(3):
            rows.append([daily_return, daily_return * 5, risk, daily_return, abs(daily_return), realized_vol])
            states.append(state)

    mapping = detector._assign_semantic_regimes(np.asarray(rows), np.asarray(states))

    assert mapping[0] == 3
    assert mapping[3] == 0
    assert mapping[2] == 1
    assert mapping[1] == 2

def test_fit_rejects_legacy_feature_width():
    detector = RegimeDetector()
    detector.fit(np.ones((40, 4), dtype=float))
    assert detector._trained is False
    assert detector.model is None