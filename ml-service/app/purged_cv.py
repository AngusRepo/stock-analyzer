"""
purged_cv.py — Purged Time Series Cross-Validation (StockVision 2.0)

解決問題：
  標準 TimeSeriesSplit 的 train/test boundary 可能有 label overlap。
  Triple-barrier label 看未來 20 天 → train 最後 20 天的 label 依賴 test 期間的價格。
  Purged CV 在 train/test 之間插入 embargo gap，消除 data leakage。

References:
  - de Prado, "Advances in Financial Machine Learning" (2018), Chapter 7
  - Purged Group Time Series Split: sklearn contrib

Architecture:
  - dates array (per-sample) → sorted unique dates → n_splits folds
  - 每個 fold: train = [0, cutoff), embargo = [cutoff, cutoff+embargo), test = [cutoff+embargo, end)
  - embargo 天數: 10-20 (可配置, default=10, 對應 triple-barrier max_days=20)
"""
import numpy as np
from typing import Iterator


class PurgedTimeSeriesCV:
    """Purged Time Series Cross-Validation with Embargo.

    Parameters:
        n_splits: Number of CV folds (default 5)
        embargo_days: Days to purge between train and test (default 15)
        min_train_ratio: Minimum fraction of data for training (default 0.3)

    Usage:
        cv = PurgedTimeSeriesCV(n_splits=5, embargo_days=15)
        for fold, (train_idx, test_idx) in enumerate(cv.split(X, y, dates)):
            X_train, y_train = X[train_idx], y[train_idx]
            X_test, y_test = X[test_idx], y[test_idx]
    """

    def __init__(
        self,
        n_splits: int = 5,
        embargo_days: int = 10,
        min_train_ratio: float = 0.3,
    ):
        self.n_splits = n_splits
        self.embargo_days = embargo_days
        self.min_train_ratio = min_train_ratio

    def split(
        self,
        X: np.ndarray,
        y: np.ndarray,
        dates: np.ndarray,
    ) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """Generate train/test indices with purged embargo.

        Args:
            X: feature matrix (n_samples, n_features) — used for length only
            y: target array (n_samples,)
            dates: date strings per sample (n_samples,) — must be sortable

        Yields:
            (train_indices, test_indices) for each fold
        """
        n_samples = len(X)
        unique_dates = np.sort(np.unique(dates))
        n_dates = len(unique_dates)

        if n_dates < self.n_splits + self.embargo_days:
            raise ValueError(
                f"Not enough unique dates ({n_dates}) for {self.n_splits} splits "
                f"with {self.embargo_days} embargo days"
            )

        # Build date → index mapping
        date_to_idx = {}
        for i, d in enumerate(dates):
            date_to_idx.setdefault(str(d), []).append(i)

        # Each fold: expanding window train, fixed-size embargo gap, then test
        min_train_dates = max(int(n_dates * self.min_train_ratio), 20)

        # Test size per fold (roughly equal)
        available_test_dates = n_dates - min_train_dates - self.embargo_days
        test_size = max(available_test_dates // self.n_splits, 5)

        for fold in range(self.n_splits):
            # Test window slides from end backwards
            # Fold 0 = latest test period, Fold n-1 = earliest test period
            test_end_idx = n_dates - fold * test_size
            test_start_idx = test_end_idx - test_size
            embargo_start_idx = test_start_idx - self.embargo_days
            train_end_idx = embargo_start_idx

            if train_end_idx < min_train_dates or test_start_idx < 0:
                continue

            # Map date indices to sample indices
            train_dates = unique_dates[:train_end_idx]
            embargo_dates = unique_dates[embargo_start_idx:test_start_idx]
            test_dates = unique_dates[test_start_idx:test_end_idx]

            train_idx = []
            for d in train_dates:
                train_idx.extend(date_to_idx.get(str(d), []))

            test_idx = []
            for d in test_dates:
                test_idx.extend(date_to_idx.get(str(d), []))

            if len(train_idx) < 100 or len(test_idx) < 50:
                continue

            train_idx = np.array(sorted(train_idx))
            test_idx = np.array(sorted(test_idx))

            yield train_idx, test_idx

    def get_n_splits(self) -> int:
        return self.n_splits

    def __repr__(self) -> str:
        return (f"PurgedTimeSeriesCV(n_splits={self.n_splits}, "
                f"embargo_days={self.embargo_days})")


def purged_train_test_split(
    X: np.ndarray,
    y: np.ndarray,
    dates: np.ndarray,
    test_ratio: float = 0.2,
    embargo_days: int = 10,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Single purged train/test split (for final model training).

    Returns: (X_train, y_train, dates_train, X_test, y_test, dates_test)
    Embargo gap samples are excluded from BOTH train and test.
    """
    unique_dates = np.sort(np.unique(dates))
    n_dates = len(unique_dates)

    cutoff_idx = int(n_dates * (1 - test_ratio))
    embargo_end_idx = min(cutoff_idx + embargo_days, n_dates)

    train_dates = set(str(d) for d in unique_dates[:cutoff_idx])
    test_dates = set(str(d) for d in unique_dates[embargo_end_idx:])
    # embargo_dates = set between cutoff_idx and embargo_end_idx — excluded from both

    train_mask = np.array([str(d) in train_dates for d in dates])
    test_mask = np.array([str(d) in test_dates for d in dates])

    embargo_count = (~train_mask & ~test_mask).sum()
    print(f"[PurgedSplit] train={train_mask.sum()}, embargo={embargo_count} "
          f"({embargo_days}d), test={test_mask.sum()}")

    return (
        X[train_mask], y[train_mask], dates[train_mask],
        X[test_mask], y[test_mask], dates[test_mask],
    )
