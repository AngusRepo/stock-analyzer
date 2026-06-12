from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "timesfm_migration_benchmark.py"
SPEC = importlib.util.spec_from_file_location("timesfm_migration_benchmark", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)


def test_timesfm_migration_metrics_include_error_coverage_and_extremes():
    rows = [
        {
            "forecast_price": 102.0,
            "actual_price": 100.0,
            "pred_return": 0.02,
            "actual_return": 0.00,
            "covered_p10_p90": True,
            "quantile_crossed": False,
        },
        {
            "forecast_price": 99.0,
            "actual_price": 110.0,
            "pred_return": -0.01,
            "actual_return": 0.10,
            "covered_p10_p90": False,
            "quantile_crossed": False,
        },
    ]
    quantiles = np.asarray([[[100.0, 95.0, 96.0, 97.0, 98.0, 99.0, 101.0, 102.0, 103.0, 105.0]]])

    metrics = bench._metrics(rows, quantiles=quantiles)

    assert metrics["price_mae"] == 6.5
    assert metrics["price_rmse"] > metrics["price_mae"]
    assert metrics["price_mape"] is not None
    assert metrics["price_smape"] is not None
    assert metrics["return_p90_abs_error"] is not None
    assert metrics["extreme_count"] == 1
    assert metrics["p10_p90_coverage"] == 0.5
    assert metrics["p10_p90_crossing_rate"] == 0.0
    assert metrics["quantile_monotonic_violation_rate"] == 0.0


def test_timesfm_migration_compare_requires_same_batch_alignment():
    base_context = {
        "context_len": 256,
        "status": "available",
        "metrics": {"oos_ic": 0.1, "price_mae": 1.0},
    }
    before = {
        "candidate_id": "TimesFM",
        "model_id": "google/timesfm-2.0-500m-pytorch",
        "contexts": [base_context],
        "row_evidence": [{"context_len": 256, "symbol": "2330", "asof_date": "2026-01-01", "target_date": "2026-01-08"}],
    }
    after = {
        "candidate_id": "TimesFM25",
        "model_id": "google/timesfm-2.5-200m-pytorch",
        "contexts": [{**base_context, "metrics": {"oos_ic": 0.2, "price_mae": 0.8}}],
        "row_evidence": [{"context_len": 256, "symbol": "2330", "asof_date": "2026-01-01", "target_date": "2026-01-08"}],
    }

    comparison = bench.compare_reports(before, after)
    row = comparison["contexts"][0]

    assert row["delta_oos_ic"] == 0.1
    assert row["delta_price_mae"] == -0.2
    assert row["row_alignment"]["same_batch"] is True
