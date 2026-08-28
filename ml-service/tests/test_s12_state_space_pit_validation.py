from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "s12_state_space_pit_validation",
    REPO_ROOT / "tools" / "s12_state_space_pit_validation.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_pearson_is_tie_safe_and_unavailable_for_constant_forecast() -> None:
    assert MODULE._pearson(np.array([1.0, 1.0, 1.0]), np.array([-1.0, 0.0, 1.0])) is None


def test_relevance_screen_uses_continuous_signal_without_top_k() -> None:
    outcomes = []
    observations = []
    for date_index, signal_date in enumerate(("2026-08-01", "2026-08-02")):
        for index in range(12):
            symbol = f"{date_index}{index:03d}"
            forecast = (index - 5.5) / 100.0
            pnl = forecast / 2.0
            outcomes.append(
                {
                    "id": date_index * 100 + index,
                    "symbol": symbol,
                    "signal_date": signal_date,
                    "pnl_pct": pnl + MODULE.ROUNDTRIP_COST_BPS / 10_000.0,
                    "exit_reason": "tp1" if pnl > 0 else "structure_stop",
                }
            )
            observations.append(
                {
                    "symbol": symbol,
                    "as_of_date": signal_date,
                    "forecast_return": forecast,
                    "latent_slope_1d": forecast / 5.0,
                    "up_probability": 0.75 if forecast > 0 else 0.25,
                    "forecast_variance": 0.01,
                    "innovation_z": 0.0,
                }
            )
    report, joined = MODULE.evaluate_relevance(outcomes, observations)
    assert report["rank_or_top_k_used"] is False
    assert report["formal_promotion_effect"] is False
    assert report["coverage"]["joined_rows"] == 24
    assert report["continuous_signal"]["row_pearson_ic"] > 0.99
    assert report["continuous_signal"]["date_clustered_ic"]["lcb90"] > 0.99
    assert report["continuous_signal"]["date_clustered_positive_spread"]["lcb90"] > 0
    assert joined.height == 24
