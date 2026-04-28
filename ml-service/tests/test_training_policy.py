from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.training_policy import FeatureSelectionPolicy  # noqa: E402


def test_feature_selection_policy_keeps_current_defaults():
    policy = FeatureSelectionPolicy.from_env()

    assert policy.to_selection_params() == {
        "max_rounds": 100,
        "alpha": 0.01,
        "required_power": 0.99,
        "icir_weight": 0.1,
    }


def test_feature_selection_policy_reads_env_overrides(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_MAX_ROUNDS", "55")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ALPHA", "0.02")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_REQUIRED_POWER", "0.95")
    monkeypatch.setenv("UNIVERSAL_FEATURE_SELECTION_ICIR_WEIGHT", "0.2")

    policy = FeatureSelectionPolicy.from_env()

    assert policy.to_selection_params() == {
        "max_rounds": 55,
        "alpha": 0.02,
        "required_power": 0.95,
        "icir_weight": 0.2,
    }


def test_feature_selection_policy_merges_payload_overrides():
    policy = FeatureSelectionPolicy()

    assert policy.to_selection_params({"max_rounds": "40", "alpha": "0.03"}) == {
        "max_rounds": 40,
        "alpha": 0.03,
        "required_power": 0.99,
        "icir_weight": 0.1,
    }


def test_feature_selection_policy_window_params_keep_lighter_default():
    policy = FeatureSelectionPolicy()

    assert policy.to_window_selection_params() == {
        "max_rounds": 60,
        "alpha": 0.01,
        "required_power": 0.99,
        "icir_weight": 0.1,
    }
