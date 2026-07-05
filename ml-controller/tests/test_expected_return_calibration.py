from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.expected_return_calibration import (  # noqa: E402
    build_expected_return_calibration_from_rows,
    load_expected_return_calibration_report,
)


def _row(
    avg_rank: float | None,
    actual_return_pct: float | None,
    prediction_date: str = "2026-07-01",
) -> dict[str, object]:
    forecast_data = {}
    if avg_rank is not None:
        forecast_data = {"ensemble_v2": {"avg_rank": avg_rank}}
    return {
        "forecast_data": json.dumps(forecast_data),
        "actual_return_pct": actual_return_pct,
        "prediction_date": prediction_date,
    }


def test_build_expected_return_calibration_from_verified_rows():
    rows = [
        _row(0.20 + idx * 0.015, -0.03 + idx * 0.002)
        for idx in range(40)
    ]

    report = build_expected_return_calibration_from_rows(
        rows,
        lookback_days=60,
        min_samples=30,
        min_bin_samples=8,
        max_bins=4,
    )

    assert report["status"] == "loaded"
    assert report["sampleCount"] == 40
    assert report["binCount"] == 4
    assert report["calibration"]["status"] == "loaded"
    assert report["calibration"]["minSamples"] == 30
    assert report["calibration"]["minBinSamples"] == 8
    assert len(report["calibration"]["bins"]) == 4


def test_build_expected_return_calibration_reports_missing_and_invalid_rows():
    rows = [
        _row(None, 0.02),
        _row(0.7, None),
        {"forecast_data": "{not-json", "actual_return_pct": 0.01},
        _row(1.2, 0.01),
        _row(0.8, 2.0),
    ]

    report = build_expected_return_calibration_from_rows(rows, min_samples=30)

    assert report["status"] == "insufficient_samples"
    assert report["sampleCount"] == 0
    assert report["missingAvgRankCount"] == 1
    assert report["missingActualReturnCount"] == 1
    assert report["invalidRowCount"] == 3
    assert report["calibration"] is None


def test_load_expected_return_calibration_report_uses_verified_ensemble_query():
    calls: list[tuple[str, list[object]]] = []

    def query_fn(sql: str, params: list[object]) -> list[dict[str, object]]:
        calls.append((sql, params))
        return [
            _row(0.20 + idx * 0.015, -0.03 + idx * 0.002, "2026-07-01")
            for idx in range(40)
        ]

    report = load_expected_return_calibration_report(query_fn, lookback_days=45)

    assert report["status"] == "loaded"
    assert len(calls) == 1
    sql, params = calls[0]
    assert "verified_at IS NOT NULL" in sql
    assert "actual_return_pct IS NOT NULL" in sql
    assert "forecast_data IS NOT NULL" in sql
    assert "date(prediction_date) AS prediction_date" in sql
    assert params == ["-45 days"]


def test_load_expected_return_calibration_report_fails_closed_on_query_error():
    def query_fn(_sql: str, _params: list[object]) -> list[dict[str, object]]:
        raise RuntimeError("d1 unavailable")

    report = load_expected_return_calibration_report(query_fn)

    assert report["status"] == "query_error"
    assert report["sampleCount"] == 0
    assert report["calibration"] is None
    assert "d1 unavailable" in report["error"]


def test_build_expected_return_calibration_excludes_all_zero_verified_days():
    good_rows = [
        _row(0.20 + idx * 0.015, -0.03 + idx * 0.002, "2026-07-02")
        for idx in range(40)
    ]
    zero_day = [_row(0.50 + idx * 0.001, 0.0, "2026-06-29") for idx in range(30)]

    report = build_expected_return_calibration_from_rows(
        [*zero_day, *good_rows],
        min_samples=30,
        min_bin_samples=8,
        max_bins=4,
    )

    assert report["status"] == "loaded"
    assert report["sampleCount"] == 40
    assert report["excludedZeroReturnDayCount"] == 1
    assert report["excludedZeroReturnRowCount"] == 30
    assert report["excludedZeroReturnDates"] == ["2026-06-29"]


def test_build_expected_return_calibration_fails_closed_when_bins_are_low_resolution():
    rows = [
        _row(0.20 + idx * 0.015, 0.001, "2026-07-02")
        for idx in range(40)
    ]

    report = build_expected_return_calibration_from_rows(
        rows,
        min_samples=30,
        min_bin_samples=8,
        max_bins=4,
    )

    assert report["status"] == "low_resolution"
    assert report["calibration"] is None
    assert report["calibrationCandidate"]["status"] == "loaded"
    assert "low_unique_forecast_bins" in report["quality"]["blockers"]
