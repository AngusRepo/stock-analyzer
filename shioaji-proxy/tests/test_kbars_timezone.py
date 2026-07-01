from __future__ import annotations

import importlib.util
from datetime import datetime, timezone
from pathlib import Path


def _load_proxy_main():
    path = Path(__file__).resolve().parents[1] / "main.py"
    spec = importlib.util.spec_from_file_location("shioaji_proxy_main", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_kbar_ts_repairs_utc_labelled_tw_session_wall_clock():
    proxy = _load_proxy_main()

    assert (
        proxy._iso_kbar_ts(datetime(2026, 7, 1, 9, 1, tzinfo=timezone.utc))
        == "2026-07-01T09:01:00+08:00"
    )


def test_kbar_ts_keeps_correct_utc_instant_for_tw_session():
    proxy = _load_proxy_main()

    assert (
        proxy._iso_kbar_ts(datetime(2026, 7, 1, 1, 1, tzinfo=timezone.utc))
        == "2026-07-01T09:01:00+08:00"
    )


def test_kbar_ts_repairs_numeric_epoch_ns_utc_labelled_tw_session_wall_clock():
    proxy = _load_proxy_main()
    skewed_epoch_ns = int(datetime(2026, 7, 1, 9, 1, tzinfo=timezone.utc).timestamp() * 1_000_000_000)

    assert proxy._iso_kbar_ts(skewed_epoch_ns) == "2026-07-01T09:01:00+08:00"


def test_kbar_ts_treats_naive_datetime_as_tw_local():
    proxy = _load_proxy_main()

    assert proxy._iso_kbar_ts(datetime(2026, 7, 1, 9, 1)) == "2026-07-01T09:01:00+08:00"
