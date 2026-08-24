from __future__ import annotations

import numpy as np
import polars as pl

from .features import compute_cross_sectional_rank


GLOBAL_CROSS_SECTIONAL_RANK_VERSION = "global-market-date-cross-sectional-rank-v1"


def recompute_global_cross_sectional_rank(
    target_returns: np.ndarray,
    dates: np.ndarray,
    markets: np.ndarray | None = None,
) -> np.ndarray:
    """Rebuild one rank universe after every prep batch has been concatenated."""
    returns = np.asarray(target_returns, dtype=float)
    date_values = np.asarray(dates, dtype=object)
    if len(returns) == 0 or len(returns) != len(date_values):
        raise ValueError("global_cross_sectional_rank_requires_aligned_raw_targets")
    if not np.isfinite(returns).all():
        raise ValueError("global_cross_sectional_rank_requires_finite_raw_targets")
    market_values = (
        np.asarray(markets, dtype=object)
        if markets is not None and len(markets) == len(returns)
        else np.asarray(["UNKNOWN"] * len(returns), dtype=object)
    )
    frame = pl.DataFrame({
        "_row_id": np.arange(len(returns), dtype=np.int64),
        "target_5d": returns,
        "_date": date_values.astype(str),
        "_market": market_values.astype(str),
    }).with_columns(
        (pl.col("_market") + pl.lit("|") + pl.col("_date")).alias("_rank_group")
    )
    ranked = compute_cross_sectional_rank(
        frame,
        return_col="target_5d",
        date_col="_rank_group",
    ).sort("_row_id")
    values = ranked["target_rank"].to_numpy()
    if len(values) != len(returns) or not np.isfinite(values).all():
        raise ValueError("global_cross_sectional_rank_materialization_incomplete")
    return np.asarray(values, dtype=float)
