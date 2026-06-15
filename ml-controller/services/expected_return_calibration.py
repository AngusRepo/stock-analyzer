from __future__ import annotations

import json
from typing import Any, Callable


def _to_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


def _monotonic_smooth_return_bins(bins: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pool adjacent return bins so higher rank never maps to lower return."""
    blocks: list[dict[str, Any]] = []
    for idx, row in enumerate(bins):
        samples = max(1, int(row.get("samples") or 1))
        mean_return = float(row.get("meanReturn") or 0.0)
        blocks.append({
            "weight": samples,
            "sum": mean_return * samples,
            "items": [idx],
        })
        while len(blocks) >= 2:
            left = blocks[-2]
            right = blocks[-1]
            left_mean = left["sum"] / left["weight"]
            right_mean = right["sum"] / right["weight"]
            if left_mean <= right_mean:
                break
            merged = {
                "weight": left["weight"] + right["weight"],
                "sum": left["sum"] + right["sum"],
                "items": left["items"] + right["items"],
            }
            blocks[-2:] = [merged]

    smoothed = [dict(row) for row in bins]
    for block in blocks:
        pooled_mean = block["sum"] / block["weight"]
        for idx in block["items"]:
            smoothed[idx]["meanReturn"] = round(pooled_mean, 6)
            smoothed[idx]["monotonicSmoothed"] = len(block["items"]) > 1
    return smoothed


def build_expected_return_calibration_from_rows(
    rows: list[dict[str, Any]],
    *,
    lookback_days: int = 90,
    min_samples: int = 30,
    min_bin_samples: int = 8,
    max_bins: int = 8,
) -> dict[str, Any]:
    samples: list[tuple[float, float]] = []
    invalid_rows = 0
    missing_avg_rank = 0
    missing_actual = 0

    for row in rows or []:
        try:
            payload = json.loads(row.get("forecast_data") or "{}")
        except (TypeError, json.JSONDecodeError):
            invalid_rows += 1
            continue
        avg_rank = _to_float((payload.get("ensemble_v2") or {}).get("avg_rank"))
        actual = _to_float(row.get("actual_return_pct"))
        if avg_rank is None:
            missing_avg_rank += 1
            continue
        if actual is None:
            missing_actual += 1
            continue
        if not (0.0 <= avg_rank <= 1.0) or not (-1.0 < actual < 1.0):
            invalid_rows += 1
            continue
        samples.append((avg_rank, actual))

    report: dict[str, Any] = {
        "status": "insufficient_samples",
        "source": "verified_ensemble_outcomes",
        "method": "empirical_rank_bins_monotonic",
        "lookbackDays": int(lookback_days),
        "minSamples": int(min_samples),
        "minBinSamples": int(min_bin_samples),
        "maxBins": int(max_bins),
        "rowCount": len(rows or []),
        "sampleCount": len(samples),
        "missingAvgRankCount": missing_avg_rank,
        "missingActualReturnCount": missing_actual,
        "invalidRowCount": invalid_rows,
        "calibration": None,
    }
    if len(samples) < min_samples:
        return report

    samples.sort(key=lambda item: item[0])
    bin_count = max(1, min(max_bins, len(samples) // max(1, min_bin_samples)))
    bins: list[dict[str, Any]] = []
    for idx in range(bin_count):
        start = round(idx * len(samples) / bin_count)
        end = round((idx + 1) * len(samples) / bin_count)
        subset = samples[start:end]
        if len(subset) < min_bin_samples:
            continue
        returns = sorted(actual for _, actual in subset)
        mean_return = sum(returns) / len(returns)
        median_return = returns[len(returns) // 2]
        bins.append({
            "rankLow": round(subset[0][0], 6),
            "rankHigh": round(subset[-1][0], 6),
            "meanReturn": round(mean_return, 6),
            "medianReturn": round(median_return, 6),
            "samples": len(subset),
        })

    if not bins:
        report["status"] = "insufficient_bin_samples"
        return report

    calibration = {
        "source": "verified_ensemble_outcomes",
        "method": "empirical_rank_bins_monotonic",
        "lookbackDays": int(lookback_days),
        "minSamples": int(min_samples),
        "minBinSamples": int(min_bin_samples),
        "sampleCount": len(samples),
        "status": "loaded",
        "bins": _monotonic_smooth_return_bins(bins),
    }
    report.update({
        "status": "loaded",
        "binCount": len(calibration["bins"]),
        "calibration": calibration,
    })
    return report


def load_expected_return_calibration_report(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    lookback_days: int = 90,
    min_samples: int = 30,
    min_bin_samples: int = 8,
    max_bins: int = 8,
) -> dict[str, Any]:
    try:
        rows = query_fn(
            """
            SELECT forecast_data, actual_return_pct
              FROM predictions
             WHERE model_name = 'ensemble'
               AND verified_at IS NOT NULL
               AND actual_return_pct IS NOT NULL
               AND forecast_data IS NOT NULL
               AND date(prediction_date) >= date('now', ?)
             ORDER BY prediction_date DESC
             LIMIT 2000
            """,
            [f"-{max(1, int(lookback_days))} days"],
        )
    except Exception as exc:  # noqa: BLE001 - calibration must report fail-closed cause.
        return {
            "status": "query_error",
            "source": "verified_ensemble_outcomes",
            "method": "empirical_rank_bins_monotonic",
            "lookbackDays": int(lookback_days),
            "minSamples": int(min_samples),
            "minBinSamples": int(min_bin_samples),
            "maxBins": int(max_bins),
            "rowCount": 0,
            "sampleCount": 0,
            "calibration": None,
            "error": str(exc)[:240],
        }

    return build_expected_return_calibration_from_rows(
        rows or [],
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_bin_samples=min_bin_samples,
        max_bins=max_bins,
    )
