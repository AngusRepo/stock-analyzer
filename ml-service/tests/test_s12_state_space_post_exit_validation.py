from __future__ import annotations

import importlib.util
from pathlib import Path

import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "s12_state_space_post_exit_validation",
    REPO_ROOT / "tools/s12_state_space_post_exit_validation.py",
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_post_exit_evaluation_is_continuous_and_no_top_k() -> None:
    rows = []
    for day in ("2026-08-01", "2026-08-02", "2026-08-03"):
        for index in range(10):
            forecast = (index - 4.5) / 100.0
            rows.append(
                {
                    "signal_date": day,
                    "symbol": f"{day}-{index}",
                    "forecast_return": forecast,
                    "forecast_positive": forecast > 0,
                    "continuation_30m": forecast,
                    "continuation_60m": forecast,
                    "continuation_120m": forecast,
                    "continuation_session_close": forecast,
                    "continuation_next_session_close": forecast,
                }
            )
    report = MODULE.evaluate_post_exit(pl.DataFrame(rows))
    assert report["rank_or_top_k_used"] is False
    assert report["formal_promotion_effect"] is False
    assert report["horizons"]["continuation_60m"]["row_pearson"] > 0.99
    assert report["horizons"]["continuation_60m"]["positive_date_mean_lcb90"]["lcb90"] > 0
    assert report["horizons"]["continuation_60m"]["positive_minus_non_positive_date_spread"]["lcb90"] > 0


def test_required_manifest_selection_is_symbol_and_date_fenced() -> None:
    outcomes = pl.DataFrame([{"symbol": "2330", "trade_date": "2026-08-01"}])
    manifests = [
        {
            "producer_run_id": "shioaji-research:2026-08-02:2330",
            "business_date": "2026-08-02",
            "r2_key": "keep",
        },
        {
            "producer_run_id": "shioaji-research:2026-08-02:2317",
            "business_date": "2026-08-02",
            "r2_key": "wrong-symbol",
        },
        {
            "producer_run_id": "shioaji-research:2026-08-20:2330",
            "business_date": "2026-08-20",
            "r2_key": "future-window",
        },
    ]
    selected = MODULE.select_required_manifests(outcomes, manifests)
    assert [row["r2_key"] for row in selected] == ["keep"]
