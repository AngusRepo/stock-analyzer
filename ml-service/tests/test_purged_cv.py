from __future__ import annotations

import numpy as np

from app.purged_cv import (
    CombinatorialPurgedCV,
    PurgedTimeSeriesCV,
    cpcv_split_count,
    dynamic_embargo_days,
    purged_explicit_walk_forward_split,
    purged_train_test_split,
)


def test_dynamic_embargo_preserves_base_for_short_history():
    assert dynamic_embargo_days(120, base_days=10, embargo_pct=0.015, max_days=20) == 10


def test_dynamic_embargo_expands_and_caps_for_long_history():
    assert dynamic_embargo_days(1000, base_days=10, embargo_pct=0.015, max_days=20) == 15
    assert dynamic_embargo_days(2000, base_days=10, embargo_pct=0.015, max_days=20) == 20


def test_purged_train_test_split_excludes_embargo_window():
    dates = np.array([f"D{(i // 2) + 1:03d}" for i in range(60)])
    X = np.arange(60).reshape(60, 1)
    y = np.arange(60)

    _, _, dates_train, _, _, dates_test = purged_train_test_split(
        X,
        y,
        dates,
        test_ratio=0.2,
        embargo_days=3,
        max_embargo_days=None,
    )

    assert sorted(set(dates_train))[-1] < sorted(set(dates_test))[0]
    train_end = sorted(set(dates_train))[-1]
    test_start = sorted(set(dates_test))[0]
    assert train_end == "D024"
    assert test_start == "D028"


def test_explicit_walk_forward_purges_five_label_horizon_dates():
    dates = np.array([f"D{(i // 2) + 1:03d}" for i in range(40)])
    X = np.arange(40).reshape(40, 1)
    y = np.arange(40)

    _, _, dates_train, _, _, dates_test, metadata = purged_explicit_walk_forward_split(
        X,
        y,
        dates,
        train_start="D001",
        train_end="D010",
        test_start="D011",
        test_end="D015",
        label_horizon_days=5,
    )

    assert sorted(set(dates_train))[-1] == "D005"
    assert sorted(set(dates_test))[0] == "D011"
    assert metadata == {
        "method": "walk_forward_explicit_label_purged",
        "purged": True,
        "label_horizon_days": 5,
        "requested_train_range": ["D001", "D010"],
        "effective_train_range": ["D001", "D005"],
        "test_range": ["D011", "D015"],
        "purged_date_count": 5,
        "purged_row_count": 10,
        "actual_label_known_date_required": False,
        "purge_method": "observed_date_horizon_approximation",
    }


def test_explicit_walk_forward_keeps_existing_five_day_gap():
    dates = np.array([f"D{i + 1:03d}" for i in range(20)])
    X = np.arange(20).reshape(20, 1)
    y = np.arange(20)

    _, _, dates_train, _, _, _, metadata = purged_explicit_walk_forward_split(
        X,
        y,
        dates,
        train_start="D001",
        train_end="D005",
        test_start="D011",
        test_end="D015",
        label_horizon_days=5,
    )

    assert sorted(set(dates_train))[-1] == "D005"
    assert metadata["purged_date_count"] == 0
    assert metadata["purged_row_count"] == 0


def test_explicit_walk_forward_rejects_overlapping_ranges():
    dates = np.array([f"D{i + 1:03d}" for i in range(20)])
    X = np.arange(20).reshape(20, 1)
    y = np.arange(20)

    with np.testing.assert_raises_regex(ValueError, "walk_forward_ranges_overlap_or_unsorted"):
        purged_explicit_walk_forward_split(
            X,
            y,
            dates,
            train_start="D001",
            train_end="D010",
            test_start="D010",
            test_end="D015",
            label_horizon_days=5,
        )


def test_purged_cv_keeps_train_before_test():
    dates = np.array([f"D{(i // 5) + 1:03d}" for i in range(600)])
    X = np.arange(600).reshape(600, 1)
    y = np.arange(600)
    cv = PurgedTimeSeriesCV(n_splits=3, embargo_days=5, min_train_ratio=0.3)

    splits = list(cv.split(X, y, dates))

    assert splits
    for train_idx, test_idx in splits:
        assert sorted(set(dates[train_idx]))[-1] < sorted(set(dates[test_idx]))[0]


def test_cpcv_split_count_matches_combinations():
    assert cpcv_split_count(n_groups=6, n_test_groups=2) == 15


def test_combinatorial_purged_cv_generates_non_overlapping_splits():
    dates = np.array([f"D{(i // 5) + 1:03d}" for i in range(600)])
    X = np.arange(600).reshape(600, 1)
    y = np.arange(600)
    cv = CombinatorialPurgedCV(
        n_groups=6,
        n_test_groups=2,
        embargo_days=2,
        min_train_groups=2,
    )

    splits = list(cv.split(X, y, dates))

    assert len(splits) == 15
    for train_idx, test_idx in splits:
        train_dates = set(dates[train_idx])
        test_dates = set(dates[test_idx])
        assert train_dates.isdisjoint(test_dates)


def test_combinatorial_purged_cv_embargoes_dates_around_test_groups():
    dates = np.array([f"D{(i // 2) + 1:03d}" for i in range(120)])
    X = np.arange(120).reshape(120, 1)
    y = np.arange(120)
    cv = CombinatorialPurgedCV(n_groups=6, n_test_groups=1, embargo_days=2)

    train_idx, test_idx = next(cv.split(X, y, dates))

    unique_dates = sorted(set(dates))
    date_pos = {date: pos for pos, date in enumerate(unique_dates)}
    train_pos = {date_pos[date] for date in set(dates[train_idx])}
    test_pos = {date_pos[date] for date in set(dates[test_idx])}
    assert all(abs(t - s) > 2 for t in train_pos for s in test_pos)
