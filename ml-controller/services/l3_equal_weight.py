"""R33 fixed seven-model arithmetic. No fitting or availability reweighting.

Ranks belong to one caller-attested prediction pool. An unavailable model has
rank 0.5 and contributes exactly zero around the neutral rank coordinate.
The final cross-sectional z describes the stock, not a missing model's output.
"""
from __future__ import annotations

from datetime import date
import math

import numpy as np

from services.l4_distribution import digest

RECIPE = "r33-seven-model-equal-rank-neutral-missing-v1"
MODELS = ("LightGBM", "ExtraTrees", "TabM", "GNN", "TimeXer", "PatchTST", "iTransformer")
CALIBRATION_SCHEMA = "r33-seven-model-frozen-oof-linear-v1"


def combine(rows):
    """Average exactly seven ranks, preserving every input stock and mask."""
    if not rows or len({r["symbol"] for r in rows}) != len(rows):
        raise ValueError("r33_candidate_pool_empty_or_duplicate")
    ranks, missing = [], []
    for row in rows:
        values, unavailable = [], []
        for model in MODELS:
            flag = (row.get("availability") or {}).get(model)
            if flag not in (True, False, 0, 1) or flag is None:
                raise ValueError("r33_availability_not_attested:" + model)
            if not flag:
                values.append(0.5)
                unavailable.append(model)
                continue
            value = (row.get("ranks") or {}).get(model)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("r33_available_rank_invalid:" + model)
            values.append(float(value))
        ranks.append(values)
        missing.append(unavailable)
    matrix = np.asarray(ranks, dtype=float)
    score = matrix.mean(axis=1)
    centered = score - score.mean()
    std = float(score.std(ddof=0))
    if std <= 0:
        raise ValueError("r33_pool_no_score_dispersion")
    return [dict(symbol=row["symbol"], rank_score=float(score[i]),
                 centered_rank=float(centered[i]), z=float(centered[i] / std),
                 missing_models=missing[i], effective_ranks=dict(zip(MODELS, ranks[i])),
                 neutral_rank_contributions=dict(zip(MODELS, (matrix[i] - 0.5).tolist())))
            for i, row in enumerate(rows)]


def fit_calibration(days, *, source_sha256, pool_contract, signal_date_max, label_known_at_max):
    """OOF daily-equal centered OLS; this never trains any base model.

    Every day supplies its complete pool. The caller must bind the real source
    receipts and ancestor proof before this diagnostic becomes a release.
    """
    if (not isinstance(source_sha256, str) or len(source_sha256) != 64
            or any(c not in "0123456789abcdef" for c in source_sha256) or not pool_contract):
        raise ValueError("r33_calibration_source_missing")
    date.fromisoformat(signal_date_max)
    date.fromisoformat(label_known_at_max)
    if signal_date_max >= label_known_at_max:
        raise ValueError("r33_calibration_cutoff_invalid")
    numerator = denominator = 0.
    seen = set()
    source_rows = []
    for day in days:
        day_date = day["date"]
        date.fromisoformat(day_date)
        if day_date in seen or day_date > signal_date_max:
            raise ValueError("r33_calibration_dates_invalid")
        seen.add(day_date)
        rows = day["rows"]
        scores = combine(rows)
        if any(r.get("prediction_kind") != "oof" or not day_date < r["label_known_date"] <= label_known_at_max for r in rows):
            raise ValueError("r33_calibration_requires_cutoff_oof")
        for row in rows:
            date.fromisoformat(row["label_known_date"])
        y = np.asarray([r["gross_return"] for r in rows], dtype=float)
        if not np.isfinite(y).all():
            raise ValueError("r33_calibration_labels_invalid")
        x = np.asarray([r["centered_rank"] for r in scores])
        numerator += float(np.mean(x * (y - y.mean())))
        denominator += float(np.mean(x ** 2))
        source_rows.extend(dict(date=day_date, symbol=r["symbol"], ranks=s["effective_ranks"],
                                missing_models=s["missing_models"], gross_return=r["gross_return"],
                                label_known_date=r["label_known_date"])
                           for r, s in zip(rows, scores, strict=True))
    if not seen or denominator <= 0:
        raise ValueError("r33_calibration_no_usable_dates")
    result = dict(schema_version=CALIBRATION_SCHEMA, recipe=RECIPE, model_order=list(MODELS),
                  missing_rank=0.5, denominator_models=7, linear_b=numerator / denominator,
                  method="daily_equal_centered_OLS_no_intercept", source_sha256=source_sha256,
                  input_records_checksum=digest(sorted(source_rows, key=lambda r: (r["date"], r["symbol"]))),
                  pool_contract=pool_contract, dates=sorted(seen), rows=len(source_rows),
                  signal_date_max=signal_date_max, label_known_at_max=label_known_at_max,
                  expected_return_semantic="five_session_relative_pool_decimal",
                  application="linear_b_times_daily_pool_centered_equal7_rank",
                  outer_updates_allowed=False, diagnostic_only=True)
    return {**result, "checksum": digest(result)}


def validate_calibration(calibration, *, signal_date, pool_contract):
    """Validate metadata without manufacturing sample inference rows."""
    body = {k: v for k, v in calibration.items() if k != "checksum"}
    if (calibration.get("checksum") != digest(body)
            or calibration.get("schema_version") != CALIBRATION_SCHEMA
            or calibration.get("recipe") != RECIPE or calibration.get("model_order") != list(MODELS)
            or calibration.get("missing_rank") != 0.5 or calibration.get("denominator_models") != 7
            or calibration.get("expected_return_semantic") != "five_session_relative_pool_decimal"
            or calibration.get("application") != "linear_b_times_daily_pool_centered_equal7_rank"
            or calibration.get("pool_contract") != pool_contract
            or calibration.get("outer_updates_allowed") is not False):
        raise ValueError("r33_calibration_identity_mismatch")
    if date.fromisoformat(calibration["label_known_at_max"]) >= date.fromisoformat(signal_date):
        raise ValueError("r33_calibration_not_known_before_signal")
    slope = calibration.get("linear_b")
    if isinstance(slope, bool) or not isinstance(slope, (int, float)) or not math.isfinite(slope) or slope <= 0:
        raise ValueError("r33_calibration_cannot_reverse_rank")
    return slope


def calibrated_scores(rows, *, calibration, signal_date, pool_contract):
    """Only the exact frozen recipe and pool semantics can apply the slope."""
    slope = validate_calibration(calibration, signal_date=signal_date, pool_contract=pool_contract)
    return [{**row, "expected_return": float(slope * row["centered_rank"]),
             "output_is_net_of_costs": False, "horizon_sessions": 5,
             "expected_return_semantic": calibration["expected_return_semantic"],
             "calibration_checksum": calibration["checksum"]} for row in combine(rows)]
