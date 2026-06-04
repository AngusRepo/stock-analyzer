import sys
import types

import numpy as np
import pytest


def test_markov_switching_accepts_ndarray_params_without_fallback(monkeypatch):
    from app import models

    seen_kwargs = {}

    class FakeResult:
        params = np.array([0.002, -0.001, 0.15, -0.1, 0.12, -0.08], dtype=float)
        param_names = [
            "const[0]",
            "const[1]",
            "ar.L1[0]",
            "ar.L1[1]",
            "ar.L2[0]",
            "ar.L2[1]",
        ]
        smoothed_marginal_probabilities = np.array([[0.25, 0.75]], dtype=float)

    class FakeModel:
        def __init__(self, *args, **kwargs):
            seen_kwargs.update(kwargs)
            pass

        def fit(self, *args, **kwargs):
            return FakeResult()

    fake_module = types.SimpleNamespace(MarkovAutoregression=FakeModel)
    monkeypatch.setitem(
        sys.modules,
        "statsmodels.tsa.regime_switching.markov_autoregression",
        fake_module,
    )

    def _unexpected_fallback(*args, **kwargs):
        raise AssertionError("run_markov_switching should not fallback for ndarray params")

    monkeypatch.setattr(models, "_fallback_model", _unexpected_fallback)

    prices = np.linspace(100, 160, 120, dtype=float)
    result = models.run_markov_switching(
        prices,
        horizon=5,
        hyperparams={"n_regimes": 2, "ar_order": 1, "switching_vol": False},
    )

    assert result.model_name == "MarkovSwitching"
    assert result.direction in ("up", "down")
    assert 0.0 <= result.confidence <= 1.0
    assert seen_kwargs["k_regimes"] == 2
    assert seen_kwargs["order"] == 1
    assert seen_kwargs["switching_variance"] is False


def test_state_space_runners_accept_hyperparams():
    from app import models

    prices = np.linspace(100, 130, 90, dtype=float)

    kalman = models.run_kalman_filter(
        prices,
        horizon=5,
        hyperparams={
            "process_noise": 0.02,
            "observation_noise": 1.5,
            "init_cov_scale": 2.0,
        },
    )

    assert kalman.model_name == "KalmanFilter"
    assert kalman.direction in ("up", "down")


def test_run_ft_transformer_is_retired_fail_closed():
    from app import models

    X = np.random.RandomState(7).randn(64, 6).astype(np.float32)
    y = (np.random.RandomState(11).rand(64) > 0.5).astype(np.int64)
    prices = np.linspace(90, 120, 80, dtype=float)

    result = models.run_ft_transformer(
        X=X,
        y=y,
        X_latest=X[-1],
        prices=prices,
        horizon=5,
        stock_id=0,
        feature_names=[f"f{i}" for i in range(6)],
    )

    assert result.model_name == "FT-Transformer"
    assert result.confidence == pytest.approx(0.35)
    assert "retired" in result.fallback_reason
