"""LinearNeutral challenger math: same-cohort exposure neutralization plus ridge.

Every (signal date, market) cohort — the same cohort the net-v4 target rank and
the OOF rank use — is transformed independently:

1. each formal131 feature becomes a centered average-tie percentile rank;
2. the ranks are OLS-residualized on the cohort's PIT exposures (industry
   dummies and/or the standardized log market cap);
3. a ridge on the residuals predicts the global cross-sectional target rank.

The ridge penalty is chosen by inner purged blocked CV.  Candidate penalties
are solved from the training Gram spectrum so that the effective degrees of
freedom are 1, 2, ..., rank-1; the grid comes from the data, not a hand-picked range.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy.stats import rankdata

LINEAR_NEUTRAL_SEMANTIC_VERSION = "linear-neutral-ridge-v1"
FEATURE_TRANSFORM = "same-date-market-centered-average-tie-percentile-rank-v1"
ALPHA_SELECTION_METHOD = "inner_purged_blocked_cv_effective_df_grid_mean_daily_rank_ic"
LOG_MARKET_CAP_FEATURE = "size_log_mktcap"
EXPOSURE_SETS: dict[str, tuple[str, ...]] = {
    "industry_log_mktcap": ("industry", "log_market_cap"),
    "log_mktcap": ("log_market_cap",),
}
# Different exposures are different models: their OOF must never share an identity.
EXPOSURE_SET_MODEL_NAMES = {"industry_log_mktcap": "LinearNeutral", "log_mktcap": "LinearNeutralSize"}


def cohort_groups(dates: np.ndarray, markets: np.ndarray) -> list[np.ndarray]:
    keys = np.char.add(np.char.add(np.asarray(markets).astype(str), "|"), np.asarray(dates).astype(str))
    order = np.argsort(keys, kind="mergesort")
    sorted_keys = keys[order]
    bounds = np.flatnonzero(sorted_keys[1:] != sorted_keys[:-1]) + 1
    return [np.asarray(part, dtype=np.int64) for part in np.split(order, bounds) if len(part)]


def _centered_rank(values: np.ndarray) -> np.ndarray:
    n = values.shape[0]
    if n == 1:
        return np.zeros_like(values, dtype=float)
    return (rankdata(values, method="average", axis=0) - 1.0) / (n - 1.0) - 0.5


def _exposure_matrix(
    idx: np.ndarray,
    exposures: tuple[str, ...],
    log_mcap: np.ndarray | None,
    industries: np.ndarray | None,
) -> np.ndarray:
    columns: list[np.ndarray] = []
    if "industry" in exposures:
        labels = np.asarray(industries)[idx].astype(str)
        for label in np.unique(labels):
            columns.append((labels == label).astype(float))
    else:
        columns.append(np.ones(len(idx), dtype=float))
    if "log_market_cap" in exposures:
        size = np.asarray(log_mcap, dtype=float)[idx]
        scale = float(np.std(size))
        columns.append((size - float(np.mean(size))) / scale if scale > 0 else np.zeros(len(idx)))
    return np.column_stack(columns)


def neutralize_cross_section(
    X: np.ndarray,
    *,
    dates: np.ndarray,
    markets: np.ndarray,
    exposures: tuple[str, ...],
    log_mcap: np.ndarray | None = None,
    industries: np.ndarray | None = None,
) -> np.ndarray:
    """Return per-cohort rank residuals orthogonal to that cohort's exposures."""

    x = np.asarray(X, dtype=float)
    if not np.isfinite(x).all():
        raise ValueError("linear_neutral_features_non_finite")
    if "log_market_cap" in exposures and (log_mcap is None or not np.isfinite(log_mcap).all()):
        raise ValueError("linear_neutral_log_market_cap_missing")
    if "industry" in exposures:
        if industries is None:
            raise ValueError("linear_neutral_industry_missing")
        if np.any(np.asarray(industries).astype(str) == ""):
            raise ValueError("linear_neutral_industry_missing")
    out = np.zeros_like(x)
    for idx in cohort_groups(dates, markets):
        ranks = _centered_rank(x[idx])
        design = _exposure_matrix(idx, exposures, log_mcap, industries)
        beta, *_ = np.linalg.lstsq(design, ranks, rcond=None)
        out[idx] = ranks - design @ beta
    return out


def daily_rank_ic(pred: np.ndarray, target: np.ndarray, groups: list[np.ndarray]) -> np.ndarray:
    """Mean same-cohort Spearman IC for each prediction column."""

    p = np.asarray(pred, dtype=float)
    p = p.reshape(len(p), -1)
    y = np.asarray(target, dtype=float).reshape(-1)
    total = np.zeros(p.shape[1])
    count = 0
    for idx in groups:
        if len(idx) < 3:
            continue
        yr = rankdata(y[idx])
        yr = yr - yr.mean()
        y_norm = float(np.sqrt((yr * yr).sum()))
        if y_norm <= 0:
            continue
        pr = rankdata(p[idx], axis=0)
        pr = pr - pr.mean(axis=0)
        p_norm = np.sqrt((pr * pr).sum(axis=0))
        ic = np.where(p_norm > 0, (pr * yr[:, None]).sum(axis=0) / np.where(p_norm > 0, p_norm, 1.0) / y_norm, 0.0)
        total += ic
        count += 1
    return total / count if count else total


def purged_date_blocks(
    dates: np.ndarray,
    label_known_dates: np.ndarray,
    *,
    n_blocks: int,
) -> list[tuple[np.ndarray, np.ndarray, dict[str, Any]]]:
    """Contiguous date blocks; train rows whose label window touches the block are purged."""

    if n_blocks < 2:
        raise ValueError("linear_neutral_inner_folds_must_be_at_least_two")
    d = np.asarray(dates).astype(str)
    known = np.asarray(label_known_dates).astype(str)
    if np.any(known <= d):
        raise ValueError("linear_neutral_label_known_date_not_after_signal_date")
    unique_dates = np.unique(d)
    if len(unique_dates) < n_blocks:
        raise ValueError("linear_neutral_inner_folds_exceed_dates")
    folds = []
    for block in np.array_split(unique_dates, n_blocks):
        start, end = str(block[0]), str(block[-1])
        test_mask = (d >= start) & (d <= end)
        test_known_max = str(np.sort(known[test_mask])[-1])
        before_overlap = (d < start) & (known >= start)
        after_overlap = (d > end) & (d <= test_known_max)
        train_mask = ~test_mask & ~before_overlap & ~after_overlap
        folds.append((np.flatnonzero(train_mask), np.flatnonzero(test_mask), {
            "test_range": [start, end],
            "purged_rows": int((before_overlap | after_overlap).sum()),
            "train_rows": int(train_mask.sum()),
            "test_rows": int(test_mask.sum()),
        }))
    return folds


def _sufficient_stats(z: np.ndarray, y: np.ndarray, idx: np.ndarray | None = None) -> tuple:
    zs, ys = (z, y) if idx is None else (z[idx], y[idx])
    return zs.T @ zs, zs.sum(axis=0), zs.T @ ys, float(ys.sum()), int(len(ys))


def _ridge_path(stats: tuple, alphas: np.ndarray) -> np.ndarray:
    """Ridge with an unpenalized intercept, solved from (Z'Z, Z'1, Z'y, 1'y, n)."""

    szz, sz, szy, sy, n = stats
    if n <= 0:
        raise ValueError("linear_neutral_ridge_rows_empty")
    z_mean = sz / n
    y_mean = sy / n
    gram = szz - n * np.outer(z_mean, z_mean)
    lam, vec = np.linalg.eigh(gram)
    lam = np.clip(lam, 0.0, None)
    proj = vec.T @ (szy - n * z_mean * y_mean)
    return vec @ (proj[:, None] / (lam[:, None] + alphas[None, :]))


def _intercepts(stats: tuple, coefs: np.ndarray) -> np.ndarray:
    _szz, sz, _szy, sy, n = stats
    return sy / n - (sz / n) @ coefs


def effective_df_alphas(stats: tuple) -> np.ndarray:
    """One penalty per effective degree of freedom: df(alpha) = k for k = 1 .. rank-1.

    df(alpha) = sum(l / (l + alpha)) over the centered Gram spectrum, so the grid
    spans the whole ridge path (near-OLS to near-constant) and is fixed by the data.
    """

    szz, sz, _szy, _sy, n = stats
    lam = np.linalg.eigvalsh(szz - np.outer(sz, sz) / n)
    lam = lam[lam > lam.max() * np.finfo(float).eps * len(lam)]
    rank = len(lam)
    if rank < 2:
        raise ValueError("linear_neutral_design_rank_too_low")

    def df(alpha: float) -> float:
        return float(np.sum(lam / (lam + alpha)))

    alphas = []
    for k in range(1, rank):
        lo, hi = 0.0, float(lam.sum()) / k  # df(0) = rank > k >= df(hi)
        for _ in range(200):
            mid = 0.5 * (lo + hi)
            lo, hi = (mid, hi) if df(mid) > k else (lo, mid)
        alphas.append(hi)
    return np.asarray(sorted(set(alphas)), dtype=float)


def select_ridge_alpha(
    z: np.ndarray,
    y: np.ndarray,
    *,
    dates: np.ndarray,
    markets: np.ndarray,
    label_known_dates: np.ndarray,
    n_blocks: int,
) -> dict[str, Any]:
    total = _sufficient_stats(z, y)
    alphas = effective_df_alphas(total)
    folds = purged_date_blocks(dates, label_known_dates, n_blocks=n_blocks)
    scores = np.zeros((len(folds), len(alphas)))
    fold_reports = []
    every_row = np.arange(len(y))
    for fold_index, (train_idx, test_idx, report) in enumerate(folds):
        if not len(train_idx):
            raise ValueError("linear_neutral_inner_fold_train_empty_after_purge")
        # Train = total minus (test + purged); the excluded set is ~1/K of rows.
        excluded = np.setdiff1d(every_row, train_idx, assume_unique=True)
        held = _sufficient_stats(z, y, excluded)
        stats = tuple(a - b for a, b in zip(total, held))
        coefs = _ridge_path(stats, alphas)
        preds = z[test_idx] @ coefs + _intercepts(stats, coefs)
        scores[fold_index] = daily_rank_ic(preds, y[test_idx], cohort_groups(dates[test_idx], markets[test_idx]))
        fold_reports.append({**report, "best_alpha_ic": float(scores[fold_index].max())})
    mean_ic = scores.mean(axis=0)
    # Ties resolve to the stronger penalty: equal evidence prefers the simpler fit.
    best = int(np.flatnonzero(mean_ic == mean_ic.max())[-1])
    return {
        "method": ALPHA_SELECTION_METHOD,
        "alpha": float(alphas[best]),
        "alpha_index": best,
        "alpha_candidates": [float(a) for a in alphas],
        "alpha_at_grid_edge": best in (0, len(alphas) - 1),
        "selected_effective_df": len(alphas) - best,
        "cv_mean_daily_rank_ic": [float(v) for v in mean_ic],
        "selected_cv_mean_daily_rank_ic": float(mean_ic[best]),
        "inner_folds": int(len(folds)),
        "purge": "label_known_date_interval_overlap_both_sides",
        "folds": fold_reports,
    }


@dataclass
class LinearNeutralModel:
    """Picklable challenger artifact; scoring requires the same PIT exposures."""

    feature_names: list[str]
    exposure_set: str
    coef_: np.ndarray
    intercept_: float
    alpha_: float
    feature_scale_: np.ndarray
    semantic_version: str = LINEAR_NEUTRAL_SEMANTIC_VERSION
    feature_transform: str = FEATURE_TRANSFORM
    alpha_selection: dict[str, Any] = field(default_factory=dict)

    @property
    def exposures(self) -> tuple[str, ...]:
        return EXPOSURE_SETS[self.exposure_set]

    def transform(self, X, *, dates, markets, industries=None) -> np.ndarray:
        x = np.asarray(X, dtype=float)
        size_index = self.feature_names.index(LOG_MARKET_CAP_FEATURE)
        residual = neutralize_cross_section(
            x, dates=dates, markets=markets, exposures=self.exposures,
            log_mcap=x[:, size_index], industries=industries,
        )
        return residual / self.feature_scale_

    def predict(self, X, *, dates, markets, industries=None) -> np.ndarray:
        return self.transform(X, dates=dates, markets=markets, industries=industries) @ self.coef_ + self.intercept_

    def get_params(self, deep: bool = False) -> dict[str, Any]:
        return {
            "semantic_version": self.semantic_version,
            "feature_transform": self.feature_transform,
            "exposure_set": self.exposure_set,
            "alpha": self.alpha_,
            "alpha_selection_method": self.alpha_selection.get("method"),
            "inner_folds": self.alpha_selection.get("inner_folds"),
        }


def fit_linear_neutral(
    X: np.ndarray,
    y: np.ndarray,
    *,
    feature_names: list[str],
    dates: np.ndarray,
    markets: np.ndarray,
    label_known_dates: np.ndarray,
    exposure_set: str,
    inner_folds: int,
    industries: np.ndarray | None = None,
) -> LinearNeutralModel:
    if exposure_set not in EXPOSURE_SETS:
        raise ValueError(f"linear_neutral_exposure_set_invalid:{exposure_set}")
    if LOG_MARKET_CAP_FEATURE not in feature_names:
        raise ValueError("linear_neutral_requires_size_log_mktcap_feature")
    x = np.asarray(X, dtype=float)
    size_index = list(feature_names).index(LOG_MARKET_CAP_FEATURE)
    residual = neutralize_cross_section(
        x, dates=dates, markets=markets, exposures=EXPOSURE_SETS[exposure_set],
        log_mcap=x[:, size_index], industries=industries,
    )
    scale = residual.std(axis=0)
    # Columns with no cross-sectional variation stay zero; they cannot move a rank.
    scale = np.where(scale > 0, scale, 1.0)
    z = residual / scale
    target = np.asarray(y, dtype=float)
    selection = select_ridge_alpha(
        z, target, dates=np.asarray(dates).astype(str), markets=np.asarray(markets).astype(str),
        label_known_dates=label_known_dates, n_blocks=int(inner_folds),
    )
    stats = _sufficient_stats(z, target)
    coefs = _ridge_path(stats, np.asarray([selection["alpha"]]))
    intercept = float(_intercepts(stats, coefs)[0])
    return LinearNeutralModel(
        feature_names=list(feature_names),
        exposure_set=exposure_set,
        coef_=coefs[:, 0],
        intercept_=intercept,
        alpha_=float(selection["alpha"]),
        feature_scale_=scale,
        alpha_selection={
            **selection,
            "zero_variance_features": [name for name, s in zip(feature_names, residual.std(axis=0)) if not s > 0],
        },
    )

