"""R33 monthly OOF admission checks, run before any full-fit is dispatched.

1. No leakage: every fold's actual training label_known max precedes its test start.
2. Not inverted: the daily rank IC of the seven-model score is positive on average,
   and days held out of a purged isotonic fit realize a positive excess above that
   fit's top-block edge (mean minus one standard error > 0).
3. Tail-fold guard (policy v4): a model whose last-three-fold daily IC has a 90% HAC
   upper bound below zero fails hard for TabM and PatchTST and warns otherwise.
Rows whose entry session opened limit-up are not buyable and are excluded from 2.
Dates from new_fold_from on are reported separately and do not gate.
"""
from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np
import polars as pl
from scipy.stats import spearmanr

from services.r33_calibration_job import crossfit_expected_excess, pool_score_table
from services.r33_isotonic_calibration import MODELS

SCHEMA = "r33-oof-checks-v1"
LIMIT_UP_OPEN_GAP = 0.095
TAIL_GUARD_POLICY = "v4"
TAIL_GUARD_HARD = ("TabM", "PatchTST")


def entry_limit_up_rows(prices: pl.DataFrame) -> pl.DataFrame:
    """(prediction_date, symbol) whose next traded session opened at least 9.5% above the close."""
    return (prices.sort(["symbol", "date"])
            .with_columns(pl.col("open").shift(-1).over("symbol").alias("entry_open"))
            .filter(pl.col("entry_open") / pl.col("close") - 1 >= LIMIT_UP_OPEN_GAP)
            .select(pl.col("date").alias("prediction_date"), "symbol"))


def _mean_se(values) -> dict:
    values = np.asarray(values, dtype=float)
    se = float(values.std(ddof=1) / math.sqrt(len(values))) if len(values) > 1 else None
    return dict(n=int(len(values)), mean=float(values.mean()) if len(values) else None, se=se)


def _hac_bounds(values, level=0.90):
    a = np.asarray(values, dtype=float)
    n = len(a)
    c = a - a.mean()
    lags = min(n - 1, int(4 * (n / 100) ** (2 / 9)))
    lrv = c @ c / n + sum(2 * (1 - k / (lags + 1)) * (c[k:] @ c[:-k] / n) for k in range(1, lags + 1))
    half = NormalDist().inv_cdf(level) * math.sqrt(max(lrv, 0.0) / n)
    return a.mean() - half, a.mean() + half


def _score_checks(table: dict, days) -> dict:
    ic = [float(spearmanr(table["score"][r], table["excess"][r])[0]) for d, r in table["day_rows"].items() if d in days]
    _, top_edge = crossfit_expected_excess(table)
    top = [table["excess"][r][table["score"][r] >= top_edge[d]] for d, r in table["day_rows"].items()
           if d in days and d in top_edge]
    top = [t.mean() for t in top if len(t)]
    return dict(daily_ic=_mean_se(ic), isotonic_top=_mean_se(top))


def run_checks(*, oof: pl.DataFrame, fold_receipts: list[dict], pool_by_date: dict[str, set[str]] | None,
               new_fold_from: str | None) -> dict:
    receipts = {str(r["fold_id"]): r for r in fold_receipts}
    leaking = sorted(f for f, r in receipts.items() if not str(r["train_label_known_max"]) < str(r["test_start"]))
    unattested = sorted(set(oof["fold_id"].unique().to_list()) - set(receipts))
    leaked_rows = oof.filter(pl.col("fold_id").is_in(leaking + unattested)).height
    leakage = dict(leaking_folds=leaking, unattested_folds=unattested, ancestor_influenced_rows=leaked_rows,
                   passed=leaked_rows == 0 and not leaking and not unattested)

    table = pool_score_table(oof, pool_by_date)
    days = set(table["day_rows"])
    scored = _score_checks(table, days)
    ic, top = scored["daily_ic"], scored["isotonic_top"]
    inversion = dict(**scored, passed=bool(ic["mean"] is not None and ic["mean"] > 0
                                           and top["se"] is not None and top["mean"] - top["se"] > 0))

    folds = sorted(oof["fold_id"].unique().to_list(), key=lambda f: str(receipts.get(f, {}).get("test_start", f)))
    tail = oof.filter(pl.col("fold_id").is_in(folds[-3:]) & ~pl.col("entry_limit_up"))
    guard = {}
    for model in MODELS:
        part = tail.filter((pl.col("model_name") == model) & pl.col("raw_score").is_finite() & pl.col("target_return").is_finite())
        daily = [float(spearmanr(g["raw_score"], g["target_return"])[0])
                 for _, g in part.sort("prediction_date").group_by("prediction_date", maintain_order=True)
                 if g.height > 2]  # chronological: the HAC bound uses autocorrelation
        if len(daily) < 3:
            guard[model] = dict(days=len(daily), status="insufficient", severity="hard" if model in TAIL_GUARD_HARD else "warn")
            continue
        lo, hi = _hac_bounds(daily)
        status = "fail" if hi < 0 else ("pass" if lo > 0 else "uncertain")
        guard[model] = dict(days=len(daily), mean=float(np.mean(daily)), bound90=[float(lo), float(hi)], status=status,
                            severity="hard" if model in TAIL_GUARD_HARD else "warn")
    hard_fail = sorted(m for m, g in guard.items() if g["severity"] == "hard" and g["status"] in ("fail", "insufficient"))
    tail_guard = dict(policy=TAIL_GUARD_POLICY, folds=folds[-3:], models=guard, hard_failures=hard_fail, passed=not hard_fail)

    new_folds = None
    if new_fold_from:
        recent = {d for d in days if d >= new_fold_from}
        new_folds = dict(from_date=new_fold_from, days=len(recent), **(_score_checks(table, recent) if len(recent) > 1 else {}))
    checks = dict(leakage=leakage, inversion=inversion, tail_guard=tail_guard)
    return dict(schema_version=SCHEMA, status="pass" if all(c["passed"] for c in checks.values()) else "fail",
                checks=checks, scope=dict(pool_days=len(days), horizon_sessions=table["horizon"],
                                          entry_limit_up_rows_excluded=table["entry_limit_up_rows"]),
                new_folds_report=new_folds)
