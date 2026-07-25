import pytest

from app.canonical_adjusted_prep import build_adjusted_target_lookup, _sequence_manifest_checksum
from app.sequence_training import CANONICAL_ROUNDTRIP_COST_BPS
from app.long_history_sequence_prep import _manifest_checksum as producer_manifest_checksum


def test_adjusted_target_lookup_uses_next_open_fifth_close_and_net_cost():
    dates = [f"2026-01-{day:02d}" for day in range(1, 8)]
    records = [{
        "symbol": "2330",
        "dates": dates,
        "open": [100.0, 101.0, 102.0, 103.0, 104.0, 105.0, 106.0],
        "close": [100.5, 101.5, 102.5, 103.5, 104.5, 111.0, 112.0],
    }]

    lookup = build_adjusted_target_lookup(records)

    expected = 111.0 / 101.0 - 1.0 - CANONICAL_ROUNDTRIP_COST_BPS / 10000.0
    assert lookup["2330"]["2026-01-01"][0] == pytest.approx(expected)
    assert lookup["2330"]["2026-01-01"][1] == "2026-01-06"


def test_adjusted_target_lookup_rejects_missing_exchange_session_bars():
    calendar = [f"2026-06-{day:02d}" for day in range(1, 9)]
    records = [
        {
            "symbol": "2330",
            "dates": calendar,
            "open": [100.0 + day for day in range(8)],
            "close": [100.5 + day for day in range(8)],
        },
        {
            "symbol": "3665",
            "dates": [date for date in calendar if date != "2026-06-02"],
            "open": [200.0 + day for day in range(7)],
            "close": [200.5 + day for day in range(7)],
        },
    ]

    lookup = build_adjusted_target_lookup(records)

    assert "2026-06-01" not in lookup["3665"]
    assert "2026-06-01" in lookup["2330"]


def test_sequence_manifest_checksum_matches_long_history_producer():
    manifest = {
        "schema_version": "finlab-long-history-sequence-prep-v2",
        "status": "ready",
        "contract": "sequence_records_v3",
        "output_gcs_prefix": "universal/sequence_long/runs/example",
        "batch_count": 1,
        "summary": {"date_min": "2025-01-02", "date_max": "2026-07-23"},
        "output_checksums": {"batch_0.npz": "a" * 64},
    }

    assert _sequence_manifest_checksum(manifest) == producer_manifest_checksum(manifest)