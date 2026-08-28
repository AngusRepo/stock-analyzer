"""Read-only promotion analysis for S12 native profit continuation.

This joins exact paired continuation deltas back to the complete current-semantic
S12 outcome cohort.  It separates conditional winner giveback from true
portfolio tail risk and never mutates production state.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from statistics import NormalDist
from typing import Any

import numpy as np
import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[1]
FULL_COHORT = REPO_ROOT / "output/s12_state_space_pit_validation/joined_evidence.parquet"
PAIRED_ROWS = REPO_ROOT / "output/s12_profit_continuation_full_cohort/paired_replay_rows.parquet"
PAIRED_REPORT = REPO_ROOT / "output/s12_profit_continuation_full_cohort/report.json"
OUTPUT = REPO_ROOT / "output/s12_profit_continuation_full_cohort/promotion_decision.json"
Z90 = NormalDist().inv_cdf(0.90)
BOOTSTRAP_SAMPLES = 50_000
BOOTSTRAP_SEED = 20_260_828
PROFIT_REASONS = {"tp1", "tp2", "tp3", "time_exit"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonicalize_numbers(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 12)
    if isinstance(value, list):
        return [canonicalize_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: canonicalize_numbers(item) for key, item in value.items()}
    return value


def lower_tail_mean(values: np.ndarray, fraction: float = 0.10) -> float:
    ordered = np.sort(values.astype(float, copy=False))
    count = max(1, math.ceil(ordered.size * fraction))
    return float(ordered[:count].mean())


def max_drawdown(values: np.ndarray) -> float:
    wealth = np.cumprod(1.0 + values.astype(float, copy=False))
    peaks = np.maximum.accumulate(wealth)
    return float(np.min(wealth / peaks - 1.0))


def lcb90(values: np.ndarray) -> dict[str, Any]:
    clean = values[np.isfinite(values)]
    if clean.size == 0:
        return {"n": 0, "mean": None, "lcb90": None}
    mean = float(clean.mean())
    lcb = None if clean.size == 1 else mean - Z90 * float(clean.std(ddof=1) / math.sqrt(clean.size))
    return {"n": int(clean.size), "mean": mean, "lcb90": lcb}


def date_frame(frame: pl.DataFrame) -> pl.DataFrame:
    return frame.group_by("signal_date").agg(
        pl.col("incumbent_net_pnl_pct").mean(),
        pl.col("candidate_net_pnl_pct").mean(),
        pl.col("incremental_delta_pct").mean(),
    ).sort("signal_date")


def portfolio_metrics(frame: pl.DataFrame) -> dict[str, Any]:
    dates = date_frame(frame)
    incumbent = dates["incumbent_net_pnl_pct"].to_numpy()
    candidate = dates["candidate_net_pnl_pct"].to_numpy()
    delta = dates["incremental_delta_pct"].to_numpy()
    tail_count = max(1, math.ceil(len(dates) * 0.10))
    return {
        "rows": frame.height,
        "dates": dates.height,
        "start_date": str(dates["signal_date"].min()),
        "end_date": str(dates["signal_date"].max()),
        "changed_rows": frame.filter(pl.col("incremental_delta_pct") != 0).height,
        "date_delta": lcb90(delta),
        "tail_date_count": tail_count,
        "incumbent": {
            "date_mean": float(incumbent.mean()),
            "date_p10": float(np.quantile(incumbent, 0.10)),
            "date_cvar10": lower_tail_mean(incumbent),
            "trade_cvar10": lower_tail_mean(frame["incumbent_net_pnl_pct"].to_numpy()),
            "cumulative_return": float(np.prod(1.0 + incumbent) - 1.0),
            "max_drawdown": max_drawdown(incumbent),
        },
        "candidate": {
            "date_mean": float(candidate.mean()),
            "date_p10": float(np.quantile(candidate, 0.10)),
            "date_cvar10": lower_tail_mean(candidate),
            "trade_cvar10": lower_tail_mean(frame["candidate_net_pnl_pct"].to_numpy()),
            "cumulative_return": float(np.prod(1.0 + candidate) - 1.0),
            "max_drawdown": max_drawdown(candidate),
        },
    }


def bootstrap_dates(frame: pl.DataFrame) -> dict[str, Any]:
    dates = date_frame(frame)
    incumbent = dates["incumbent_net_pnl_pct"].to_numpy()
    candidate = dates["candidate_net_pnl_pct"].to_numpy()
    delta = dates["incremental_delta_pct"].to_numpy()
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    indexes = rng.integers(0, len(dates), size=(BOOTSTRAP_SAMPLES, len(dates)))
    sampled_mean = delta[indexes].mean(axis=1)
    tail_count = max(1, math.ceil(len(dates) * 0.10))
    sampled_cvar_delta = (
        np.sort(candidate[indexes], axis=1)[:, :tail_count].mean(axis=1)
        - np.sort(incumbent[indexes], axis=1)[:, :tail_count].mean(axis=1)
    )
    return {
        "samples": BOOTSTRAP_SAMPLES,
        "seed": BOOTSTRAP_SEED,
        "mean_delta_q05_q50_q95": [float(value) for value in np.quantile(sampled_mean, [0.05, 0.50, 0.95])],
        "probability_mean_positive": float(np.mean(sampled_mean > 0)),
        "cvar10_delta_q05_q50_q95": [
            float(value) for value in np.quantile(sampled_cvar_delta, [0.05, 0.50, 0.95])
        ],
        "probability_cvar_non_degradation": float(np.mean(sampled_cvar_delta >= 0)),
    }


def slice_metrics(frame: pl.DataFrame) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key, group in frame.partition_by("market", as_dict=True).items():
        date_delta = group.group_by("signal_date").agg(
            pl.col("incremental_delta_pct").mean().alias("delta")
        )["delta"].to_numpy()
        rows.append({
            "market": str(key[0] if isinstance(key, tuple) else key),
            "rows": group.height,
            "dates": group["signal_date"].n_unique(),
            "symbols": group["symbol"].n_unique(),
            "positive_dates": int(np.sum(date_delta > 0)),
            "date_delta": lcb90(date_delta),
        })
    return sorted(rows, key=lambda row: row["market"])


def main() -> int:
    full = pl.read_parquet(FULL_COHORT)
    paired_report = json.loads(PAIRED_REPORT.read_text(encoding="utf-8"))
    paired = pl.read_parquet(PAIRED_ROWS)
    exact = paired.filter(pl.col("incumbent_parity").struct.field("exact"))
    changed = exact.filter(pl.col("eligible") == True).select(
        "id", "symbol", "market", "signal_date", "market_segment", "cost_net_delta_pct",
    ).rename({"cost_net_delta_pct": "incremental_delta_pct"})
    joined = full.join(changed.select("id", "incremental_delta_pct"), on="id", how="left").with_columns(
        pl.col("incremental_delta_pct").fill_null(0.0),
        pl.col("net_pnl_pct").alias("incumbent_net_pnl_pct"),
    ).with_columns(
        (pl.col("incumbent_net_pnl_pct") + pl.col("incremental_delta_pct")).alias("candidate_net_pnl_pct"),
    )
    if joined.height != full.height or joined["id"].n_unique() != full["id"].n_unique():
        raise RuntimeError("full_cohort_join_identity_mismatch")

    portfolio = portfolio_metrics(joined)
    bootstrap = bootstrap_dates(joined)
    conditional = changed.group_by("signal_date").agg(
        pl.col("incremental_delta_pct").mean().alias("delta")
    ).sort("signal_date")
    delta_values = conditional["delta"].to_numpy()
    leave_one_out = np.asarray([
        np.delete(delta_values, index).mean() for index in range(delta_values.size)
    ])
    dates = conditional["signal_date"].to_list()
    split = len(dates) // 2
    early = conditional.filter(pl.col("signal_date").is_in(dates[:split]))["delta"].to_numpy()
    late = conditional.filter(pl.col("signal_date").is_in(dates[split:]))["delta"].to_numpy()
    profit_rows = full.filter(pl.col("exit_reason").is_in(sorted(PROFIT_REASONS))).height

    gates = {
        "incumbent_exact_parity_100pct": paired_report["incumbent_parity"]["rate"] == 1.0,
        "immutable_full_cohort_identity_complete": joined.height == full.height,
        "conditional_date_lcb90_positive": lcb90(delta_values)["lcb90"] > 0,
        "early_date_lcb90_positive": lcb90(early)["lcb90"] > 0,
        "late_date_lcb90_positive": lcb90(late)["lcb90"] > 0,
        "full_portfolio_mean_bootstrap_q05_positive": bootstrap["mean_delta_q05_q50_q95"][0] > 0,
        "full_portfolio_trade_cvar10_non_degradation": (
            portfolio["candidate"]["trade_cvar10"] >= portfolio["incumbent"]["trade_cvar10"]
        ),
        "full_portfolio_date_cvar10_non_degradation": (
            portfolio["candidate"]["date_cvar10"] >= portfolio["incumbent"]["date_cvar10"]
        ),
        "full_portfolio_drawdown_non_degradation": (
            portfolio["candidate"]["max_drawdown"] >= portfolio["incumbent"]["max_drawdown"]
        ),
        "no_overnight_or_deadline_violation": (
            paired_report["candidate"]["no_overnight_violations"] == 0
            and paired_report["candidate"]["deadline_violations"] == 0
        ),
    }
    report = {
        "schema_version": "s12-profit-continuation-promotion-decision-v1",
        "contract": "s12-profit-continuation-v1",
        "mode": "read_only",
        "production_effect": False,
        "cohort": {
            "rows": full.height,
            "dates": full["signal_date"].n_unique(),
            "start_date": str(full["signal_date"].min()),
            "end_date": str(full["signal_date"].max()),
            "profit_exit_rows": profit_rows,
            "exact_paired_profit_rows": exact.height,
            "changed_rows": changed.height,
            "changed_share": changed.height / full.height,
            "full_cohort_checksum": sha256_file(FULL_COHORT),
            "paired_rows_checksum": sha256_file(PAIRED_ROWS),
        },
        "conditional_continuation": {
            "date_delta": lcb90(delta_values),
            "early": lcb90(early),
            "late": lcb90(late),
            "leave_one_date_out_mean_min": float(leave_one_out.min()),
            "leave_one_date_out_mean_max": float(leave_one_out.max()),
            "market_slices": slice_metrics(changed),
            "winner_subset_cvar_note": "diagnostic_only_not_full_portfolio_safety_gate",
        },
        "full_portfolio": portfolio,
        "paired_date_bootstrap": bootstrap,
        "gates": gates,
        "data_qualified_for_paper_promotion": all(gates.values()),
        "real_order_effect": False,
        "decision_scope": "paper_only_requires_separate_serving_integration_and_atomic_cutover",
        "context_warning": "incumbent_full_cohort_is_negative; continuation_improves_exit_increment_only",
    }
    report["blockers"] = [name for name, value in gates.items() if not value]
    report = canonicalize_numbers(report)
    report["receipt_checksum"] = hashlib.sha256(
        json.dumps(report, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
