from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.training_policy import TrainingPolicy  # noqa: E402


def test_training_policy_default_regime_lookbacks():
    policy = TrainingPolicy.from_env()

    assert policy.resolve_regime(vix=26.0, twii_bias=0.0) == ("bear", 252)
    assert policy.resolve_regime(vix=17.0, twii_bias=0.03) == ("bull", 900)
    assert policy.resolve_regime(vix=20.0, twii_bias=0.0) == ("sideways", 500)


def test_training_policy_monthly_detection_keeps_existing_default():
    policy = TrainingPolicy.from_env()

    assert policy.is_monthly(force_monthly=False, tw_day=7) is True
    assert policy.is_monthly(force_monthly=False, tw_day=8) is False
    assert policy.is_monthly(force_monthly=True, tw_day=20) is True


def test_training_policy_env_overrides_selection_params(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_MAX_ROUNDS", "55")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ALPHA", "0.02")

    policy = TrainingPolicy.from_env()

    assert policy.feature_selection_params() == {"max_rounds": 55, "alpha": 0.02}
