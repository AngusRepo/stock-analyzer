from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "optuna_scripts"))

from optuna_l2_sensitivity import (  # noqa: E402
    DEFAULT_SEARCH_SPACE,
    OptunaL2Policy,
    _l2_push_allowed,
    _l2_push_blockers,
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


def test_l2_push_allowed_requires_passed_pbo_and_walk_forward_evidence():
    assert _l2_push_allowed(
        push_kv=True,
        dry_run=False,
        best_params_nested={"circuit": {"drawdownHalt": 0.12}},
        pbo_audit={"go_live_verdict": "FAIL"},
        walk_forward_evidence={"passed": True},
    ) is False

    assert _l2_push_allowed(
        push_kv=True,
        dry_run=False,
        best_params_nested={"circuit": {"drawdownHalt": 0.12}},
        pbo_audit={"go_live_verdict": "PASS"},
    ) is False

    assert _l2_push_allowed(
        push_kv=True,
        dry_run=False,
        best_params_nested={"circuit": {"drawdownHalt": 0.12}},
        pbo_audit={"go_live_verdict": "PASS"},
        walk_forward_evidence={"decision": "PASS"},
    ) is True


def test_l2_push_blockers_explain_missing_walk_forward_evidence():
    blockers = _l2_push_blockers(
        push_kv=True,
        dry_run=False,
        best_params_nested={"L2_formula": {"confidence_risk_mult": 0.2}},
        pbo_audit={"go_live_verdict": "PASS"},
        walk_forward_evidence={"passed": False},
    )

    assert blockers == ["walk_forward_evidence_not_passed"]


def test_l2_sensitivity_excludes_bandit_constants_until_objective_consumes_multiplier_replay():
    names = {str(dim["name"]) for dim in DEFAULT_SEARCH_SPACE}

    assert not any(name.startswith("bandit_") for name in names)


def test_l2_sensitivity_never_searches_the_retired_bull_alignment_threshold():
    # Wei 10/29 Q5: P4 no longer triggers on bull alignment, so the dimension is not searched,
    # even when a KV-supplied space still lists it.
    from optuna_l2_sensitivity import RETIRED_PATHS, run_l2_sensitivity_search
    assert 'circuit.bullAlignmentThreshold' in RETIRED_PATHS
    assert not any(dim['path'] in RETIRED_PATHS for dim in DEFAULT_SEARCH_SPACE)
    retired = [{'name': 'bullAlignmentThreshold', 'path': 'circuit.bullAlignmentThreshold', 'type': 'int', 'low': 10, 'high': 40}]
    with pytest.raises(ValueError, match='empty search_space'):
        run_l2_sensitivity_search(search_space=retired, start_date='2026-01-01', end_date='2026-03-31',
                                  baseline_config={}, n_trials=1)


RETIRED_CONFIDENCE = {'circuit.sellConfThreshold': (.55, .8), 'circuit.buyConfThreshold': (.5, .75),
                      'circuit.lowAccuracyThreshold': (.35, .55), 'circuit.drawdownRaisedConf': (.65, .8),
                      'L2_formula.confidence_risk_mult': (.05, .4), 'L2_formula.confidence_perf_mult': (.05, .5),
                      'L2_formula.confidence_delta_clip_lo': (-.2, -.05), 'L2_formula.confidence_delta_clip_hi': (.1, .3),
                      'L2_formula.confidence_effective_clip_lo': (.35, .55),
                      'L2_formula.confidence_effective_clip_hi': (.65, .85)}


def test_retired_confidence_dims_never_reach_the_replay_or_the_push_payload(monkeypatch, kv_position_risk):
    # Wei 10/30: Paper reads no buy confidence threshold (and its ML SELL exit has no SELL rows);
    # the KV fields stay, the search stops tuning them, even when a KV-supplied space lists them.
    import optuna_l2_sensitivity as l2
    from types import SimpleNamespace
    from services import backtest_engine
    assert set(RETIRED_CONFIDENCE) <= l2.RETIRED_PATHS
    assert not set(RETIRED_CONFIDENCE) & {dim['path'] for dim in DEFAULT_SEARCH_SPACE}
    assert len(DEFAULT_SEARCH_SPACE) == 10
    monkeypatch.delenv('CF_D1_RESEARCH_DB_ID', raising=False)
    monkeypatch.setattr(backtest_engine.BacktestDataset, 'load_for_research',
                        lambda **_: (object(), {'source': 'snapshot'}))
    seen = []
    def replay(**kw):
        seen.append(kw['params'])
        return SimpleNamespace(sharpe=1.0, max_drawdown=.1, total_trades=50, partition_returns=[])
    monkeypatch.setattr(backtest_engine, 'replay_period', replay)
    kv_space = [{'name': path.split('.')[1], 'path': path, 'type': 'uniform', 'low': lo, 'high': hi}
                for path, (lo, hi) in RETIRED_CONFIDENCE.items()]
    kv_space.append({'name': 'drawdownHalt', 'path': 'circuit.drawdownHalt', 'type': 'uniform',
                     'low': .08, 'high': .25})
    baseline = {'positionRiskDistribution': kv_position_risk,
                'circuit': {'sellConfThreshold': .66, 'buyConfThreshold': .6, 'lowAccuracyThreshold': .45,
                            'drawdownRaisedConf': .7, 'drawdownHalt': .15},
                'L2_formula': {path.split('.')[1]: 0.123 for path in RETIRED_CONFIDENCE
                               if path.startswith('L2_formula.')}}
    result = l2.run_l2_sensitivity_search(search_space=kv_space, start_date='2026-01-01', end_date='2026-03-31',
                                          baseline_config=baseline, n_trials=2)
    assert set(result['best_params']) == {'drawdownHalt'}
    assert result['best_params_nested'] == {'circuit': {'drawdownHalt': result['best_params']['drawdownHalt']}}
    for params in seen:                                                     # baseline untouched
        assert {k: v for k, v in params['circuit'].items() if k != 'drawdownHalt'} == \
            {k: v for k, v in baseline['circuit'].items() if k != 'drawdownHalt'}
        assert params['L2_formula'] == baseline['L2_formula']
