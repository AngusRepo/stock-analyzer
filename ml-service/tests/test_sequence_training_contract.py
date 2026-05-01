import numpy as np

from app.sequence_training import (
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


def test_daily_sequence_ic_uses_cross_sectional_dates():
    ic = mean_daily_spearman_ic(
        predictions=np.array([0.3, 0.2, 0.1, 0.1, 0.2, 0.3]),
        actual_returns=np.array([0.03, 0.02, 0.01, 0.01, 0.02, 0.03]),
        target_dates=["2026-04-01"] * 3 + ["2026-04-02"] * 3,
    )
    assert ic["oos_ic"] == 1.0
    assert ic["daily_ic_count"] == 2
    assert ic["passed"] is True
