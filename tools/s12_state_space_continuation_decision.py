"""Build the canonical local decision receipt from post-exit samples."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


REPO_ROOT = Path(__file__).resolve().parents[1]
INPUT = REPO_ROOT / "output/s12_state_space_post_exit_validation/post_exit_samples_reliable.parquet"
OUTPUT = REPO_ROOT / "output/s12_state_space_post_exit_validation/decision_report.json"
Z90 = 1.6448536269514722


def _cluster(values: list[float]) -> dict[str, Any]:
    array = np.asarray(values, dtype=np.float64)
    mean = float(array.mean())
    return {
        "dates": int(array.size),
        "mean": mean,
        "lcb90": mean - Z90 * float(array.std(ddof=1) / math.sqrt(array.size)),
    }


def _date_means(frame: pl.DataFrame, column: str) -> list[float]:
    return [
        float(frame.filter(pl.col("signal_date") == day)[column].mean())
        for day in sorted(frame["signal_date"].unique().to_list())
    ]


def main() -> int:
    frame = pl.read_parquet(INPUT).filter(
        pl.col("continuation_60m").is_not_null() & pl.col("post_exit_mae_60m").is_not_null()
    )
    frame = frame.with_columns(
        ((pl.col("exit_price") * (1 + pl.col("post_exit_mae_60m"))) <= pl.col("entry_price"))
        .alias("breach_breakeven")
    ).with_columns(
        pl.when(pl.col("breach_breakeven"))
        .then(pl.col("entry_price") / pl.col("exit_price") - 1)
        .otherwise(pl.col("continuation_60m"))
        .alias("breakeven_stop_delta")
    )
    dates = sorted(frame["signal_date"].unique().to_list())
    cut = len(dates) // 2

    lower_bound: dict[str, Any] = {}
    for name, subset in (
        ("all", frame),
        ("state_positive", frame.filter(pl.col("forecast_positive"))),
        ("state_non_positive", frame.filter(~pl.col("forecast_positive"))),
    ):
        values = subset["breakeven_stop_delta"].to_numpy()
        lower_bound[name] = {
            "rows": subset.height,
            "breakeven_breach_rate": float(subset["breach_breakeven"].mean()),
            "mean_delta_last_tranche": float(values.mean()),
            "median_delta_last_tranche": float(np.median(values)),
            "positive_rate": float(np.mean(values > 0)),
            "p10": float(np.quantile(values, 0.10)),
            "date_cluster": _cluster(_date_means(subset, "breakeven_stop_delta")),
        }

    chronological: dict[str, Any] = {}
    for name, selected_dates in (("early", dates[:cut]), ("late", dates[cut:])):
        subset = frame.filter(pl.col("signal_date").is_in(selected_dates))
        chronological[name] = {
            "start": selected_dates[0],
            "end": selected_dates[-1],
            "rows": subset.height,
            "dates": len(selected_dates),
            "breakeven_60m": _cluster(_date_means(subset, "breakeven_stop_delta")),
            "raw_60m": _cluster(_date_means(subset, "continuation_60m")),
        }

    features = ["up_probability", "forecast_variance", "innovation_z"]
    oof_rows: list[dict[str, float | str]] = []
    for index in range(10, len(dates)):
        train_dates = dates[: max(0, index - 5)]
        if len(train_dates) < 5:
            continue
        test_date = dates[index]
        train = frame.filter(pl.col("signal_date").is_in(train_dates))
        test = frame.filter(pl.col("signal_date") == test_date)
        model = make_pipeline(StandardScaler(), LinearRegression()).fit(
            train.select(features).to_numpy(), train["breakeven_stop_delta"].to_numpy()
        )
        predictions = model.predict(test.select(features).to_numpy())
        baseline = float(train["breakeven_stop_delta"].mean())
        for prediction, realized in zip(predictions, test["breakeven_stop_delta"].to_numpy(), strict=True):
            oof_rows.append(
                {"signal_date": test_date, "prediction": float(prediction), "baseline": baseline, "realized": float(realized)}
            )
    oof = pl.DataFrame(oof_rows)
    realized = oof["realized"].to_numpy()
    predictions = oof["prediction"].to_numpy()
    baseline = oof["baseline"].to_numpy()
    oof_report = {
        "rows": oof.height,
        "dates": oof["signal_date"].n_unique(),
        "embargo_sessions": 5,
        "features": features,
        "model_pearson": float(np.corrcoef(predictions, realized)[0, 1]),
        "model_mse": float(np.mean((realized - predictions) ** 2)),
        "baseline_mse": float(np.mean((realized - baseline) ** 2)),
        "oos_r2_vs_expanding_mean": float(
            1 - np.sum((realized - predictions) ** 2) / np.sum((realized - baseline) ** 2)
        ),
        "model_sign_accuracy": float(np.mean((predictions > 0) == (realized > 0))),
        "baseline_sign_accuracy": float(np.mean((baseline > 0) == (realized > 0))),
    }

    source_report = json.loads(
        (OUTPUT.parent / "report_reliable.json").read_text(encoding="utf-8")
    )
    spread_lcb = float(
        source_report["horizons"]["continuation_60m"]
        ["positive_minus_non_positive_date_spread"]["lcb90"]
    )
    next_session_lcb = float(
        source_report["horizons"]["continuation_next_session_close"]
        ["positive_date_mean_lcb90"]["lcb90"]
    )
    receipt = {
        "schema_version": "state-space-s12-continuation-decision-v1",
        "rank_or_top_k_used": False,
        "formal_production_effect": False,
        "coverage": {
            "profit_exit_outcomes": source_report["source_receipt"]["profit_exit_outcomes"],
            "post_exit_samples": source_report["rows"],
            "post_exit_dates": source_report["dates"],
            "artifacts": source_report["source_receipt"]["artifacts_downloaded"],
            "download_errors": len(source_report["source_receipt"]["download_errors"]),
        },
        "incumbent_exit_extension_evidence": {
            "raw_horizons": source_report["horizons"],
            "breakeven_stop_60m_lower_bound": lower_bound,
            "chronological_holdout": chronological,
        },
        "state_space_incremental_oos": oof_report,
        "decision": {
            "state_space_exit_owner_qualified": False,
            "state_space_blockers": [
                f"60m_positive_vs_non_positive_spread_lcb90={spread_lcb:.12f}<=0",
                f"next_session_positive_continuation_lcb90={next_session_lcb:.12f}<=0",
                f"purged_oos_r2={oof_report['oos_r2_vs_expanding_mean']:.12f}<=0",
                f"model_mse={oof_report['model_mse']:.12f}>=baseline_mse={oof_report['baseline_mse']:.12f}",
            ],
            "s12_profit_exit_extension_candidate": True,
            "candidate_reason": (
                "Existing TP exits show positive intraday continuation and the incumbent breakeven-stop 60m lower bound "
                "is positive in both chronological halves; exact structure-stop/reverse-BOS/tranche replay remains required."
            ),
        },
        "source_checksums": {
            "input": source_report["source_receipt"]["input_checksum"],
            "manifests": source_report["source_receipt"]["selected_manifest_checksum"],
        },
    }
    canonical = json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    receipt["receipt_checksum"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    OUTPUT.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps(receipt, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
