"""Purged time-series cross validation with optional dynamic embargo.

Financial labels often look forward several days. A normal time split can leak
future label information across the train/test boundary. Purged CV removes an
embargo gap between train and test windows and keeps the split expanding-only.

References:
- Lopez de Prado, Advances in Financial Machine Learning, Chapter 7.
- Purged / embargoed time-series validation used in quantitative finance.
"""

from __future__ import annotations

from itertools import combinations
from math import comb
from typing import Iterator

import numpy as np


def dynamic_embargo_days(
    n_dates: int,
    *,
    base_days: int = 10,
    embargo_pct: float | None = None,
    max_days: int | None = 20,
) -> int:
    """Return a date-count-aware embargo without weakening the baseline.

    `base_days` preserves legacy behavior. `embargo_pct` lets longer training
    histories use a wider purge gap while `max_days` prevents runaway cost.
    """

    base = max(0, int(base_days))
    if embargo_pct is None or embargo_pct <= 0 or n_dates <= 0:
        return base
    pct_days = int(np.ceil(n_dates * float(embargo_pct)))
    resolved = max(base, pct_days)
    if max_days is not None:
        resolved = min(resolved, max(0, int(max_days)))
    return resolved


def cpcv_split_count(*, n_groups: int, n_test_groups: int) -> int:
    """Return the number of CPCV train/test combinations."""

    if n_groups <= 0 or n_test_groups <= 0 or n_test_groups >= n_groups:
        raise ValueError("n_groups must be positive and 0 < n_test_groups < n_groups")
    return comb(n_groups, n_test_groups)


class PurgedTimeSeriesCV:
    """Purged expanding-window CV with an embargo gap."""

    def __init__(
        self,
        n_splits: int = 5,
        embargo_days: int = 10,
        min_train_ratio: float = 0.3,
        embargo_pct: float | None = None,
        max_embargo_days: int | None = 20,
    ):
        self.n_splits = n_splits
        self.embargo_days = embargo_days
        self.min_train_ratio = min_train_ratio
        self.embargo_pct = embargo_pct
        self.max_embargo_days = max_embargo_days

    def split(
        self,
        X: np.ndarray,
        y: np.ndarray,
        dates: np.ndarray,
    ) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """Generate train/test indices with purged embargo."""

        n_samples = len(X)
        if len(y) != n_samples or len(dates) != n_samples:
            raise ValueError("X, y, and dates must have the same length")

        unique_dates = np.sort(np.unique(dates))
        n_dates = len(unique_dates)
        embargo_days = dynamic_embargo_days(
            n_dates,
            base_days=self.embargo_days,
            embargo_pct=self.embargo_pct,
            max_days=self.max_embargo_days,
        )

        if n_dates < self.n_splits + embargo_days:
            raise ValueError(
                f"Not enough unique dates ({n_dates}) for {self.n_splits} splits "
                f"with {embargo_days} embargo days"
            )

        date_to_idx: dict[str, list[int]] = {}
        for i, d in enumerate(dates):
            date_to_idx.setdefault(str(d), []).append(i)

        min_train_dates = max(int(n_dates * self.min_train_ratio), 20)
        available_test_dates = n_dates - min_train_dates - embargo_days
        test_size = max(available_test_dates // self.n_splits, 5)

        for fold in range(self.n_splits):
            test_end_idx = n_dates - fold * test_size
            test_start_idx = test_end_idx - test_size
            embargo_start_idx = test_start_idx - embargo_days
            train_end_idx = embargo_start_idx

            if train_end_idx < min_train_dates or test_start_idx < 0:
                continue

            train_dates = unique_dates[:train_end_idx]
            test_dates = unique_dates[test_start_idx:test_end_idx]

            train_idx: list[int] = []
            for d in train_dates:
                train_idx.extend(date_to_idx.get(str(d), []))

            test_idx: list[int] = []
            for d in test_dates:
                test_idx.extend(date_to_idx.get(str(d), []))

            if len(train_idx) < 100 or len(test_idx) < 50:
                continue

            yield np.array(sorted(train_idx)), np.array(sorted(test_idx))

    def get_n_splits(self) -> int:
        return self.n_splits

    def __repr__(self) -> str:
        return (
            "PurgedTimeSeriesCV("
            f"n_splits={self.n_splits}, embargo_days={self.embargo_days}, "
            f"embargo_pct={self.embargo_pct}, max_embargo_days={self.max_embargo_days})"
        )


class CombinatorialPurgedCV:
    """Combinatorial Purged CV (CPCV) for financial model validation.

    Dates are split into contiguous groups. Each split chooses a combination of
    groups as test data and purges training dates within the embargo window of
    any test date. This gives model-level OOS evidence beyond a single
    walk-forward path.
    """

    def __init__(
        self,
        *,
        n_groups: int = 6,
        n_test_groups: int = 2,
        embargo_days: int = 10,
        embargo_pct: float | None = None,
        max_embargo_days: int | None = 20,
        min_train_groups: int = 2,
    ) -> None:
        if n_groups <= 1:
            raise ValueError("n_groups must be greater than 1")
        if n_test_groups <= 0 or n_test_groups >= n_groups:
            raise ValueError("n_test_groups must satisfy 0 < n_test_groups < n_groups")
        self.n_groups = int(n_groups)
        self.n_test_groups = int(n_test_groups)
        self.embargo_days = int(embargo_days)
        self.embargo_pct = embargo_pct
        self.max_embargo_days = max_embargo_days
        self.min_train_groups = int(min_train_groups)

    def split(
        self,
        X: np.ndarray,
        y: np.ndarray,
        dates: np.ndarray,
    ) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """Generate CPCV train/test indices with purged embargo."""

        n_samples = len(X)
        if len(y) != n_samples or len(dates) != n_samples:
            raise ValueError("X, y, and dates must have the same length")

        unique_dates = np.sort(np.unique(dates))
        if len(unique_dates) < self.n_groups:
            raise ValueError(
                f"Not enough unique dates ({len(unique_dates)}) for {self.n_groups} CPCV groups"
            )

        resolved_embargo = dynamic_embargo_days(
            len(unique_dates),
            base_days=self.embargo_days,
            embargo_pct=self.embargo_pct,
            max_days=self.max_embargo_days,
        )
        groups = [np.array(group) for group in np.array_split(unique_dates, self.n_groups) if len(group)]
        if len(groups) != self.n_groups:
            raise ValueError("Unable to build non-empty CPCV date groups")

        date_to_pos = {str(date): pos for pos, date in enumerate(unique_dates)}
        date_to_idx: dict[str, list[int]] = {}
        for idx, date in enumerate(dates):
            date_to_idx.setdefault(str(date), []).append(idx)

        for test_group_ids in combinations(range(self.n_groups), self.n_test_groups):
            train_group_ids = [gid for gid in range(self.n_groups) if gid not in test_group_ids]
            if len(train_group_ids) < self.min_train_groups:
                continue

            test_dates = {
                str(date)
                for gid in test_group_ids
                for date in groups[gid]
            }
            test_positions = {date_to_pos[date] for date in test_dates}
            train_dates: set[str] = set()
            for gid in train_group_ids:
                for date in groups[gid]:
                    text_date = str(date)
                    pos = date_to_pos[text_date]
                    if all(abs(pos - test_pos) > resolved_embargo for test_pos in test_positions):
                        train_dates.add(text_date)

            train_idx = [
                row
                for date in train_dates
                for row in date_to_idx.get(date, [])
            ]
            test_idx = [
                row
                for date in test_dates
                for row in date_to_idx.get(date, [])
            ]

            if not train_idx or not test_idx:
                continue
            yield np.array(sorted(train_idx)), np.array(sorted(test_idx))

    def get_n_splits(self) -> int:
        return cpcv_split_count(n_groups=self.n_groups, n_test_groups=self.n_test_groups)

    def __repr__(self) -> str:
        return (
            "CombinatorialPurgedCV("
            f"n_groups={self.n_groups}, n_test_groups={self.n_test_groups}, "
            f"embargo_days={self.embargo_days}, embargo_pct={self.embargo_pct}, "
            f"max_embargo_days={self.max_embargo_days})"
        )


def purged_train_test_split(
    X: np.ndarray,
    y: np.ndarray,
    dates: np.ndarray,
    test_ratio: float = 0.2,
    embargo_days: int = 10,
    embargo_pct: float | None = None,
    max_embargo_days: int | None = 20,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Single purged train/test split for final training."""

    unique_dates = np.sort(np.unique(dates))
    n_dates = len(unique_dates)
    resolved_embargo = dynamic_embargo_days(
        n_dates,
        base_days=embargo_days,
        embargo_pct=embargo_pct,
        max_days=max_embargo_days,
    )

    cutoff_idx = int(n_dates * (1 - test_ratio))
    embargo_end_idx = min(cutoff_idx + resolved_embargo, n_dates)

    train_dates = set(str(d) for d in unique_dates[:cutoff_idx])
    test_dates = set(str(d) for d in unique_dates[embargo_end_idx:])

    train_mask = np.array([str(d) in train_dates for d in dates])
    test_mask = np.array([str(d) in test_dates for d in dates])

    embargo_count = int((~train_mask & ~test_mask).sum())
    print(
        f"[PurgedSplit] train={train_mask.sum()}, embargo={embargo_count} "
        f"({resolved_embargo}d), test={test_mask.sum()}"
    )

    return (
        X[train_mask],
        y[train_mask],
        dates[train_mask],
        X[test_mask],
        y[test_mask],
        dates[test_mask],
    )
