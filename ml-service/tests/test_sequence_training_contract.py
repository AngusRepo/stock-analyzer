import numpy as np

from app.sequence_training import (
    CANONICAL_ROUNDTRIP_COST_BPS,
    build_sequence_cpcv_evidence,
    sequence_cpcv_policy_enabled,
    build_sequence_record,
    build_sequence_window_dataset,
    mean_daily_spearman_ic,
)
from app.neuralforecast_sequence_runtime import default_seq_len_for_model


def test_sequence_record_requires_symbol_dates_and_positive_close():
    prices = [
        {"date": f"2026-04-{day:02d}", "open": 99 + day, "close": 100 + day}
        for day in range(1, 71)
    ]
    record = build_sequence_record(
        symbol="2330",
        market_type="TWSE",
        prices_data=prices,
        min_len=65,
    )
    assert record is not None
    assert record["symbol"] == "2330"
    assert len(record["close"]) == len(record["open"]) == len(record["dates"]) == 70


def test_sequence_window_dataset_carries_lifecycle_metadata():
    records = []
    for idx, symbol in enumerate(["2330", "2317", "5871"]):
        records.append({
            "symbol": symbol,
            "market_type": "TWSE",
            "close": [100 + idx + day * 0.5 for day in range(80)],
            "open": [99.5 + idx + day * 0.5 for day in range(80)],
            "dates": [f"2026-03-{(day % 28) + 1:02d}" for day in range(80)],
        })

    dataset = build_sequence_window_dataset(records, seq_len=20, pred_len=5, oos_ratio=0.25)

    assert dataset.report["lifecycle_ready"] is True
    assert dataset.report["oos_windows"] > 0
    assert {"symbol", "asof_date", "target_date", "entry_open", "forward_return", "target_semantic_version"} <= set(dataset.meta[0].keys())
    assert dataset.meta[0]["forward_return"] == (
        dataset.meta[0]["target_close"] - dataset.meta[0]["entry_open"]
    ) / dataset.meta[0]["entry_open"] - CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
    assert dataset.X_train.shape[1] == 20
    assert dataset.y_oos.shape[1] == 5
    assert dataset.X_all.shape[1] == 20
    assert dataset.y_all.shape[1] == 5


def test_sequence_window_dataset_does_not_shift_across_missing_market_session():
    calendar = [f"2026-06-{day:02d}" for day in range(1, 31)]
    records = [
        {
            "symbol": "2330",
            "market_type": "TWSE",
            "close": [100.0 + day for day in range(30)],
            "open": [99.5 + day for day in range(30)],
            "dates": calendar,
        },
        {
            "symbol": "3665",
            "market_type": "TWSE",
            "close": [200.0 + day for day in range(29)],
            "open": [199.5 + day for day in range(29)],
            "dates": [date for date in calendar if date != "2026-06-22"],
        },
    ]

    dataset = build_sequence_window_dataset(records, seq_len=20, pred_len=5, oos_ratio=0.25)
    rows = {(row["symbol"], row["asof_date"]): row for row in dataset.meta}

    assert ("2330", "2026-06-21") in rows
    assert ("3665", "2026-06-21") not in rows
    assert dataset.report["dropped_session_gap"] > 0


def test_daily_sequence_ic_uses_cross_sectional_dates():
    ic = mean_daily_spearman_ic(
        predictions=np.array([0.3, 0.2, 0.1, 0.1, 0.2, 0.3]),
        actual_returns=np.array([0.03, 0.02, 0.01, 0.01, 0.02, 0.03]),
        target_dates=["2026-04-01"] * 3 + ["2026-04-02"] * 3,
    )
    assert ic["oos_ic"] == 1.0
    assert ic["daily_ic_count"] == 2
    assert ic["passed"] is True


def test_sequence_cpcv_evidence_uses_target_date_purged_splits():
    records = []
    for idx, symbol in enumerate(["2330", "2317", "5871", "2454"]):
        records.append({
            "symbol": symbol,
            "market_type": "TWSE",
            "close": [100 + idx * 5 + day * (0.2 + idx * 0.03) for day in range(120)],
            "open": [99.8 + idx * 5 + day * (0.2 + idx * 0.03) for day in range(120)],
            "dates": [f"2026-04-{(day % 30) + 1:02d}" for day in range(120)],
        })
    dataset = build_sequence_window_dataset(records, seq_len=20, pred_len=5, oos_ratio=0.25)
    seen: list[tuple[int, int]] = []

    def fit_predict(train_idx, test_idx):
        seen.append((len(train_idx), len(test_idx)))
        return np.asarray([dataset.meta[int(i)]["target_close"] for i in test_idx], dtype=float)

    evidence = build_sequence_cpcv_evidence(
        model="DLinear",
        dataset=dataset,
        fit_predict=fit_predict,
        n_groups=5,
        n_test_groups=2,
        embargo_days=1,
        min_train_groups=2,
        policy={"min_folds": 5, "min_test_rows": 20, "min_coverage": 0.8},
    )

    assert evidence["method"] == "purged_cpcv_sequence_rank_ic"
    assert evidence["model"] == "DLinear"
    assert evidence["folds"] == 10
    assert len(seen) == 10
    assert evidence["coverage_mean"] >= 0.8


def test_sequence_cpcv_evidence_can_describe_existing_oos_fold_without_retraining():
    records = []
    for idx, symbol in enumerate(["2330", "2317", "5871"]):
        records.append({
            "symbol": symbol,
            "market_type": "TWSE",
            "close": [100 + idx + day * 0.5 for day in range(80)],
            "open": [99.5 + idx + day * 0.5 for day in range(80)],
            "dates": [f"2026-05-{(day % 28) + 1:02d}" for day in range(80)],
        })
    dataset = build_sequence_window_dataset(records, seq_len=20, pred_len=5, oos_ratio=0.25)
    forecast_prices = np.asarray([dataset.meta[int(i)]["target_close"] for i in dataset.oos_index], dtype=float)

    from app.sequence_training import build_sequence_oos_fold_evidence

    evidence = build_sequence_oos_fold_evidence(
        model="PatchTST",
        dataset=dataset,
        forecast_prices=forecast_prices,
        policy={"min_folds": 1, "min_test_rows": 10, "min_coverage": 0.8},
    )

    assert evidence["method"] == "chronological_holdout_rank_ic"
    assert evidence["folds"] == 1
    assert evidence["model"] == "PatchTST"
    assert evidence["date_field"] == "target_date"
    assert evidence["decision"] == "FAIL"
    assert "sequence_temporal_refit_required" in evidence["failed_gates"]
    assert evidence["validation_design"]["refit_each_fold"] is False
    assert evidence["coverage_gate_value"] == 1.0
    assert evidence["coverage_gate_semantics"] == "predicted_rows_over_eligible_oos_windows"
    assert evidence["policy"]["coverage_mode"] == "sequence_window"


def test_sequence_cpcv_policy_requires_explicit_enable():
    assert sequence_cpcv_policy_enabled(None, "DLinear") is False
    assert sequence_cpcv_policy_enabled(
        {"family_adapters": {"DLinear": {"enabled": True}}},
        "DLinear",
    ) is True
    assert sequence_cpcv_policy_enabled(
        {"family_adapters": {"DLinear": {"enabled": True}}},
        "PatchTST",
    ) is False


def test_sequence_model_default_context_fits_finlab_three_year_artifact():
    assert default_seq_len_for_model("PatchTST") == 512
    assert default_seq_len_for_model("iTransformer") == 512
def test_sequence_spearman_constant_prediction_is_neutral():
    from app.sequence_training import _spearman_corr
    assert _spearman_corr(np.ones(8), np.arange(8, dtype=float)) == 0.0
