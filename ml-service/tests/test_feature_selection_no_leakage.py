import numpy as np

from app.feature_selection import _permuted_target


def test_permuted_target_preserves_each_date_distribution():
    y = np.array([0.1, 0.2, 0.3, 0.9, 0.8, 0.7])
    dates = np.array(["2026-04-01"] * 3 + ["2026-04-02"] * 3)
    rng = np.random.RandomState(7)

    shuffled = _permuted_target(y, rng=rng, dates=dates, mode="within_date")

    assert sorted(shuffled[:3].tolist()) == sorted(y[:3].tolist())
    assert sorted(shuffled[3:].tolist()) == sorted(y[3:].tolist())
    assert sorted(shuffled.tolist()) == sorted(y.tolist())


def test_permuted_target_global_mode_keeps_legacy_fallback():
    y = np.array([0.1, 0.2, 0.3, 0.9, 0.8, 0.7])
    rng = np.random.RandomState(7)

    shuffled = _permuted_target(y, rng=rng, dates=None, mode="global")

    assert sorted(shuffled.tolist()) == sorted(y.tolist())
