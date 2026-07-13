from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import d1_client  # noqa: E402
from services.l4_alpha_ev_artifact_builder import (  # noqa: E402
    FEATURE_NAMES,
    LABEL_PURGE_DATE_GROUPS,
    _corr,
    _fit_ridge,
    _metrics,
    _samples,
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 8) if math.isfinite(value) else None
    return value


def build_audit(
    *,
    end_date: str,
    knowledge_cutoff_date: str,
    lookback_days: int,
    limit: int,
    l2: float,
) -> dict[str, Any]:
    rows = load_l4_alpha_ev_training_rows(
        d1_client.query,
        end_date=end_date,
        knowledge_cutoff_date=knowledge_cutoff_date,
        lookback_days=lookback_days,
        limit=limit,
    )
    result = build_l4_alpha_ev_artifact_from_rows(
        rows,
        trained_until=end_date,
        lookback_days=lookback_days,
        min_samples=500,
        min_dates=20,
        l2=l2,
        fit_min_samples=100,
        fit_min_dates=5,
    )
    samples, diagnostics = _samples(rows)
    dates = sorted({str(sample["date"]) for sample in samples})
    split_idx = max(1, round(len(dates) * 0.8)) if dates else 0
    train_dates = set(dates[:max(0, split_idx - LABEL_PURGE_DATE_GROUPS)])
    test_dates = set(dates[split_idx:])
    train = [sample for sample in samples if sample["date"] in train_dates]
    test = [sample for sample in samples if sample["date"] in test_dates]

    feature_train: dict[str, Any] = {}
    feature_oos: dict[str, Any] = {}
    for feature_name in FEATURE_NAMES:
        coefs = {name: 1.0 if name == feature_name else 0.0 for name in FEATURE_NAMES}
        feature_train[feature_name] = _metrics(train, 0.0, coefs)
        feature_oos[feature_name] = _metrics(test, 0.0, coefs)

    feature_corr: dict[str, dict[str, float | None]] = {}
    for left in FEATURE_NAMES:
        feature_corr[left] = {}
        for right in FEATURE_NAMES:
            value = _corr(
                [float(sample["features"][left]) for sample in train],
                [float(sample["features"][right]) for sample in train],
            )
            feature_corr[left][right] = None if value is None else round(value, 8)

    target_by_date: dict[str, list[float]] = defaultdict(list)
    for sample in samples:
        target_by_date[str(sample["date"])].append(float(sample["target"]))
    date_targets = {
        day: {
            "samples": len(values),
            "mean": round(sum(values) / len(values), 8),
            "positive_rate": round(sum(value > 0 for value in values) / len(values), 8),
        }
        for day, values in sorted(target_by_date.items())
    }

    validation_fit: dict[str, Any] = {"performed": False}
    if train and test:
        intercept, coefficients = _fit_ridge(train, l2=l2)
        validation_fit = {
            "performed": True,
            "intercept": round(intercept, 10),
            "coefficients": {name: round(value, 10) for name, value in coefficients.items()},
            "train_metrics": _metrics(train, intercept, coefficients),
            "oos_metrics": _metrics(test, intercept, coefficients),
        }

    return {
        "schema_version": "l4-oos-attribution-audit-v1",
        "end_date": end_date,
        "knowledge_cutoff_date": knowledge_cutoff_date,
        "lookback_days": lookback_days,
        "label_schema_version": result["artifact"]["label_schema_version"],
        "sample_audit": diagnostics,
        "date_split": {
            "all_dates": dates,
            "train_dates": sorted(train_dates),
            "purged_dates": dates[max(0, split_idx - LABEL_PURGE_DATE_GROUPS):split_idx],
            "oos_dates": sorted(test_dates),
        },
        "target_by_date": date_targets,
        "feature_train_correlation": feature_corr,
        "feature_train_standalone_metrics": feature_train,
        "feature_oos_standalone_metrics": feature_oos,
        "validation_fit": validation_fit,
        "artifact_validation": result["validation_packet"],
        "artifact_coefficients_full_refit": result["artifact"]["coefficients"],
        "status": result["status"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit L4 clean-label OOS attribution")
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--knowledge-cutoff-date", required=True)
    parser.add_argument("--lookback-days", type=int, default=90)
    parser.add_argument("--limit", type=int, default=12000)
    parser.add_argument("--l2", type=float, default=0.25)
    args = parser.parse_args()
    print(json.dumps(build_audit(
        end_date=args.end_date,
        knowledge_cutoff_date=args.knowledge_cutoff_date,
        lookback_days=args.lookback_days,
        limit=args.limit,
        l2=args.l2,
    ), ensure_ascii=False, indent=2, sort_keys=True, default=_round))


if __name__ == "__main__":
    main()
