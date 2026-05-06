from __future__ import annotations

import numpy as np
import sys
import types


try:
    import pydantic  # noqa: F401
except ModuleNotFoundError:
    class _BaseModel:
        def __init__(self, **kwargs):
            for key in getattr(self, "__annotations__", {}):
                if hasattr(type(self), key):
                    setattr(self, key, getattr(type(self), key))
            for key, value in kwargs.items():
                setattr(self, key, value)

    sys.modules["pydantic"] = types.SimpleNamespace(BaseModel=_BaseModel)


def test_update_arf_uses_return_pct_not_pnl_r_for_profitability(monkeypatch):
    from app import linucb_bandit, prediction_runtime

    arf_labels: list[bool] = []
    bandit_rewards: list[tuple[str, float]] = []

    class FakeARF:
        n_trained = 0

        def update(self, features, actual_up):
            arf_labels.append(actual_up)

        def is_warmed_up(self):
            return False

    class FakeBandit:
        def update(self, arm_idx, ctx, reward):
            bandit_rewards.append((f"arm:{arm_idx}", reward))

    monkeypatch.setattr(prediction_runtime, "load_arf", lambda *args, **kwargs: FakeARF())
    monkeypatch.setattr(prediction_runtime, "save_arf", lambda *args, **kwargs: None)
    monkeypatch.setattr(linucb_bandit, "load_bandit", lambda *args, **kwargs: FakeBandit())
    monkeypatch.setattr(linucb_bandit, "save_bandit", lambda *args, **kwargs: None)
    monkeypatch.setattr(linucb_bandit, "build_context", lambda *args, **kwargs: np.ones(4))

    def _capture_linucb_update(**kwargs):
        bandit_rewards.append((kwargs["model_name"], kwargs["reward"]))

    monkeypatch.setattr(linucb_bandit, "linucb_update", _capture_linucb_update)

    from app.arf_aggregator import FEATURE_DIM

    req = prediction_runtime.ARFUpdateRequest(
        arf_features=[0.1] * FEATURE_DIM,
        actual_up=True,
        actual_return_pct=0.001,
        realized_pnl_r=2.0,
        model_name="XGBoost",
        forecast_pct=0.02,
    )

    result = prediction_runtime.update_arf(req)

    assert result["net_profitable"] is False
    assert arf_labels == [False]
    assert ("XGBoost", 0.0) in bandit_rewards


def test_update_arf_updates_conformal_residuals(monkeypatch):
    from app import linucb_bandit, prediction_runtime

    updates: list[tuple[float, float]] = []

    class FakeARF:
        n_trained = 0

        def update(self, features, actual_up):
            pass

        def is_warmed_up(self):
            return False

    class FakeBandit:
        def update(self, arm_idx, ctx, reward):
            pass

    class FakeConformal:
        def update(self, forecast_pct, actual_pct, anomaly_score=0.0):
            updates.append((forecast_pct, actual_pct))

    monkeypatch.setattr(prediction_runtime, "load_arf", lambda *args, **kwargs: FakeARF())
    monkeypatch.setattr(prediction_runtime, "save_arf", lambda *args, **kwargs: None)
    monkeypatch.setattr(linucb_bandit, "load_bandit", lambda *args, **kwargs: FakeBandit())
    monkeypatch.setattr(linucb_bandit, "save_bandit", lambda *args, **kwargs: None)
    monkeypatch.setattr(linucb_bandit, "build_context", lambda *args, **kwargs: np.ones(4))
    monkeypatch.setattr(linucb_bandit, "linucb_update", lambda **kwargs: None)

    import app.conformal as conformal

    monkeypatch.setattr(conformal, "load_conformal", lambda *args, **kwargs: FakeConformal())
    monkeypatch.setattr(conformal, "save_conformal", lambda *args, **kwargs: {"gcs_saved": True})

    from app.arf_aggregator import FEATURE_DIM

    req = prediction_runtime.ARFUpdateRequest(
        arf_features=[0.1] * FEATURE_DIM,
        actual_up=True,
        actual_return_pct=0.021,
        realized_pnl_r=1.4,
        forecast_pct=0.015,
    )

    result = prediction_runtime.update_arf(req)

    assert result["results"]["conformal"]["updated"] is True
    assert updates == [(0.015, 0.021)]
