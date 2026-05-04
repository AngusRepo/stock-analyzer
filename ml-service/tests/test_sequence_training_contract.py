import numpy as np

from app.sequence_training import (
    build_sequence_cpcv_evidence,
    sequence_cpcv_policy_enabled,
    build_sequence_record,
    build_sequence_window_dataset,
    mean_daily_spearman_ic,
)


def test_sequence_record_requires_symbol_dates_and_positive_close():
    prices = [
        {"date": f"2026-04-{day:02d}", "close": 100 + day}
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
    assert len(record["close"]) == len(record["dates"]) == 70


def test_sequence_window_dataset_carries_lifecycle_metadata():
    records = []
    for idx, symbol in enumerate(["2330", "2317", "5871"]):
        records.append({
            "symbol": symbol,
            "market_type": "TWSE",
            "close": [100 + idx + day * 0.5 for day in range(80)],
            "dates": [f"2026-03-{(day % 28) + 1:02d}" for day in range(80)],
        })

    dataset = build_sequence_window_dataset(records, seq_len=20, pred_len=5, oos_ratio=0.25)

    assert dataset.report["lifecycle_ready"] is True
    assert dataset.report["oos_windows"] > 0
    assert {"symbol", "asof_date", "target_date", "forward_return"} <= set(dataset.meta[0].keys())
    assert dataset.X_train.shape[1] == 20
    assert dataset.y_oos.shape[1] == 5
    assert dataset.X_all.shape[1] == 20
    assert dataset.y_all.shape[1] == 5


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

    assert evidence["method"] == "sequence_oos_fold_rank_ic"
    assert evidence["folds"] == 1
    assert evidence["model"] == "PatchTST"
    assert evidence["date_field"] == "target_date"


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
