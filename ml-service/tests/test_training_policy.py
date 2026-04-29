from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.training_policy import FeatureSelectionPolicy, UniversalTrainingPolicy  # noqa: E402


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


def test_universal_training_policy_keeps_current_defaults():
    policy = UniversalTrainingPolicy.from_env()

    assert policy.requested_groups({}) == ["tree", "ftt", "dlinear", "patchtst"]
    assert policy.sequence_min_length({}) == 65
    assert policy.to_base_train_payload({}, candidate_version="v-test") == {
        "batch_count": 5,
        "ftt_d_model": 128,
        "ftt_n_heads": 8,
        "ftt_n_layers": 3,
        "ftt_dropout": 0.12,
        "ftt_max_epochs": 120,
        "ftt_lr": 2e-4,
        "ftt_patience": 16,
        "ftt_batch_size": 1024,
        "ftt_margin": 0.0,
        "output_model_version": "v-test",
        "register_challengers": False,
    }


def test_universal_training_policy_reads_env_and_payload_overrides(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_TRAIN_MODEL_GROUPS", "tree,ftt")
    monkeypatch.setenv("UNIVERSAL_SEQUENCE_MIN_LEN", "88")
    monkeypatch.setenv("UNIVERSAL_FTT_D_MODEL", "256")
    monkeypatch.setenv("UNIVERSAL_FTT_LR", "0.0003")

    policy = UniversalTrainingPolicy.from_env()

    assert policy.requested_groups({}) == ["tree", "ftt"]
    assert policy.sequence_min_length({}) == 88
    assert policy.to_base_train_payload(
        {
            "batch_count": "7",
            "ftt_lr": "0.0001",
            "ftt_dropout": "0.2",
        },
        candidate_version="v-env",
    )["ftt_lr"] == 0.0001
    assert policy.to_base_train_payload({"ftt_dropout": "0.2"}, candidate_version="v-env")[
        "ftt_d_model"
    ] == 256


def test_universal_training_policy_accepts_payload_group_string():
    policy = UniversalTrainingPolicy(default_train_groups=("tree", "ftt"))

    assert policy.requested_groups({"train_model_groups": "tree,patchtst"}) == ["tree", "patchtst"]
