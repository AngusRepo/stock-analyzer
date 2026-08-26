from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from app.neuralforecast_sequence_runtime import (
    _build_fixed_oof_panel,
    _resolve_nf_training_options,
)
from app.oof_lineage import date_market_rank_ic_evidence


def _sequence_records(calendar: list[str], count: int = 12) -> list[dict]:
    return [
        {
            "symbol": f"S{index:02d}",
            "market_type": "LISTED" if index < count // 2 else "OTC",
            "dates": calendar,
            "close": [100.0 + index + day for day in range(len(calendar))],
            "open": [99.5 + index + day for day in range(len(calendar))],
        }
        for index in range(count)
    ]


def test_patchtst_research_full_pit_history_creates_multiple_windows_without_future_rows():
    calendar = [f"2026-01-{day:02d}" for day in range(1, 17)]
    records = _sequence_records(calendar)

    minimum_rows, _minimum_records, minimum = _build_fixed_oof_panel(
        records,
        calendar=calendar,
        train_end="2026-01-12",
        seq_len=4,
        pred_len=2,
        max_series=20,
    )
    full_rows, _full_records, full = _build_fixed_oof_panel(
        records,
        calendar=calendar,
        train_end="2026-01-12",
        seq_len=4,
        pred_len=2,
        max_series=20,
        training_history_mode="full_pit_history",
    )

    assert minimum["unique_training_windows"] == 12
    assert full["unique_training_windows"] == 12 * 7
    assert full["training_windows_per_selected_series"] == 7
    assert full["calendar_end"] == "2026-01-12"
    assert len(full_rows) > len(minimum_rows)
    assert max(row["ds"] for row in full_rows) == 11


def test_patchtst_research_options_are_deterministic_and_monthly_defaults_stay_fixed():
    monthly = _resolve_nf_training_options({}, "PatchTST")
    research = _resolve_nf_training_options(
        {
            "oof_training_history_mode": "full_pit_history",
            "max_steps": 120,
        },
        "PatchTST",
    )

    assert monthly["oof_training_history_mode"] == "minimum_single_window"
    assert monthly["trainer_deterministic"] is True
    assert monthly["trainer_benchmark"] is False
    assert research["oof_training_history_mode"] == "full_pit_history"
    assert research["patch_len"] == 16
    assert research["stride"] == 8
    assert research["revin"] is True

    with pytest.raises(ValueError, match="oof_training_history_mode_invalid"):
        _resolve_nf_training_options({"oof_training_history_mode": "full_history_without_pit"}, "PatchTST")


def test_sequence_runtime_preserves_each_prediction_signal_date_for_ic_clustering():
    source = (Path(__file__).resolve().parents[1] / "app" / "neuralforecast_sequence_runtime.py").read_text(encoding="utf-8")

    assert 'signal_dates_per_row.append(str(row.get("signal_date") or ""))' in source
    assert 'dates=np.asarray(signal_dates_per_row, dtype=object)' in source
    assert 'dates=np.asarray([signal_dates[-1] if signal_dates else ""]' not in source


def test_date_market_ic_owner_is_market_separated_and_tie_neutral():
    evidence = date_market_rank_ic_evidence(
        raw_scores=np.asarray([1.0, 2.0, 3.0, 1.0, 2.0, 3.0]),
        targets=np.asarray([1.0, 2.0, 3.0, 3.0, 2.0, 1.0]),
        dates=np.asarray(["2026-01-12"] * 6),
        markets=np.asarray(["TWSE"] * 3 + ["TPEX"] * 3),
        min_cohort_rows=3,
    )
    constant = date_market_rank_ic_evidence(
        raw_scores=np.asarray([7.0] * 6),
        targets=np.asarray([1.0, 2.0, 3.0, 3.0, 2.0, 1.0]),
        dates=np.asarray(["2026-01-12"] * 6),
        markets=np.asarray(["TWSE"] * 3 + ["TPEX"] * 3),
        min_cohort_rows=3,
    )

    assert evidence["date_cluster_count"] == 1
    assert evidence["date_cluster_ics"][0]["segments"] == 2
    assert evidence["date_cluster_ics"][0]["rank_ic"] == pytest.approx(0.0)
    assert evidence["fold_oos_ic"] == pytest.approx(0.0)
    assert constant["fold_oos_ic"] == pytest.approx(0.0)
