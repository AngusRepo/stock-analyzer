from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.model_ic_tracker import (  # noqa: E402
    ACTIVE_ARTIFACT_CHALLENGER_MODELS,
    ALPHA_PREDICTION_MODELS,
    EXPERIMENTAL_SHADOW_MODELS,
    IC_TARGET_SEMANTIC_VERSION,
    apply_weekly_ic_to_pool,
    compute_weekly_ic_from_rows,
    market_segment_from_prediction_row,
    rank_score_from_prediction_row,
    tracked_model_names,
)


def test_tracked_model_names_follow_refactored_l3_pool():
    assert ALPHA_PREDICTION_MODELS == (
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
    )
    assert EXPERIMENTAL_SHADOW_MODELS == ("ResidualMLP",)
    assert ACTIVE_ARTIFACT_CHALLENGER_MODELS == ALPHA_PREDICTION_MODELS
    tracked = tracked_model_names()
    assert "CatBoost" not in tracked
    assert "FT-Transformer" not in tracked
    assert "Chronos" not in tracked
    assert "GNN::challenger" in tracked
    assert "XGBoost::challenger" in tracked
    assert "ResidualMLP::challenger" in tracked


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


def test_weekly_ic_is_equal_weighted_across_daily_cross_sections():
    rows = []
    for rank in range(1, 6):
        rows.append({
            "model_name": "XGBoost",
            "prediction_date": "2026-07-01",
            "forecast_data": f'{{"rank_score": {rank}}}',
            "actual_return_pct": rank / 100,
        })
    for rank in range(1, 4):
        rows.append({
            "model_name": "XGBoost",
            "prediction_date": "2026-07-02",
            "forecast_data": f'{{"rank_score": {rank}}}',
            "actual_return_pct": -rank / 100,
        })

    result = compute_weekly_ic_from_rows(
        rows,
        min_samples=8,
        min_dates=2,
        all_tracked=("XGBoost",),
    )["XGBoost"]

    assert result["status"] == "computed"
    assert result["ic"] == 0.0
    assert result["n_dates"] == 2
    assert result["daily_ic"] == {"2026-07-01": 1.0, "2026-07-02": -1.0}
    assert result["positive_ic_rate"] == 0.5


def test_weekly_ic_rejects_single_date_even_with_many_rows():
    rows = [
        {
            "model_name": "XGBoost",
            "prediction_date": "2026-07-01",
            "forecast_data": f'{{"rank_score": {rank}}}',
            "actual_return_pct": rank / 100,
        }
        for rank in range(1, 51)
    ]

    result = compute_weekly_ic_from_rows(
        rows,
        min_samples=50,
        min_dates=3,
        all_tracked=("XGBoost",),
    )["XGBoost"]

    assert result["status"] == "insufficient_dates"
    assert result["root_cause"] == "date_coverage_low"
    assert result["n_dates"] == 1
    assert result.get("ic") is None


def test_weekly_ic_deduplicates_reruns_by_stock_model_and_date():
    rows = [
        {
            "id": 1,
            "stock_id": rank,
            "model_name": "XGBoost",
            "prediction_date": "2026-07-01",
            "generated_at": "2026-07-01T10:00:00Z",
            "forecast_data": f'{{"rank_score": {6 - rank}}}',
            "actual_return_pct": rank / 100,
        }
        for rank in range(1, 6)
    ]
    rows.extend({
        **row,
        "id": int(row["id"]) + 100,
        "generated_at": "2026-07-01T11:00:00Z",
        "forecast_data": f'{{"rank_score": {row["stock_id"]}}}',
    } for row in list(rows))

    result = compute_weekly_ic_from_rows(
        rows,
        min_samples=5,
        all_tracked=("XGBoost",),
    )["XGBoost"]

    assert result["ic"] == 1.0
    assert result["n_samples"] == 5
    assert result["diagnostics"]["duplicate_rows_dropped"] == 5


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
        {"model_name": "TabM", "forecast_data": '{"rank_score": 0}', "actual_return_pct": 0.01},
        {"model_name": "TabM", "forecast_data": '{"rank_score": 0}', "actual_return_pct": -0.02},
        {"model_name": "TabM", "forecast_data": '{"rank_score": 0}', "actual_return_pct": 0.03},
        {"model_name": "TabM", "forecast_data": '{"rank_score": 0}', "actual_return_pct": -0.04},
    ]

    result = compute_weekly_ic_from_rows(rows, min_samples=4, all_tracked=("TabM",))

    assert result["TabM"]["status"] == "undefined_variance"
    assert result["TabM"]["root_cause"] == "undefined_variance"
    assert result["TabM"]["ic"] is None
    assert result["TabM"]["n_samples"] == 4
    assert result["TabM"]["error"] == "rank_score_or_actual_return_has_zero_cross_sectional_variance"


def test_compute_weekly_ic_reports_actionable_root_causes():
    rows = [
        {"model_name": "XGBoost", "forecast_data": '{"rank_score": 1}', "actual_return_pct": 0.01, "verified_at": None},
        {"model_name": "GNN", "forecast_data": '{"rank_score": 1}', "actual_return_pct": None, "verified_at": "2026-05-01"},
        {"model_name": "LightGBM", "forecast_data": "{}", "actual_return_pct": 0.01, "verified_at": "2026-05-01"},
    ]

    result = compute_weekly_ic_from_rows(
        rows,
        min_samples=2,
        all_tracked=("XGBoost", "GNN", "LightGBM", "DLinear"),
    )

    assert result["XGBoost"]["root_cause"] == "verification_missing"
    assert result["XGBoost"]["diagnostics"]["unverified_rows"] == 1
    assert result["GNN"]["root_cause"] == "outcome_missing"
    assert result["GNN"]["diagnostics"]["missing_outcome_rows"] == 1
    assert result["LightGBM"]["root_cause"] == "ranking_signal_missing"
    assert result["LightGBM"]["diagnostics"]["missing_score_rows"] == 1
    assert result["DLinear"]["root_cause"] == "prediction_missing"
    assert result["DLinear"]["diagnostics"]["raw_rows"] == 0


def test_compute_weekly_ic_rejects_unmigrated_verification_labels():
    rows = [
        {
            "model_name": "XGBoost",
            "stock_id": idx,
            "prediction_date": "2026-07-01",
            "forecast_data": f'{{"rank_score": {idx}}}',
            "actual_return_pct": idx / 100,
            "verified_at": "2026-07-08",
            "verification_label_schema_version": None,
            "verification_label_entry_price": None,
            "verification_label_end_date": None,
            "verification_label_known_date": None,
        }
        for idx in range(1, 5)
    ]

    result = compute_weekly_ic_from_rows(
        rows,
        min_samples=2,
        all_tracked=("XGBoost",),
    )

    assert result["XGBoost"]["status"] == "insufficient_samples"
    assert result["XGBoost"]["root_cause"] == "label_semantic_mismatch"
    assert result["XGBoost"]["diagnostics"]["label_semantic_mismatch_rows"] == 4


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


def test_apply_weekly_ic_resets_history_when_estimator_semantic_changes():
    pool = {
        "models": {
            "XGBoost": {
                "version": "vNew",
                "weekly_ic": [0.2, 0.3],
                "ic_4w_avg": 0.25,
                "rolling_ic": 0.25,
                "consecutive_negative_weeks": 0,
            }
        }
    }
    per_model_ic = {
        "XGBoost": {
            "status": "computed",
            "root_cause": "ok",
            "ic": -0.04,
            "n_samples": 800,
            "evaluation_contract": {
                "semantic_version": "daily-cross-sectional-equal-date-v2",
                "target_semantic_version": IC_TARGET_SEMANTIC_VERSION,
            },
        }
    }

    changes, changed = apply_weekly_ic_to_pool(
        pool,
        per_model_ic,
        history_max=26,
        append_history=True,
    )

    assert changed is True
    assert pool["models"]["XGBoost"]["weekly_ic"] == [-0.04]
    assert pool["models"]["XGBoost"]["ic_4w_avg"] == -0.04
    assert pool["models"]["XGBoost"]["last_ic_semantic_version"] == "daily-cross-sectional-equal-date-v2"
    assert pool["models"]["XGBoost"]["last_ic_target_semantic_version"] == IC_TARGET_SEMANTIC_VERSION
    assert pool["models"]["XGBoost"]["last_ic_artifact_version"] == "vNew"
    assert changes["XGBoost"]["semantic_migration"] is True


def test_weekly_ic_strictly_filters_to_current_champion_artifact_version():
    def row(stock_id: int, version: str, rank: float, actual: float) -> dict:
        return {
            "stock_id": stock_id,
            "model_name": "XGBoost",
            "prediction_date": "2026-07-17",
            "generated_at": f"2026-07-17T13:00:{stock_id:02d}Z",
            "actual_return_pct": actual,
            "forecast_data": json.dumps({
                "rank_score": rank,
                "model_signal": {
                    "artifact_version": version,
                    "target_semantic_version": IC_TARGET_SEMANTIC_VERSION,
                },
            }),
        }

    result = compute_weekly_ic_from_rows(
        [
            row(1, "vCurrent", 0.1, -0.02),
            row(2, "vCurrent", 0.9, 0.03),
            row(3, "vOld", 0.9, -0.04),
            row(4, "vOld", 0.1, 0.05),
        ],
        min_samples=2,
        all_tracked=("XGBoost",),
        expected_artifact_versions={"XGBoost": "vCurrent"},
    )

    info = result["XGBoost"]
    assert info["status"] == "computed"
    assert info["ic"] == 1.0
    assert info["n_samples"] == 2
    assert info["diagnostics"]["artifact_version_mismatch_rows"] == 2
    assert info["evaluation_contract"]["artifact_version"] == "vCurrent"
def test_challenger_weekly_ic_requires_exact_artifact_id_and_checksum():
    def row(stock_id: int, artifact_id: str, checksum: str, rank: float, actual: float) -> dict:
        return {
            "stock_id": stock_id,
            "model_name": "PatchTST::challenger",
            "prediction_date": "2026-08-25",
            "generated_at": f"2026-08-25T13:00:{stock_id:02d}Z",
            "actual_return_pct": actual,
            "forecast_data": json.dumps({
                "rank_score": rank,
                "model_signal": {
                    "artifact_version": "vCandidate",
                    "artifact_id": artifact_id,
                    "artifact_checksum": checksum,
                    "target_semantic_version": IC_TARGET_SEMANTIC_VERSION,
                },
            }),
        }

    expected_id = "PatchTST:vCandidate:monthly_release"
    expected_checksum = "sha256:" + "d" * 64
    result = compute_weekly_ic_from_rows(
        [
            row(1, expected_id, expected_checksum, 0.1, -0.02),
            row(2, expected_id, expected_checksum, 0.9, 0.03),
            row(3, "PatchTST:vOther:monthly_release", expected_checksum, 0.9, -0.04),
            row(4, expected_id, "sha256:" + "e" * 64, 0.1, 0.05),
        ],
        min_samples=2,
        all_tracked=("PatchTST::challenger",),
        expected_artifact_versions={"PatchTST::challenger": "vCandidate"},
        expected_artifact_identities={
            "PatchTST::challenger": {
                "artifact_id": expected_id,
                "checksum": expected_checksum,
            },
        },
    )

    info = result["PatchTST::challenger"]
    assert info["status"] == "computed"
    assert info["ic"] == 1.0
    assert info["n_samples"] == 2
    assert info["diagnostics"]["artifact_identity_mismatch_rows"] == 2
    assert info["evaluation_contract"]["artifact_identity"]["artifact_id"] == expected_id


# 2026-11-26: champion rows never carried artifact_id/checksum (only the challenger
# writer does), so requiring them turned every champion IC into
# artifact_identity_mismatch -> insufficient_samples from a8ea12e0 (8/27) on.
_CHAMPION_ID = "LightGBM:vServed:oof_full_fit_release"
_CHAMPION_CHECKSUM = "sha256:" + "a" * 64


def _lineage_row(model: str, stock_id: int, day: str, rank: float, actual: float, *,
                 version: str = "vServed", artifact_id: str | None = None,
                 checksum: str | None = None) -> dict:
    signal = {"artifact_version": version, "target_semantic_version": IC_TARGET_SEMANTIC_VERSION}
    if artifact_id is not None:
        signal["artifact_id"] = artifact_id
    if checksum is not None:
        signal["artifact_checksum"] = checksum
    return {
        "stock_id": stock_id,
        "model_name": model,
        "prediction_date": day,
        "generated_at": f"{day}T13:00:{stock_id:02d}Z",
        "actual_return_pct": actual,
        "forecast_data": json.dumps({"rank_score": rank, "model_signal": signal}),
    }


def _two_day_rows(model: str, **identity) -> list[dict]:
    rows = []
    for day in ("2026-11-02", "2026-11-03"):
        for stock_id, (rank, actual) in enumerate(((0.1, -0.02), (0.5, 0.01), (0.9, 0.03)), start=1):
            rows.append(_lineage_row(model, stock_id, day, rank, actual, **identity))
    return rows


def _ic_for(model: str, rows: list[dict], *, version: str = "vServed") -> dict:
    return compute_weekly_ic_from_rows(
        rows,
        min_samples=4,
        min_dates=2,
        all_tracked=(model,),
        expected_artifact_versions={model: version},
        expected_artifact_identities={model: {"artifact_id": _CHAMPION_ID, "checksum": _CHAMPION_CHECKSUM}},
    )[model]


def test_champion_rows_without_identity_compute_on_version_and_target():
    info = _ic_for("LightGBM", _two_day_rows("LightGBM"))

    assert info["status"] == "computed"
    assert info["root_cause"] == "ok"
    assert info["ic"] == 1.0
    assert info["n_samples"] == 6
    assert info["diagnostics"]["artifact_identity_mismatch_rows"] == 0
    assert info["diagnostics"]["artifact_identity_unattested_rows"] == 6
    assert info["observed_artifact_versions"] == {"vServed": 6}
    assert info["evaluation_contract"]["artifact_identity_policy"] == (
        "challenger_exact_match;champion_exact_match_when_row_attests_identity")


def test_challenger_rows_without_identity_stay_identity_mismatch():
    info = _ic_for("LightGBM::challenger", _two_day_rows("LightGBM::challenger"))

    assert info["status"] == "insufficient_samples"
    assert info["root_cause"] == "artifact_identity_mismatch"
    assert info["n_samples"] == 0
    assert info["diagnostics"]["artifact_identity_mismatch_rows"] == 6
    assert info["diagnostics"]["artifact_identity_unattested_rows"] == 0


def test_champion_rows_with_wrong_identity_are_mismatched():
    wrong_id = _two_day_rows("LightGBM", artifact_id="LightGBM:vOther:oof_full_fit_release",
                             checksum=_CHAMPION_CHECKSUM)
    # A row attesting only a checksum is still held to the full identity.
    checksum_only = _two_day_rows("LightGBM", checksum="sha256:" + "b" * 64)
    for rows in (wrong_id, checksum_only):
        info = _ic_for("LightGBM", rows)
        assert info["status"] == "insufficient_samples"
        assert info["root_cause"] == "artifact_identity_mismatch"
        assert info["diagnostics"]["artifact_identity_mismatch_rows"] == 6
        assert info["diagnostics"]["artifact_identity_unattested_rows"] == 0


def test_champion_rows_with_matching_identity_compute():
    rows = _two_day_rows("LightGBM", artifact_id=_CHAMPION_ID, checksum=_CHAMPION_CHECKSUM.upper())
    info = _ic_for("LightGBM", rows)

    assert info["status"] == "computed"
    assert info["diagnostics"]["artifact_identity_unattested_rows"] == 0


def test_champion_rows_of_a_previous_version_report_version_mismatch():
    # 11/24 promotion: the pool serves vNew while every labeled row in the window is vOld.
    rows = _two_day_rows("LightGBM", version="vOld")
    info = _ic_for("LightGBM", rows, version="vNew")

    assert info["status"] == "insufficient_samples"
    assert info["root_cause"] == "artifact_version_mismatch"
    assert info["diagnostics"]["artifact_version_mismatch_rows"] == 6
    assert info["observed_artifact_versions"] == {"vOld": 6}
    assert info["evaluation_contract"]["artifact_version"] == "vNew"


def test_mixed_versions_compute_only_the_served_version_and_report_both():
    rows = _two_day_rows("LightGBM") + [
        _lineage_row("LightGBM", 10 + i, "2026-11-04", 0.5, 0.0, version="vOld") for i in range(3)
    ]
    info = _ic_for("LightGBM", rows)

    assert info["status"] == "computed"
    assert info["n_samples"] == 6
    assert info["diagnostics"]["artifact_version_mismatch_rows"] == 3
    assert info["observed_artifact_versions"] == {"vServed": 6, "vOld": 3}


def test_model_outside_the_serving_pool_reports_version_mismatch():
    rows = _two_day_rows("XGBoost")
    info = compute_weekly_ic_from_rows(
        rows, min_samples=4, min_dates=2, all_tracked=("XGBoost",),
        expected_artifact_versions={}, expected_artifact_identities={},
    )["XGBoost"]

    assert info["status"] == "insufficient_samples"
    assert info["root_cause"] == "artifact_version_mismatch"
    assert info["evaluation_contract"]["artifact_version"] is None


# Dual track (Wei 11/26): the gate track stays serving-version only; ic_by_version is
# a diagnostics-only regrouping of the same rows by the version each row carries.
_GATE_KEYS = ("status", "root_cause", "ic", "n_samples", "n_dates", "icir", "daily_ic", "diagnostics")


def test_prior_version_ic_is_reported_while_the_serving_version_has_no_labels():
    rows = _two_day_rows("LightGBM", version="vOld")
    info = _ic_for("LightGBM", rows, version="vNew")

    assert info["status"] == "insufficient_samples"
    assert info["root_cause"] == "artifact_version_mismatch"
    assert "ic" not in info
    old = info["ic_by_version"]["vOld"]
    assert old["status"] == "computed" and old["ic"] == 1.0
    assert old["n_samples"] == 6 and old["n_dates"] == 2
    assert (old["first_date"], old["last_date"]) == ("2026-11-02", "2026-11-03")
    assert old["serving_version"] is False
    assert set(old["daily_ic"]) == {"2026-11-02", "2026-11-03"}
    assert set(info["ic_by_version"]) == {"vOld"}


def test_two_computed_versions_group_separately_and_gate_takes_the_serving_one():
    serving = _two_day_rows("LightGBM")  # rank and return agree: IC 1.0
    prior = [
        _lineage_row("LightGBM", stock_id + 20, day, rank, actual, version="vOld")
        for day in ("2026-10-27", "2026-10-28")
        for stock_id, (rank, actual) in enumerate(((0.1, 0.03), (0.5, 0.01), (0.9, -0.02)), start=1)
    ]  # rank and return disagree: IC -1.0
    info = _ic_for("LightGBM", serving + prior)
    gate_only = _ic_for("LightGBM", serving)

    assert info["status"] == "computed" and info["ic"] == 1.0 and info["n_samples"] == 6
    assert {key: info[key] for key in _GATE_KEYS if key != "diagnostics"} == {
        key: gate_only[key] for key in _GATE_KEYS if key != "diagnostics"}
    assert info["diagnostics"]["artifact_version_mismatch_rows"] == 6
    by_version = info["ic_by_version"]
    assert by_version["vServed"]["ic"] == 1.0 and by_version["vServed"]["serving_version"] is True
    assert by_version["vOld"]["ic"] == -1.0 and by_version["vOld"]["serving_version"] is False
    assert by_version["vOld"]["first_date"] == "2026-10-27"
    for key in ("status", "ic", "n_samples", "n_dates", "icir"):
        assert by_version["vServed"][key] == info[key]


def test_serving_group_reports_its_own_root_cause_not_the_whole_model_one():
    # Serving-version rows attest a different artifact; the prior version has more rows, so the
    # gate (decided over all of the model's rows) reports artifact_version_mismatch.
    serving = _two_day_rows("LightGBM", artifact_id="LightGBM:vServed:other", checksum=_CHAMPION_CHECKSUM)
    prior = [
        _lineage_row("LightGBM", stock_id + 20 * week, day, rank, actual, version="vOld")
        for week, days in enumerate((("2026-10-27", "2026-10-28"), ("2026-10-20", "2026-10-21")), start=1)
        for day in days
        for stock_id, (rank, actual) in enumerate(((0.1, -0.02), (0.5, 0.01), (0.9, 0.03)), start=1)
    ]
    info = _ic_for("LightGBM", serving + prior)
    alone = _ic_for("LightGBM", serving)

    assert info["status"] == "insufficient_samples"
    assert info["root_cause"] == "artifact_version_mismatch"
    group = info["ic_by_version"]["vServed"]
    assert group["serving_version"] is True
    assert group["root_cause"] == alone["root_cause"] == "artifact_identity_mismatch"
    for key in ("status", "n_samples", "n_dates"):
        assert group[key] == alone[key]
    assert info["ic_by_version"]["vOld"]["status"] == "computed"


def test_serving_group_daily_ic_is_a_copy_of_the_gate_series():
    info = _ic_for("LightGBM", _two_day_rows("LightGBM"))
    group = info["ic_by_version"]["vServed"]

    assert group["daily_ic"] == info["daily_ic"]
    assert group["daily_ic"] is not info["daily_ic"]
    group["daily_ic"]["2026-11-02"] = 0.0
    assert info["daily_ic"]["2026-11-02"] == 1.0


def test_ic_by_version_keeps_challenger_identity_strict():
    expected = {"artifact_id": _CHAMPION_ID, "checksum": _CHAMPION_CHECKSUM}
    attested = _two_day_rows("LightGBM::challenger", artifact_id=_CHAMPION_ID, checksum=_CHAMPION_CHECKSUM)
    unattested = [dict(r, stock_id=r["stock_id"] + 30) for r in _two_day_rows("LightGBM::challenger", version="vOther")]
    other_attested = [dict(r, stock_id=r["stock_id"] + 50) for r in _two_day_rows(
        "LightGBM::challenger", version="vPrior", artifact_id="LightGBM:vPrior:x", checksum=_CHAMPION_CHECKSUM)]
    info = compute_weekly_ic_from_rows(
        attested + unattested + other_attested, min_samples=4, min_dates=2,
        all_tracked=("LightGBM::challenger",),
        expected_artifact_versions={"LightGBM::challenger": "vServed"},
        expected_artifact_identities={"LightGBM::challenger": expected},
    )["LightGBM::challenger"]

    assert info["status"] == "computed"
    by_version = info["ic_by_version"]
    assert by_version["vServed"]["status"] == "computed"
    # Outside the candidate there is no expected identity, so challenger rows cannot prove one.
    for version in ("vOther", "vPrior"):
        assert by_version[version]["status"] == "insufficient_samples"
        assert by_version[version]["root_cause"] == "artifact_identity_mismatch"


def test_ic_by_version_champion_rows_attesting_a_non_serving_identity_are_rejected():
    rows = _two_day_rows("LightGBM", version="vOld", artifact_id="LightGBM:vOld:x", checksum=_CHAMPION_CHECKSUM)
    old = _ic_for("LightGBM", rows, version="vNew")["ic_by_version"]["vOld"]

    assert old["status"] == "insufficient_samples"
    assert old["root_cause"] == "artifact_identity_mismatch"


def test_live_gate_decision_ignores_ic_by_version():
    from services.model_artifact_registry import _live_gate_decision

    rows = _two_day_rows("LightGBM", version="vOld")
    per_model = compute_weekly_ic_from_rows(
        rows, min_samples=4, min_dates=2, all_tracked=("LightGBM", "LightGBM::challenger"),
        expected_artifact_versions={"LightGBM": "vNew"}, expected_artifact_identities={})
    stripped = {name: {k: v for k, v in info.items() if k != "ic_by_version"} for name, info in per_model.items()}

    assert per_model["LightGBM"]["ic_by_version"]["vOld"]["status"] == "computed"
    with_track = _live_gate_decision(model_name="LightGBM", per_model_ic=per_model, min_samples=4)
    without = _live_gate_decision(model_name="LightGBM", per_model_ic=stripped, min_samples=4)
    assert with_track == without
    assert with_track["metrics"]["production_ic"] is None
