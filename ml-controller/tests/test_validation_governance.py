from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.validation_governance import (  # noqa: E402
    VALIDATION_PACKET_SCHEMA_VERSION,
    build_strategy_lab_record,
    build_strategy_replay_contract,
    build_validation_packet,
    data_snooping_reality_check,
    deflated_sharpe_proxy,
    explain_backtest_metrics,
    hansen_spa_reality_check,
)


def _mode_b_backtest() -> dict:
    return {
        "mode": "B",
        "total_trades": 120,
        "sharpe": 1.2,
        "profit_factor": 1.5,
        "max_drawdown": 0.1,
        "win_rate": 0.55,
        "expectancy": 0.01,
        "fill_rate": 0.35,
        "absolute_confidence": "moderate",
        "sanity_flags": [],
        "parity_audit": {"worker_parity": {"decision": "PASS", "drift_rate": 0.0}},
    }


def _mode_b_backtest_with_returns() -> dict:
    returns = [
        0.018,
        0.011,
        -0.006,
        0.014,
        0.009,
        -0.004,
        0.016,
        0.012,
        -0.005,
        0.013,
    ] * 12
    return {**_mode_b_backtest(), "return_series": returns}


def _promotion_grade_backtest() -> dict:
    return {
        **_mode_b_backtest(),
        "per_regime": {
            "bull": {"trades": 40, "return": 0.08},
            "bear": {"trades": 20, "return": 0.01},
            "volatile": {"trades": 25, "return": 0.02},
            "sideways": {"trades": 35, "return": 0.03},
        },
    }


def _monte_carlo() -> dict:
    return {
        "source": "backtest",
        "simulation_method": "block_bootstrap",
        "mdd_95th": 0.16,
        "go_live_verdict": "PASS",
    }


def _pbo() -> dict:
    return {
        "source": "backtest",
        "method": "cscv_rank_logit",
        "pbo": 0.31,
        "oos_mean_return": 0.03,
        "go_live_verdict": "PASS",
    }


def _data_snooping_pass() -> dict:
    return {
        "method": "white_reality_check",
        "p_value": 0.12,
        "go_live_verdict": "PASS",
        "candidate_count": 4,
    }


def test_metric_explanations_are_human_readable_chinese():
    explanations = explain_backtest_metrics(_mode_b_backtest())
    by_metric = {item["metric"]: item for item in explanations}

    assert "sharpe" in by_metric
    assert "max_drawdown" in by_metric
    assert "fill_rate" in by_metric
    assert "交易次數" in by_metric["total_trades"]["meaning_zh"]
    assert "最大回撤" in by_metric["max_drawdown"]["meaning_zh"]
    assert "Monte Carlo" in by_metric["max_drawdown"]["interpretation_zh"]


def test_deflated_sharpe_proxy_is_fail_closed_for_low_samples():
    out = deflated_sharpe_proxy(2.0, 1)

    assert out["status"] == "FAIL"
    assert out["reason"] == "sample_count_lt_2"
    assert out["method"] == "deflated_sharpe_proxy"
    assert out["exact_formula"] is False
    assert "skew" in out["missing_inputs"]


def test_validation_packet_declares_cpcv_cscv_governance_scope():
    packet = build_validation_packet(
        source="promotion_gate",
        backtest=_mode_b_backtest(),
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
    )

    assert packet["validation_scope"]["purged_cv"] == "required"
    assert packet["validation_scope"]["cpcv_cscv"] == "required"
    assert packet["validation_scope"]["pbo_method"] == "cscv_rank_logit"
    assert packet["validation_scope"]["deflated_sharpe"] == "proxy_until_exact_inputs_available"
    assert packet["validation_scope"]["train_serve_parity"] == "required"
    assert packet["validation_scope"]["data_snooping"] == "white_reality_check_or_hansen_spa"
    assert "model_family_validation_owners_are_declared_in_training_metadata" in packet["validation_scope"]
    assert "non_tree_model_cpcv_requires_family_specific_fit_predict_adapters" not in packet["validation_scope"]["known_gaps"]


def test_data_snooping_reality_check_passes_clear_robust_edge():
    out = data_snooping_reality_check(
        {
            "robust_alpha": [0.018, 0.017, 0.016, 0.019, 0.018, 0.017, 0.016, 0.019],
            "weak_alpha": [0.002, -0.001, 0.001, 0.000, 0.002, -0.001, 0.001, 0.000],
            "bad_alpha": [-0.01, -0.008, -0.006, -0.009, -0.01, -0.008, -0.006, -0.009],
        },
        n_bootstrap=200,
        seed=7,
    )

    assert out["method"] == "white_reality_check"
    assert out["go_live_verdict"] == "PASS"
    assert out["best_candidate"] == "robust_alpha"
    assert out["p_value"] <= 0.20


def test_data_snooping_reality_check_fails_when_edge_is_not_distinct():
    out = data_snooping_reality_check(
        {
            "candidate_a": [0.003, -0.002, 0.002, -0.001, 0.003, -0.002, 0.002, -0.001],
            "candidate_b": [0.002, -0.001, 0.003, -0.002, 0.002, -0.001, 0.003, -0.002],
            "candidate_c": [0.001, -0.001, 0.002, -0.002, 0.001, -0.001, 0.002, -0.002],
        },
        n_bootstrap=200,
        seed=11,
    )

    assert out["method"] == "white_reality_check"
    assert out["go_live_verdict"] == "FAIL"
    assert out["p_value"] > 0.20


def test_hansen_spa_reality_check_passes_clear_candidate_edge():
    out = hansen_spa_reality_check(
        {
            "champion": [0.003, 0.001, 0.002, 0.001, 0.003, 0.001, 0.002, 0.001],
            "candidate": [0.015, 0.013, 0.014, 0.016, 0.015, 0.013, 0.014, 0.016],
            "noisy": [0.001, -0.001, 0.002, -0.002, 0.001, -0.001, 0.002, -0.002],
        },
        benchmark="champion",
        n_bootstrap=200,
        seed=17,
    )

    assert out["method"] == "hansen_spa"
    assert out["go_live_verdict"] == "PASS"
    assert out["best_candidate"] == "candidate"
    assert out["p_value"] <= 0.20


def test_hansen_spa_reality_check_fails_when_candidate_does_not_beat_benchmark():
    out = hansen_spa_reality_check(
        {
            "champion": [0.004, 0.003, 0.005, 0.004, 0.004, 0.003, 0.005, 0.004],
            "candidate": [0.003, 0.002, 0.004, 0.003, 0.003, 0.002, 0.004, 0.003],
        },
        benchmark="champion",
        n_bootstrap=200,
        seed=19,
    )

    assert out["method"] == "hansen_spa"
    assert out["go_live_verdict"] == "FAIL"
    assert out["best_mean_excess_return"] <= 0


def test_validation_packet_accepts_hansen_spa_data_snooping_guard():
    packet = build_validation_packet(
        source="promotion_gate",
        backtest=_promotion_grade_backtest(),
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
        data_snooping={
            "method": "hansen_spa",
            "p_value": 0.11,
            "go_live_verdict": "PASS",
            "candidate_count": 3,
        },
        walk_forward={"passed": True, "windows": 6},
    )
    gate = next(g for g in packet["gates"] if g["name"] == "data_snooping_overfit_guard")

    assert packet["decision"] == "PASS"
    assert gate["evidence"]["method"] == "hansen_spa"


def test_validation_packet_uses_exact_dsr_when_return_series_exists():
    packet = build_validation_packet(
        source="promotion_gate",
        backtest=_mode_b_backtest_with_returns(),
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
    )
    dsr_gate = next(g for g in packet["gates"] if g["name"] == "deflated_sharpe")

    assert dsr_gate["evidence"]["method"] == "deflated_sharpe_bailey_lopez_de_prado"
    assert dsr_gate["evidence"]["exact_formula"] is True
    assert dsr_gate["evidence"]["skew"] is not None
    assert dsr_gate["evidence"]["kurtosis"] is not None


def test_replay_packet_keeps_missing_walk_forward_advisory_only():
    packet = build_validation_packet(
        source="backtest_replay",
        backtest=_mode_b_backtest(),
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
        data_snooping=_data_snooping_pass(),
    )

    assert packet["schema_version"] == VALIDATION_PACKET_SCHEMA_VERSION
    assert packet["decision"] == "PASS"
    assert "walk_forward" in packet["warnings"]
    assert "deflated_sharpe" not in packet["failed_gates"]
    assert "data_snooping_overfit_guard" not in packet["failed_gates"]


def test_promotion_validation_packet_fails_closed_without_walk_forward():
    packet = build_validation_packet(
        source="promotion_gate",
        backtest=_mode_b_backtest(),
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
        data_snooping=_data_snooping_pass(),
    )

    assert packet["decision"] == "FAIL"
    assert "walk_forward" in packet["failed_gates"]


def test_promotion_validation_packet_fails_closed_without_regime_split():
    packet = build_validation_packet(
        source="promotion_gate",
        backtest=_mode_b_backtest(),
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
        data_snooping=_data_snooping_pass(),
        walk_forward={"passed": True, "windows": 6},
    )

    assert packet["decision"] == "FAIL"
    assert "regime_split_validation" in packet["failed_gates"]


def test_promotion_validation_packet_passes_with_walk_forward_and_regime_split():
    packet = build_validation_packet(
        source="promotion_gate",
        backtest=_promotion_grade_backtest(),
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
        data_snooping=_data_snooping_pass(),
        walk_forward={"passed": True, "windows": 6},
    )

    assert packet["decision"] == "PASS"
    assert "walk_forward" not in packet["failed_gates"]
    assert "regime_split_validation" not in packet["failed_gates"]


def test_validation_packet_fails_mode_a_for_promotion_context():
    backtest = {**_mode_b_backtest(), "mode": "A"}

    packet = build_validation_packet(
        source="promotion_gate",
        backtest=backtest,
        monte_carlo=_monte_carlo(),
        pbo=_pbo(),
    )

    assert packet["decision"] == "FAIL"
    assert "backtest_mode_b" in packet["failed_gates"]


def test_replay_only_packet_warns_instead_of_failing_missing_mc_pbo():
    packet = build_validation_packet(
        source="backtest_replay",
        backtest=_mode_b_backtest(),
        external_risk_required=False,
    )

    assert packet["decision"] == "PASS"
    assert "monte_carlo_tail_risk" in packet["warnings"]
    assert "pbo_overfit_risk" in packet["warnings"]


def test_strategy_replay_contract_is_read_only_by_default():
    contract = build_strategy_replay_contract(
        mode="B",
        start_date="2026-01-01",
        end_date="2026-04-30",
        persisted=False,
        symbols_count=50,
    )

    assert contract["mutation_scope"] == "read_only"
    assert contract["production_promotion_allowed"] is False
    assert "Purged CV / dynamic embargo" in contract["promotion_requires"]
    assert "CPCV/CSCV rank-logit PBO PASS" in contract["promotion_requires"]


def test_strategy_lab_record_requires_reproducibility_evidence():
    validation_packet = build_validation_packet(
        source="backtest_replay",
        backtest=_mode_b_backtest(),
        external_risk_required=False,
    )
    replay_contract = build_strategy_replay_contract(
        mode="B",
        start_date="2026-01-01",
        end_date="2026-04-30",
        persisted=False,
        symbols_count=50,
    )

    record = build_strategy_lab_record(
        hypothesis="Test whether breakout bucket improves Mode B replay.",
        data_slice={"start_date": "2026-01-01", "end_date": "2026-04-30", "symbols_count": 50},
        dataset_snapshot={"prices_snapshot": "gcs://stockvision/snapshots/prices/2026-04-30.parquet"},
        model_versions={"xgboost": "2026-04-30T1700Z"},
        metrics=_mode_b_backtest(),
        validation_packet=validation_packet,
        strategy_replay_contract=replay_contract,
        follow_up=["Run alpha candidate evidence gate"],
    )

    assert record["schema_version"] == "strategy-lab-record-v1"
    assert record["owner"] == "ml-controller.validation_governance"
    assert record["decision"] == "PASS"
    assert record["production_promotion_allowed"] is False
    assert record["promotion_owner"] == "model_pool/promote_check"
    assert record["dataset_snapshot"]["prices_snapshot"].startswith("gcs://")


def test_strategy_lab_record_fails_closed_without_snapshot_or_packet():
    record = build_strategy_lab_record(
        hypothesis="",
        data_slice={},
        dataset_snapshot=None,
        model_versions={},
        metrics=_mode_b_backtest(),
        validation_packet=None,
        strategy_replay_contract=None,
    )

    assert record["decision"] == "FAIL"
    assert "hypothesis_present" in record["failed_gates"]
    assert "dataset_snapshot_present" in record["failed_gates"]
    assert "validation_packet_present" in record["failed_gates"]
