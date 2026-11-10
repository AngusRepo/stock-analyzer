"""R33 monthly calibration inputs: attested L2 pool history and the pool score table.

Ranks are re-taken per model from raw_score among the pool stocks of each day,
so OOF, calibration and serving share one rank definition. Rows whose entry
session opened limit-up cannot be bought: they keep their place in the day's
ranking but never enter the fit, the excess baseline or the evaluation.
"""
from __future__ import annotations

import numpy as np
import polars as pl

from services.r33_isotonic_calibration import MODELS, build_payload, checksum, pava, pool_scores, predict

POOL_SOURCE = "ops.screener_funnel_items:final_selection"
# Every isotonic block must carry at least one full day of evidence (days weigh
# one each). Without it the top block was a single row (+18.6% on the r32 OOF).
MIN_BLOCK_DAYS = 1.0


def load_l2_pool(ops_query, *, start: str, end: str) -> tuple[dict[str, set[str]], dict]:
    """One screener run per day (the latest); returns the pool and its receipt."""
    rows = ops_query(
        "SELECT i.date, i.run_id, i.symbol, i.decision, r.created_at FROM screener_funnel_items i "
        "JOIN screener_funnel_runs r ON r.run_id=i.run_id "
        "WHERE i.stage='final_selection' AND i.date BETWEEN ? AND ? ORDER BY i.date, r.created_at, i.symbol",
        [start, end])
    latest: dict[str, tuple[str, str]] = {}
    for row in rows:
        key = (str(row["created_at"]), str(row["run_id"]))
        if row["date"] not in latest or key > latest[row["date"]]:
            latest[row["date"]] = key
    pool: dict[str, set[str]] = {}
    decisions: dict[str, int] = {}
    for row in rows:
        if latest[row["date"]][1] == str(row["run_id"]):
            pool.setdefault(row["date"], set()).add(str(row["symbol"]))
            decisions[row["decision"]] = decisions.get(row["decision"], 0) + 1
    runs_per_day = {}
    for row in rows:
        runs_per_day.setdefault(row["date"], set()).add(row["run_id"])
    receipt = dict(source=POOL_SOURCE, start=start, end=end, days=len(pool),
                   rows=int(sum(map(len, pool.values()))), decisions=decisions,
                   multi_run_days=sorted(d for d, r in runs_per_day.items() if len(r) > 1),
                   membership_sha256=checksum({d: sorted(s) for d, s in sorted(pool.items())}))
    return pool, receipt


def measured_horizon(dates, label_known) -> tuple[int, dict[str, int]]:
    """Label horizon in OOF sessions, measured on the full OOF calendar (pool days have gaps)."""
    calendar = sorted(set(dates))
    index = {d: i for i, d in enumerate(calendar)}
    gaps = {index[k] - index[d] for d, k in set(zip(dates, label_known)) if k in index}
    if len(gaps) != 1:
        raise ValueError("r33_label_horizon_not_uniform:" + str(sorted(gaps)))
    return gaps.pop(), index


def pool_score_table(oof: pl.DataFrame, pool_by_date: dict[str, set[str]] | None, *, variant: str = "mean_z") -> dict:
    """Wide per (date, symbol) table scored inside each day's pool (whole universe when pool is None)."""
    horizon, calendar_index = measured_horizon(oof["prediction_date"].to_numpy().astype(str),
                                               oof["label_known_date"].to_numpy().astype(str))
    wide = (oof.filter(pl.col("model_name").is_in(MODELS))
            .pivot(on="model_name", index=["prediction_date", "symbol"], values="raw_score", aggregate_function="first")
            .join(oof.group_by(["prediction_date", "symbol"]).agg(
                pl.col("target_return").first(), pl.col("label_known_date").first(),
                pl.col("entry_limit_up").any()), on=["prediction_date", "symbol"])
            .sort(["prediction_date", "symbol"]))
    for model in MODELS:
        if model not in wide.columns:
            wide = wide.with_columns(pl.lit(None, dtype=pl.Float64).alias(model))
    if pool_by_date is not None:
        members = pl.DataFrame([(d, s) for d, syms in pool_by_date.items() for s in syms],
                               schema=["prediction_date", "symbol"], orient="row")
        wide = wide.join(members, on=["prediction_date", "symbol"], how="semi")
    dates = wide["prediction_date"].to_numpy().astype(str)
    ranks = wide.select(MODELS).to_numpy().astype(float)
    available = np.isfinite(ranks)
    target = wide["target_return"].to_numpy().astype(float)
    buyable = ~wide["entry_limit_up"].to_numpy().astype(bool) & np.isfinite(target)
    score = np.full(len(wide), np.nan)
    excess = np.full(len(wide), np.nan)
    weight = np.full(len(wide), np.nan)
    day_rows, uninformative = {}, {}
    for day in sorted(set(dates)):
        rows = np.flatnonzero(dates == day)
        score[rows], _, dropped = pool_scores(ranks[rows], available[rows], variant=variant)
        if dropped:
            uninformative[day] = dropped
        kept = rows[buyable[rows]]
        if len(kept) > 1:
            excess[kept] = target[kept] - target[kept].mean()
            weight[kept] = 1.0 / len(kept)
            day_rows[day] = kept
    return dict(dates=dates, symbols=wide["symbol"].to_numpy().astype(str), score=score, excess=excess,
                weight=weight, day_rows=day_rows, horizon=horizon, calendar_index=calendar_index,
                uninformative_model_days=uninformative,
                entry_limit_up_rows=int((~buyable & np.isfinite(target)).sum()))


def crossfit_expected_excess(table: dict, *, min_block_weight: float = MIN_BLOCK_DAYS) -> tuple[np.ndarray, dict[str, float]]:
    """Purged leave-one-day-out isotonic; also each held-out day's top-block lower edge."""
    days = sorted(table["day_rows"])
    index = table["calendar_index"]
    out = np.full(len(table["score"]), np.nan)
    top_edge = {}
    for day in days:
        train = [table["day_rows"][d] for d in days if abs(index[d] - index[day]) >= table["horizon"]]
        if not train:
            continue
        train = np.concatenate(train)
        blocks = pava(table["score"][train], table["excess"][train], table["weight"][train], min_block_weight=min_block_weight)
        rows = table["day_rows"][day]
        out[rows] = predict(blocks, table["score"][rows])
        top_edge[day] = blocks[-1]["score_lo"]
    return out, top_edge


def fit_calibration(*, oof: pl.DataFrame, pool_by_date, round_trip_cost: float, inputs: dict,
                    variant: str = "mean_z", min_block_weight: float = MIN_BLOCK_DAYS) -> dict:
    table = pool_score_table(oof, pool_by_date, variant=variant)
    if not table["day_rows"]:
        raise ValueError("r33_calibration_no_pool_days")
    rows = np.concatenate(list(table["day_rows"].values()))
    blocks = pava(table["score"][rows], table["excess"][rows], table["weight"][rows], min_block_weight=min_block_weight)
    predicted, _ = crossfit_expected_excess(table, min_block_weight=min_block_weight)
    above = [table["excess"][r][predicted[r] > round_trip_cost] for r in table["day_rows"].values()]
    realized = np.array([a.mean() for a in above if len(a)])
    diagnostics = dict(days=len(table["day_rows"]), rows=int(len(rows)), entry_limit_up_rows_excluded=table["entry_limit_up_rows"],
                       uninformative_model_days=table["uninformative_model_days"],
                       crossfit_above_cost=dict(days_with_picks=int(len(realized)),
                                                picks_per_day=float(np.mean([len(a) for a in above])),
                                                realized_excess_mean=float(realized.mean()) if len(realized) else None))
    return build_payload(blocks=blocks, variant=variant, horizon_sessions=table["horizon"],
                         inputs=dict(inputs, round_trip_cost=round_trip_cost, min_block_weight=min_block_weight),
                         diagnostics=diagnostics)
