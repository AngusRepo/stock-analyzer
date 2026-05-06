from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "optuna_scripts"))

from optuna_l2_sensitivity import (  # noqa: E402
    OptunaL2Policy,
    _l2_push_allowed,
    _pbo_audit_from_strategy_returns,
    _score_l2_trial,
    _strategy_returns_by_partition_from_trials,
)


class FakeTrial:
    def __init__(self, number: int, value: float | None, partition_returns: list[float] | None):
        self.number = number
        self.value = value
        self.user_attrs = {}
        if partition_returns is not None:
            self.user_attrs["partition_returns"] = partition_returns


def test_strategy_returns_by_partition_from_trials_keeps_top_equal_length_candidates():
    trials = [
        FakeTrial(1, 0.2, [0.01, 0.02, 0.03, 0.04]),
        FakeTrial(2, 0.5, [0.04, 0.03, 0.02, 0.01]),
        FakeTrial(3, None, [0.9, 0.9, 0.9, 0.9]),
        FakeTrial(4, 0.4, [0.02, 0.02]),
    ]

    out = _strategy_returns_by_partition_from_trials(trials, max_candidates=2)

    assert out == {
        "trial_2": [0.04, 0.03, 0.02, 0.01],
        "trial_1": [0.01, 0.02, 0.03, 0.04],
    }


def test_l2_policy_reads_env_overrides(monkeypatch):
    monkeypatch.setenv("OPTUNA_L2_MIN_TRADES", "12")
    monkeypatch.setenv("OPTUNA_L2_DD_PENALTY", "3.5")
    monkeypatch.setenv("OPTUNA_L2_PBO_MAX_CANDIDATES", "7")
    monkeypatch.setenv("OPTUNA_L2_PBO_MIN_PARTITIONS", "6")

    policy = OptunaL2Policy.from_env()

    assert policy.min_trades == 12
    assert policy.dd_penalty == 3.5
    assert policy.pbo_max_candidates == 7
    assert policy.pbo_min_partitions == 6


def test_l2_trial_score_uses_policy_min_trades_and_dd_penalty():
    policy = OptunaL2Policy(min_trades=10, dd_penalty=4.0)

    assert _score_l2_trial(sharpe=2.0, max_drawdown=0.2, n_trades=9, policy=policy) == -1.0
    assert _score_l2_trial(sharpe=2.0, max_drawdown=0.2, n_trades=10, policy=policy) == 1.2


def test_strategy_returns_by_partition_from_trials_uses_policy_defaults(monkeypatch):
    monkeypatch.setenv("OPTUNA_L2_PBO_MAX_CANDIDATES", "1")
    monkeypatch.setenv("OPTUNA_L2_PBO_MIN_PARTITIONS", "3")
    trials = [
        FakeTrial(1, 0.2, [0.01, 0.02, 0.03]),
        FakeTrial(2, 0.5, [0.04, 0.03, 0.02]),
        FakeTrial(3, 0.4, [0.02, 0.02]),
    ]

    out = _strategy_returns_by_partition_from_trials(trials)

    assert out == {"trial_2": [0.04, 0.03, 0.02]}


def test_pbo_audit_from_strategy_returns_runs_cscv_rank_logit_gate():
    audit = _pbo_audit_from_strategy_returns({
        "stable": [0.03, 0.02, 0.025, 0.03, 0.02, 0.025],
        "weak": [0.005, 0.004, 0.006, 0.005, 0.004, 0.006],
    })

    assert audit["method"] == "cscv_rank_logit"
    assert audit["go_live_verdict"] == "PASS"
    assert audit["pbo"] == 0.0


def test_pbo_audit_from_strategy_returns_fails_closed_when_candidates_missing():
    audit = _pbo_audit_from_strategy_returns({})

    assert audit["method"] == "cscv_rank_logit"
    assert audit["go_live_verdict"] == "FAIL"
    assert audit["pbo"] == 1.0
    assert "candidate" in audit["verdict_reason"].lower()


def test_l2_push_allowed_requires_passed_pbo_audit():
    assert _l2_push_allowed(
        push_kv=True,
        dry_run=False,
        best_params_nested={"circuit": {"buyConfThreshold": 0.62}},
        pbo_audit={"go_live_verdict": "FAIL"},
    ) is False

    assert _l2_push_allowed(
        push_kv=True,
        dry_run=False,
        best_params_nested={"circuit": {"buyConfThreshold": 0.62}},
        pbo_audit={"go_live_verdict": "PASS"},
    ) is True
