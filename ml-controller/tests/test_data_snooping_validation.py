from __future__ import annotations

import itertools
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.data_snooping_validation import (  # noqa: E402
    _long_run_variance,
    _stationary_indices,
    data_snooping_evidence_errors,
    run_data_snooping_test,
)
from services.validation_governance import build_validation_packet, hansen_spa_reality_check  # noqa: E402


def _returns() -> dict:
    return {"champion": [0.001] * 40, "candidate": [0.02, 0.018, 0.021, 0.019] * 10}


def _valid_evidence() -> dict:
    return hansen_spa_reality_check(_returns(), n_bootstrap=200, search_candidate_ids=["candidate"])


def _paper_variance(values, block):
    """Scalar reference from the covariance/kernel equations on Hansen p. 372."""
    n = len(values)
    mean = sum(values) / n
    covariances = [
        sum((values[j] - mean) * (values[j + lag] - mean) for j in range(n - lag)) / n
        for lag in range(n)
    ]
    decay = 1 - 1 / block
    return covariances[0] + sum(
        2 * ((1 - lag / n) * decay**lag + lag / n * decay ** (n - lag)) * covariances[lag]
        for lag in range(1, n)
    )


def _exact_stationary_tail(columns, block, studentized):
    """Enumerate ALL index paths and their exact Markov probabilities.

    This oracle uses no RNG or production bootstrap helpers. It verifies the
    studentized max statistic, null centering and dependence-preserving law.
    """
    n = len(columns[0])
    means = [sum(values) / n for values in columns]
    variances = [_paper_variance(values, block) for values in columns]
    scales = [math.sqrt(v) if studentized else 1.0 for v in variances]
    observed = max(0.0, *(math.sqrt(n) * mean / scale for mean, scale in zip(means, scales)))
    centers = [
        mean if not studentized or mean >= -math.sqrt(v / n * 2 * math.log(math.log(n))) else 0.0
        for mean, v in zip(means, variances)
    ]
    tail = 0.0
    for path in itertools.product(range(n), repeat=n):
        probability = 1 / n
        for previous, current in zip(path, path[1:]):
            probability *= (1 - 1 / block) * (current == (previous + 1) % n) + 1 / (block * n)
        statistic = max(0.0, *(
            math.sqrt(n) * (sum(values[i] for i in path) / n - center) / scale
            for values, center, scale in zip(columns, centers, scales)
        ))
        if statistic >= observed - 1e-12:
            tail += probability
    return tail


@pytest.mark.parametrize("method", ["hansen_spa", "white_reality_check"])
def test_statistic_and_bootstrap_match_exact_stationary_distribution(method):
    columns = [[0.8, -0.4, 0.5, 0.1], [3.0, -2.0, -0.1, 0.6], [-2.0, -1.7, -2.3, -1.9]]
    returns = {f"candidate-{i}": values for i, values in enumerate(columns)}
    benchmark = "champion" if method == "hansen_spa" else None
    if benchmark:
        returns[benchmark] = [0.0] * 4
    result = run_data_snooping_test(
        returns, method=method, benchmark=benchmark, n_bootstrap=30_000, block_size=2,
        search_candidate_ids=[f"candidate-{i}" for i in range(3)], seed=79,
    )
    expected = _exact_stationary_tail(columns, 2, method == "hansen_spa")
    assert result["p_value"] == pytest.approx(expected, abs=0.015)
    assert result["long_run_variances"]["candidate-0"] == pytest.approx(_paper_variance(columns[0], 2), rel=1e-12)


def test_spa_is_invariant_to_individual_candidate_scale():
    rng = np.random.default_rng(91)
    candidates = {"a": (rng.normal(0.001, 0.01, 80)).tolist(), "b": (rng.normal(0.002, 0.02, 80)).tolist()}
    before = hansen_spa_reality_check({"champion": [0.0] * 80, **candidates}, n_bootstrap=2000)
    after = hansen_spa_reality_check({"champion": [0.0] * 80, "a": candidates["a"], "b": [v * 100 for v in candidates["b"]]}, n_bootstrap=2000)
    assert before["p_value"] == after["p_value"]
    assert before["best_candidate"] == after["best_candidate"]
    assert before["observed_statistic"] == pytest.approx(after["observed_statistic"], rel=1e-12)


def test_spa_preserves_clearly_bad_candidate_mean_under_consistent_null():
    returns = _returns()
    returns["bad"] = [-0.03, -0.028, -0.031, -0.029] * 10
    out = hansen_spa_reality_check(returns, n_bootstrap=200)
    assert out["null_centers"]["bad"] == 0.0
    assert out["null_centers"]["candidate"] > 0.0


def test_stationary_sampler_retains_successors_more_often_than_iid():
    indices = _stationary_indices(np.random.default_rng(44), 200, 200, 10)
    successor_ratio = np.mean(indices[:, 1:] == (indices[:, :-1] + 1) % 200)
    assert 0.88 < successor_ratio < 0.92


def test_long_run_variance_detects_serial_dependence():
    values = np.repeat([1.0, -1.0], 30).reshape(-1, 1)
    assert _long_run_variance(values, 6)[0] > 5 * values.var(axis=0)[0]


@pytest.mark.parametrize("mutation, reason", [
    (lambda r: r["candidate"].pop(), "partition_length_mismatch"),
    (lambda r: r["candidate"].__setitem__(8, float("nan")), "non_finite_return"),
    (lambda r: r["candidate"].__setitem__(8, float("inf")), "non_finite_return"),
    (lambda r: r["candidate"].__setitem__(8, "invalid"), "invalid_return_series"),
    (lambda r: r.__setitem__("candidate", [0.02] * 40), "degenerate_long_run_variance"),
    (lambda r: r.__setitem__("candidate", [[0.02]] * 40), "invalid_return_series_dimensions"),
])
def test_invalid_candidates_are_rejected_instead_of_dropped_or_truncated(mutation, reason):
    returns = _returns()
    mutation(returns)
    out = hansen_spa_reality_check(returns, n_bootstrap=200, search_candidate_ids=["candidate"])
    assert out["reason"] == reason
    assert out["promotion_eligible"] is False
    assert out["go_live_verdict"] == "FAIL"


def test_pairwise_success_is_not_complete_search_evidence():
    out = hansen_spa_reality_check(_returns(), n_bootstrap=200)
    assert out["passed"] is True
    assert out["go_live_verdict"] == "FAIL"
    assert out["test_scope"] == "provided_candidates_only"
    assert out["reason"] == "search_universe_not_fully_covered"


def test_full_search_receipt_is_reproducible_and_never_has_zero_p_value():
    out = _valid_evidence()
    assert out == _valid_evidence()
    assert out["p_value"] >= 1 / (out["n_bootstrap"] + 1)
    assert data_snooping_evidence_errors(out, max_p_value=0.10, required_trial_count=1) == []
    assert "search_universe_not_fully_covered" in data_snooping_evidence_errors(out, max_p_value=0.10, required_trial_count=24)


@pytest.mark.parametrize("patch", [
    {"schema_version": "data-snooping-evidence-v1"},
    {"studentized": False},
    {"bootstrap_method": "iid_bootstrap"},
    {"null_centering": "all_candidates_zero_mean"},
    {"search_candidate_ids": ["candidate", "missing-trial"]},
    {"search_candidate_ids": ["candidate", "candidate"]},
    {"search_trial_count": 24},
    {"p_value": float("nan")},
    {"p_value": 0.0},
    {"p_value": True},
])
def test_forged_or_incomplete_method_receipts_cannot_pass(patch):
    receipt = {**_valid_evidence(), **patch}
    assert data_snooping_evidence_errors(receipt, max_p_value=0.20)


@pytest.mark.parametrize("source", ["promotion_gate", "alpha_policy_evidence_gate", "alpha_policy_evidence_bundle", "parameter_candidate_evidence_gate"])
def test_missing_correction_blocks_every_promotion_source_even_if_external_risk_disabled(source):
    packet = build_validation_packet(source=source, backtest={}, external_risk_required=False)
    gate = next(g for g in packet["gates"] if g["name"] == "data_snooping_overfit_guard")
    assert gate["status"] == "FAIL"
    assert gate["severity"] == "blocking"


def test_missing_correction_remains_advisory_for_read_only_research():
    packet = build_validation_packet(source="backtest_replay", backtest={}, external_risk_required=False)
    gate = next(g for g in packet["gates"] if g["name"] == "data_snooping_overfit_guard")
    assert gate["status"] == "WARN"


def test_fusion_cannot_accept_legacy_name_only_evidence_or_a_pair_for_24_trials():
    from services.allocator_ev_fusion_artifact_builder import _multiple_testing_gate
    legacy = {"method": "hansen_spa", "passed": True, "adjusted_p_value": 0.04}
    assert _multiple_testing_gate(24, legacy)["decision"] == "FAIL"
    assert _multiple_testing_gate(24, _valid_evidence())["decision"] == "FAIL"
    assert _multiple_testing_gate(1, None)["decision"] == "PASS"


def test_latest_backtest_normalization_preserves_versioned_correction():
    import json
    from services.promotion_service import normalize_latest_backtest_row
    evidence = _valid_evidence()
    row = normalize_latest_backtest_row({"raw_results": json.dumps({"mode": "B", "data_snooping": evidence})})
    assert row["data_snooping"] == evidence


def test_evidence_runner_does_not_replace_invalid_return_with_zero():
    from services.alpha_evidence_runner import _data_snooping_row
    candidate = {"partition_returns": [0.01, 0.02, "bad", 0.015]}
    champion = {"partition_returns": [0.001, 0.002, 0.001, 0.002]}
    evidence = _data_snooping_row(champion, candidate, nav={"status": "complete", "champion": champion, "candidate": candidate})
    assert evidence["reason"] == "invalid_return_series"
    assert evidence["go_live_verdict"] == "FAIL"
