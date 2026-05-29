from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_ic_tracker import (  # noqa: E402
    apply_weekly_ic_to_pool,
    compute_weekly_ic_from_rows,
    market_segment_from_prediction_row,
    rank_score_from_prediction_row,
    tracked_model_names,
)


def test_rank_score_uses_forecast_rank_score_only():
    score, source = rank_score_from_prediction_row(
        {
            "direction_accuracy": 0.1,
            "forecast_data": '{"rank_score": 0.9}',
        }
    )

    assert score == 0.9
    assert source == "forecast_data.rank_score"

    score, source = rank_score_from_prediction_row(
        {
            "direction_accuracy": 0.8,
            "forecast_data": '{}',
        }
    )
    assert score is None
    assert source == "missing"


def test_compute_weekly_ic_uses_rank_score_and_reports_score_sources():
    rows = [
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 1}', "direction_accuracy": 0.9, "actual_return_pct": 0.01},
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 2}', "direction_accuracy": 0.1, "actual_return_pct": 0.02},
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 3}', "direction_accuracy": 0.2, "actual_return_pct": 0.03},
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 4}', "direction_accuracy": 0.3, "actual_return_pct": 0.04},
    ]

    result = compute_weekly_ic_from_rows(rows, min_samples=4, all_tracked=("XGBoost",))

    assert result["XGBoost"]["status"] == "computed"
    assert result["XGBoost"]["root_cause"] == "ok"
    assert result["XGBoost"]["ic"] == 1.0
    assert result["XGBoost"]["diagnostics"]["production_rows"] == 4
    assert result["XGBoost"]["score_sources"] == {"forecast_data.rank_score": 4}


def test_compute_weekly_ic_reports_market_segment_diagnostics():
    rows = [
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 1, "stock_meta": {"market_segment": "EMERGING"}}',
            "actual_return_pct": 0.01,
        },
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 2, "stock_meta": {"market_segment": "EMERGING"}}',
            "actual_return_pct": 0.03,
        },
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 3, "stock_meta": {"market_segment": "LISTED"}}',
            "actual_return_pct": 0.02,
        },
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 4, "stock_meta": {"market_segment": "LISTED"}}',
            "actual_return_pct": 0.04,
        },
    ]

    result = compute_weekly_ic_from_rows(rows, min_samples=2, all_tracked=("XGBoost",))

    assert result["XGBoost"]["status"] == "computed"
    assert result["XGBoost"]["n_samples"] == 2
    assert result["XGBoost"]["segments"]["EMERGING"]["n_samples"] == 2
    assert result["XGBoost"]["segments"]["EMERGING"]["ic"] == 1.0
    assert result["XGBoost"]["segments"]["LISTED"]["n_samples"] == 2
    assert market_segment_from_prediction_row(rows[0]) == "EMERGING"


def test_emerging_predictions_do_not_count_toward_production_ic():
    rows = [
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 1, "stock_meta": {"market_segment": "EMERGING"}}',
            "actual_return_pct": 0.01,
        },
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 2, "stock_meta": {"market_segment": "EMERGING"}}',
            "actual_return_pct": 0.02,
        },
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 3, "stock_meta": {"market_segment": "EMERGING"}}',
            "actual_return_pct": 0.03,
        },
        {
            "model_name": "XGBoost",
            "forecast_data": '{"rank_score": 4, "stock_meta": {"market_segment": "EMERGING"}}',
            "actual_return_pct": 0.04,
        },
    ]

    result = compute_weekly_ic_from_rows(rows, min_samples=2, all_tracked=("XGBoost",))

    assert result["XGBoost"]["status"] == "insufficient_samples"
    assert result["XGBoost"]["n_samples"] == 0
    assert result["XGBoost"]["segments"]["EMERGING"]["status"] == "computed"
    assert result["XGBoost"]["segments"]["EMERGING"]["n_samples"] == 4


def test_compute_weekly_ic_marks_constant_scores_as_undefined_variance():
    rows = [
        {"model_name": "FT-Transformer", "forecast_data": '{"rank_score": 0}', "actual_return_pct": 0.01},
        {"model_name": "FT-Transformer", "forecast_data": '{"rank_score": 0}', "actual_return_pct": -0.02},
        {"model_name": "FT-Transformer", "forecast_data": '{"rank_score": 0}', "actual_return_pct": 0.03},
        {"model_name": "FT-Transformer", "forecast_data": '{"rank_score": 0}', "actual_return_pct": -0.04},
    ]

    result = compute_weekly_ic_from_rows(rows, min_samples=4, all_tracked=("FT-Transformer",))

    assert result["FT-Transformer"]["status"] == "undefined_variance"
    assert result["FT-Transformer"]["root_cause"] == "undefined_variance"
    assert result["FT-Transformer"]["ic"] is None
    assert result["FT-Transformer"]["n_samples"] == 4
    assert result["FT-Transformer"]["error"] == "rank_score_or_actual_return_has_zero_cross_sectional_variance"


def test_compute_weekly_ic_reports_actionable_root_causes():
    rows = [
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 1}', "actual_return_pct": 0.01, "verified_at": None},
        {"model_name": "CatBoost", "forecast_data": '{"rank_score": 1}', "actual_return_pct": None, "verified_at": "2026-05-01"},
        {"model_name": "LightGBM", "forecast_data": "{}", "actual_return_pct": 0.01, "verified_at": "2026-05-01"},
    ]

    result = compute_weekly_ic_from_rows(
        rows,
        min_samples=2,
        all_tracked=("XGBoost", "CatBoost", "LightGBM", "DLinear"),
    )

    assert result["XGBoost"]["root_cause"] == "verification_missing"
    assert result["XGBoost"]["diagnostics"]["unverified_rows"] == 1
    assert result["CatBoost"]["root_cause"] == "outcome_missing"
    assert result["CatBoost"]["diagnostics"]["missing_outcome_rows"] == 1
    assert result["LightGBM"]["root_cause"] == "ranking_signal_missing"
    assert result["LightGBM"]["diagnostics"]["missing_score_rows"] == 1
    assert result["DLinear"]["root_cause"] == "prediction_missing"
    assert result["DLinear"]["diagnostics"]["raw_rows"] == 0


def test_tracked_model_names_exclude_retired_shadow_paths_and_include_formal_slots():
    tracked = tracked_model_names()

    assert "ResidualMLP" not in tracked
    assert ("ResidualMLP" + "::" + "challenger") not in tracked
    assert "GNN::challenger" not in tracked
    assert "TabM" in tracked
    assert "GNN" in tracked
    assert "iTransformer" in tracked
    assert "TimesFM" in tracked
    assert "XGBoost::challenger" not in tracked


def test_apply_weekly_ic_updates_active_and_challenger_histories():
    pool = {
        "models": {
            "XGBoost": {
                "weekly_ic": [0.1],
                "ic_4w_avg": 0.1,
                "consecutive_negative_weeks": 0,
                "challenger": {
                    "weekly_ic": [-0.1],
                    "ic_4w_avg": -0.1,
                    "consecutive_negative_weeks": 1,
                },
            }
        }
    }
    per_model_ic = {
        "XGBoost": {"ic": -0.2, "score_sources": {"forecast_data.rank_score": 10}},
        "XGBoost::challenger": {"ic": 0.3, "score_sources": {"forecast_data.rank_score": 10}},
    }

    changes, changed = apply_weekly_ic_to_pool(pool, per_model_ic, history_max=2)

    assert changed is True
    assert pool["models"]["XGBoost"]["weekly_ic"] == [0.1, -0.2]
    assert pool["models"]["XGBoost"]["ic_4w_avg"] == -0.05
    assert pool["models"]["XGBoost"]["consecutive_negative_weeks"] == 1
    assert pool["models"]["XGBoost"]["challenger"]["weekly_ic"] == [-0.1, 0.3]
    assert pool["models"]["XGBoost"]["challenger"]["ic_4w_avg"] == 0.1
    assert pool["models"]["XGBoost"]["challenger"]["consecutive_negative_weeks"] == 0
    assert changes["XGBoost"]["score_sources"] == {"forecast_data.rank_score": 10}
    assert changes["XGBoost::challenger"]["history_len"] == 2


def test_apply_weekly_ic_updates_formal_layer3_slot_without_shadow_entry():
    pool = {
        "models": {},
        "formal_layer3_slots": {
            "TabM": {
                "weekly_ic": [],
                "ic_4w_avg": None,
                "consecutive_negative_weeks": 0,
            }
        },
    }
    per_model_ic = {
        "TabM": {"ic": 0.07, "n_samples": 64, "score_sources": {"forecast_data.rank_score": 64}},
        "GNN::challenger": {"ic": 0.2, "n_samples": 64},
    }

    changes, changed = apply_weekly_ic_to_pool(pool, per_model_ic, history_max=26)

    assert changed is True
    assert pool["formal_layer3_slots"]["TabM"]["weekly_ic"] == [0.07]
    assert pool["formal_layer3_slots"]["TabM"]["ic_4w_avg"] == 0.07
    assert "TabM" in changes
    assert "GNN::challenger" not in changes


def test_apply_weekly_ic_records_sample_diagnostics_even_when_insufficient():
    pool = {
        "models": {
            "XGBoost": {
                "weekly_ic": [],
                "ic_4w_avg": None,
                "consecutive_negative_weeks": 0,
            }
        }
    }
    per_model_ic = {
        "XGBoost": {
            "status": "insufficient_samples",
            "n_samples": 12,
            "score_sources": {"forecast_data.rank_score": 12},
        }
    }

    changes, changed = apply_weekly_ic_to_pool(pool, per_model_ic, history_max=26)

    assert changed is True
    assert pool["models"]["XGBoost"]["weekly_ic"] == []
    assert pool["models"]["XGBoost"]["last_ic_status"] == "insufficient_samples"
    assert pool["models"]["XGBoost"]["last_ic_root_cause"] is None
    assert pool["models"]["XGBoost"]["last_ic_sample_count"] == 12
    assert pool["models"]["XGBoost"]["last_ic_score_sources"] == {"forecast_data.rank_score": 12}
    assert changes["XGBoost"]["status"] == "insufficient_samples"
    assert changes["XGBoost"]["n_samples"] == 12


def test_apply_weekly_ic_persists_root_cause_diagnostics():
    pool = {
        "models": {
            "XGBoost": {
                "weekly_ic": [],
                "ic_4w_avg": None,
                "consecutive_negative_weeks": 0,
            }
        }
    }
    per_model_ic = {
        "XGBoost": {
            "status": "insufficient_samples",
            "root_cause": "outcome_missing",
            "n_samples": 0,
            "diagnostics": {"raw_rows": 30, "outcome_rows": 0},
            "score_sources": {},
        }
    }

    changes, changed = apply_weekly_ic_to_pool(pool, per_model_ic, history_max=26)

    assert changed is True
    assert pool["models"]["XGBoost"]["last_ic_root_cause"] == "outcome_missing"
    assert pool["models"]["XGBoost"]["last_ic_diagnostics"]["raw_rows"] == 30
    assert changes["XGBoost"]["root_cause"] == "outcome_missing"
    assert changes["XGBoost"]["diagnostics"]["outcome_rows"] == 0


def test_apply_weekly_ic_persists_segment_ic_diagnostics():
    pool = {
        "models": {
            "XGBoost": {
                "weekly_ic": [],
                "ic_4w_avg": None,
                "consecutive_negative_weeks": 0,
            }
        }
    }
    per_model_ic = {
        "XGBoost": {
            "status": "computed",
            "ic": 0.2,
            "n_samples": 80,
            "score_sources": {"forecast_data.rank_score": 80},
            "segments": {
                "LISTED": {"status": "computed", "ic": 0.22, "n_samples": 70},
                "EMERGING": {"status": "insufficient_samples", "ic": None, "n_samples": 10},
            },
        }
    }

    changes, changed = apply_weekly_ic_to_pool(pool, per_model_ic, history_max=26)

    assert changed is True
    assert pool["models"]["XGBoost"]["last_ic_by_segment"]["EMERGING"]["n_samples"] == 10
    assert changes["XGBoost"]["segments"]["LISTED"]["ic"] == 0.22


def test_apply_weekly_ic_can_refresh_rolling_weight_without_appending_history():
    pool = {
        "models": {
            "XGBoost": {
                "weekly_ic": [0.1],
                "ic_4w_avg": 0.1,
                "consecutive_negative_weeks": 0,
            }
        }
    }
    per_model_ic = {
        "XGBoost": {"ic": 0.04, "n_samples": 80, "score_sources": {"forecast_data.rank_score": 80}},
    }

    changes, changed = apply_weekly_ic_to_pool(
        pool,
        per_model_ic,
        history_max=26,
        append_history=False,
    )

    assert changed is True
    assert pool["models"]["XGBoost"]["weekly_ic"] == [0.1]
    assert pool["models"]["XGBoost"]["ic_4w_avg"] == 0.1
    assert pool["models"]["XGBoost"]["rolling_ic"] == 0.04
    assert changes["XGBoost"]["rolling_ic"] == 0.04
    assert changes["XGBoost"]["history_len"] == 1
