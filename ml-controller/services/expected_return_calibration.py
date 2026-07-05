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


def _row_date(row: dict[str, Any]) -> str | None:
    for key in ("prediction_date", "date", "run_date"):
        raw = row.get(key)
        if raw is None:
            continue
        text = str(raw).strip()
        if text:
            return text[:10]
    return None


def _pearson_corr(pairs: list[tuple[float, float]]) -> float | None:
    if len(pairs) < 3:
        return None
    xs = [item[0] for item in pairs]
    ys = [item[1] for item in pairs]
    x_mean = sum(xs) / len(xs)
    y_mean = sum(ys) / len(ys)
    x_var = sum((value - x_mean) ** 2 for value in xs)
    y_var = sum((value - y_mean) ** 2 for value in ys)
    if x_var <= 0 or y_var <= 0:
        return None
    cov = sum((x - x_mean) * (y - y_mean) for x, y in pairs)
    return cov / ((x_var * y_var) ** 0.5)


def _calibration_quality(
    *,
    bins: list[dict[str, Any]],
    smoothed_bins: list[dict[str, Any]],
    samples: list[tuple[float, float]],
    min_unique_mean_returns: int,
    min_top_bottom_spread: float,
) -> dict[str, Any]:
    means = [float(row.get("meanReturn") or 0.0) for row in smoothed_bins]
    raw_means = [float(row.get("meanReturn") or 0.0) for row in bins]
    unique_mean_returns = len({round(value, 6) for value in means})
    top_bottom_spread = means[-1] - means[0] if len(means) >= 2 else 0.0
    raw_top_bottom_spread = raw_means[-1] - raw_means[0] if len(raw_means) >= 2 else 0.0
    corr = _pearson_corr(samples)
    smoothed_bin_count = sum(1 for row in smoothed_bins if row.get("monotonicSmoothed"))
    blockers: list[str] = []
    if unique_mean_returns < min_unique_mean_returns:
        blockers.append("low_unique_forecast_bins")
    if top_bottom_spread < min_top_bottom_spread:
        blockers.append("low_top_bottom_spread")
    if corr is not None and corr < 0.0:
        blockers.append("negative_rank_return_correlation")
    if smoothed_bin_count >= max(1, len(smoothed_bins) // 2):
        blockers.append("excessive_monotonic_pooling")
    return {
        "status": "ok" if not blockers else "low_resolution",
        "blockers": blockers,
        "uniqueMeanReturnCount": unique_mean_returns,
        "minUniqueMeanReturnCount": min_unique_mean_returns,
        "topBottomSpread": round(top_bottom_spread, 6),
        "rawTopBottomSpread": round(raw_top_bottom_spread, 6),
        "minTopBottomSpread": round(min_top_bottom_spread, 6),
        "rankReturnCorrelation": None if corr is None else round(corr, 6),
        "monotonicSmoothedBinCount": smoothed_bin_count,
    }


def build_expected_return_calibration_from_rows(
    rows: list[dict[str, Any]],
    *,
    lookback_days: int = 90,
    min_samples: int = 30,
    min_bin_samples: int = 8,
    max_bins: int = 8,
    min_unique_mean_returns: int = 4,
    min_top_bottom_spread: float = 0.001,
    zero_return_day_min_samples: int = 20,
) -> dict[str, Any]:
    samples: list[tuple[float, float]] = []
    invalid_rows = 0
    missing_avg_rank = 0
    missing_actual = 0
    parsed_by_date: dict[str, list[tuple[float, float]]] = {}

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
        row_key = _row_date(row) or "unknown"
        parsed_by_date.setdefault(row_key, []).append((avg_rank, actual))

    excluded_zero_dates: list[str] = []
    excluded_zero_rows = 0
    for row_key, date_samples in parsed_by_date.items():
        if (
            row_key != "unknown"
            and len(date_samples) >= zero_return_day_min_samples
            and all(abs(actual) <= 1e-12 for _, actual in date_samples)
        ):
            excluded_zero_dates.append(row_key)
            excluded_zero_rows += len(date_samples)
            continue
        samples.extend(date_samples)

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
        "excludedZeroReturnDayCount": len(excluded_zero_dates),
        "excludedZeroReturnRowCount": excluded_zero_rows,
        "excludedZeroReturnDates": excluded_zero_dates[:20],
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

    smoothed_bins = _monotonic_smooth_return_bins(bins)
    quality = _calibration_quality(
        bins=bins,
        smoothed_bins=smoothed_bins,
        samples=samples,
        min_unique_mean_returns=max(1, min(min_unique_mean_returns, len(smoothed_bins))),
        min_top_bottom_spread=max(0.0, float(min_top_bottom_spread)),
    )
    calibration = {
        "source": "verified_ensemble_outcomes",
        "method": "empirical_rank_bins_monotonic_5bar_close",
        "semantic": "forecast_return_5bar_not_trade_ev",
        "forecastHorizonBars": 5,
        "lookbackDays": int(lookback_days),
        "minSamples": int(min_samples),
        "minBinSamples": int(min_bin_samples),
        "sampleCount": len(samples),
        "status": "loaded",
        "bins": smoothed_bins,
        "rawBins": bins,
        "quality": quality,
    }
    if quality["status"] != "ok":
        report.update({
            "status": quality["status"],
            "binCount": len(calibration["bins"]),
            "calibration": None,
            "calibrationCandidate": calibration,
            "quality": quality,
        })
        return report
    report.update({
        "status": "loaded",
        "binCount": len(calibration["bins"]),
        "calibration": calibration,
        "quality": quality,
    })
    return report


def load_expected_return_calibration_report(
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]],
    *,
    lookback_days: int = 90,
    min_samples: int = 30,
    min_bin_samples: int = 8,
    max_bins: int = 8,
    min_unique_mean_returns: int = 4,
    min_top_bottom_spread: float = 0.001,
    zero_return_day_min_samples: int = 20,
) -> dict[str, Any]:
    try:
        rows = query_fn(
            """
            SELECT forecast_data, actual_return_pct, date(prediction_date) AS prediction_date
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
            "excludedZeroReturnDayCount": 0,
            "excludedZeroReturnRowCount": 0,
            "excludedZeroReturnDates": [],
            "calibration": None,
            "error": str(exc)[:240],
        }

    return build_expected_return_calibration_from_rows(
        rows or [],
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_bin_samples=min_bin_samples,
        max_bins=max_bins,
        min_unique_mean_returns=min_unique_mean_returns,
        min_top_bottom_spread=min_top_bottom_spread,
        zero_return_day_min_samples=zero_return_day_min_samples,
    )
