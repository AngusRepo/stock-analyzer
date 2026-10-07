from __future__ import annotations

import numpy as np
from services.hmm_input_contract import CONTRACT_HASH,SOURCE,checksum

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
        "realized_vol_3d": abs(ret),"benchmark_source":SOURCE,"risk_quality_status":"score_verified",
    }


def test_feature_builder_excludes_non_taiwan_and_incomplete_dates():
    history = {f"2026-06-{day:02d}": _market_row(day / 10_000) for day in range(1, 21)}
    env={"history":history,"requested_run_date":"2026-06-20","hmm_input_contract":CONTRACT_HASH,"hmm_input_checksum":checksum(history)}
    matrix=build_market_feature_matrix(env)
    assert matrix is not None and matrix.shape==(20,6)
    assert latest_market_feature_date(env)=="2026-06-20"
    history["2026-06-21"]={"us_vix":18}
    env["hmm_input_checksum"]=checksum(history)
    assert build_market_feature_matrix(env) is None


class _PosteriorModel:
    def predict_proba(self, sequence: np.ndarray) -> np.ndarray:
        assert len(sequence) == 3
        return np.asarray([[0.8, 0.2], [0.5, 0.5], [0.1, 0.9]])


def test_predict_regime_uses_latest_sequence_posterior_surface():
    detector = RegimeDetector()
    detector._trained = True
    detector.input_contract = CONTRACT_HASH
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
            five_day_return = 0.01 if state == 1 else daily_return * 5
            rows.append([daily_return, five_day_return, risk, daily_return, abs(daily_return), realized_vol])
            states.append(state)

    mapping = detector._assign_semantic_regimes(np.asarray(rows), np.asarray(states))

    assert mapping[0] == 3
    assert mapping[3] == 0
    assert mapping[2] == 1
    assert mapping[1] == 2


def test_semantic_mapping_does_not_force_bull_or_volatile_from_return_rank():
    detector = RegimeDetector()
    detector.n_components = 3
    rows = np.repeat(np.asarray([
        [-0.03, -0.15, 0.1, 0.0, 0.03, 0.03],
        [-0.02, -0.10, 0.1, 0.0, 0.02, 0.02],
        [-0.01, -0.05, 0.9, 0.0, 0.01, 0.01],
    ]), 3, axis=0)
    states = np.repeat(np.arange(3), 3)

    mapping = detector._assign_semantic_regimes(rows, states)

    assert 0 not in mapping.values(), "all-negative states cannot produce a bull label"
    assert mapping[2] != 1, "low observed volatility cannot be called volatile"


class _EmissionPosteriorModel(_PosteriorModel):
    means_ = np.asarray([
        [-0.01, -0.02, 0.0, 0.0, 0.0, -0.2],
        [0.01, 0.02, 0.0, 0.0, 0.0, -0.4],
    ])


def test_loaded_artifact_relabels_emissions_without_fitting():
    detector = RegimeDetector()
    detector._trained = True
    detector.input_contract = CONTRACT_HASH
    detector.model = _EmissionPosteriorModel()
    detector.feature_means = np.asarray([0, 0, 0, 0, 0, 0.01])
    detector.feature_stds = np.asarray([1, 1, 1, 1, 1, 0.005])
    detector.regime_map = {0: 1, 1: 0}  # legacy persisted map is wrong

    result = detector.predict_regime(np.zeros((3, 6)))

    assert result["regime_surface"]["bear_market"] == 0.1
    assert result["regime_surface"]["bull_market"] == 0.9
    assert result["semantic_mapping_version"] == "emission_direction_vol_v2"
    assert result["regime_policies"]["sideways"]["consensus_threshold"] == 0.68

def test_fit_rejects_legacy_feature_width():
    detector = RegimeDetector()
    detector.fit(np.ones((40, 4), dtype=float),input_contract=CONTRACT_HASH,training_input_checksum="a"*64)
    assert detector._trained is False
    assert detector.model is None
