import numpy as np

from app.universal_training import _date_min_max_for_manifest


def test_date_min_max_for_manifest_handles_numpy_string_dates():
    dates = np.asarray(["2026-05-02", "2026-04-30", "2026-05-01"], dtype="<U10")

    assert _date_min_max_for_manifest(dates) == ("2026-04-30", "2026-05-02")


def test_date_min_max_for_manifest_handles_empty_dates():
    assert _date_min_max_for_manifest(np.asarray([], dtype="<U10")) == (None, None)
