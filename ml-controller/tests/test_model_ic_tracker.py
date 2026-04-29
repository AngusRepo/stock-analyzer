from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_ic_tracker import (  # noqa: E402
    apply_weekly_ic_to_pool,
    compute_weekly_ic_from_rows,
    rank_score_from_prediction_row,
)


def test_rank_score_prefers_forecast_rank_score_over_direction_accuracy():
    score, source = rank_score_from_prediction_row(
        {
            "direction_accuracy": 0.1,
            "forecast_data": '{"rank_score": 0.9}',
        }
    )

    assert score == 0.9
    assert source == "forecast_data.rank_score"


def test_compute_weekly_ic_uses_rank_score_and_reports_score_sources():
    rows = [
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 1}', "direction_accuracy": 0.9, "actual_return_pct": 0.01},
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 2}', "direction_accuracy": 0.1, "actual_return_pct": 0.02},
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 3}', "direction_accuracy": 0.2, "actual_return_pct": 0.03},
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 4}', "direction_accuracy": 0.3, "actual_return_pct": 0.04},
    ]

    result = compute_weekly_ic_from_rows(rows, min_samples=4, all_tracked=("XGBoost",))

    assert result["XGBoost"]["status"] == "computed"
    assert result["XGBoost"]["ic"] == 1.0
    assert result["XGBoost"]["score_sources"] == {"forecast_data.rank_score": 4}


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
    assert pool["models"]["XGBoost"]["last_ic_sample_count"] == 12
    assert pool["models"]["XGBoost"]["last_ic_score_sources"] == {"forecast_data.rank_score": 12}
    assert changes["XGBoost"]["status"] == "insufficient_samples"
    assert changes["XGBoost"]["n_samples"] == 12


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
