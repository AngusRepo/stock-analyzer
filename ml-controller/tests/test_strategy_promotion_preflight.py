from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.strategy_promotion_preflight import (  # noqa: E402
    FUSED_ID,
    _factor_contract_row,
    _strategy_summary,
    _validate_fixed_contract,
    finlab701_api_key,
)


def _policy() -> dict:
    return {
        "policy": {
            "fixed_backtest_contract": {
                "start_date": "2023-01-01",
                "end_date": "2026-06-15",
                "universe": "sii",
                "resample": "M",
                "top_k": 10,
                "required_extra_slippage_bps": [0, 50, 100],
            }
        },
        "defaults_by_factor_type": {
            "price_technical": {
                "coverage_min": 0.95,
                "min_unique_values": 20,
                "exact_stats_required": True,
                "asof_lag_rule": "same_day_or_lookback_only",
            },
            "fundamental_factor_diversity": {
                "coverage_min": 0.85,
                "min_unique_values": 20,
                "exact_stats_required": True,
                "asof_lag_rule": "reported_asof_no_future_leakage",
            },
        },
        "by_factor": {
            "KLOW2": {"factor_type": "price_technical"},
            "l1_squeezeRelease": {
                "factor_type": "l1_signal",
                "coverage_min": 0.8,
                "min_unique_values": 2,
            },
            "finlab701_financial_statement_財務成本": {
                "factor_type": "fundamental_factor_diversity",
                "coverage_min": 0.85,
            },
        },
    }


def test_finlab701_api_key_maps_chinese_factor_id():
    assert (
        finlab701_api_key("finlab701_financial_statement_財務成本")
        == "financial_statement:財務成本"
    )


def test_fixed_backtest_contract_matches_required_window_and_costs():
    summary = {
        "config": {
            "start_date": "2023-01-01",
            "end_date": "2026-06-15",
            "universe": "sii",
            "resample": "M",
            "top_k": 10,
            "extra_slippage_bps": [0, 10, 25, 50, 100],
        }
    }

    assert _validate_fixed_contract(summary, _policy()) == []

    bad = {**summary, "config": {**summary["config"], "top_k": 12}}
    assert _validate_fixed_contract(bad, _policy()) == [
        "fixed_contract_mismatch:top_k:12!=10"
    ]


def test_fixed_backtest_contract_can_read_summary_sidecar(tmp_path: Path):
    full = tmp_path / "robustness.json"
    full.write_text(
        json.dumps(
            {
                "config": {
                    "start_date": "2023-01-01",
                    "end_date": "2026-06-15",
                    "universe": "sii",
                    "resample": "M",
                    "top_k": 10,
                    "extra_slippage_bps": [0, 10, 25, 50, 100],
                }
            }
        ),
        encoding="utf-8",
    )
    summary = tmp_path / "summary.json"
    summary.write_text(json.dumps({"json": str(full)}), encoding="utf-8")

    assert _validate_fixed_contract({"json": str(full)}, _policy(), summary) == []


def test_finlab701_factor_passes_by_factor_coverage_gate():
    row = _factor_contract_row(
        strategy_id="alpha223_0248",
        source_strategy_id=None,
        factor_id="finlab701_financial_statement_財務成本",
        weight=0.1,
        policy=_policy(),
        registry={},
        finlab86={
            "financial_statement:財務成本": {
                "api_key": "financial_statement:財務成本",
                "group": "fundamental_factor_diversity",
                "coverage": "0.93477",
                "trade_count": "390",
            }
        },
        materialization={},
        source="unit_test",
    )

    assert row["source_type"] == "finlab701"
    assert row["mapping_ok"] is True
    assert row["coverage_ok"] is True
    assert row["unique_ok"] is True
    assert row["gate_ok"] is True


def test_formal137_factor_requires_exact_factor_stats_to_avoid_select0_regression():
    row = _factor_contract_row(
        strategy_id="alpha223_0248",
        source_strategy_id=None,
        factor_id="KLOW2",
        weight=0.1,
        policy=_policy(),
        registry={"KLOW2": {"feature_id": "KLOW2", "category": "price_technical"}},
        finlab86={},
        materialization={},
        source="unit_test",
    )

    assert row["coverage_status"] == "exact_factor_stats_missing"
    assert row["gate_ok"] is False
    assert row["blocker"] == "exact_factor_stats_missing"


def test_formal137_factor_passes_with_exact_coverage_and_unique_stats():
    row = _factor_contract_row(
        strategy_id="alpha223_0248",
        source_strategy_id=None,
        factor_id="KLOW2",
        weight=0.1,
        policy=_policy(),
        registry={"KLOW2": {"feature_id": "KLOW2", "category": "price_technical"}},
        finlab86={},
        materialization={
            "factor_stats": {
                "KLOW2": {
                    "coverage": 0.99,
                    "unique_values": 200,
                    "non_constant": True,
                }
            }
        },
        source="unit_test",
    )

    assert row["gate_ok"] is True
    assert row["blocker"] == ""


def test_formal137_factor_without_runtime_mapping_is_blocked():
    row = _factor_contract_row(
        strategy_id="alpha223_x",
        source_strategy_id=None,
        factor_id="formal_but_not_runtime",
        weight=0.1,
        policy=_policy(),
        registry={
            "formal_but_not_runtime": {
                "feature_id": "formal_but_not_runtime",
                "category": "price_technical",
            }
        },
        finlab86={},
        materialization={
            "factor_stats": {
                "formal_but_not_runtime": {
                    "coverage": 0.99,
                    "unique_values": 200,
                    "non_constant": True,
                }
            }
        },
        source="unit_test",
    )

    assert row["mapping_ok"] is True
    assert row["runtime_mapping_ok"] is False
    assert row["blocker"] == "runtime_mapping_missing"
    assert row["gate_ok"] is False


def test_binary_l1_event_factor_can_pass_with_two_unique_values_when_overridden():
    row = _factor_contract_row(
        strategy_id="alpha223_0248",
        source_strategy_id=None,
        factor_id="l1_squeezeRelease",
        weight=0.1,
        policy=_policy(),
        registry={
            "l1_squeezeRelease": {
                "feature_id": "l1_squeezeRelease",
                "category": "l1_signal",
            }
        },
        finlab86={},
        materialization={
            "factor_stats": {
                "l1_squeezeRelease": {
                    "coverage": 1.0,
                    "unique_values": 2,
                    "non_constant": True,
                }
            }
        },
        source="unit_test",
    )

    assert row["coverage_min"] == 0.8
    assert row["min_unique_values"] == 2
    assert row["gate_ok"] is True


def test_fused_strategy_is_not_promotion_ready_until_backtest_exists():
    summary = _strategy_summary(
        strategy_id=FUSED_ID,
        factor_rows=[
            {
                "strategy_id": FUSED_ID,
                "factor_id": "KLOW2",
                "blocker": "",
            }
        ],
        replacement_rows={},
        confirm_rows={},
    )

    assert summary["factor_gate_ok"] is True
    assert summary["performance_contract_ok"] is False
    assert summary["performance_status"] == "fused_backtest_pending"
    assert summary["promotion_ready"] is False
